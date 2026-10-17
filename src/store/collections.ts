import { changeStatements, guard, liveCollectionGuard, type ChangeInput } from "./batch";

export interface CollectionRow {
  id: number;
  user_id: number;
  slug: string;
  displayname: string | null;
  description: string | null;
  color: string | null;
  sort_order: string | null;
  timezone: string | null;
  components: string;
  dead_props: string;
  sync_revision: number;
  pruned_revision: number;
  created_at: number;
  updated_at: number;
}

/** Collection properties a client can set; `null` clears one. */
export interface CollectionProps {
  displayname?: string | null;
  description?: string | null;
  color?: string | null;
  sort_order?: string | null;
  timezone?: string | null;
  dead_props?: Record<string, string>;
}

export const COMPONENT_TYPES = ["VEVENT", "VTODO", "VJOURNAL"] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const componentsOf = (c: CollectionRow) => c.components.split(",") as ComponentType[];
export const deadPropsOf = (c: CollectionRow) => JSON.parse(c.dead_props) as Record<string, string>;

const COLUMNS =
  "id, user_id, slug, displayname, description, color, sort_order, timezone, components, dead_props, sync_revision, pruned_revision, created_at, updated_at";

export async function listCollections(db: D1Database, userId: number): Promise<CollectionRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM collections WHERE user_id = ? AND deleted_at IS NULL ORDER BY slug`)
    .bind(userId)
    .all<CollectionRow>();
  return results;
}

export async function getCollection(db: D1Database, userId: number, slug: string): Promise<CollectionRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM collections WHERE user_id = ? AND slug = ? AND deleted_at IS NULL`)
    .bind(userId, slug)
    .first<CollectionRow>();
}

export async function collectionIsLive(db: D1Database, id: number): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS ok FROM collections WHERE id = ? AND deleted_at IS NULL").bind(id).first()) !== null;
}

type Audit = Pick<ChangeInput, "actor" | "at">;

export function createCollectionStatements(
  db: D1Database,
  userId: number,
  slug: string,
  components: ComponentType[],
  props: CollectionProps,
  audit: Audit,
): D1PreparedStatement[] {
  // A collection re-created under a deleted one's slug continues its revision
  // sequence, so consumers keying events on (slug, object) by revision never
  // see a new event as older than one they already hold.
  const priorRevision = "(SELECT COALESCE(MAX(sync_revision), 0) FROM collections WHERE user_id = ? AND slug = ?)";
  return [
    db
      .prepare(
        `INSERT INTO collections (user_id, slug, displayname, description, color, sort_order, timezone, components, dead_props,
                                  created_at, updated_at, sync_revision, pruned_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${priorRevision}, ${priorRevision})`,
      )
      .bind(
        userId,
        slug,
        props.displayname ?? null,
        props.description ?? null,
        props.color ?? null,
        props.sort_order ?? null,
        props.timezone ?? null,
        components.join(","),
        JSON.stringify(props.dead_props ?? {}),
        audit.at,
        audit.at,
        userId,
        slug,
        userId,
        slug,
      ),
    ...changeStatements(db, { collection: { userId, slug }, type: "collection.created", ...audit }),
  ];
}

export function updateCollectionStatements(
  db: D1Database,
  coll: CollectionRow,
  props: CollectionProps,
  audit: Audit,
): D1PreparedStatement[] {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of ["displayname", "description", "color", "sort_order", "timezone"] as const) {
    if (key in props) {
      sets.push(`${key} = ?`);
      params.push(props[key] ?? null);
    }
  }
  if (props.dead_props) {
    sets.push("dead_props = ?");
    params.push(JSON.stringify(props.dead_props));
  }
  if (sets.length === 0) return [];
  return [
    // live, with the dead properties as read: a concurrent PROPPATCH can't be overwritten
    // by a stale copy, and object writes (which only bump the revision) don't interfere
    guard(db, "EXISTS (SELECT 1 FROM collections WHERE id = ? AND deleted_at IS NULL AND dead_props = ?)", coll.id, coll.dead_props),
    db.prepare(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`).bind(...params, coll.id),
    ...changeStatements(db, { collection: coll.id, type: "collection.updated", ...audit }),
  ];
}

/** Soft-delete the collection (its change log must outlive it for the event) and drop its objects. */
export function deleteCollectionStatements(db: D1Database, coll: CollectionRow, audit: Audit): D1PreparedStatement[] {
  return [
    liveCollectionGuard(db, coll.id),
    ...changeStatements(db, { collection: coll.id, type: "collection.deleted", ...audit }),
    db.prepare("DELETE FROM objects WHERE collection_id = ?").bind(coll.id),
    db.prepare("UPDATE collections SET deleted_at = ? WHERE id = ?").bind(audit.at, coll.id),
  ];
}

/** Bytes used by a user's live objects, optionally only in one collection or in the collections with the given slugs. */
export async function usedBytes(
  db: D1Database,
  userId: number,
  only?: { collectionId: number } | { slugs: string[] },
): Promise<number> {
  let where = "";
  const binds: (number | string)[] = [userId];
  if (only && "collectionId" in only) {
    where = "AND c.id = ?";
    binds.push(only.collectionId);
  } else if (only) {
    if (only.slugs.length === 0) return 0;
    where = `AND c.slug IN (${only.slugs.map(() => "?").join(", ")})`;
    binds.push(...only.slugs);
  }
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(o.size), 0) AS used FROM objects o JOIN collections c ON c.id = o.collection_id
       WHERE c.user_id = ? AND c.deleted_at IS NULL ${where}`,
    )
    .bind(...binds)
    .first<{ used: number }>();
  return row?.used ?? 0;
}
