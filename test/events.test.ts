import { describe, expect, it } from "vitest";
import { pruneChanges, runScheduled, EVERY_MINUTE } from "../src/cron";
import { sweepOrphanBodies } from "../src/store/bodies";
import { call, makeEnv, userWithPassword } from "./helpers";

const ics = { "Content-Type": "text/calendar; charset=utf-8" };
const todo = (uid: string, extra = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VTODO\r\nUID:${uid}\r\nDTSTAMP:20261016T000000Z\r\nSUMMARY:${uid}\r\n${extra}END:VTODO\r\nEND:VCALENDAR\r\n`;

const unpublished = async (db: D1Database) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM changes WHERE published = 0").first<{ n: number }>())!.n;

describe("event stream", () => {
  it("publishes one message per write with the design's schema and marks it published", async () => {
    const { env, queue } = makeEnv();
    const { auth, passwordId } = await userWithPassword(env);
    const put = await call(env, "PUT", "/dav/calendars/alice/tasks/t.ics", { auth, headers: ics, body: todo("t") });
    expect(queue.sent).toHaveLength(1);
    const ev = queue.sent[0]!;
    expect(Object.keys(ev).sort()).toEqual(["actor", "at", "collection", "component", "etag", "id", "object", "revision", "type", "uid", "user", "v"]);
    expect(ev).toMatchObject({
      v: 1,
      type: "object.created",
      user: "alice",
      collection: "tasks",
      object: "t.ics",
      uid: "t",
      component: "VTODO",
      etag: put.headers.get("ETag"),
      actor: passwordId,
    });
    expect(ev.id).toBe(`${ev.id.split(":")[0]}:${ev.revision}`);
    expect(ev.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(await unpublished(env.DB)).toBe(0);
  });

  it("gives revisions that increase per collection", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    for (const u of ["a", "b", "c"]) await call(env, "PUT", `/dav/calendars/alice/tasks/${u}.ics`, { auth, headers: ics, body: todo(u) });
    const revs = queue.sent.map((e) => e.revision);
    expect(revs).toEqual([...revs].sort((x, y) => x - y));
    expect(new Set(queue.sent.map((e) => e.id)).size).toBe(3);
  });

  it("recovers from a crash between the D1 commit and queue.send() through the cron", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    queue.failing = true; // the send after commit fails, as if the isolate died
    const res = await call(env, "PUT", "/dav/calendars/alice/tasks/t.ics", { auth, headers: ics, body: todo("t") });
    expect(res.status).toBe(201); // the client's write succeeded and is durable
    expect(queue.sent).toHaveLength(0);
    expect(await unpublished(env.DB)).toBe(1);

    // the cron leaves rows alone during the grace period, so it doesn't race in-flight sends
    queue.failing = false;
    const now = Date.now();
    await runScheduled(EVERY_MINUTE, env, now);
    expect(queue.sent).toHaveLength(0);

    await runScheduled(EVERY_MINUTE, env, now + 60_000);
    expect(queue.sent).toEqual([expect.objectContaining({ type: "object.created", object: "t.ics", uid: "t" })]);
    expect(await unpublished(env.DB)).toBe(0);

    // nothing is sent twice once published
    await runScheduled(EVERY_MINUTE, env, now + 120_000);
    expect(queue.sent).toHaveLength(1);
  });

  it("re-sends pending events in batches, oldest first", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    queue.failing = true;
    for (let i = 0; i < 120; i++) await call(env, "PUT", `/dav/calendars/alice/tasks/${i}.ics`, { auth, headers: ics, body: todo(`u${i}`) });
    queue.failing = false;
    await runScheduled(EVERY_MINUTE, env, Date.now() + 60_000);
    expect(queue.sent).toHaveLength(120);
    expect(queue.sent.map((e) => e.revision)).toEqual([...queue.sent.map((e) => e.revision)].sort((a, b) => a - b));
  });
});

describe("change log retention", () => {
  it("prunes published rows past retention and invalidates older sync tokens", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/tasks/a.ics", { auth, headers: ics, body: todo("a") });
    await call(env, "PUT", "/dav/calendars/alice/tasks/b.ics", { auth, headers: ics, body: todo("b") });
    const old = Math.floor(Date.now() / 1000) - 100 * 86400;
    await env.DB.prepare("UPDATE changes SET at = ? WHERE object_name = 'a.ics'").bind(old).run();
    await pruneChanges(env, Math.floor(Date.now() / 1000));
    const rows = await env.DB.prepare("SELECT object_name FROM changes c JOIN collections co ON co.id = c.collection_id WHERE co.slug = 'tasks' AND object_name IS NOT NULL").all();
    expect(rows.results).toEqual([{ object_name: "b.ics" }]);
    const coll = await env.DB.prepare("SELECT pruned_revision, sync_revision FROM collections WHERE slug = 'tasks'").first<{ pruned_revision: number; sync_revision: number }>();
    expect(coll!.pruned_revision).toBe(coll!.sync_revision - 1);
  });

  it("keeps unpublished rows however old", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    queue.failing = true;
    await call(env, "PUT", "/dav/calendars/alice/tasks/a.ics", { auth, headers: ics, body: todo("a") });
    await env.DB.prepare("UPDATE changes SET at = 0").run();
    await pruneChanges(env, Math.floor(Date.now() / 1000));
    expect(await unpublished(env.DB)).toBe(1);
  });
});

describe("R2 sweep", () => {
  it("deletes unreferenced bodies older than a day and keeps referenced ones", async () => {
    const { env } = makeEnv();
    await env.BODIES.put("bodies/orphan", "x");
    await env.BODIES.put("bodies/kept", "y");
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/tasks/a.ics", { auth, headers: ics, body: todo("a") });
    await env.DB.prepare("UPDATE objects SET body_r2_key = 'bodies/kept' WHERE name = 'a.ics'").run();
    expect(await sweepOrphanBodies(env, Math.floor(Date.now() / 1000))).toBe(0);
    expect(await sweepOrphanBodies(env, Math.floor(Date.now() / 1000) + 2 * 86400)).toBe(1);
    expect(await env.BODIES.head("bodies/orphan")).toBeNull();
    expect(await env.BODIES.head("bodies/kept")).not.toBeNull();
  });
});
