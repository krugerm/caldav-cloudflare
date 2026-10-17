import { randomToken, sha256Hex } from "../util/crypto";
import { runBatch } from "./batch";
import { createCollectionStatements } from "./collections";

export interface UserRow {
  id: number;
  username: string;
  is_admin: number;
  created_at: number;
}

export interface AppPasswordRow {
  id: string;
  user_id: number;
  label: string;
  scope_json: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** Usernames appear in URLs; keep them to a safe, case-sensitive set. */
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** Collections every new user starts with: one for events, one for tasks. */
const DEFAULT_COLLECTIONS = [
  { slug: "calendar", components: ["VEVENT"] as const, displayname: "Calendar" },
  { slug: "tasks", components: ["VTODO"] as const, displayname: "Tasks" },
];

/** Random positive id below 2^48, exact in a JS number and in SQLite INTEGER. */
function randomId(): number {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return (hi! & 0xffff) * 2 ** 32 + lo! || 1;
}

export async function getUser(db: D1Database, username: string): Promise<UserRow | null> {
  return db.prepare("SELECT id, username, is_admin, created_at FROM users WHERE username = ?").bind(username).first<UserRow>();
}

export async function listUsers(db: D1Database): Promise<UserRow[]> {
  return (await db.prepare("SELECT id, username, is_admin, created_at FROM users ORDER BY username").all<UserRow>()).results;
}

export async function createUser(
  db: D1Database,
  username: string,
  opts: { isAdmin?: boolean; actor: string; at: number },
): Promise<{ user: UserRow; results: D1Result[] }> {
  if (!USERNAME_RE.test(username)) throw new Error("invalid username");
  // The id is chosen here so the user and their default collections go in one batch.
  const user: UserRow = { id: randomId(), username, is_admin: opts.isAdmin ? 1 : 0, created_at: opts.at };
  const results = await runBatch(db, [
    db
      .prepare("INSERT INTO users (id, username, is_admin, created_at) VALUES (?, ?, ?, ?)")
      .bind(user.id, user.username, user.is_admin, user.created_at),
    ...DEFAULT_COLLECTIONS.flatMap((c) =>
      createCollectionStatements(db, user.id, c.slug, [...c.components], { displayname: c.displayname }, opts),
    ),
  ]);
  return { user, results };
}

export async function deleteUser(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}

export async function listAppPasswords(db: D1Database, userId: number): Promise<AppPasswordRow[]> {
  return (
    await db
      .prepare(
        "SELECT id, user_id, label, scope_json, created_at, last_used_at, revoked_at FROM app_passwords WHERE user_id = ? ORDER BY created_at",
      )
      .bind(userId)
      .all<AppPasswordRow>()
  ).results;
}

/** Issue an app password. The token is returned once and only its hash is stored. */
export async function issueAppPassword(
  db: D1Database,
  userId: number,
  label: string,
  scopeJson: string | null,
  at: number,
): Promise<{ id: string; token: string }> {
  const id = `ap_${randomToken(9)}`;
  const token = randomToken(24); // 192 bits
  await db
    .prepare("INSERT INTO app_passwords (id, user_id, label, token_hash, scope_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, label, await sha256Hex(token), scopeJson, at)
    .run();
  return { id, token };
}

export async function revokeAppPassword(db: D1Database, userId: number, id: string, at: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE app_passwords SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(at, id, userId)
    .run();
  return r.meta.changes > 0;
}
