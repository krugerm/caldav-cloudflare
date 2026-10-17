import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, makeEnv, userWithPassword } from "./helpers";

const fixtureBytes = (name: string) => Uint8Array.from(atob(testEnv.FIXTURES[name]!), (c) => c.charCodeAt(0));
const fixtureNames = Object.keys(testEnv.FIXTURES).sort();

const componentOf = (bytes: Uint8Array) => /BEGIN:(VEVENT|VTODO|VJOURNAL)/.exec(new TextDecoder().decode(bytes))![1]!;
const collectionFor = { VEVENT: "calendar", VTODO: "tasks", VJOURNAL: "journal" } as Record<string, string>;

const JOURNAL_MKCOL = `<mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype>
  <C:supported-calendar-component-set><C:comp name="VJOURNAL"/></C:supported-calendar-component-set></prop></set></mkcol>`;

const event = (uid: string, extra = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261016T000000Z\r\nDTSTART:20261020T100000Z\r\nDTEND:20261020T110000Z\r\nSUMMARY:Test ${uid}\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;

const ics = { "Content-Type": "text/calendar; charset=utf-8" };

describe("byte-for-byte round trip", () => {
  it("has fixtures to test", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of fixtureNames) {
    it(`stores and returns ${name} unchanged`, async () => {
      const { env, queue } = makeEnv();
      const { auth, passwordId } = await userWithPassword(env);
      await call(env, "MKCOL", "/dav/calendars/alice/journal/", { auth, body: JOURNAL_MKCOL });
      const bytes = fixtureBytes(name);
      const path = `/dav/calendars/alice/${collectionFor[componentOf(bytes)]}/${name}`;
      const put = await call(env, "PUT", path, { auth, headers: { ...ics, "If-None-Match": "*" }, body: bytes });
      expect(put.status).toBe(201);
      const etag = put.headers.get("ETag");
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

      const get = await call(env, "GET", path, { auth });
      expect(get.status).toBe(200);
      expect(get.headers.get("ETag")).toBe(etag);
      expect(get.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

      const head = await call(env, "HEAD", path, { auth });
      expect(head.status).toBe(200);
      expect(head.headers.get("Content-Length")).toBe(String(bytes.byteLength));
      expect(await head.text()).toBe("");

      expect(queue.sent.at(-1)).toMatchObject({ type: "object.created", object: name, etag, actor: passwordId, component: componentOf(bytes) });
    });
  }

  it("keeps a large body with inline ATTACH in R2 and returns it unchanged", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const b64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(3 * 1024)))).repeat(100);
    const folded = `ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=application/pdf:${b64}`.match(/.{1,74}/g)!.join("\r\n ");
    const body = new TextEncoder().encode(event("big@example.com", `${folded}\r\n`));
    expect(body.byteLength).toBeGreaterThan(256 * 1024);
    expect((await call(env, "PUT", "/dav/calendars/alice/calendar/big.ics", { auth, headers: ics, body })).status).toBe(201);
    const row = await env.DB.prepare("SELECT body_inline, body_r2_key FROM objects WHERE name = 'big.ics'").first<{ body_inline: string | null; body_r2_key: string }>();
    expect(row!.body_inline).toBeNull();
    expect(row!.body_r2_key).toMatch(/^bodies\/[0-9a-f]{64}-[A-Za-z0-9_-]{12}$/);
    const get = await call(env, "GET", "/dav/calendars/alice/calendar/big.ics", { auth });
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body);
  });
});

describe("conditional writes", () => {
  it("creates with If-None-Match: * once, updates only with the current ETag", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    const path = "/dav/calendars/alice/calendar/a.ics";
    const first = await call(env, "PUT", path, { auth, headers: { ...ics, "If-None-Match": "*" }, body: event("a") });
    expect(first.status).toBe(201);
    const etag1 = first.headers.get("ETag")!;
    expect((await call(env, "PUT", path, { auth, headers: { ...ics, "If-None-Match": "*" }, body: event("a") })).status).toBe(412);
    expect((await call(env, "PUT", path, { auth, headers: { ...ics, "If-Match": '"stale"' }, body: event("a", "LOCATION:x\r\n") })).status).toBe(412);
    const second = await call(env, "PUT", path, { auth, headers: { ...ics, "If-Match": etag1 }, body: event("a", "LOCATION:Room 1\r\n") });
    expect(second.status).toBe(204);
    const etag2 = second.headers.get("ETag")!;
    expect(etag2).not.toBe(etag1);
    expect(queue.sent.map((e) => e.type)).toEqual(["object.created", "object.updated"]);
    expect(queue.sent[1]).toMatchObject({ etag: etag2, revision: queue.sent[0]!.revision + 1 });
  });

  it("answers GET with 304 when If-None-Match has the current ETag", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const etag = (await call(env, "PUT", "/dav/calendars/alice/calendar/a.ics", { auth, headers: ics, body: event("a") })).headers.get("ETag")!;
    expect((await call(env, "GET", "/dav/calendars/alice/calendar/a.ics", { auth, headers: { "If-None-Match": etag } })).status).toBe(304);
  });

  it("deletes only with a matching If-Match", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    const path = "/dav/calendars/alice/calendar/a.ics";
    const etag = (await call(env, "PUT", path, { auth, headers: ics, body: event("a") })).headers.get("ETag")!;
    expect((await call(env, "DELETE", path, { auth, headers: { "If-Match": '"nope"' } })).status).toBe(412);
    expect((await call(env, "DELETE", path, { auth, headers: { "If-Match": etag } })).status).toBe(204);
    expect((await call(env, "GET", path, { auth })).status).toBe(404);
    expect((await call(env, "DELETE", path, { auth })).status).toBe(404);
    expect(queue.sent.at(-1)).toMatchObject({ type: "object.deleted", object: "a.ics", uid: "a" });
    expect(queue.sent.at(-1)).not.toHaveProperty("etag");
  });
});

describe("PUT validation", () => {
  const put = async (body: string | Uint8Array, collection = "calendar", headers: Record<string, string> = ics) => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await call(env, "PUT", `/dav/calendars/alice/${collection}/x.ics`, { auth, headers, body });
    return { status: res.status, text: await res.text() };
  };

  it("rejects a component the collection doesn't accept", async () => {
    const r = await put(event("x"), "tasks");
    expect(r.status).toBe(403);
    expect(r.text).toContain("supported-calendar-component");
  });

  it("rejects data that isn't iCalendar", async () => {
    const r = await put("hello");
    expect(r.status).toBe(403);
    expect(r.text).toContain("valid-calendar-data");
  });

  it("rejects mixed components and missing or differing UIDs", async () => {
    const mixed = event("m").replace("END:VCALENDAR", "BEGIN:VTODO\r\nUID:m\r\nDTSTAMP:20261016T000000Z\r\nEND:VTODO\r\nEND:VCALENDAR");
    expect((await put(mixed)).text).toContain("valid-calendar-object-resource");
    expect((await put(event("a").replace("UID:a\r\n", ""))).text).toContain("valid-calendar-object-resource");
    const twoUids = event("a").replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:b\r\nDTSTAMP:20261016T000000Z\r\nDTSTART:20261021T100000Z\r\nRECURRENCE-ID:20261021T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR");
    expect((await put(twoUids)).text).toContain("valid-calendar-object-resource");
  });

  it("rejects bodies that aren't UTF-8 or aren't text/calendar", async () => {
    const latin1 = new TextEncoder().encode(event("x"));
    latin1[latin1.length - 30] = 0xe9;
    // RFC 4791 §5.3.2.1 preconditions: 403 with the precondition element
    expect((await put(latin1)).status).toBe(403);
    expect((await put(event("x"), "calendar", { "Content-Type": "application/json" })).status).toBe(403);
  });

  it("rejects bodies over the size limit", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const big = event("x", `DESCRIPTION:${"x".repeat(70)}\r\n`.repeat(160_000));
    const res = await call(env, "PUT", "/dav/calendars/alice/calendar/x.ics", { auth, headers: ics, body: big });
    expect(res.status).toBe(413);
  });

  it("reports a UID already used by another object in the collection", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/calendar/one.ics", { auth, headers: ics, body: event("same") });
    const res = await call(env, "PUT", "/dav/calendars/alice/calendar/two.ics", { auth, headers: ics, body: event("same") });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("no-uid-conflict");
    expect(text).toContain("/dav/calendars/alice/calendar/one.ics");
  });

  it("allows the same UID in different collections", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "MKCOL", "/dav/calendars/alice/other/", {
      auth,
      body: `<mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype></prop></set></mkcol>`,
    });
    await call(env, "PUT", "/dav/calendars/alice/calendar/one.ics", { auth, headers: ics, body: event("same") });
    expect((await call(env, "PUT", "/dav/calendars/alice/other/one.ics", { auth, headers: ics, body: event("same") })).status).toBe(201);
  });

  it("answers 409 for a missing collection and 403 for a read-only password", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    expect((await call(env, "PUT", "/dav/calendars/alice/nope/x.ics", { auth, headers: ics, body: event("x") })).status).toBe(409);
    const ro = await userWithPassword(env, "alice", JSON.stringify({ access: "read" }));
    expect((await call(env, "PUT", "/dav/calendars/alice/calendar/x.ics", { auth: ro.auth, headers: ics, body: event("x") })).status).toBe(403);
    expect((await call(env, "PUT", "/dav/calendars/bob/calendar/x.ics", { auth, headers: ics, body: event("x") })).status).toBe(409);
  });
});

describe("index", () => {
  const indexed = async (fixture: string, collection: string) => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", `/dav/calendars/alice/${collection}/${fixture}`, { auth, headers: ics, body: fixtureBytes(fixture) });
    return env.DB.prepare("SELECT dtstart_utc, dtend_utc, is_recurring, component, uid FROM objects WHERE name = ?").bind(fixture).first();
  };

  it("spans a DUE-only task from DUE to DUE, widened because DATE values float", async () => {
    const due = Date.UTC(2026, 10, 1) / 1000;
    expect(await indexed("davx5-tasksorg-due-only.ics", "tasks")).toMatchObject({ dtstart_utc: due - 14 * 3600, dtend_utc: null, is_recurring: 1 });
  });

  it("leaves an undated task unbounded on both sides", async () => {
    expect(await indexed("davx5-undated-todo.ics", "tasks")).toMatchObject({ dtstart_utc: null, dtend_utc: null, is_recurring: 0 });
  });

  it("bounds a COUNT rule at its last instance and includes moved overrides", async () => {
    // daily x5 from 2006-01-02 12:00 EST (17:00Z), 1 hour; the 01-06 instance moved to 14:00-15:00 EST (20:00Z end)
    expect(await indexed("rfc4791-recurring-override.ics", "calendar")).toMatchObject({
      dtstart_utc: Date.UTC(2006, 0, 2, 17) / 1000,
      dtend_utc: Date.UTC(2006, 0, 6, 20) / 1000,
      is_recurring: 1,
    });
  });
});
