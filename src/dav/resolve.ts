import { canSeeCollection } from "../auth/scope";
import { HttpError } from "../http/errors";
import { getCollection } from "../store/collections";
import { getObject } from "../store/objects";
import type { DavContext, Resource } from "./context";
import type { Address } from "./paths";

export const notFound = () => new HttpError(404, "not found");

/**
 * Resolve an address to a resource the principal may see, or null if it
 * doesn't exist. Other users' resources and collections outside the app
 * password's scope are reported as missing, so they can't be enumerated.
 */
export async function resolve(ctx: DavContext, a: Address): Promise<Resource | null> {
  switch (a.kind) {
    case "root":
    case "principals":
      return { kind: a.kind };
    case "principal":
    case "home":
      return a.user === ctx.principal.username ? { kind: a.kind, user: a.user } : null;
    case "collection":
    case "object": {
      if (a.user !== ctx.principal.username || !canSeeCollection(ctx.principal.scope, a.collection)) return null;
      const coll = await getCollection(ctx.env.DB, ctx.principal.userId, a.collection);
      if (!coll) return null;
      if (a.kind === "collection") return { kind: "collection", user: a.user, coll };
      const obj = await getObject(ctx.env.DB, coll.id, a.object);
      return obj ? { kind: "object", user: a.user, coll, obj } : null;
    }
  }
}

/** Resolve or throw 404. */
export async function resolveExisting(ctx: DavContext, a: Address): Promise<Resource> {
  const r = await resolve(ctx, a);
  if (!r) throw notFound();
  return r;
}
