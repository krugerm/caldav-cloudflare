import { authenticateAdmin } from "../auth/auth";
import type { AppEnv } from "../env";
import { HttpError } from "../http/errors";
import { handleAdminApi } from "./api";
import { overview, tokenPage } from "./html";
import { AdminError, createCollection, createUserAccount, deleteCollection, deleteUserAccount, issuePassword, listAll, revokePassword } from "./service";

/**
 * Browsers send Basic credentials automatically, so state-changing requests
 * must come from this origin. Non-browser clients (curl, scripts) send
 * neither Origin nor Sec-Fetch-Site and are allowed.
 */
function checkSameOrigin(request: Request, url: URL) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin !== null ? origin !== url.origin : site !== null && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "cross-origin admin requests are not allowed");
  }
}

const redirect = () => new Response(null, { status: 303, headers: { Location: "/admin" } });

async function form(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new AdminError(400, "expected a form submission");
  }
}

async function handleForm(request: Request, env: AppEnv, url: URL, segments: string[]): Promise<Response> {
  const [area, user, sub, id, action] = segments;
  const f = await form(request);
  const text = (k: string) => String(f.get(k) ?? "");
  if (area === "users" && user === undefined) {
    await createUserAccount(env, text("username").trim());
    return redirect();
  }
  if (area !== "users" || user === undefined) throw new AdminError(404, "not found");
  if (sub === "delete" && id === undefined) {
    await deleteUserAccount(env, user);
    return redirect();
  }
  if (sub === "passwords" && id === undefined) {
    const collections = f.getAll("collections").map(String);
    const scope = { access: f.get("readonly") ? "read" : "read-write", collections: collections.length ? collections : null };
    const { token } = await issuePassword(env, user, text("label"), scope);
    return tokenPage(user, text("label"), token, url.origin);
  }
  if (sub === "passwords" && id !== undefined && action === "revoke") {
    await revokePassword(env, user, id);
    return redirect();
  }
  if (sub === "collections" && id === undefined) {
    await createCollection(env, user, { slug: text("slug"), displayname: text("displayname"), components: f.getAll("components").map(String) });
    return redirect();
  }
  if (sub === "collections" && id !== undefined && action === "delete") {
    await deleteCollection(env, user, id);
    return redirect();
  }
  throw new AdminError(404, "not found");
}

export async function handleAdmin(request: Request, env: AppEnv): Promise<Response> {
  await authenticateAdmin(env, request);
  const url = new URL(request.url);
  checkSameOrigin(request, url);
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "bad percent-encoding");
  }
  if (segments[0] === "api") return handleAdminApi(request, env, segments.slice(1));
  try {
    if (segments.length === 0 && request.method === "GET") return overview(await listAll(env), url.origin);
    if (request.method === "POST") return await handleForm(request, env, url, segments);
    throw new AdminError(404, "not found");
  } catch (e) {
    if (e instanceof AdminError) return overview(await listAll(env), url.origin, { message: e.message, status: e.status });
    throw e;
  }
}
