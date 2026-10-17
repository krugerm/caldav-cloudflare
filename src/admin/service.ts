// Admin operations shared by the HTML page and the JSON API.
import { normaliseScope, parseScope, type Scope } from "../auth/scope";
import { isValidName } from "../dav/paths";
import type { AppEnv } from "../env";
import { publishChanges } from "../events/publish";
import { loggedRevisions, PreconditionFailed, runBatch, UniqueViolation } from "../store/batch";
import {
  COMPONENT_TYPES,
  componentsOf,
  createCollectionStatements,
  deleteCollectionStatements,
  getCollection,
  listCollections,
  type ComponentType,
} from "../store/collections";
import { createUser, deleteUser, getUser, issueAppPassword, listAppPasswords, listUsers, revokeAppPassword, USERNAME_RE, type UserRow } from "../store/users";
import { nowSeconds } from "../util/time";

const ACTOR = "admin";

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const notFound = (what: string) => new AdminError(404, `${what} not found`);

async function requireUser(env: AppEnv, username: string): Promise<UserRow> {
  const user = await getUser(env.DB, username);
  if (!user) throw notFound(`user ${username}`);
  return user;
}

async function commitAndPublish(env: AppEnv, statements: D1PreparedStatement[]) {
  const results = await runBatch(env.DB, statements);
  await publishChanges(env, loggedRevisions(results));
}

export interface PasswordView {
  id: string;
  label: string;
  scope: Scope;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CollectionView {
  slug: string;
  displayname: string | null;
  components: ComponentType[];
  color: string | null;
  objects: number;
  bytes: number;
}

export interface UserView {
  username: string;
  is_admin: boolean;
  created_at: number;
  passwords: PasswordView[];
  collections: CollectionView[];
}

export async function describeUser(env: AppEnv, user: UserRow): Promise<UserView> {
  const [passwords, collections, counts] = await Promise.all([
    listAppPasswords(env.DB, user.id),
    listCollections(env.DB, user.id),
    env.DB.prepare(
      `SELECT o.collection_id AS id, COUNT(*) AS n, SUM(o.size) AS bytes FROM objects o JOIN collections c ON c.id = o.collection_id
       WHERE c.user_id = ? AND c.deleted_at IS NULL GROUP BY o.collection_id`,
    )
      .bind(user.id)
      .all<{ id: number; n: number; bytes: number }>(),
  ]);
  const byId = new Map(counts.results.map((r) => [r.id, r]));
  return {
    username: user.username,
    is_admin: user.is_admin === 1,
    created_at: user.created_at,
    passwords: passwords.map((p) => ({
      id: p.id,
      label: p.label,
      scope: parseScope(p.scope_json),
      created_at: p.created_at,
      last_used_at: p.last_used_at,
      revoked_at: p.revoked_at,
    })),
    collections: collections.map((c) => ({
      slug: c.slug,
      displayname: c.displayname,
      components: componentsOf(c),
      color: c.color,
      objects: byId.get(c.id)?.n ?? 0,
      bytes: byId.get(c.id)?.bytes ?? 0,
    })),
  };
}

export async function listAll(env: AppEnv): Promise<UserView[]> {
  return Promise.all((await listUsers(env.DB)).map((u) => describeUser(env, u)));
}

export async function getUserView(env: AppEnv, username: string): Promise<UserView> {
  return describeUser(env, await requireUser(env, username));
}

export async function createUserAccount(env: AppEnv, username: string): Promise<UserView> {
  if (!USERNAME_RE.test(username)) throw new AdminError(400, "usernames are 1-64 characters: letters, digits, and . _ @ - (not first)");
  if (await getUser(env.DB, username)) throw new AdminError(409, `user ${username} already exists`);
  try {
    const { user, results } = await createUser(env.DB, username, { actor: ACTOR, at: nowSeconds() });
    await publishChanges(env, loggedRevisions(results));
    return describeUser(env, user);
  } catch (e) {
    if (e instanceof UniqueViolation) throw new AdminError(409, `user ${username} already exists`);
    throw e;
  }
}

/** Users can be deleted once their collections are gone and every event about them has been sent. */
export async function deleteUserAccount(env: AppEnv, username: string): Promise<void> {
  if (username === env.ADMIN_USERNAME) throw new AdminError(409, "the bootstrap admin user cannot be deleted");
  const user = await requireUser(env, username);
  if ((await listCollections(env.DB, user.id)).length > 0) throw new AdminError(409, "delete the user's collections first");
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM changes ch JOIN collections c ON c.id = ch.collection_id WHERE c.user_id = ? AND ch.published = 0",
  )
    .bind(user.id)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) throw new AdminError(409, "events for this user are still being delivered; try again in a minute");
  await deleteUser(env.DB, user.id);
}

export async function issuePassword(env: AppEnv, username: string, label: string, scope: unknown): Promise<{ id: string; token: string }> {
  const user = await requireUser(env, username);
  const cleanLabel = label.trim();
  if (cleanLabel === "" || cleanLabel.length > 100) throw new AdminError(400, "label must be 1-100 characters");
  let scopeJson: string | null;
  try {
    scopeJson = normaliseScope(scope);
  } catch (e) {
    throw new AdminError(400, (e as Error).message);
  }
  return issueAppPassword(env.DB, user.id, cleanLabel, scopeJson, nowSeconds());
}

export async function revokePassword(env: AppEnv, username: string, id: string): Promise<void> {
  const user = await requireUser(env, username);
  if (!(await revokeAppPassword(env.DB, user.id, id, nowSeconds()))) throw notFound(`active app password ${id}`);
}

export interface NewCollection {
  slug: string;
  displayname?: string;
  components?: string[];
  color?: string;
}

export async function createCollection(env: AppEnv, username: string, input: NewCollection): Promise<CollectionView> {
  const user = await requireUser(env, username);
  const slug = (input.slug ?? "").trim();
  if (!isValidName(slug) || slug.length > 64) throw new AdminError(400, "invalid collection slug");
  const components = [...new Set((input.components ?? ["VEVENT"]).map((c) => c.toUpperCase()))];
  if (components.length === 0 || !components.every((c): c is ComponentType => (COMPONENT_TYPES as readonly string[]).includes(c))) {
    throw new AdminError(400, `components must be a non-empty subset of ${COMPONENT_TYPES.join(", ")}`);
  }
  if (await getCollection(env.DB, user.id, slug)) throw new AdminError(409, `collection ${slug} already exists`);
  try {
    await commitAndPublish(
      env,
      createCollectionStatements(
        env.DB,
        user.id,
        slug,
        components as ComponentType[],
        { displayname: input.displayname?.trim() || null, color: input.color?.trim() || null },
        { actor: ACTOR, at: nowSeconds() },
      ),
    );
  } catch (e) {
    if (e instanceof UniqueViolation) throw new AdminError(409, `collection ${slug} already exists`);
    throw e;
  }
  const view = (await describeUser(env, user)).collections.find((c) => c.slug === slug);
  return view!;
}

export async function deleteCollection(env: AppEnv, username: string, slug: string): Promise<void> {
  const user = await requireUser(env, username);
  const coll = await getCollection(env.DB, user.id, slug);
  if (!coll) throw notFound(`collection ${slug}`);
  try {
    await commitAndPublish(env, deleteCollectionStatements(env.DB, coll, { actor: ACTOR, at: nowSeconds() }));
  } catch (e) {
    // a concurrent delete won
    if (e instanceof PreconditionFailed) throw notFound(`collection ${slug}`);
    throw e;
  }
}
