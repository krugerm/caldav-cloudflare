import type { Principal } from "../auth/auth";
import type { AppEnv, Config } from "../env";
import { publishChanges } from "../events/publish";
import { loggedRevisions, runBatch } from "../store/batch";
import type { CollectionRow } from "../store/collections";
import type { ObjectRow } from "../store/objects";

/** Everything a DAV method handler needs. */
export interface DavContext {
  env: AppEnv;
  cfg: Config;
  request: Request;
  url: URL;
  principal: Principal;
  waitUntil(p: Promise<unknown>): void;
}

/** A resource the request addresses, after authorisation. */
export type Resource =
  | { kind: "root" }
  | { kind: "principals" }
  | { kind: "principal"; user: string }
  | { kind: "home"; user: string }
  | { kind: "collection"; user: string; coll: CollectionRow }
  | { kind: "object"; user: string; coll: CollectionRow; obj: ObjectRow };

/**
 * Run a write batch, then publish the changes it logged. Publishing runs
 * after the response via waitUntil; a failure leaves the rows unpublished
 * for the every-minute cron.
 */
export async function commit(ctx: DavContext, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  const results = await runBatch(ctx.env.DB, statements);
  const keys = loggedRevisions(results);
  if (keys.length > 0) ctx.waitUntil(publishChanges(ctx.env, keys));
  return results;
}
