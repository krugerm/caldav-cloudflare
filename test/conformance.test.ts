// Conformance gaps found by Apple's CalDAVTester (D-023).
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { call, makeEnv, propfindBody, responses, userWithPassword, xml } from "./helpers";

const ics = { "Content-Type": "text/calendar; charset=utf-8" };
const NSDECL = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;

const wrap = (inner: string, tz = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${tz}${inner}END:VCALENDAR\r\n`;
const vevent = (uid: string, lines = "DTSTART:20261020T100000Z\r\nDTEND:20261020T110000Z\r\n") =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261016T000000Z\r\n${lines}END:VEVENT\r\n`;

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:US/Eastern",
  "BEGIN:DAYLIGHT",
  "DTSTART:20000404T020000",
  "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "DTSTART:20001026T020000",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "END:STANDARD",
  "END:VTIMEZONE",
  "",
].join("\r\n");

const put = (env: AppEnv, auth: string, path: string, body: string, headers: Record<string, string> = ics) =>
  call(env, "PUT", path, { auth, headers, body });

const report = (env: AppEnv, auth: string, path: string, body: string, depth = "1") =>
  call(env, "REPORT", path, { auth, headers: { Depth: depth, "Content-Type": "application/xml" }, body });

const query = (filter: string, props = "<D:getetag/>", extra = "") =>
  `<C:calendar-query ${NSDECL}><D:prop>${props}</D:prop><C:filter><C:comp-filter name="VCALENDAR">${filter}</C:comp-filter></C:filter>${extra}</C:calendar-query>`;

async function names(res: Response) {
  expect(res.status).toBe(207);
  return [...responses(await xml(res)).keys()].map((h) => h.split("/").slice(-2).join("/")).sort();
}

async function expectPrecondition(res: Response, status: number, element: string) {
  expect(res.status).toBe(status);
  expect(await res.text()).toContain(element);
}

describe("no-uid-conflict when replacing an object (RFC 4791 §5.3.2.1)", () => {
  it("refuses a PUT that changes an existing object's UID", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    expect((await put(env, auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("one")))).status).toBe(201);
    await expectPrecondition(await put(env, auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("two"))), 403, "no-uid-conflict");
    expect((await put(env, auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("one", "DTSTART:20261021T100000Z\r\n")))).status).toBe(204);
  });

  it("refuses a MOVE onto an object with a different UID", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("one")));
    await put(env, auth, "/dav/calendars/alice/calendar/b.ics", wrap(vevent("two")));
    const res = await call(env, "MOVE", "/dav/calendars/alice/calendar/a.ics", {
      auth,
      headers: { Destination: "https://cal.example.com/dav/calendars/alice/calendar/b.ics", Overwrite: "T" },
    });
    await expectPrecondition(res, 403, "no-uid-conflict");
    expect((await call(env, "GET", "/dav/calendars/alice/calendar/a.ics", { auth })).status).toBe(200);
  });
});

describe("PUT validation errors (RFC 4791 §4.1, §5.3.2.1)", () => {
  it("answers a non-calendar media type with supported-calendar-data", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await put(env, auth, "/dav/calendars/alice/calendar/x.ics", "<x/>", { "Content-Type": "text/xml" });
    await expectPrecondition(res, 403, "supported-calendar-data");
  });

  it("answers non-UTF-8 data with valid-calendar-data", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const latin1 = new Uint8Array([...new TextEncoder().encode(wrap(vevent("l1")).replace("UID:l1", "UID:l1\r\nSUMMARY:caf")), 0xe9]);
    const res = await call(env, "PUT", "/dav/calendars/alice/calendar/x.ics", { auth, headers: ics, body: latin1 });
    await expectPrecondition(res, 403, "valid-calendar-data");
  });

  it("refuses an object with a METHOD property", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = wrap(vevent("m")).replace("VERSION:2.0\r\n", "VERSION:2.0\r\nMETHOD:PUBLISH\r\n");
    await expectPrecondition(await put(env, auth, "/dav/calendars/alice/calendar/m.ics", body), 403, "valid-calendar-object-resource");
  });
});

describe("filter validation (RFC 4791 §9.7)", () => {
  const invalid: [string, string][] = [
    ["time-range on VCALENDAR", `<C:time-range start="20260101T000000Z" end="20260102T000000Z"/>`],
    ["VALARM directly under VCALENDAR", `<C:comp-filter name="VALARM"/>`],
    ["time-range on VTIMEZONE", `<C:comp-filter name="VTIMEZONE"><C:time-range start="20260101T000000Z" end="20260102T000000Z"/></C:comp-filter>`],
    ["VEVENT inside VEVENT", `<C:comp-filter name="VEVENT"><C:comp-filter name="VEVENT"/></C:comp-filter>`],
    [
      "time-range on STANDARD",
      `<C:comp-filter name="VTIMEZONE"><C:comp-filter name="STANDARD"><C:time-range start="20260101T000000Z" end="20260102T000000Z"/></C:comp-filter></C:comp-filter>`,
    ],
    ["a component inside VALARM", `<C:comp-filter name="VEVENT"><C:comp-filter name="VALARM"><C:comp-filter name="VEVENT"/></C:comp-filter></C:comp-filter>`],
    [
      "time-range on SUMMARY",
      `<C:comp-filter name="VEVENT"><C:prop-filter name="SUMMARY"><C:time-range start="20260101T000000Z" end="20260102T000000Z"/></C:prop-filter></C:comp-filter>`,
    ],
  ];
  for (const [label, filter] of invalid) {
    it(`refuses ${label}`, async () => {
      const { env } = makeEnv();
      const { auth } = await userWithPassword(env);
      await expectPrecondition(await report(env, auth, "/dav/calendars/alice/calendar/", query(filter)), 403, "valid-filter");
    });
  }

  it("still accepts time ranges on date properties and VALARMs", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const ok = [
      `<C:comp-filter name="VEVENT"><C:prop-filter name="DTSTAMP"><C:time-range start="20260101T000000Z" end="20270102T000000Z"/></C:prop-filter></C:comp-filter>`,
      `<C:comp-filter name="VEVENT"><C:comp-filter name="VALARM"><C:time-range start="20260101T000000Z" end="20260102T000000Z"/></C:comp-filter></C:comp-filter>`,
      `<C:comp-filter name="VTIMEZONE"/>`,
    ];
    for (const f of ok) expect((await report(env, auth, "/dav/calendars/alice/calendar/", query(f))).status, f).toBe(207);
  });
});

describe("calendar-data attributes (RFC 4791 §9.6)", () => {
  it("refuses an unsupported content-type or version", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    for (const attrs of [`content-type="text/vcalendar" version="2.0"`, `content-type="text/calendar" version="3.0"`]) {
      const res = await report(env, auth, "/dav/calendars/alice/calendar/", query(`<C:comp-filter name="VEVENT"/>`, `<C:calendar-data ${attrs}/>`));
      await expectPrecondition(res, 403, "supported-calendar-data");
    }
    const ok = await report(env, auth, "/dav/calendars/alice/calendar/", query(`<C:comp-filter name="VEVENT"/>`, `<C:calendar-data content-type="text/calendar" version="2.0"/>`));
    expect(ok.status).toBe(207);
  });
});

describe("time zones must be exactly one valid VTIMEZONE (RFC 4791 §5.2.2)", () => {
  const tzCalendar = (extra: string, tz = VTIMEZONE) => wrap(extra, tz);
  const escaped = (s: string) => s.replace(/\r/g, "&#13;");

  it("refuses a calendar-timezone that also holds an event", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = `<D:propertyupdate ${NSDECL}><D:set><D:prop><C:calendar-timezone>${escaped(tzCalendar(vevent("e")))}</C:calendar-timezone></D:prop></D:set></D:propertyupdate>`;
    const res = await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", { auth, body });
    expect(res.status).toBe(207);
    expect(await res.text()).toContain("403");
  });

  it("refuses a query time zone that also holds an event, or has a broken observance", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const filter = `<C:comp-filter name="VEVENT"><C:time-range start="20260101T000000Z" end="20260102T000000Z"/></C:comp-filter>`;
    for (const tz of [tzCalendar(vevent("e")), tzCalendar("", VTIMEZONE.replace("DTSTART:20001026T020000", "DTSTART:20001026T"))]) {
      const res = await report(env, auth, "/dav/calendars/alice/calendar/", query(filter, "<D:getetag/>", `<C:timezone>${escaped(tz)}</C:timezone>`));
      await expectPrecondition(res, 403, "valid-calendar-data");
    }
    const ok = await report(env, auth, "/dav/calendars/alice/calendar/", query(filter, "<D:getetag/>", `<C:timezone>${escaped(tzCalendar(""))}</C:timezone>`));
    expect(ok.status).toBe(207);
  });
});

describe("sync-collection request details (RFC 6578)", () => {
  const sync = (level: string, props = "") =>
    `<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>${level}</D:sync-level><D:prop>${props}</D:prop></D:sync-collection>`;

  it("gives each member a propstat when no properties are requested", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("a")));
    const res = await report(env, auth, "/dav/calendars/alice/calendar/", sync("1"), "0");
    expect(res.status).toBe(207);
    const doc = await xml(res);
    const resp = doc.children.find((c) => c.name === "response")!;
    const propstat = resp.children.find((c) => c.name === "propstat");
    expect(propstat).toBeDefined();
    expect(propstat!.children.find((c) => c.name === "status")!.text).toContain("200");
  });

  it("accepts sync-level 1 and infinite and refuses anything else", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    expect((await report(env, auth, "/dav/calendars/alice/calendar/", sync("infinite"), "0")).status).toBe(207);
    expect((await report(env, auth, "/dav/calendars/alice/calendar/", sync("bogus"), "0")).status).toBe(400);
  });
});

describe("PROPFIND request details (RFC 4918 §9.1)", () => {
  it("refuses Depth: infinity with propfind-finite-depth", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    for (const depth of ["infinity", "Infinity"]) {
      const res = await call(env, "PROPFIND", "/dav/calendars/alice/", { auth, headers: { Depth: depth }, body: propfindBody(["d", "resourcetype"]) });
      await expectPrecondition(res, 403, "propfind-finite-depth");
    }
  });

  it("refuses allprop and propname together", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = `<D:propfind xmlns:D="DAV:"><D:allprop/><D:propname/></D:propfind>`;
    expect((await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "0" }, body })).status).toBe(400);
  });

  it("reports getcontentlength on objects only", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("a")));
    const res = await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "1" }, body: propfindBody(["d", "getcontentlength"]) });
    const all = responses(await xml(res));
    expect(all.get("/dav/calendars/alice/calendar/")!.missing.has("{DAV:}getcontentlength")).toBe(true);
    expect(all.get("/dav/calendars/alice/calendar/a.ics")!.props.has("{DAV:}getcontentlength")).toBe(true);
  });

  it("keeps xml:lang on a dead property", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = `<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:details xml:lang="en">My Name</D:details></D:prop></D:set></D:propertyupdate>`;
    expect((await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", { auth, body })).status).toBe(207);
    const res = await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "0" }, body: propfindBody(["d", "details"]) });
    expect(await res.text()).toMatch(/details[^>]* xml:lang="en"[^>]*>My Name</);
  });
});

describe("REPORTs on the calendar home (RFC 4791 §7.8–7.10)", () => {
  it("runs calendar-multiget, calendar-query and free-busy-query across the user's collections", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("a")));
    await put(env, auth, "/dav/calendars/alice/tasks/t.ics", wrap(`BEGIN:VTODO\r\nUID:t\r\nDTSTAMP:20261016T000000Z\r\nDUE:20261020T120000Z\r\nEND:VTODO\r\n`));
    const multiget = `<C:calendar-multiget ${NSDECL}><D:prop><D:getetag/></D:prop><D:href>/dav/calendars/alice/calendar/a.ics</D:href><D:href>/dav/calendars/alice/tasks/t.ics</D:href></C:calendar-multiget>`;
    expect(await names(await report(env, auth, "/dav/calendars/alice/", multiget))).toEqual(["calendar/a.ics", "tasks/t.ics"]);
    const range = `<C:time-range start="20261020T000000Z" end="20261021T000000Z"/>`;
    const filter = `<C:comp-filter name="VEVENT">${range}</C:comp-filter>`;
    expect(await names(await report(env, auth, "/dav/calendars/alice/", query(filter)))).toEqual(["calendar/a.ics"]);
    expect(await names(await report(env, auth, "/dav/calendars/alice/", query(filter), "0"))).toEqual([]);
    const fb = await report(env, auth, "/dav/calendars/alice/", `<C:free-busy-query ${NSDECL}>${range}</C:free-busy-query>`);
    expect(fb.status).toBe(200);
    expect(await fb.text()).toContain("FREEBUSY;FBTYPE=BUSY:20261020T100000Z/20261020T110000Z");
  });

  it("limits a scoped password to its collections", async () => {
    const { env } = makeEnv();
    const owner = await userWithPassword(env);
    await put(env, owner.auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("a")));
    const scoped = await userWithPassword(env, "alice", JSON.stringify({ collections: ["tasks"] }));
    const filter = `<C:comp-filter name="VEVENT"/>`;
    expect(await names(await report(env, scoped.auth, "/dav/calendars/alice/", query(filter)))).toEqual([]);
  });
});

describe("recurrence details", () => {
  it("evaluates time-range and prop-filters on the same instance", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const master = vevent("d", "DTSTART:20261001T100000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=10\r\nSUMMARY:plain\r\n");
    const changed = vevent("d", "RECURRENCE-ID:20261003T100000Z\r\nDTSTART:20261003T120000Z\r\nDURATION:PT1H\r\nSUMMARY:changed\r\n");
    await put(env, auth, "/dav/calendars/alice/calendar/d.ics", wrap(master + changed));
    const f = (start: string, end: string) =>
      `<C:comp-filter name="VEVENT"><C:time-range start="${start}" end="${end}"/><C:prop-filter name="SUMMARY"><C:text-match>changed</C:text-match></C:prop-filter></C:comp-filter>`;
    expect(await names(await report(env, auth, "/dav/calendars/alice/calendar/", query(f("20261005T000000Z", "20261006T000000Z"))))).toEqual([]);
    expect(await names(await report(env, auth, "/dav/calendars/alice/calendar/", query(f("20261003T000000Z", "20261004T000000Z"))))).toEqual([
      "calendar/d.ics",
    ]);
  });

  it("recurs a task with DUE and no DTSTART from its DUE", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const todo = `BEGIN:VTODO\r\nUID:r\r\nDTSTAMP:20261016T000000Z\r\nDUE;TZID=US/Eastern:20270102T110000\r\nRRULE:FREQ=DAILY;COUNT=5\r\nSUMMARY:r\r\nEND:VTODO\r\n`;
    await put(env, auth, "/dav/calendars/alice/tasks/r.ics", wrap(todo, VTIMEZONE));
    const f = (start: string, end: string) => `<C:comp-filter name="VTODO"><C:time-range start="${start}" end="${end}"/></C:comp-filter>`;
    expect(await names(await report(env, auth, "/dav/calendars/alice/tasks/", query(f("20270105T000000Z", "20270106T000000Z"))))).toEqual(["tasks/r.ics"]);
    expect(await names(await report(env, auth, "/dav/calendars/alice/tasks/", query(f("20270107T000000Z", "20270108T000000Z"))))).toEqual([]);
  });
});

describe("well-known URI (RFC 6764)", () => {
  it("redirects with or without a trailing slash", async () => {
    const { env } = makeEnv();
    for (const path of ["/.well-known/caldav", "/.well-known/caldav/"]) {
      const res = await call(env, "PROPFIND", path, {});
      expect(res.status, path).toBe(301);
      expect(res.headers.get("Location")).toBe("/dav/");
    }
  });
});
