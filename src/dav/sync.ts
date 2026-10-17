import type { CollectionRow } from "../store/collections";

// Sync tokens must be URIs (RFC 6578 §3.2). They name a collection and a revision.
const PREFIX = "urn:caldav-cloudflare:sync:";

export const syncToken = (coll: Pick<CollectionRow, "id" | "sync_revision">) => `${PREFIX}${coll.id}:${coll.sync_revision}`;

export function parseSyncToken(token: string): { collectionId: number; revision: number } | null {
  if (!token.startsWith(PREFIX)) return null;
  const m = /^(\d+):(\d+)$/.exec(token.slice(PREFIX.length));
  return m ? { collectionId: Number(m[1]), revision: Number(m[2]) } : null;
}
