// Live properties: what each resource reports in PROPFIND and REPORT responses.
import { canManageCollections, canWrite } from "../auth/scope";
import { componentsOf, deadPropsOf, usedBytes } from "../store/collections";
import { httpDate } from "../util/time";
import type { DavContext, Resource } from "./context";
import { href, hrefOf } from "./paths";
import { syncToken } from "./sync";
import { NS, c, clark, d, el, type XNode } from "./xml";

/** A property value: child elements or text. `undefined` from a getter means 404. */
export type PropValue = XNode[] | string;

interface PropDef {
  ns: string;
  name: string;
  /** Returned for <allprop/>. RFC 4918 lets expensive or large properties opt out. */
  allprop: boolean;
  get(ctx: DavContext, r: Resource): PropValue | undefined | Promise<PropValue | undefined>;
}

const hrefNode = (h: string) => d("href", h);

function addressOf(r: Resource) {
  switch (r.kind) {
    case "collection":
      return href.collection(r.user, r.coll.slug);
    case "object":
      return href.object(r.user, r.coll.slug, r.obj.name);
    default:
      return hrefOf(r as Exclude<Resource, { kind: "collection" | "object" }>);
  }
}

export const resourceHref = addressOf;

function privileges(ctx: DavContext, r: Resource): string[] {
  const read = ["read", "read-current-user-privilege-set", "read-free-busy"];
  const scope = ctx.principal.scope;
  switch (r.kind) {
    case "home":
      return canManageCollections(scope) ? [...read, "write", "write-properties", "write-content", "bind", "unbind"] : read;
    case "collection":
      return canWrite(scope) ? [...read, "write", "write-properties", "write-content", "bind", "unbind"] : read;
    case "object":
      return canWrite(scope) ? [...read, "write", "write-properties", "write-content"] : read;
    default:
      return read;
  }
}

/** read-free-busy is CalDAV's (RFC 4791 §6.1.1); the rest are DAV:. */
const privilegeNode = (name: string) => d("privilege", [name === "read-free-busy" ? c(name) : d(name)]);

function supportedPrivilege(name: string, abstract: boolean, children: XNode[] = []): XNode {
  return d("supported-privilege", [
    privilegeNode(name),
    ...(abstract ? [d("abstract")] : []),
    d("description", name),
    ...children,
  ]);
}

const SUPPORTED_PRIVILEGES = d("supported-privilege-set", [
  supportedPrivilege("all", true, [
    supportedPrivilege("read", false, [
      supportedPrivilege("read-current-user-privilege-set", false),
      // §6.1.1: aggregated under DAV:read
      supportedPrivilege("read-free-busy", false),
    ]),
    supportedPrivilege("write", false, [
      supportedPrivilege("write-properties", false),
      supportedPrivilege("write-content", false),
      supportedPrivilege("bind", false),
      supportedPrivilege("unbind", false),
    ]),
  ]),
]).children!;

const report = (ns: string, name: string) => d("supported-report", [d("report", [el(ns, name)])]);

const isCollectionLike = (r: Resource) => r.kind !== "object";

async function quota(ctx: DavContext, r: Resource): Promise<{ used: number; available?: number } | undefined> {
  if (r.kind !== "home" && r.kind !== "collection") return undefined;
  const { userId, scope } = ctx.principal;
  if (r.kind === "collection") {
    const used = await usedBytes(ctx.env.DB, userId, { collectionId: r.coll.id });
    if (scope.collections !== null) return { used };
    return { used, available: Math.max(0, ctx.cfg.quotaBytes - (await usedBytes(ctx.env.DB, userId))) };
  }
  // the remaining space depends on collections a scoped password can't see, so it gets usage over its own collections only
  if (scope.collections !== null) return { used: await usedBytes(ctx.env.DB, userId, { slugs: scope.collections }) };
  const total = await usedBytes(ctx.env.DB, userId);
  return { used: total, available: Math.max(0, ctx.cfg.quotaBytes - total) };
}

const defs: PropDef[] = [
  {
    ns: NS.DAV,
    name: "resourcetype",
    allprop: true,
    get: (_ctx, r) => {
      switch (r.kind) {
        case "principal":
          return [d("collection"), d("principal")];
        case "collection":
          return [d("collection"), c("calendar")];
        case "object":
          return [];
        default:
          return [d("collection")];
      }
    },
  },
  {
    ns: NS.DAV,
    name: "displayname",
    allprop: true,
    get: (_ctx, r) => {
      switch (r.kind) {
        case "principal":
        case "home":
          return r.user;
        case "collection":
          return r.coll.displayname ?? r.coll.slug;
        default:
          return undefined;
      }
    },
  },
  { ns: NS.DAV, name: "current-user-principal", allprop: false, get: (ctx) => [hrefNode(href.principal(ctx.principal.username))] },
  { ns: NS.DAV, name: "principal-URL", allprop: false, get: (_ctx, r) => (r.kind === "principal" ? [hrefNode(href.principal(r.user))] : undefined) },
  {
    ns: NS.DAV,
    name: "principal-collection-set",
    allprop: false,
    get: (_ctx, r) => (r.kind === "principal" || r.kind === "root" ? [hrefNode(href.principals())] : undefined),
  },
  {
    ns: NS.DAV,
    name: "owner",
    allprop: false,
    get: (_ctx, r) =>
      r.kind === "home" || r.kind === "collection" || r.kind === "object" || r.kind === "principal"
        ? [hrefNode(href.principal(r.user))]
        : undefined,
  },
  { ns: NS.DAV, name: "current-user-privilege-set", allprop: false, get: (ctx, r) => privileges(ctx, r).map(privilegeNode) },
  { ns: NS.DAV, name: "supported-privilege-set", allprop: false, get: () => SUPPORTED_PRIVILEGES },
  {
    ns: NS.DAV,
    name: "supported-report-set",
    allprop: false,
    get: (_ctx, r) =>
      r.kind === "collection"
        ? [
            report(NS.CALDAV, "calendar-multiget"),
            report(NS.CALDAV, "calendar-query"),
            report(NS.CALDAV, "free-busy-query"),
            report(NS.DAV, "sync-collection"),
          ]
        : r.kind === "object"
          ? undefined
          : [],
  },
  { ns: NS.DAV, name: "sync-token", allprop: false, get: (_ctx, r) => (r.kind === "collection" ? syncToken(r.coll) : undefined) },
  { ns: NS.DAV, name: "getetag", allprop: true, get: (_ctx, r) => (r.kind === "object" ? r.obj.etag : undefined) },
  {
    ns: NS.DAV,
    name: "getcontenttype",
    allprop: true,
    get: (_ctx, r) =>
      r.kind === "object" ? `text/calendar; charset=utf-8; component=${r.obj.component.toLowerCase()}` : undefined,
  },
  { ns: NS.DAV, name: "getcontentlength", allprop: true, get: (_ctx, r) => (r.kind === "object" ? String(r.obj.size) : undefined) },
  {
    ns: NS.DAV,
    name: "getlastmodified",
    allprop: true,
    get: (_ctx, r) =>
      r.kind === "object" ? httpDate(r.obj.updated_at) : r.kind === "collection" ? httpDate(r.coll.updated_at) : undefined,
  },
  {
    ns: NS.DAV,
    name: "quota-available-bytes",
    allprop: false,
    get: async (ctx, r) => (await quota(ctx, r))?.available?.toString(),
  },
  { ns: NS.DAV, name: "quota-used-bytes", allprop: false, get: async (ctx, r) => (await quota(ctx, r))?.used.toString() },
  {
    ns: NS.CALDAV,
    name: "calendar-home-set",
    allprop: false,
    get: (_ctx, r) => (r.kind === "principal" ? [hrefNode(href.home(r.user))] : undefined),
  },
  {
    ns: NS.CALDAV,
    name: "calendar-user-address-set",
    allprop: false,
    get: (_ctx, r) => (r.kind === "principal" ? [hrefNode(href.principal(r.user))] : undefined),
  },
  {
    ns: NS.CALDAV,
    name: "supported-calendar-component-set",
    allprop: false,
    get: (_ctx, r) =>
      r.kind === "collection" ? componentsOf(r.coll).map((name) => ({ ns: NS.CALDAV, name: "comp", attrs: { name } })) : undefined,
  },
  {
    ns: NS.CALDAV,
    name: "supported-calendar-data",
    allprop: false,
    get: (_ctx, r) =>
      r.kind === "collection"
        ? [{ ns: NS.CALDAV, name: "calendar-data", attrs: { "content-type": "text/calendar", version: "2.0" } }]
        : undefined,
  },
  {
    ns: NS.CALDAV,
    name: "max-resource-size",
    allprop: false,
    get: (ctx, r) => (r.kind === "collection" ? String(ctx.cfg.maxObjectBytes) : undefined),
  },
  {
    ns: NS.CALDAV,
    name: "calendar-description",
    allprop: false,
    get: (_ctx, r) => (r.kind === "collection" ? (r.coll.description ?? undefined) : undefined),
  },
  {
    ns: NS.CALDAV,
    name: "calendar-timezone",
    allprop: false,
    get: (_ctx, r) => (r.kind === "collection" ? (r.coll.timezone ?? undefined) : undefined),
  },
  { ns: NS.CS, name: "getctag", allprop: false, get: (_ctx, r) => (r.kind === "collection" ? syncToken(r.coll) : undefined) },
  {
    ns: NS.APPLE,
    name: "calendar-color",
    allprop: false,
    get: (_ctx, r) => (r.kind === "collection" ? (r.coll.color ?? undefined) : undefined),
  },
  {
    ns: NS.APPLE,
    name: "calendar-order",
    allprop: false,
    get: (_ctx, r) => (r.kind === "collection" ? (r.coll.sort_order ?? undefined) : undefined),
  },
];

const byKey = new Map(defs.map((p) => [clark(p.ns, p.name), p]));

/** Live properties a client may set with PROPPATCH or MKCALENDAR, mapped to collection columns. */
export const WRITABLE: Record<string, "displayname" | "description" | "timezone" | "color" | "sort_order"> = {
  [clark(NS.DAV, "displayname")]: "displayname",
  [clark(NS.CALDAV, "calendar-description")]: "description",
  [clark(NS.CALDAV, "calendar-timezone")]: "timezone",
  [clark(NS.APPLE, "calendar-color")]: "color",
  [clark(NS.APPLE, "calendar-order")]: "sort_order",
};

export const isLiveProperty = (key: string) => byKey.has(key);

export type PropResult = { key: string; value: PropValue | XNode } | { key: string; missing: true };

/** Look up one property on a resource. Dead properties come from the collection's store. */
export async function getProp(ctx: DavContext, r: Resource, key: string): Promise<PropResult> {
  const def = byKey.get(key);
  if (def) {
    const value = await def.get(ctx, r);
    return value === undefined ? { key, missing: true } : { key, value };
  }
  if (r.kind === "collection") {
    const dead = deadPropsOf(r.coll)[key];
    if (dead !== undefined) return { key, value: { ns: "", name: "", raw: dead } };
  }
  return { key, missing: true };
}

/** Property names for <allprop/> and <propname/>. */
export function allPropKeys(r: Resource, includeAll = false): string[] {
  const live = defs.filter((p) => includeAll || p.allprop).map((p) => clark(p.ns, p.name));
  const dead = r.kind === "collection" ? Object.keys(deadPropsOf(r.coll)) : [];
  return [...live, ...dead];
}

export { isCollectionLike };
