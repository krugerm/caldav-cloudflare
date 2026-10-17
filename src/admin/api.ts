// JSON admin API under /admin/api/.
//   GET    /admin/api/users
//   POST   /admin/api/users                              {"username"}
//   GET    /admin/api/users/:user
//   DELETE /admin/api/users/:user
//   POST   /admin/api/users/:user/passwords              {"label", "scope"?}  -> {"id", "token"}
//   DELETE /admin/api/users/:user/passwords/:id          (revoke)
//   POST   /admin/api/users/:user/collections            {"slug", "displayname"?, "components"?, "color"?}
//   DELETE /admin/api/users/:user/collections/:slug
import type { AppEnv } from "../env";
import {
  AdminError,
  createCollection,
  createUserAccount,
  deleteCollection,
  deleteUserAccount,
  getUserView,
  issuePassword,
  listAll,
  revokePassword,
  type NewCollection,
} from "./service";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2) + "\n", { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

const noContent = async (done: Promise<void>) => {
  await done;
  return new Response(null, { status: 204 });
};

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AdminError(400, "request body must be JSON");
  }
}

export async function handleAdminApi(request: Request, env: AppEnv, segments: string[]): Promise<Response> {
  const m = request.method;
  const [area, user, sub, id, ...rest] = segments;
  try {
    if (area !== "users" || rest.length > 0) throw new AdminError(404, "not found");
    if (user === undefined) {
      if (m === "GET") return json(await listAll(env));
      if (m === "POST") return json(await createUserAccount(env, String((await body<{ username?: unknown }>(request)).username ?? "")), 201);
    } else if (sub === undefined) {
      if (m === "GET") return json(await getUserView(env, user));
      // awaited here so a rejection is caught below
      if (m === "DELETE") return await noContent(deleteUserAccount(env, user));
    } else if (sub === "passwords") {
      if (id === undefined && m === "POST") {
        const b = await body<{ label?: unknown; scope?: unknown }>(request);
        return json(await issuePassword(env, user, String(b.label ?? ""), b.scope ?? null), 201);
      }
      if (id !== undefined && m === "DELETE") return await noContent(revokePassword(env, user, id));
    } else if (sub === "collections") {
      if (id === undefined && m === "POST") return json(await createCollection(env, user, await body<NewCollection>(request)), 201);
      if (id !== undefined && m === "DELETE") return await noContent(deleteCollection(env, user, id));
    }
    throw new AdminError(m === "GET" || m === "POST" || m === "DELETE" ? 404 : 405, "not found");
  } catch (e) {
    if (e instanceof AdminError) return json({ error: e.message }, e.status);
    throw e;
  }
}
