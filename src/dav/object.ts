// GET, HEAD, PUT and DELETE on calendar object resources.
import { canWrite } from "../auth/scope";
import { hasPreconditions, ifNoneMatchHolds, preconditionsOf, writePreconditionsHold } from "../http/conditional";
import { HttpError, pre } from "../http/errors";
import { readBytes } from "../http/body";
import { empty } from "../http/response";
import { InvalidCalendar } from "../ical/calendar";
import { indexObject } from "../ical/index";
import { PreconditionFailed, UniqueViolation } from "../store/batch";
import { storeBody } from "../store/bodies";
import { collectionIsLive, componentsOf, type CollectionRow } from "../store/collections";
import { deleteObjectStatements, getObject, getObjectByUid, putObjectStatements, readBody, type ObjectRow } from "../store/objects";
import { httpDate, nowSeconds } from "../util/time";
import { commit, type DavContext, type Resource } from "./context";
import { href, isValidName, type Address } from "./paths";
import { resolve } from "./resolve";
import { XML_FORBIDDEN, d } from "./xml";

const preconditionFailed = () => new HttpError(412, "precondition failed");
const collectionGone = () => new HttpError(409, "the collection was deleted");
const readOnly = () => new HttpError(403, "this app password is read-only", pre.dav("need-privileges"));

const objectHeaders = (obj: ObjectRow) => ({
  "Content-Type": "text/calendar; charset=utf-8",
  ETag: obj.etag,
  "Last-Modified": httpDate(obj.updated_at),
});

export async function getObjectResource(ctx: DavContext, target: Resource, head: boolean): Promise<Response> {
  if (target.kind !== "object") {
    throw new HttpError(405, "GET is only supported on calendar objects", undefined, { Allow: "OPTIONS, PROPFIND, PROPPATCH, REPORT, DELETE" });
  }
  const headers = objectHeaders(target.obj);
  const inm = ctx.request.headers.get("If-None-Match");
  if (inm !== null && !ifNoneMatchHolds(inm, target.obj.etag)) return empty(304, headers);
  const body = await readBody(ctx.env, target.obj);
  return new Response(head ? null : body, { headers: { ...headers, "Content-Length": String(target.obj.size) } });
}

/** Decode a body as UTF-8 without altering a single byte (BOM included). */
function decodeExact(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new HttpError(403, "calendar data must be UTF-8", pre.caldav("valid-calendar-data"));
  }
}

function checkContentType(request: Request) {
  const ct = request.headers.get("Content-Type");
  if (ct === null) return;
  const type = ct.split(";")[0]!.trim().toLowerCase();
  if (type !== "text/calendar") throw new HttpError(403, "expected text/calendar", pre.caldav("supported-calendar-data"));
}

export async function putObject(ctx: DavContext, address: Address, target: Resource | null): Promise<Response> {
  if (address.kind !== "object") throw new HttpError(405, "PUT is only supported on calendar object URLs", undefined, { Allow: "OPTIONS, PROPFIND, PROPPATCH, REPORT, DELETE" });
  if (!isValidName(address.object)) throw new HttpError(400, "invalid object name");
  let coll: CollectionRow;
  if (target?.kind === "object") coll = target.coll;
  else {
    const parent = await resolve(ctx, { kind: "collection", user: address.user, collection: address.collection });
    if (parent?.kind !== "collection") throw new HttpError(409, "the parent collection does not exist");
    coll = parent.coll;
  }
  if (!canWrite(ctx.principal.scope)) throw readOnly();
  checkContentType(ctx.request);
  const bytes = await readBytes(ctx.request, ctx.cfg.maxObjectBytes, () =>
    new HttpError(413, "calendar object too large", pre.caldav("max-resource-size")),
  );
  const text = decodeExact(bytes);
  // XML 1.0 can't carry these even as character references, so an object holding
  // one would break every REPORT that returns it. Refuse it instead of rewriting it.
  if (XML_FORBIDDEN.test(text)) {
    throw new HttpError(403, "calendar data contains control characters that CalDAV responses cannot carry", pre.caldav("valid-calendar-data"));
  }

  let index;
  try {
    index = indexObject(text);
  } catch (e) {
    if (e instanceof InvalidCalendar) throw new HttpError(403, e.message, pre.caldav(e.precondition));
    throw e;
  }
  if (!componentsOf(coll).includes(index.component as never)) {
    throw new HttpError(403, `this collection does not accept ${index.component}`, pre.caldav("supported-calendar-component"));
  }

  const preconditions = preconditionsOf(ctx.request);
  const body = await storeBody(ctx.env, ctx.cfg, bytes, text);
  const audit = { actor: ctx.principal.actor, at: nowSeconds() };
  let current = target?.kind === "object" ? target.obj : null;
  // Without client preconditions, a concurrent write between our read and the batch is retried once.
  for (let attempt = 0; ; attempt++) {
    if (!writePreconditionsHold(preconditions, current?.etag ?? null)) throw preconditionFailed();
    if (current && current.uid !== index.uid) throw uidChange();
    const owner = await getObjectByUid(ctx.env.DB, coll.id, index.uid);
    if (owner && owner.name !== address.object) throw uidConflict(address.user, coll, owner);
    try {
      await commit(
        ctx,
        putObjectStatements(ctx.env.DB, coll.id, address.object, index, body, current ? { exists: true, etag: current.etag } : { exists: false }, audit),
      );
      break;
    } catch (e) {
      if (e instanceof UniqueViolation && e.constraint.includes("uid")) {
        const other = await getObjectByUid(ctx.env.DB, coll.id, index.uid);
        throw other ? uidConflict(address.user, coll, other) : e;
      }
      if (!(e instanceof PreconditionFailed)) throw e;
      if (!(await collectionIsLive(ctx.env.DB, coll.id))) throw collectionGone();
      if (hasPreconditions(preconditions) || attempt > 0) throw preconditionFailed();
      current = await getObject(ctx.env.DB, coll.id, address.object);
    }
  }
  // The body is stored as sent, so the ETag is valid for the client's own copy (RFC 4791 §5.3.4).
  return empty(current ? 204 : 201, { ETag: body.etag });
}

export function uidConflict(user: string, coll: CollectionRow, owner: ObjectRow) {
  return new HttpError(403, "another object in this collection has the same UID", {
    ...pre.caldav("no-uid-conflict"),
    children: [d("href", href.object(user, coll.slug, owner.name))],
  });
}

/** §5.3.2.1: an object may not be replaced by one with a different UID. */
export const uidChange = () => new HttpError(403, "the replacement has a different UID from the object it replaces", pre.caldav("no-uid-conflict"));

export async function deleteObject(ctx: DavContext, target: Extract<Resource, { kind: "object" }>): Promise<Response> {
  if (!canWrite(ctx.principal.scope)) throw readOnly();
  const preconditions = preconditionsOf(ctx.request);
  if (!writePreconditionsHold(preconditions, target.obj.etag)) throw preconditionFailed();
  let obj = target.obj;
  // Without client preconditions, a concurrent change between our read and the batch is retried once.
  for (let attempt = 0; ; attempt++) {
    try {
      await commit(ctx, deleteObjectStatements(ctx.env.DB, obj, { actor: ctx.principal.actor, at: nowSeconds() }));
      return empty(204);
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e;
      const now = await getObject(ctx.env.DB, target.coll.id, target.obj.name);
      if (!now || !(await collectionIsLive(ctx.env.DB, target.coll.id))) throw new HttpError(404, "not found");
      if (hasPreconditions(preconditions) || attempt > 0) throw preconditionFailed();
      obj = now;
    }
  }
}
