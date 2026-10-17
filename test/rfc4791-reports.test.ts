// RFC 4791 §2 requires every report in Section 7: VALARM time ranges (§9.9),
// free-busy-query (§7.10), and expand / limit-recurrence-set in calendar-data (§9.6).
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { call, makeEnv, propfindBody, responses, userWithPassword, xml } from "./helpers";

const ics = { "Content-Type": "text/calendar; charset=utf-8" };
const NSDECL = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;
const CAL = "{urn:ietf:params:xml:ns:caldav}calendar-data";

const wrap = (inner: string, tz = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${tz}${inner}END:VCALENDAR\r\n`;
const vevent = (uid: string, lines: string) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261016T000000Z\r\n${lines}END:VEVENT\r\n`;
const alarm = (lines: string) => `BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\n${lines}END:VALARM\r\n`;

const BERLIN = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "",
].join("\r\n");

async function put(env: AppEnv, auth: string, path: string, body: string) {
  const res = await call(env, "PUT", path, { auth, headers: ics, body });
  expect(res.status, `PUT ${path}`).toBeLessThan(300);
}

const report = (env: AppEnv, auth: string, path: string, body: string, depth = "1") =>
  call(env, "REPORT", path, { auth, headers: { Depth: depth, "Content-Type": "application/xml" }, body });

const query = (filter: string, props = "<D:getetag/>", extra = "") =>
  `<C:calendar-query ${NSDECL}><D:prop>${props}</D:prop><C:filter><C:comp-filter name="VCALENDAR">${filter}</C:comp-filter></C:filter>${extra}</C:calendar-query>`;

async function names(env: AppEnv, auth: string, coll: string, filter: string) {
  const res = await report(env, auth, `/dav/calendars/alice/${coll}/`, query(filter));
  expect(res.status).toBe(207);
  return [...responses(await xml(res)).keys()].map((h) => h.split("/").pop()!).sort();
}

const alarmRange = (start: string, end: string, comp = "VEVENT") =>
  `<C:comp-filter name="${comp}"><C:comp-filter name="VALARM"><C:time-range start="${start}" end="${end}"/></C:comp-filter></C:comp-filter>`;

describe("VALARM time-range (RFC 4791 §9.9)", () => {
  it("matches relative, end-related, absolute and repeating triggers", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const at10 = "DTSTART:20261020T100000Z\r\nDTEND:20261020T110000Z\r\n";
    await put(env, auth, "/dav/calendars/alice/calendar/before.ics", wrap(vevent("before", at10 + alarm("TRIGGER:-PT15M\r\n"))));
    await put(env, auth, "/dav/calendars/alice/calendar/end.ics", wrap(vevent("end", at10 + alarm("TRIGGER;RELATED=END:PT5M\r\n"))));
    await put(
      env,
      auth,
      "/dav/calendars/alice/calendar/absolute.ics",
      wrap(vevent("absolute", at10 + alarm("TRIGGER;VALUE=DATE-TIME:20261019T080000Z\r\n"))),
    );
    await put(
      env,
      auth,
      "/dav/calendars/alice/calendar/repeat.ics",
      wrap(vevent("repeat", at10 + alarm("TRIGGER:-PT1H\r\nREPEAT:3\r\nDURATION:PT10M\r\n"))),
    );
    await put(env, auth, "/dav/calendars/alice/calendar/none.ics", wrap(vevent("none", at10)));

    expect(await names(env, auth, "calendar", alarmRange("20261020T094000Z", "20261020T095000Z"))).toEqual(["before.ics"]);
    // the event itself overlaps this window, but none of its alarms do
    expect(await names(env, auth, "calendar", alarmRange("20261020T100000Z", "20261020T110000Z"))).toEqual([]);
    expect(await names(env, auth, "calendar", alarmRange("20261020T110000Z", "20261020T111000Z"))).toEqual(["end.ics"]);
    expect(await names(env, auth, "calendar", alarmRange("20261019T000000Z", "20261019T235959Z"))).toEqual(["absolute.ics"]);
    // the third repeat fires at 09:30
    expect(await names(env, auth, "calendar", alarmRange("20261020T092500Z", "20261020T093500Z"))).toEqual(["repeat.ics"]);
    expect(await names(env, auth, "calendar", alarmRange("20261020T093500Z", "20261020T094000Z"))).toEqual([]);
  });

  it("finds the alarms of recurrence instances and of overrides", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const daily = vevent("daily", "DTSTART:20261001T100000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY\r\n" + alarm("TRIGGER:-PT15M\r\n"));
    // the 10-05 instance moved to 14:00 and has no alarm
    const moved = vevent("daily", "RECURRENCE-ID:20261005T100000Z\r\nDTSTART:20261005T140000Z\r\nDURATION:PT1H\r\n");
    await put(env, auth, "/dav/calendars/alice/calendar/daily.ics", wrap(daily + moved));
    expect(await names(env, auth, "calendar", alarmRange("20261009T094000Z", "20261009T095000Z"))).toEqual(["daily.ics"]);
    expect(await names(env, auth, "calendar", alarmRange("20261005T094000Z", "20261005T095000Z"))).toEqual([]);
    expect(await names(env, auth, "calendar", alarmRange("20261005T134000Z", "20261005T135000Z"))).toEqual([]);
  });

  it("anchors end-related task alarms on DUE", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const todo = `BEGIN:VTODO\r\nUID:t\r\nDTSTAMP:20261016T000000Z\r\nDUE:20261020T170000Z\r\nSUMMARY:t\r\n${alarm("TRIGGER;RELATED=END:-PT30M\r\n")}END:VTODO\r\n`;
    await put(env, auth, "/dav/calendars/alice/tasks/t.ics", wrap(todo));
    expect(await names(env, auth, "tasks", alarmRange("20261020T162500Z", "20261020T163500Z", "VTODO"))).toEqual(["t.ics"]);
    expect(await names(env, auth, "tasks", alarmRange("20261020T165000Z", "20261020T180000Z", "VTODO"))).toEqual([]);
  });
});

describe("EXDATE and RDATE", () => {
  it("excludes an RDATE that an EXDATE removes", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = vevent("r", "DTSTART:20261001T100000Z\r\nDURATION:PT1H\r\nRDATE:20261015T100000Z\r\nEXDATE:20261015T100000Z\r\n");
    await put(env, auth, "/dav/calendars/alice/calendar/r.ics", wrap(body));
    const range = `<C:comp-filter name="VEVENT"><C:time-range start="20261015T000000Z" end="20261016T000000Z"/></C:comp-filter>`;
    expect(await names(env, auth, "calendar", range)).toEqual([]);
  });
});

describe("free-busy-query (RFC 4791 §7.10)", () => {
  const fb = (start: string, end: string) => `<C:free-busy-query ${NSDECL}><C:time-range start="${start}" end="${end}"/></C:free-busy-query>`;

  async function seed(env: AppEnv, auth: string) {
    const ev = (uid: string, lines: string) => put(env, auth, `/dav/calendars/alice/calendar/${uid}.ics`, wrap(vevent(uid, lines)));
    await ev("busy", "DTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\n");
    await ev("tentative", "DTSTART:20261020T110000Z\r\nDTEND:20261020T120000Z\r\nSTATUS:TENTATIVE\r\n");
    await ev("transparent", "DTSTART:20261020T130000Z\r\nDTEND:20261020T140000Z\r\nTRANSP:TRANSPARENT\r\n");
    await ev("cancelled", "DTSTART:20261020T150000Z\r\nDTEND:20261020T160000Z\r\nSTATUS:CANCELLED\r\n");
    await ev("instant", "DTSTART:20261020T170000Z\r\n");
    // starts before the window, so its period is clipped to the window start
    await ev("early", "DTSTART:20261019T230000Z\r\nDTEND:20261020T010000Z\r\n");
    await ev("weekly", "DTSTART:20261006T080000Z\r\nDURATION:PT30M\r\nRRULE:FREQ=WEEKLY\r\n");
    await ev("outside", "DTSTART:20261025T090000Z\r\nDTEND:20261025T100000Z\r\n");
    await put(
      env,
      auth,
      "/dav/calendars/alice/calendar/berlin.ics",
      wrap(vevent("berlin", "DTSTART;TZID=Europe/Berlin:20261020T200000\r\nDTEND;TZID=Europe/Berlin:20261020T210000\r\n"), BERLIN),
    );
  }

  it("returns one VFREEBUSY with busy and tentative periods in UTC", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await seed(env, auth);
    const res = await report(env, auth, "/dav/calendars/alice/calendar/", fb("20261020T000000Z", "20261021T000000Z"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/calendar/);
    const text = await res.text();
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(text.match(/BEGIN:VFREEBUSY/g)).toHaveLength(1);
    expect(text).toContain("DTSTART:20261020T000000Z\r\n");
    expect(text).toContain("DTEND:20261021T000000Z\r\n");
    const lines = text.split("\r\n").filter((l) => l.startsWith("FREEBUSY"));
    expect(lines.sort()).toEqual(
      [
        "FREEBUSY;FBTYPE=BUSY:20261020T000000Z/20261020T010000Z",
        "FREEBUSY;FBTYPE=BUSY:20261020T080000Z/20261020T083000Z",
        "FREEBUSY;FBTYPE=BUSY:20261020T090000Z/20261020T100000Z",
        "FREEBUSY;FBTYPE=BUSY:20261020T180000Z/20261020T190000Z",
        "FREEBUSY;FBTYPE=BUSY-TENTATIVE:20261020T110000Z/20261020T120000Z",
      ].sort(),
    );
  });

  it("merges overlapping periods of the same type", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", wrap(vevent("a", "DTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\n")));
    await put(env, auth, "/dav/calendars/alice/calendar/b.ics", wrap(vevent("b", "DTSTART:20261020T093000Z\r\nDTEND:20261020T110000Z\r\n")));
    const res = await report(env, auth, "/dav/calendars/alice/calendar/", fb("20261020T000000Z", "20261021T000000Z"));
    const lines = (await res.text()).split("\r\n").filter((l) => l.startsWith("FREEBUSY"));
    expect(lines).toEqual(["FREEBUSY;FBTYPE=BUSY:20261020T090000Z/20261020T110000Z"]);
  });

  it("needs a time range and is advertised in supported-report-set", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await report(env, auth, "/dav/calendars/alice/calendar/", `<C:free-busy-query ${NSDECL}/>`);
    expect(res.status).toBe(400);
    const pf = await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", {
      auth,
      headers: { Depth: "0" },
      body: propfindBody(["d", "supported-report-set"]),
    });
    expect(await pf.text()).toContain("free-busy-query");
  });

  it("works for a read-only password and not on another user's calendar", async () => {
    const { env } = makeEnv();
    const bob = await userWithPassword(env, "bob");
    await put(env, bob.auth, "/dav/calendars/bob/calendar/x.ics", wrap(vevent("x", "DTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\n")));
    const ro = await userWithPassword(env, "alice", JSON.stringify({ access: "read" }));
    const own = await report(env, ro.auth, "/dav/calendars/alice/calendar/", fb("20261020T000000Z", "20261021T000000Z"));
    expect(own.status).toBe(200);
    const other = await report(env, ro.auth, "/dav/calendars/bob/calendar/", fb("20261020T000000Z", "20261021T000000Z"));
    expect(other.status).toBeGreaterThanOrEqual(400);
  });
});

describe("calendar-data expand and limit-recurrence-set (RFC 4791 §9.6)", () => {
  // weekly on Tuesdays at 18:00 Berlin time; the 10-27 instance (after the DST change) moved to 19:00, 10-13 excluded
  const series =
    vevent(
      "series",
      "DTSTART;TZID=Europe/Berlin:20261006T180000\r\nDTEND;TZID=Europe/Berlin:20261006T190000\r\nRRULE:FREQ=WEEKLY\r\nEXDATE;TZID=Europe/Berlin:20261013T180000\r\nSUMMARY:Choir\r\n",
    ) +
    vevent(
      "series",
      "RECURRENCE-ID;TZID=Europe/Berlin:20261027T180000\r\nDTSTART;TZID=Europe/Berlin:20261027T190000\r\nDTEND;TZID=Europe/Berlin:20261027T200000\r\nSUMMARY:Choir (late)\r\n",
    );

  const expandProp = (start: string, end: string) => `<C:calendar-data><C:expand start="${start}" end="${end}"/></C:calendar-data>`;
  const range = (start: string, end: string) => `<C:comp-filter name="VEVENT"><C:time-range start="${start}" end="${end}"/></C:comp-filter>`;

  async function calendarData(res: Response) {
    expect(res.status).toBe(207);
    return [...responses(await xml(res)).values()].map((r) => r.props.get(CAL)!.text);
  }

  it("returns each instance in the range in UTC with a RECURRENCE-ID and no rules", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/series.ics", wrap(series, BERLIN));
    const [text] = await calendarData(
      await report(
        env,
        auth,
        "/dav/calendars/alice/calendar/",
        query(range("20261001T000000Z", "20261101T000000Z"), expandProp("20261001T000000Z", "20261101T000000Z")),
      ),
    );
    expect(text).not.toContain("RRULE");
    expect(text).not.toContain("EXDATE");
    expect(text).not.toContain("VTIMEZONE");
    expect(text).not.toContain("TZID");
    // 10-06, 10-20 and the moved 10-27; 10-13 is excluded
    expect(text!.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(text).toContain("DTEND:20261006T170000Z");
    for (const day of ["20261006T160000Z", "20261020T160000Z"]) {
      expect(text).toContain(`DTSTART:${day}`);
      expect(text).toContain(`RECURRENCE-ID:${day}`);
    }
    // the excluded instance is absent; the moved one appears at its new time, after the change to CET
    expect(text).not.toContain("20261013T160000Z");
    expect(text).toContain("RECURRENCE-ID:20261027T170000Z");
    expect(text).toContain("DTSTART:20261027T180000Z");
    expect(text).toContain("SUMMARY:Choir (late)");
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
  });

  it("expands only the expand range, and works in calendar-multiget", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/series.ics", wrap(series, BERLIN));
    const [text] = await calendarData(
      await report(
        env,
        auth,
        "/dav/calendars/alice/calendar/",
        `<C:calendar-multiget ${NSDECL}><D:prop>${expandProp("20261019T000000Z", "20261021T000000Z")}</D:prop><D:href>/dav/calendars/alice/calendar/series.ics</D:href></C:calendar-multiget>`,
      ),
    );
    expect(text!.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).toContain("DTSTART:20261020T160000Z");
  });

  it("converts a non-recurring object to UTC and leaves the stored body alone", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = wrap(vevent("one", "DTSTART;TZID=Europe/Berlin:20261020T200000\r\nDTEND;TZID=Europe/Berlin:20261020T210000\r\n"), BERLIN);
    await put(env, auth, "/dav/calendars/alice/calendar/one.ics", body);
    const [text] = await calendarData(
      await report(env, auth, "/dav/calendars/alice/calendar/", query(range("20261020T000000Z", "20261021T000000Z"), expandProp("20261020T000000Z", "20261021T000000Z"))),
    );
    expect(text).toContain("DTSTART:20261020T180000Z");
    expect(text).not.toContain("RECURRENCE-ID");
    const get = await call(env, "GET", "/dav/calendars/alice/calendar/one.ics", { auth });
    expect(await get.text()).toBe(body);
  });

  it("limit-recurrence-set keeps the master and drops overrides outside the range", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/series.ics", wrap(series, BERLIN));
    const limit = (start: string, end: string) => `<C:calendar-data><C:limit-recurrence-set start="${start}" end="${end}"/></C:calendar-data>`;
    const [early] = await calendarData(
      await report(env, auth, "/dav/calendars/alice/calendar/", query(range("20261001T000000Z", "20261010T000000Z"), limit("20261001T000000Z", "20261010T000000Z"))),
    );
    expect(early).toContain("RRULE:FREQ=WEEKLY");
    expect(early).toContain("BEGIN:VTIMEZONE");
    expect(early).not.toContain("Choir (late)");
    const [late] = await calendarData(
      await report(env, auth, "/dav/calendars/alice/calendar/", query(range("20261026T000000Z", "20261028T000000Z"), limit("20261026T000000Z", "20261028T000000Z"))),
    );
    expect(late).toContain("Choir (late)");
  });

  it("rejects an expand without both bounds", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await report(
      env,
      auth,
      "/dav/calendars/alice/calendar/",
      query("", `<C:calendar-data><C:expand start="20261001T000000Z"/></C:calendar-data>`),
    );
    expect(res.status).toBe(400);
  });
});
