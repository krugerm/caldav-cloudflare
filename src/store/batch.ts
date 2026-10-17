// Atomic writes. Every client write is one db.batch(): D1 runs a batch as a
// single transaction and rolls it back if any statement fails.

export class PreconditionFailed extends Error {}
export class UniqueViolation extends Error {
  constructor(readonly constraint: string) {
    super(`unique constraint failed: ${constraint}`);
  }
}

/**
 * A statement that aborts the batch unless `condition` (an SQL boolean
 * expression) holds. See the write_guard table in the initial migration.
 */
export function guard(db: D1Database, condition: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO write_guard SELECT 1 WHERE NOT (${condition})`).bind(...params);
}

export async function runBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("precondition_failed")) throw new PreconditionFailed();
    const unique = /UNIQUE constraint failed: ([\w.,\s]+)/.exec(msg);
    if (unique) throw new UniqueViolation(unique[1]!.trim());
    throw e;
  }
}

/** A collection by id, or by owner and slug when its id isn't known yet (same batch as its INSERT). */
export type CollectionRef = number | { userId: number; slug: string };

function refWhere(ref: CollectionRef): [string, unknown[]] {
  return typeof ref === "number"
    ? ["id = ? AND deleted_at IS NULL", [ref]]
    : ["user_id = ? AND slug = ? AND deleted_at IS NULL", [ref.userId, ref.slug]];
}

/**
 * Abort the batch if the collection was deleted after the handler read it,
 * so a write racing a collection DELETE can't land in a dead collection.
 */
export const liveCollectionGuard = (db: D1Database, collectionId: number) =>
  guard(db, "EXISTS (SELECT 1 FROM collections WHERE id = ? AND deleted_at IS NULL)", collectionId);

export interface ChangeInput {
  collection: CollectionRef;
  type: string;
  objectName?: string | null;
  uid?: string | null;
  component?: string | null;
  etag?: string | null;
  actor: string;
  at: number;
}

/**
 * Bump the collection's sync revision and log the change under the new
 * revision. Append to a write batch; the INSERT returns the revision.
 */
export function changeStatements(db: D1Database, ch: ChangeInput): D1PreparedStatement[] {
  const [where, params] = refWhere(ch.collection);
  return [
    db
      .prepare(`UPDATE collections SET sync_revision = sync_revision + 1, updated_at = ? WHERE ${where}`)
      .bind(ch.at, ...params),
    db
      .prepare(
        `INSERT INTO changes (collection_id, revision, type, object_name, uid, component, etag, actor, at)
         SELECT id, sync_revision, ?, ?, ?, ?, ?, ?, ? FROM collections WHERE ${where}
         RETURNING collection_id, revision`,
      )
      .bind(ch.type, ch.objectName ?? null, ch.uid ?? null, ch.component ?? null, ch.etag ?? null, ch.actor, ch.at, ...params),
  ];
}

/** Revisions returned by the change INSERTs of a batch, in order. */
export function loggedRevisions(results: D1Result[]): { collection_id: number; revision: number }[] {
  return results.flatMap((r) =>
    (r.results as { collection_id?: number; revision?: number }[]).filter(
      (row): row is { collection_id: number; revision: number } =>
        typeof row?.collection_id === "number" && typeof row?.revision === "number",
    ),
  );
}
