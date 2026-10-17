import type { AppEnv } from "../env";
import { publishChanges } from "../events/publish";
import { loggedRevisions } from "../store/batch";
import { HttpError } from "../http/errors";
import { createUser, getUser } from "../store/users";
import { sha256Hex, timingSafeEqualStrings } from "../util/crypto";
import { nowSeconds } from "../util/time";
import { parseScope, type Scope } from "./scope";

/** The authenticated caller of a DAV request. */
export interface Principal {
  userId: number;
  username: string;
  /** App password id; recorded as the actor of every change this caller makes. */
  actor: string;
  scope: Scope;
}

const REALM = 'Basic realm="CalDAV", charset="UTF-8"';
const LAST_USED_RESOLUTION = 3600;

export const unauthorized = () => new HttpError(401, "authentication required", undefined, { "WWW-Authenticate": REALM });

export function parseBasic(header: string | null): { username: string; password: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!m) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(m[1]!), (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  return i < 0 ? null : { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

interface AuthRow {
  id: string;
  scope_json: string | null;
  last_used_at: number | null;
  user_id: number;
  username: string;
}

/**
 * Authenticate a DAV request by username and app password. Returns the
 * principal and, when last_used_at is stale, a promise to pass to waitUntil.
 */
export async function authenticate(env: AppEnv, request: Request): Promise<{ principal: Principal; touch?: Promise<unknown> }> {
  const creds = parseBasic(request.headers.get("Authorization"));
  if (!creds) throw unauthorized();
  const row = await env.DB.prepare(
    `SELECT p.id, p.scope_json, p.last_used_at, u.id AS user_id, u.username
     FROM app_passwords p JOIN users u ON u.id = p.user_id
     WHERE p.token_hash = ? AND p.revoked_at IS NULL`,
  )
    .bind(await sha256Hex(creds.password))
    .first<AuthRow>();
  // Usernames are compared exactly; the token lookup already proved knowledge of the secret.
  if (!row || row.username !== creds.username) throw unauthorized();
  const now = nowSeconds();
  const touch =
    row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION
      ? env.DB.prepare("UPDATE app_passwords SET last_used_at = ? WHERE id = ?").bind(now, row.id).run()
      : undefined;
  return {
    principal: { userId: row.user_id, username: row.username, actor: row.id, scope: parseScope(row.scope_json) },
    touch,
  };
}

/** Admin access: the ADMIN_USERNAME / ADMIN_PASSWORD secrets, checked in constant time. */
export async function authenticateAdmin(env: AppEnv, request: Request): Promise<void> {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) throw new HttpError(503, "admin secrets are not configured");
  const creds = parseBasic(request.headers.get("Authorization"));
  const ok =
    creds !== null &&
    (await timingSafeEqualStrings(creds.username, env.ADMIN_USERNAME)) &&
    (await timingSafeEqualStrings(creds.password, env.ADMIN_PASSWORD));
  if (!ok) throw new HttpError(401, "admin authentication required", undefined, { "WWW-Authenticate": 'Basic realm="CalDAV admin", charset="UTF-8"' });
}

let bootstrapped = false;

/** Create the bootstrap admin user from the secrets on the first request an isolate serves. */
export async function ensureBootstrapAdmin(env: AppEnv): Promise<void> {
  if (bootstrapped || !env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) return;
  if (!(await getUser(env.DB, env.ADMIN_USERNAME))) {
    try {
      const { results } = await createUser(env.DB, env.ADMIN_USERNAME, { isAdmin: true, actor: "admin", at: nowSeconds() });
      await publishChanges(env, loggedRevisions(results));
    } catch (e) {
      // a concurrent first request may have created it
      if (!(await getUser(env.DB, env.ADMIN_USERNAME))) throw e;
    }
  }
  bootstrapped = true;
}

/** Test hook: set whether the bootstrap counts as done in this isolate. */
export function setBootstrappedForTests(done: boolean) {
  bootstrapped = done;
}
