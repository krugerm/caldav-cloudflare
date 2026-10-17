import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { basic, call, makeEnv } from "./helpers";

const ADMIN = basic("admin", "admin-secret-for-tests");
const jsonHeaders = { "Content-Type": "application/json" };

const api = (env: AppEnv, method: string, path: string, body?: unknown, auth = ADMIN) =>
  call(env, method, `/admin/api${path}`, { auth, headers: jsonHeaders, body: body === undefined ? undefined : JSON.stringify(body) });

describe("admin authentication", () => {
  it("requires the admin secrets", async () => {
    const { env } = makeEnv();
    expect((await call(env, "GET", "/admin")).status).toBe(401);
    expect((await call(env, "GET", "/admin", { auth: basic("admin", "wrong") })).status).toBe(401);
    expect((await call(env, "GET", "/admin", { auth: ADMIN })).status).toBe(200);
  });

  it("does not accept an app password", async () => {
    const { env } = makeEnv();
    const created = await (await api(env, "POST", "/users", { username: "alice" })).json<{ username: string }>();
    expect(created.username).toBe("alice");
    const { token } = await (await api(env, "POST", "/users/alice/passwords", { label: "phone" })).json<{ token: string }>();
    expect((await call(env, "GET", "/admin", { auth: basic("alice", token) })).status).toBe(401);
  });

  it("rejects cross-origin form posts", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/admin/users", {
      auth: ADMIN,
      headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=mallory",
    });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'mallory'").first("n")).toBe(0);
  });
});

describe("admin JSON API", () => {
  it("creates a user whose new app password works for CalDAV", async () => {
    const { env, queue } = makeEnv();
    expect((await api(env, "POST", "/users", { username: "alice" })).status).toBe(201);
    expect(queue.sent.map((e) => [e.type, e.collection, e.actor])).toEqual([
      ["collection.created", "calendar", "admin"],
      ["collection.created", "tasks", "admin"],
    ]);
    const issued = await api(env, "POST", "/users/alice/passwords", { label: "iPhone" });
    expect(issued.status).toBe(201);
    const { id, token } = await issued.json<{ id: string; token: string }>();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect((await call(env, "PROPFIND", "/dav/calendars/alice/", { auth: basic("alice", token), headers: { Depth: "0" } })).status).toBe(207);

    const view = await (await api(env, "GET", "/users/alice")).json<{ passwords: { id: string; label: string }[]; collections: { slug: string }[] }>();
    expect(view.passwords).toEqual([expect.objectContaining({ id, label: "iPhone" })]);
    expect(JSON.stringify(view)).not.toContain(token);
    expect(view.collections.map((c) => c.slug)).toEqual(["calendar", "tasks"]);

    expect((await api(env, "DELETE", `/users/alice/passwords/${id}`)).status).toBe(204);
    expect((await call(env, "PROPFIND", "/dav/calendars/alice/", { auth: basic("alice", token), headers: { Depth: "0" } })).status).toBe(401);
  });

  it("issues scoped passwords and validates the scope", async () => {
    const { env } = makeEnv();
    await api(env, "POST", "/users", { username: "alice" });
    const ok = await api(env, "POST", "/users/alice/passwords", { label: "sync bot", scope: { access: "read", collections: ["tasks"] } });
    expect(ok.status).toBe(201);
    const { token } = await ok.json<{ token: string }>();
    expect((await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth: basic("alice", token), headers: { Depth: "0" } })).status).toBe(404);
    expect((await api(env, "POST", "/users/alice/passwords", { label: "x", scope: { access: "admin" } })).status).toBe(400);
    expect((await api(env, "POST", "/users/alice/passwords", { label: "" })).status).toBe(400);
  });

  it("creates and deletes collections with events", async () => {
    const { env, queue } = makeEnv();
    await api(env, "POST", "/users", { username: "alice" });
    queue.sent.length = 0;
    const created = await api(env, "POST", "/users/alice/collections", { slug: "shopping", displayname: "Shopping", components: ["VTODO"] });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ slug: "shopping", displayname: "Shopping", components: ["VTODO"], objects: 0 });
    expect((await api(env, "POST", "/users/alice/collections", { slug: "shopping" })).status).toBe(409);
    expect((await api(env, "POST", "/users/alice/collections", { slug: "x", components: ["VCARD"] })).status).toBe(400);
    expect((await api(env, "DELETE", "/users/alice/collections/shopping")).status).toBe(204);
    expect(queue.sent.map((e) => e.type)).toEqual(["collection.created", "collection.deleted"]);
  });

  it("deletes a user only after their collections are gone", async () => {
    const { env } = makeEnv();
    await api(env, "POST", "/users", { username: "alice" });
    expect((await api(env, "DELETE", "/users/alice")).status).toBe(409);
    await api(env, "DELETE", "/users/alice/collections/calendar");
    await api(env, "DELETE", "/users/alice/collections/tasks");
    expect((await api(env, "DELETE", "/users/alice")).status).toBe(204);
    expect((await api(env, "GET", "/users/alice")).status).toBe(404);
  });

  it("validates usernames and refuses duplicates", async () => {
    const { env } = makeEnv();
    expect((await api(env, "POST", "/users", { username: "../evil" })).status).toBe(400);
    expect((await api(env, "POST", "/users", { username: "alice" })).status).toBe(201);
    expect((await api(env, "POST", "/users", { username: "alice" })).status).toBe(409);
    expect((await api(env, "POST", "/users", "not json")).status).toBe(400);
  });
});

describe("admin page", () => {
  const post = (env: AppEnv, path: string, fields: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
    return call(env, "POST", path, {
      auth: ADMIN,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://cal.example.com" },
      body: body.toString(),
    });
  };

  it("creates a user, issues a password shown once, and lists collections", async () => {
    const { env } = makeEnv();
    const created = await post(env, "/admin/users", { username: "alice" });
    expect(created.status).toBe(303);
    const issued = await post(env, "/admin/users/alice/passwords", { label: "Mac", readonly: "1", collections: ["tasks"] });
    expect(issued.status).toBe(200);
    const html = await issued.text();
    const token = /<div class="token">([^<]+)<\/div>/.exec(html)![1]!;
    expect((await call(env, "PROPFIND", "/dav/calendars/alice/tasks/", { auth: basic("alice", token), headers: { Depth: "0" } })).status).toBe(207);

    const page = await (await call(env, "GET", "/admin", { auth: ADMIN })).text();
    expect(page).toContain("alice");
    expect(page).toContain("read-only, tasks");
    expect(page).not.toContain(token);
    expect(page).toContain("https://cal.example.com/dav/calendars/alice/tasks/");
  });

  it("escapes user-controlled text", async () => {
    const { env } = makeEnv();
    await post(env, "/admin/users", { username: "alice" });
    await post(env, "/admin/users/alice/collections", { slug: "x", displayname: '<script>alert("x")</script>', components: ["VEVENT"] });
    const page = await (await call(env, "GET", "/admin", { auth: ADMIN })).text();
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&lt;script&gt;");
  });

  it("shows errors on the page", async () => {
    const { env } = makeEnv();
    const res = await post(env, "/admin/users", { username: "no spaces" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("usernames are");
  });
});
