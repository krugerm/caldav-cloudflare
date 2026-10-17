import type { AppEnv } from "../env";
import { isoFromSeconds } from "../util/time";
import type { ChangeEvent } from "./event";

interface ChangeRow {
  collection_id: number;
  revision: number;
  type: ChangeEvent["type"];
  object_name: string | null;
  uid: string | null;
  component: string | null;
  etag: string | null;
  actor: string | null;
  at: number;
  username: string;
  slug: string;
}

const SELECT_CHANGES = `
  SELECT ch.collection_id, ch.revision, ch.type, ch.object_name, ch.uid, ch.component, ch.etag,
         ch.actor, ch.at, u.username, co.slug
  FROM changes ch
  JOIN collections co ON co.id = ch.collection_id
  JOIN users u ON u.id = co.user_id`;

export function toEvent(r: ChangeRow): ChangeEvent {
  const ev: ChangeEvent = {
    v: 1,
    id: `${r.collection_id}:${r.revision}`,
    type: r.type,
    user: r.username,
    collection: r.slug,
    revision: r.revision,
    actor: r.actor ?? "",
    at: isoFromSeconds(r.at),
  };
  if (r.object_name !== null) ev.object = r.object_name;
  if (r.uid !== null) ev.uid = r.uid;
  if (r.component !== null) ev.component = r.component;
  if (r.etag !== null) ev.etag = r.etag;
  return ev;
}

/** Queues limits a sendBatch to 100 messages and 256 KB; stay well inside both. */
const BATCH_MESSAGES = 100;
const BATCH_BYTES = 200 * 1024;
/** After this many failed sends a row is parked so it can't hold up the rows behind it. */
export const MAX_ATTEMPTS = 10;

function chunks(rows: ChangeRow[]): ChangeRow[][] {
  const out: ChangeRow[][] = [];
  let current: ChangeRow[] = [];
  let bytes = 0;
  for (const r of rows) {
    const size = JSON.stringify(toEvent(r)).length;
    if (current.length > 0 && (current.length >= BATCH_MESSAGES || bytes + size > BATCH_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(r);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const keyOf = (r: ChangeRow) => [r.collection_id, r.revision] as const;

async function mark(env: AppEnv, rows: ChangeRow[], sql: string) {
  if (rows.length > 0) await env.DB.batch(rows.map((r) => env.DB.prepare(sql).bind(...keyOf(r))));
}

/**
 * Send rows in size-bounded batches and mark the sent ones published. When a
 * batch fails, its rows are sent one at a time, so one unsendable message
 * can't block the others; each row that still fails has its attempts counted.
 */
async function sendAndMark(env: AppEnv, rows: ChangeRow[]): Promise<number> {
  let sent = 0;
  for (const chunk of chunks(rows)) {
    try {
      await env.CHANGES.sendBatch(chunk.map((r) => ({ body: toEvent(r), contentType: "json" as const })));
      await mark(env, chunk, "UPDATE changes SET published = 1 WHERE collection_id = ? AND revision = ?");
      sent += chunk.length;
      continue;
    } catch (e) {
      if (chunk.length === 1) {
        await mark(env, chunk, "UPDATE changes SET publish_attempts = publish_attempts + 1 WHERE collection_id = ? AND revision = ?");
        console.error("event send failed", e);
        continue;
      }
    }
    for (const r of chunk) sent += await sendAndMark(env, [r]);
  }
  return sent;
}

/** Publish the changes a write just committed. Failures are left for the cron. */
export async function publishChanges(env: AppEnv, keys: { collection_id: number; revision: number }[]): Promise<void> {
  if (keys.length === 0) return;
  const where = keys.map(() => "(ch.collection_id = ? AND ch.revision = ?)").join(" OR ");
  const { results } = await env.DB.prepare(`${SELECT_CHANGES} WHERE ${where} ORDER BY ch.collection_id, ch.revision`)
    .bind(...keys.flatMap((k) => [k.collection_id, k.revision]))
    .all<ChangeRow>();
  try {
    await sendAndMark(env, results);
  } catch (e) {
    console.error("event publish failed; the cron will re-send", e);
  }
}

/**
 * Re-send changes still unpublished after `graceSeconds`, fewest attempts and
 * oldest first. The grace period avoids racing a request whose own send is in
 * flight. Rows that have failed MAX_ATTEMPTS times are left for an operator.
 */
export async function republishPending(env: AppEnv, now: number, graceSeconds = 30, limit = 100): Promise<number> {
  let sent = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      `${SELECT_CHANGES} WHERE ch.published = 0 AND ch.publish_attempts < ? AND ch.at <= ?
       ORDER BY ch.publish_attempts, ch.at, ch.collection_id, ch.revision LIMIT ?`,
    )
      .bind(MAX_ATTEMPTS, now - graceSeconds, limit)
      .all<ChangeRow>();
    const n = await sendAndMark(env, results);
    sent += n;
    // stop when the queue is drained, or when a page made no progress (every row failed)
    if (results.length < limit || n === 0) return sent;
  }
}
