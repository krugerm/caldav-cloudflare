// MOVE of a calendar object within one user's collections (RFC 4918 §9.9).
import { canWrite } from "../auth/scope";
import { preconditionsOf, writePreconditionsHold } from "../http/conditional";
import { HttpError, pre } from "../http/errors";
import { empty } from "../http/response";
import { PreconditionFailed, UniqueViolation } from "../store/batch";
import { componentsOf } from "../store/collections";
import { getObjectByUid, moveObjectStatements } from "../store/objects";
import { nowSeconds } from "../util/time";
import { commit, type DavContext, type Resource } from "./context";
import { uidChange, uidConflict } from "./object";
import { isValidName, parsePath } from "./paths";
import { resolve } from "./resolve";

export async function move(ctx: DavContext, source: Resource): Promise<Response> {
  if (source.kind !== "object") throw new HttpError(403, "only calendar objects can be moved");
  if (!canWrite(ctx.principal.scope)) throw new HttpError(403, "this app password is read-only", pre.dav("need-privileges"));
  const destHeader = ctx.request.headers.get("Destination");
  if (!destHeader) throw new HttpError(400, "Destination header required");
  let destUrl: URL;
  try {
    destUrl = new URL(destHeader, ctx.url);
  } catch {
    throw new HttpError(400, "invalid Destination");
  }
  if (destUrl.host !== ctx.url.host) throw new HttpError(502, "Destination is on another server");
  const dest = parsePath(destUrl.pathname);
  if (dest?.kind !== "object" || dest.user !== ctx.principal.username || !isValidName(dest.object)) {
    throw new HttpError(403, "Destination must be a calendar object URL in your own collections");
  }
  if (dest.collection === source.coll.slug && dest.object === source.obj.name) throw new HttpError(403, "source and destination are the same");

  const destColl = await resolve(ctx, { kind: "collection", user: dest.user, collection: dest.collection });
  if (destColl?.kind !== "collection") throw new HttpError(409, "the destination collection does not exist");
  if (!componentsOf(destColl.coll).includes(source.obj.component as never)) {
    throw new HttpError(403, `the destination collection does not accept ${source.obj.component}`, pre.caldav("supported-calendar-component"));
  }
  if (!writePreconditionsHold(preconditionsOf(ctx.request), source.obj.etag)) throw new HttpError(412, "precondition failed");

  const existing = await resolve(ctx, dest);
  const replaces = existing?.kind === "object" ? existing.obj : null;
  const overwrite = (ctx.request.headers.get("Overwrite") ?? "T").trim().toUpperCase() !== "F";
  if (replaces && !overwrite) throw new HttpError(412, "destination exists and Overwrite is F");
  if (replaces && replaces.uid !== source.obj.uid) throw uidChange();

  const uidOwner = await getObjectByUid(ctx.env.DB, destColl.coll.id, source.obj.uid);
  if (uidOwner && uidOwner.id !== source.obj.id && uidOwner.id !== replaces?.id) throw uidConflict(dest.user, destColl.coll, uidOwner);

  try {
    await commit(
      ctx,
      moveObjectStatements(ctx.env.DB, source.obj, { collectionId: destColl.coll.id, name: dest.object, replaces }, { actor: ctx.principal.actor, at: nowSeconds() }),
    );
  } catch (e) {
    if (e instanceof PreconditionFailed) throw new HttpError(412, "the source, the destination or a collection changed during the move");
    if (e instanceof UniqueViolation) throw new HttpError(403, "the destination collection has an object with the same UID", pre.caldav("no-uid-conflict"));
    throw e;
  }
  return empty(replaces ? 204 : 201, { ETag: source.obj.etag });
}
