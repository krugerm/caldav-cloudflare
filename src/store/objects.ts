import type { AppEnv } from "../env";
import { changeStatements, guard, liveCollectionGuard, type ChangeInput } from "./batch";

/** Object metadata, without the body. */
export interface ObjectRow {
  id: number;
  collection_id: number;
  name: string;
  uid: string;
  etag: string;
  component: string;
  body_r2_key: string | null;
  size: number;
  dtstart_utc: number | null;
  dtend_utc: number | null;
  is_recurring: number;
  created_at: number;
  updated_at: number;
}

export interface ObjectWithBody extends ObjectRow {
  body_inline: string | null;
}

const META = "id, collection_id, name, uid, etag, component, body_r2_key, size, dtstart_utc, dtend_utc, is_recurring, created_at, updated_at";

export async function getObject(db: D1Database, collectionId: number, name: string): Promise<ObjectRow | null> {
  return db.prepare(`SELECT ${META} FROM objects WHERE collection_id = ? AND name = ?`).bind(collectionId, name).first<ObjectRow>();
}

export async function getObjectByUid(db: D1Database, collectionId: number, uid: string): Promise<ObjectRow | null> {
  return db.prepare(`SELECT ${META} FROM objects WHERE collection_id = ? AND uid = ?`).bind(collectionId, uid).first<ObjectRow>();
}

export async function listObjects(db: D1Database, collectionId: number): Promise<ObjectRow[]> {
  return (await db.prepare(`SELECT ${META} FROM objects WHERE collection_id = ? ORDER BY name`).bind(collectionId).all<ObjectRow>()).results;
}

/**
 * Objects by name, with inline bodies only when asked for (an ETag-only sync
 * must not pull every body out of D1). D1 limits bound parameters per
 * statement, so names go in chunks.
 */
export async function getObjectsByName(
  db: D1Database,
  collectionId: number,
  names: string[],
  withBodies: boolean,
): Promise<ObjectWithBody[]> {
  const out: ObjectWithBody[] = [];
  const columns = withBodies ? `${META}, body_inline` : META;
  for (let i = 0; i < names.length; i += 90) {
    const chunk = names.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT ${columns} FROM objects WHERE collection_id = ? AND name IN (${chunk.map(() => "?").join(",")})`)
      .bind(collectionId, ...chunk)
      .all<ObjectWithBody>();
    out.push(...results);
  }
  return out;
}

/**
 * Candidates for a calendar-query, without bodies: objects of the given
 * components whose time-range span overlaps [start, end). NULL bounds are
 * unbounded; a NULL query bound means no time-range filter on that side.
 */
export async function queryCandidates(
  db: D1Database,
  collectionId: number,
  components: string[] | null,
  range: { start: number | null; end: number | null } | null,
): Promise<ObjectRow[]> {
  const where = ["collection_id = ?"];
  const params: unknown[] = [collectionId];
  if (components) {
    where.push(`component IN (${components.map(() => "?").join(",")})`);
    params.push(...components);
  }
  if (range?.end != null) {
    where.push("(dtstart_utc IS NULL OR dtstart_utc <= ?)");
    params.push(range.end);
  }
  if (range?.start != null) {
    where.push("(dtend_utc IS NULL OR dtend_utc >= ?)");
    params.push(range.start);
  }
  const { results } = await db
    .prepare(`SELECT ${META} FROM objects WHERE ${where.join(" AND ")} ORDER BY name`)
    .bind(...params)
    .all<ObjectRow>();
  return results;
}

/** Load a body as stored: inline in D1 or from R2. */
export async function readBody(env: AppEnv, obj: ObjectRow & { body_inline?: string | null }): Promise<string> {
  if (obj.body_inline != null) return obj.body_inline;
  if (obj.body_r2_key) {
    const r = await env.BODIES.get(obj.body_r2_key);
    // not r.text(): it strips a leading byte order mark, and the body must come back exactly
    if (r) return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(await r.arrayBuffer());
  }
  if (obj.body_inline === undefined) {
    const row = await env.DB.prepare("SELECT body_inline FROM objects WHERE id = ?").bind(obj.id).first<{ body_inline: string | null }>();
    if (row?.body_inline != null) return row.body_inline;
  }
  throw new Error(`body missing for object ${obj.id}`);
}

/** Index fields derived from a body by the iCalendar indexer. */
export interface ObjectIndex {
  uid: string;
  component: string;
  dtstartUtc: number | null;
  dtendUtc: number | null;
  isRecurring: boolean;
}

export interface StoredBody {
  inline: string | null;
  r2Key: string | null;
  size: number;
  etag: string;
}

/** What the caller observed before writing; the batch fails if it has changed. */
export type Expected = { exists: false } | { exists: true; etag: string };

function expectGuard(db: D1Database, collectionId: number, name: string, expected: Expected): D1PreparedStatement {
  return expected.exists
    ? guard(db, "EXISTS (SELECT 1 FROM objects WHERE collection_id = ? AND name = ? AND etag = ?)", collectionId, name, expected.etag)
    : guard(db, "NOT EXISTS (SELECT 1 FROM objects WHERE collection_id = ? AND name = ?)", collectionId, name);
}

type Audit = Pick<ChangeInput, "actor" | "at">;

export function putObjectStatements(
  db: D1Database,
  collectionId: number,
  name: string,
  index: ObjectIndex,
  body: StoredBody,
  expected: Expected,
  audit: Audit,
): D1PreparedStatement[] {
  return [
    liveCollectionGuard(db, collectionId),
    expectGuard(db, collectionId, name, expected),
    db
      .prepare(
        `INSERT INTO objects (collection_id, name, uid, etag, component, body_inline, body_r2_key, size,
                              dtstart_utc, dtend_utc, is_recurring, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection_id, name) DO UPDATE SET
           uid = excluded.uid, etag = excluded.etag, component = excluded.component,
           body_inline = excluded.body_inline, body_r2_key = excluded.body_r2_key, size = excluded.size,
           dtstart_utc = excluded.dtstart_utc, dtend_utc = excluded.dtend_utc,
           is_recurring = excluded.is_recurring, updated_at = excluded.updated_at`,
      )
      .bind(
        collectionId,
        name,
        index.uid,
        body.etag,
        index.component,
        body.inline,
        body.r2Key,
        body.size,
        index.dtstartUtc,
        index.dtendUtc,
        index.isRecurring ? 1 : 0,
        audit.at,
        audit.at,
      ),
    ...changeStatements(db, {
      collection: collectionId,
      type: expected.exists ? "object.updated" : "object.created",
      objectName: name,
      uid: index.uid,
      component: index.component,
      etag: body.etag,
      ...audit,
    }),
  ];
}

export function deleteObjectStatements(
  db: D1Database,
  obj: ObjectRow,
  audit: Audit,
): D1PreparedStatement[] {
  return [
    liveCollectionGuard(db, obj.collection_id),
    expectGuard(db, obj.collection_id, obj.name, { exists: true, etag: obj.etag }),
    db.prepare("DELETE FROM objects WHERE id = ?").bind(obj.id),
    ...changeStatements(db, {
      collection: obj.collection_id,
      type: "object.deleted",
      objectName: obj.name,
      uid: obj.uid,
      component: obj.component,
      ...audit,
    }),
  ];
}

/**
 * Move an object to another collection and/or name. The source is logged as
 * deleted and the destination as created (or updated, when it replaces one).
 */
export function moveObjectStatements(
  db: D1Database,
  src: ObjectRow,
  dest: { collectionId: number; name: string; replaces: ObjectRow | null },
  audit: Audit,
): D1PreparedStatement[] {
  const destExpected: Expected = dest.replaces ? { exists: true, etag: dest.replaces.etag } : { exists: false };
  return [
    liveCollectionGuard(db, src.collection_id),
    liveCollectionGuard(db, dest.collectionId),
    expectGuard(db, src.collection_id, src.name, { exists: true, etag: src.etag }),
    expectGuard(db, dest.collectionId, dest.name, destExpected),
    ...(dest.replaces ? [db.prepare("DELETE FROM objects WHERE id = ?").bind(dest.replaces.id)] : []),
    db.prepare("UPDATE objects SET collection_id = ?, name = ?, updated_at = ? WHERE id = ?").bind(dest.collectionId, dest.name, audit.at, src.id),
    ...changeStatements(db, {
      collection: src.collection_id,
      type: "object.deleted",
      objectName: src.name,
      uid: src.uid,
      component: src.component,
      ...audit,
    }),
    ...changeStatements(db, {
      collection: dest.collectionId,
      type: dest.replaces ? "object.updated" : "object.created",
      objectName: dest.name,
      uid: src.uid,
      component: src.component,
      etag: src.etag,
      ...audit,
    }),
  ];
}
