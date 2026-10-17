// Regressions for findings from the code review (see docs/decisions.md D-020).
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { EVERY_MINUTE, pruneChanges, runScheduled } from "../src/cron";
import { MAX_ATTEMPTS } from "../src/events/publish";
import { PreconditionFailed, runBatch } from "../src/store/batch";
import { deleteCollectionStatements, getCollection, updateCollectionStatements } from "../src/store/collections";
import { putObjectStatements } from "../src/store/objects";
import { call, makeEnv, responses, userWithPassword, xml } from "./helpers";

const ics = { "Content-Type": "text/calendar; charset=utf-8" };
const event = (uid: string, lines: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261016T000000Z\r\n${lines}END:VEVENT\r\nEND:VCALENDAR\r\n`;

const query = (start: string, end: string) =>
  `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${start}" end="${end}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;

async function names(env: AppEnv, auth: string, start: string, end: string) {
  const res = await call(env, "REPORT", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "1" }, body: query(start, end) });
  expect(res.status).toBe(207);
  return [...responses(await xml(res)).keys()].map((h) => h.split("/").pop()).sort();
}

describe("third review round", () => {
  it("refuses a UID longer than 1 KB", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await call(env, "PUT", "/dav/calendars/alice/calendar/u.ics", {
      auth,
      headers: ics,
      body: event("x".repeat(1100), "DTSTART:20261020T100000Z\r\n").replace(`UID:${"x".repeat(1100)}`, `UID:${"x".repeat(73)}\r\n ${"x".repeat(1027)}`),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("valid-calendar-object-resource");
  });

  it("keeps sending other events when one can't be sent, and parks it after repeated failures", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    queue.rejects = (ev) => ev.uid === "poison";
    await call(env, "PUT", "/dav/calendars/alice/calendar/p.ics", { auth, headers: ics, body: event("poison", "DTSTART:20261020T100000Z\r\n") });
    queue.failing = true;
    for (const u of ["a", "b"]) await call(env, "PUT", `/dav/calendars/alice/calendar/${u}.ics`, { auth, headers: ics, body: event(u, "DTSTART:20261020T100000Z\r\n") });
    queue.failing = false;
    const now = Date.now() + 60_000;
    await runScheduled(EVERY_MINUTE, env, now);
    expect(queue.sent.map((e) => e.uid).sort()).toEqual(["a", "b"]);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await runScheduled(EVERY_MINUTE, env, now + i * 60_000);
    const row = await env.DB.prepare("SELECT published, publish_attempts FROM changes WHERE uid = 'poison'").first<{ published: number; publish_attempts: number }>();
    expect(row).toEqual({ published: 0, publish_attempts: MAX_ATTEMPTS });
  });

  it("never lowers pruned_revision, so old tokens stay invalid", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    const sync = (token: string) =>
      call(env, "REPORT", "/dav/calendars/alice/calendar/", {
        auth,
        headers: { Depth: "0" },
        body: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`,
      });
    queue.failing = true;
    await call(env, "PUT", "/dav/calendars/alice/calendar/e1.ics", { auth, headers: ics, body: event("e1", "DTSTART:20261020T100000Z\r\n") });
    queue.failing = false;
    for (const u of ["e2", "e3", "e4"]) await call(env, "PUT", `/dav/calendars/alice/calendar/${u}.ics`, { auth, headers: ics, body: event(u, "DTSTART:20261020T100000Z\r\n") });
    const e1 = (await env.DB.prepare("SELECT revision, collection_id FROM changes WHERE uid = 'e1'").first<{ revision: number; collection_id: number }>())!;
    const nowS = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE changes SET at = ? WHERE collection_id = ?").bind(nowS - 200 * 86400, e1.collection_id).run();
    await pruneChanges(env, nowS); // e1 is unpublished, so it survives; e2..e4 go
    await env.DB.prepare("UPDATE changes SET published = 1 WHERE uid = 'e1'").run();
    await pruneChanges(env, nowS);
    const coll = (await env.DB.prepare("SELECT pruned_revision FROM collections WHERE id = ?").bind(e1.collection_id).first<{ pruned_revision: number }>())!;
    expect(coll.pruned_revision).toBeGreaterThan(e1.revision);
    expect((await sync(`urn:caldav-cloudflare:sync:${e1.collection_id}:${e1.revision}`)).status).toBe(403);
  });

  it("refuses property values XML can't carry, so listings keep parsing", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env, "alice", JSON.stringify({ collections: ["tasks"] }));
    const res = await call(env, "PROPPATCH", "/dav/calendars/alice/tasks/", {
      auth,
      body: `<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Tasks&#11;</d:displayname></d:prop></d:set></d:propertyupdate>`,
    });
    expect(await res.text()).toContain("403 Forbidden");
    const listing = await call(env, "PROPFIND", "/dav/calendars/alice/", { auth, headers: { Depth: "1" } });
    expect(await listing.text()).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  });

  it("keeps path-safe characters unencoded in hrefs", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/calendar/abc@host:1+x.ics", { auth, headers: ics, body: event("h", "DTSTART:20261020T100000Z\r\n") });
    await call(env, "PUT", "/dav/calendars/alice/calendar/with%20space.ics", { auth, headers: ics, body: event("s", "DTSTART:20261020T100000Z\r\n") });
    const text = await (await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "1" } })).text();
    expect(text).toContain("<d:href>/dav/calendars/alice/calendar/abc@host:1+x.ics</d:href>");
    expect(text).toContain("<d:href>/dav/calendars/alice/calendar/with%20space.ics</d:href>");
  });

  it("answers an ETag-only sync and a components-only query without reading bodies", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/tasks/t.ics", { auth, headers: ics, body: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VTODO\r\nUID:t\r\nDTSTAMP:20261016T000000Z\r\nEND:VTODO\r\nEND:VCALENDAR\r\n" });
    // corrupt the stored body: a request that reads it would fail or return it
    await env.DB.prepare("UPDATE objects SET body_inline = 'BROKEN' WHERE name = 't.ics'").run();
    const sync = await call(env, "REPORT", "/dav/calendars/alice/tasks/", {
      auth,
      headers: { Depth: "0" },
      body: `<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`,
    });
    expect(await sync.text()).toContain("t.ics");
    const q = await call(env, "REPORT", "/dav/calendars/alice/tasks/", {
      auth,
      headers: { Depth: "1" },
      body: `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter></C:calendar-query>`,
    });
    expect(await q.text()).toContain("t.ics");
  });
});

describe("review findings", () => {
  it("refuses control characters that XML responses can't carry", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await call(env, "PUT", "/dav/calendars/alice/calendar/v.ics", {
      auth,
      headers: ics,
      body: event("v", "DTSTART:20261020T100000Z\r\nSUMMARY:a\x0Bb\r\n"),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("valid-calendar-data");
  });

  it("fails a write that commits after its collection was deleted, and a second delete", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const coll = (await getCollection(env.DB, (await env.DB.prepare("SELECT id FROM users WHERE username = 'alice'").first<{ id: number }>())!.id, "calendar"))!;
    const audit = { actor: "test", at: 1 };
    await runBatch(env.DB, deleteCollectionStatements(env.DB, coll, audit));
    const late = putObjectStatements(
      env.DB,
      coll.id,
      "late.ics",
      { uid: "late", component: "VEVENT", dtstartUtc: 0, dtendUtc: 0, isRecurring: false },
      { inline: "x", r2Key: null, size: 1, etag: '"x"' },
      { exists: false },
      audit,
    );
    await expect(runBatch(env.DB, late)).rejects.toBeInstanceOf(PreconditionFailed);
    await expect(runBatch(env.DB, deleteCollectionStatements(env.DB, coll, audit))).rejects.toBeInstanceOf(PreconditionFailed);
    const types = await env.DB.prepare("SELECT type FROM changes WHERE collection_id = ? ORDER BY revision").bind(coll.id).all();
    expect(types.results.map((r) => r.type)).toEqual(["collection.created", "collection.deleted"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM objects WHERE collection_id = ?").bind(coll.id).first("n")).toBe(0);
    // over HTTP the collection is simply gone
    expect((await call(env, "PUT", "/dav/calendars/alice/calendar/late.ics", { auth, headers: ics, body: event("late", "DTSTART:20261020T100000Z\r\n") })).status).toBe(409);
  });

  it("rejects a PROPPATCH built on a stale copy of the collection", async () => {
    const { env } = makeEnv();
    const { userId } = await userWithPassword(env);
    const stale = (await getCollection(env.DB, userId, "calendar"))!;
    await runBatch(env.DB, updateCollectionStatements(env.DB, stale, { dead_props: { "{x:}a": "<a xmlns='x:'/>" } }, { actor: "t", at: 1 }));
    await expect(
      runBatch(env.DB, updateCollectionStatements(env.DB, stale, { dead_props: { "{x:}b": "<b xmlns='x:'/>" } }, { actor: "t", at: 2 })),
    ).rejects.toBeInstanceOf(PreconditionFailed);
  });

  it("lets a PROPPATCH through when only objects changed since the read", async () => {
    const { env } = makeEnv();
    const { auth, userId } = await userWithPassword(env);
    const read = (await getCollection(env.DB, userId, "calendar"))!;
    await call(env, "PUT", "/dav/calendars/alice/calendar/x.ics", { auth, headers: ics, body: event("x", "DTSTART:20261020T100000Z\r\n") });
    await runBatch(env.DB, updateCollectionStatements(env.DB, read, { displayname: "Renamed" }, { actor: "t", at: 1 }));
    expect((await getCollection(env.DB, userId, "calendar"))!.displayname).toBe("Renamed");
  });

  it("widens the index for a floating RDATE on a UTC master", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/calendar/f.ics", {
      auth,
      headers: ics,
      body: event("f", "DTSTART:20261201T100000Z\r\nRDATE:20261101T020000\r\n"),
    });
    // read in UTC+14 the floating RDATE is 2026-10-31 12:00Z, before both DTSTART and the RDATE read as UTC
    const row = await env.DB.prepare("SELECT dtstart_utc FROM objects WHERE name = 'f.ics'").first<{ dtstart_utc: number }>();
    expect(row!.dtstart_utc).toBeLessThanOrEqual(Date.UTC(2026, 9, 31, 12) / 1000);
  });

  it("matches RDATE periods and RDATEs before DTSTART without failing the query", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/calendar/p.ics", {
      auth,
      headers: ics,
      body: event("p", "DTSTART:20261201T100000Z\r\nDTEND:20261201T110000Z\r\nRDATE;VALUE=PERIOD:20261205T100000Z/20261209T100000Z\r\nRDATE:20261101T100000Z\r\n"),
    });
    await call(env, "PUT", "/dav/calendars/alice/calendar/plain.ics", { auth, headers: ics, body: event("plain", "DTSTART:20261207T100000Z\r\n") });
    // inside the period, after its start: the period's own end applies, not DTEND - DTSTART
    expect(await names(env, auth, "20261207T000000Z", "20261208T000000Z")).toEqual(["p.ics", "plain.ics"]);
    // the RDATE before DTSTART
    expect(await names(env, auth, "20261101T100000Z", "20261101T103000Z")).toEqual(["p.ics"]);
    expect(await names(env, auth, "20261102T000000Z", "20261103T000000Z")).toEqual([]);
  });

  it("returns an R2 body that starts with a byte order mark unchanged", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const text = event("bom", `DTSTART:20261020T100000Z\r\n${`COMMENT:${"x".repeat(70)}\r\n`.repeat(4000)}`);
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
    expect((await call(env, "PUT", "/dav/calendars/alice/calendar/bom.ics", { auth, headers: ics, body: bytes })).status).toBe(201);
    const get = await call(env, "GET", "/dav/calendars/alice/calendar/bom.ics", { auth });
    const back = new Uint8Array(await get.arrayBuffer());
    expect(get.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(back.byteLength).toBe(bytes.byteLength);
    expect(back).toEqual(bytes);
  });

  it("continues revisions when a collection slug is reused", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    for (const u of ["a", "b", "c"]) await call(env, "PUT", `/dav/calendars/alice/calendar/${u}.ics`, { auth, headers: ics, body: event(u, "DTSTART:20261020T100000Z\r\n") });
    await call(env, "DELETE", "/dav/calendars/alice/calendar/", { auth });
    const before = Math.max(...queue.sent.map((e) => e.revision));
    await call(env, "MKCOL", "/dav/calendars/alice/calendar/", {
      auth,
      body: `<mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype></prop></set></mkcol>`,
    });
    await call(env, "PUT", "/dav/calendars/alice/calendar/a.ics", { auth, headers: ics, body: event("a", "DTSTART:20261021T100000Z\r\n") });
    const recreated = queue.sent.filter((e) => e.revision > before);
    expect(recreated.map((e) => e.type)).toEqual(["collection.created", "object.created"]);
  });

  it("refuses an invalid calendar-timezone and ignores a bad stored one in queries", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", {
      auth,
      body: `<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><C:calendar-timezone>not a timezone</C:calendar-timezone></D:prop></D:set></D:propertyupdate>`,
    });
    const text = await res.text();
    expect(text).toContain("403 Forbidden");
    expect(text).toContain("valid-calendar-data");
    await env.DB.prepare("UPDATE collections SET timezone = 'garbage' WHERE slug = 'calendar'").run();
    expect(await names(env, auth, "20261001T000000Z", "20261101T000000Z")).toEqual([]);
  });
});
