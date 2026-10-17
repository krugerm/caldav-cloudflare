// Extended MKCOL, PROPPATCH and DELETE on calendar collections.
import { canManageCollections, canWrite } from "../auth/scope";
import { HttpError, pre } from "../http/errors";
import { readXml } from "../http/body";
import { empty, xmlResponse } from "../http/response";
import { parseTimezone } from "../ical/calendar";
import { PreconditionFailed, UniqueViolation } from "../store/batch";
import {
  COMPONENT_TYPES,
  createCollectionStatements,
  deadPropsOf,
  deleteCollectionStatements,
  getCollection,
  updateCollectionStatements,
  type CollectionProps,
  type ComponentType,
} from "../store/collections";
import { nowSeconds } from "../util/time";
import { commit, type DavContext, type Resource } from "./context";
import { multistatus, propNode, statusLine } from "./multistatus";
import { href, isValidName, type Address } from "./paths";
import { WRITABLE, isLiveProperty } from "./props";
import { NS, XML_FORBIDDEN, child, children, clark, d, serializeFragment, type XNode, type XmlElement } from "./xml";

const forbidden = (msg: string) => new HttpError(403, msg, pre.dav("need-privileges"));

const audit = (ctx: DavContext) => ({ actor: ctx.principal.actor, at: nowSeconds() });

const COMPONENT_SET = clark(NS.CALDAV, "supported-calendar-component-set");
const RESOURCETYPE = clark(NS.DAV, "resourcetype");

type PropOutcome = { key: string; status: 200 | 403 | 409 | 424 | 507; precondition?: string };

/** Limits that keep a collection row well inside D1's 2 MB row cap. */
export const LIMITS = {
  deadProps: 64,
  deadPropBytes: 64 * 1024,
  textBytes: 4 * 1024,
  timezoneBytes: 64 * 1024,
};

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

/**
 * Turn <set>/<remove> property elements into collection column updates.
 * Returns the outcome per property; any failure means nothing is applied.
 */
function applyProps(
  ops: { op: "set" | "remove"; prop: XmlElement }[],
  dead: Record<string, string>,
  creating: boolean,
): { props: CollectionProps; components?: ComponentType[]; outcomes: PropOutcome[] } {
  const props: CollectionProps = {};
  let components: ComponentType[] | undefined;
  let deadChanged = false;
  const outcomes: PropOutcome[] = [];
  for (const { op, prop } of ops) {
    const key = clark(prop.ns, prop.name);
    // a value XML can't carry would break every later PROPFIND of this collection
    if (op === "set" && XML_FORBIDDEN.test(serializeFragment(prop))) {
      outcomes.push({ key, status: 403 });
      continue;
    }
    const column = WRITABLE[key];
    if (column) {
      const limit = column === "timezone" ? LIMITS.timezoneBytes : LIMITS.textBytes;
      if (op === "set" && byteLength(prop.text) > limit) {
        outcomes.push({ key, status: 507 });
        continue;
      }
      // RFC 4791 §5.2.2: a VCALENDAR with exactly the time zone
      if (column === "timezone" && op === "set" && !parseTimezone(prop.text)) {
        outcomes.push({ key, status: 403, precondition: "valid-calendar-data" });
        continue;
      }
      props[column] = op === "set" ? prop.text : null;
      outcomes.push({ key, status: 200 });
    } else if (key === COMPONENT_SET && creating && op === "set") {
      const names = children(prop, NS.CALDAV, "comp").map((c) => (c.attrs.name ?? "").toUpperCase());
      const ok = names.length > 0 && names.every((n): n is ComponentType => (COMPONENT_TYPES as readonly string[]).includes(n));
      if (ok) components = [...new Set(names as ComponentType[])];
      outcomes.push(ok ? { key, status: 200 } : { key, status: 403, precondition: "supported-calendar-component" });
    } else if (key === RESOURCETYPE && creating) {
      // extended MKCOL sends the resource type; only calendars can be created here
      const isCalendar = !!child(prop, NS.CALDAV, "calendar");
      outcomes.push(isCalendar ? { key, status: 200 } : { key, status: 403, precondition: "valid-resourcetype" });
    } else if (isLiveProperty(key)) {
      outcomes.push({ key, status: 403, precondition: "cannot-modify-protected-property" });
    } else {
      if (op === "set") dead[key] = serializeFragment(prop);
      else delete dead[key];
      deadChanged = true;
      outcomes.push({ key, status: 200 });
    }
  }
  if (deadChanged) {
    const tooMany = Object.keys(dead).length > LIMITS.deadProps;
    const tooBig = byteLength(JSON.stringify(dead)) > LIMITS.deadPropBytes;
    if (tooMany || tooBig) {
      // the dead properties being set are what doesn't fit
      for (const o of outcomes) if (o.status === 200 && !isLiveProperty(o.key) && !WRITABLE[o.key]) o.status = 507;
    }
    props.dead_props = dead;
  }
  const failed = outcomes.some((o) => o.status !== 200);
  return {
    props,
    components,
    outcomes: failed ? outcomes.map((o) => (o.status === 200 ? { ...o, status: 424 as const } : o)) : outcomes,
  };
}

/** Collect the property operations of a propertyupdate / mkcalendar / mkcol body, in document order. */
function propertyOps(body: XmlElement | null): { op: "set" | "remove"; prop: XmlElement }[] {
  if (!body) return [];
  return body.children.flatMap((opEl) => {
    if (opEl.ns !== NS.DAV || (opEl.name !== "set" && opEl.name !== "remove")) return [];
    return (child(opEl, NS.DAV, "prop")?.children ?? []).map((prop) => ({ op: opEl.name as "set" | "remove", prop }));
  });
}

const CALDAV_PRECONDITIONS = new Set(["supported-calendar-component", "valid-calendar-data"]);
const preconditionNode = (name: string) => (CALDAV_PRECONDITIONS.has(name) ? { ns: NS.CALDAV, name } : d(name));

/** One propstat per status, each with the preconditions that caused it. */
function propstatElements(outcomes: PropOutcome[]): XNode[] {
  const byStatus = new Map<number, PropOutcome[]>();
  outcomes.forEach((o) => byStatus.set(o.status, [...(byStatus.get(o.status) ?? []), o]));
  return [...byStatus].map(([status, list]) => {
    const preconditions = [...new Set(list.flatMap((o) => (o.precondition ? [o.precondition] : [])))];
    return d("propstat", [
      d("prop", list.map((o) => propNode(o.key))),
      d("status", statusLine(status)),
      ...(preconditions.length ? [d("error", preconditions.map(preconditionNode))] : []),
    ]);
  });
}

const propstatResponse = (target: string, outcomes: PropOutcome[]) =>
  multistatus([d("response", [d("href", target), ...propstatElements(outcomes)])]);

/**
 * Extended MKCOL (RFC 5689) creating a calendar collection. MKCALENDAR is
 * not offered: workerd rejects the method before the Worker runs (D-010).
 */
export async function makeCollection(ctx: DavContext, address: Address, existing: Resource | null): Promise<Response> {
  if (address.kind !== "collection") throw new HttpError(403, "MKCOL is only allowed for a calendar collection URL");
  if (address.user !== ctx.principal.username) throw new HttpError(404, "not found");
  if (!canManageCollections(ctx.principal.scope)) throw forbidden("this app password cannot create collections");
  if (existing) throw new HttpError(405, "a resource already exists here", pre.dav("resource-must-be-null"), { Allow: "OPTIONS, PROPFIND, PROPPATCH, DELETE, REPORT" });
  if (!isValidName(address.collection)) throw new HttpError(400, "invalid collection name");
  const body = await readXml(ctx.request);
  if (body && (body.ns !== NS.DAV || body.name !== "mkcol")) throw new HttpError(400, "expected DAV:mkcol body");
  const ops = propertyOps(body);
  if (!ops.some((o) => clark(o.prop.ns, o.prop.name) === RESOURCETYPE && child(o.prop, NS.CALDAV, "calendar"))) {
    // plain collections aren't part of the URL layout
    throw new HttpError(403, "only calendar collections can be created", pre.dav("valid-resourcetype"));
  }
  const { props, components, outcomes } = applyProps(ops, {}, true);
  const target = href.collection(address.user, address.collection);
  if (outcomes.some((o) => o.status !== 200)) {
    // RFC 5689 §3.3: report per-property failures and create nothing
    return xmlResponse(d("mkcol-response", propstatElements(outcomes)), 403);
  }
  try {
    await commit(ctx, createCollectionStatements(ctx.env.DB, ctx.principal.userId, address.collection, components ?? ["VEVENT", "VTODO"], props, audit(ctx)));
  } catch (e) {
    if (e instanceof UniqueViolation) throw new HttpError(405, "a resource already exists here", pre.dav("resource-must-be-null"));
    throw e;
  }
  return empty(201, { Location: target, "Content-Length": "0" });
}

export async function proppatch(ctx: DavContext, target: Resource): Promise<Response> {
  const body = await readXml(ctx.request);
  if (!body || body.ns !== NS.DAV || body.name !== "propertyupdate") throw new HttpError(400, "expected DAV:propertyupdate");
  const ops = propertyOps(body);
  if (target.kind !== "collection") {
    // only collections carry settable properties
    const keys = ops.map((o) => ({ key: clark(o.prop.ns, o.prop.name), status: 403 as const, precondition: "cannot-modify-protected-property" }));
    return xmlResponse(propstatResponse(ctx.url.pathname, keys));
  }
  if (!canWrite(ctx.principal.scope)) throw forbidden("this app password is read-only");
  let coll = target.coll;
  let outcomes: PropOutcome[];
  // The batch fails if the collection changed since it was read (a concurrent write would
  // otherwise lose dead properties); re-read and re-apply once.
  for (let attempt = 0; ; attempt++) {
    const applied = applyProps(ops, deadPropsOf(coll), false);
    outcomes = applied.outcomes;
    if (outcomes.some((o) => o.status !== 200)) break;
    try {
      await commit(ctx, updateCollectionStatements(ctx.env.DB, coll, applied.props, audit(ctx)));
      break;
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e;
      const fresh = await getCollection(ctx.env.DB, coll.user_id, coll.slug);
      if (!fresh || fresh.id !== coll.id) throw new HttpError(404, "not found");
      if (attempt > 0) throw new HttpError(409, "the collection changed during the update; retry");
      coll = fresh;
    }
  }
  return xmlResponse(propstatResponse(href.collection(target.user, target.coll.slug), outcomes));
}

export async function deleteCollection(ctx: DavContext, target: Extract<Resource, { kind: "collection" }>): Promise<Response> {
  if (!canManageCollections(ctx.principal.scope)) throw forbidden("this app password cannot delete collections");
  try {
    await commit(ctx, deleteCollectionStatements(ctx.env.DB, target.coll, audit(ctx)));
  } catch (e) {
    // a concurrent DELETE won; there is nothing left to delete
    if (e instanceof PreconditionFailed) throw new HttpError(404, "not found");
    throw e;
  }
  return empty(204);
}
