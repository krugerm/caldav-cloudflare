import { describe, expect, it } from "vitest";
import { revokeAppPassword } from "../src/store/users";
import { basic, call, makeEnv, userWithPassword } from "./helpers";

describe("authentication", () => {
  it("challenges requests without credentials", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PROPFIND", "/dav/", { headers: { Depth: "0" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm=/);
  });

  it("accepts a valid app password and rejects a wrong one", async () => {
    const { env } = makeEnv();
    const { auth, token } = await userWithPassword(env);
    expect((await call(env, "PROPFIND", "/dav/", { auth, headers: { Depth: "0" } })).status).toBe(207);
    expect((await call(env, "PROPFIND", "/dav/", { auth: basic("alice", token + "x"), headers: { Depth: "0" } })).status).toBe(401);
    expect((await call(env, "PROPFIND", "/dav/", { auth: basic("bob", token), headers: { Depth: "0" } })).status).toBe(401);
  });

  it("rejects a revoked app password", async () => {
    const { env } = makeEnv();
    const { auth, userId, passwordId } = await userWithPassword(env);
    await revokeAppPassword(env.DB, userId, passwordId, 1);
    expect((await call(env, "PROPFIND", "/dav/", { auth, headers: { Depth: "0" } })).status).toBe(401);
  });

  it("records last use", async () => {
    const { env } = makeEnv();
    const { auth, passwordId } = await userWithPassword(env);
    await call(env, "PROPFIND", "/dav/", { auth, headers: { Depth: "0" } });
    const row = await env.DB.prepare("SELECT last_used_at FROM app_passwords WHERE id = ?").bind(passwordId).first<{ last_used_at: number }>();
    expect(row!.last_used_at).toBeGreaterThan(0);
  });

  it("answers OPTIONS without credentials and advertises calendar-access only", async () => {
    const { env } = makeEnv();
    const res = await call(env, "OPTIONS", "/dav/calendars/alice/");
    expect(res.status).toBe(200);
    expect(res.headers.get("DAV")).toBe("1, 3, calendar-access, extended-mkcol");
    expect(res.headers.get("DAV")).not.toContain("calendar-auto-schedule");
    expect(res.headers.get("Allow")).toContain("REPORT");
  });
});

describe("bootstrap admin", () => {
  it("creates the admin user with default collections on the first request", async () => {
    const { env, queue } = makeEnv({ bootstrap: true });
    await call(env, "GET", "/");
    expect(queue.sent.map((e) => e.type)).toEqual(["collection.created", "collection.created"]);
    const user = await env.DB.prepare("SELECT id, is_admin FROM users WHERE username = 'admin'").first<{ id: number; is_admin: number }>();
    expect(user?.is_admin).toBe(1);
    const colls = await env.DB.prepare("SELECT slug, components FROM collections WHERE user_id = ? ORDER BY slug").bind(user!.id).all();
    expect(colls.results).toEqual([
      { slug: "calendar", components: "VEVENT" },
      { slug: "tasks", components: "VTODO" },
    ]);
  });
});
