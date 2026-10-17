import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { call, makeEnv, responses, userWithPassword, xml } from "./helpers";

const ics = { "Content-Type": "text/calendar; charset=utf-8" };
const fixture = (name: string) => new TextDecoder().decode(Uint8Array.from(atob(testEnv.FIXTURES[name]!), (c) => c.charCodeAt(0)));

const event = (uid: string, start = "20261020T100000Z", end = "20261020T110000Z", extra = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261016T000000Z\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:Event ${uid}\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;

const NSDECL = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;
const CAL = "{urn:ietf:params:xml:ns:caldav}calendar-data";

async function put(env: AppEnv, auth: string, path: string, body: string) {
  const res = await call(env, "PUT", path, { auth, headers: ics, body });
  expect(res.status, `PUT ${path}`).toBeLessThan(300);
  return res.headers.get("ETag")!;
}

async function report(env: AppEnv, auth: string, path: string, body: string, depth = "1") {
  return call(env, "REPORT", path, { auth, headers: { Depth: depth, "Content-Type": "application/xml" }, body });
}

describe("calendar-multiget", () => {
  it("returns ETags and calendar data for the requested hrefs, and 404 for missing ones", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const etag = await put(env, auth, "/dav/calendars/alice/calendar/a.ics", event("a"));
    await put(env, auth, "/dav/calendars/alice/calendar/b.ics", event("b"));
    const res = await report(
      env,
      auth,
      "/dav/calendars/alice/calendar/",
      `<C:calendar-multiget ${NSDECL}><D:prop><D:getetag/><C:calendar-data/></D:prop>
        <D:href>/dav/calendars/alice/calendar/a.ics</D:href>
        <D:href>https://cal.example.com/dav/calendars/alice/calendar/b.ics</D:href>
        <D:href>/dav/calendars/alice/calendar/missing.ics</D:href>
      </C:calendar-multiget>`,
    );
    expect(res.status).toBe(207);
    const all = responses(await xml(res));
    expect(all.get("/dav/calendars/alice/calendar/a.ics")!.props.get("{DAV:}getetag")!.text).toBe(etag);
    // CRLF survives the XML round trip because CR is sent as a character reference
    expect(all.get("/dav/calendars/alice/calendar/a.ics")!.props.get(CAL)!.text).toBe(event("a"));
    expect(all.get("/dav/calendars/alice/calendar/b.ics")!.props.get(CAL)!.text).toBe(event("b"));
    expect(all.get("/dav/calendars/alice/calendar/missing.ics")!.status).toContain("404");
  });

  it("does not return another user's objects", async () => {
    const { env } = makeEnv();
    const bob = await userWithPassword(env, "bob");
    await put(env, bob.auth, "/dav/calendars/bob/calendar/secret.ics", event("secret"));
    const { auth } = await userWithPassword(env, "alice");
    const res = await report(
      env,
      auth,
      "/dav/calendars/alice/calendar/",
      `<C:calendar-multiget ${NSDECL}><D:prop><C:calendar-data/></D:prop><D:href>/dav/calendars/bob/calendar/secret.ics</D:href></C:calendar-multiget>`,
    );
    const text = await res.text();
    expect(text).not.toContain("BEGIN:VCALENDAR");
    expect(text).toContain("404");
  });
});

describe("sync-collection", () => {
  const sync = (token: string, props = "<D:getetag/>", limit = "") =>
    `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level>${limit}<D:prop>${props}</D:prop></D:sync-collection>`;

  const run = async (env: AppEnv, auth: string, token: string, limit = "") => {
    const res = await report(env, auth, "/dav/calendars/alice/calendar/", sync(token, "<D:getetag/>", limit), "0");
    expect(res.status).toBe(207);
    const doc = await xml(res);
    return { all: responses(doc), token: doc.children.find((c) => c.name === "sync-token")!.text };
  };

  it("reports everything first, then only changes and deletions", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", event("a"));
    await put(env, auth, "/dav/calendars/alice/calendar/b.ics", event("b"));
    const first = await run(env, auth, "");
    expect([...first.all.keys()].sort()).toEqual(["/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/calendar/b.ics"]);

    const unchanged = await run(env, auth, first.token);
    expect(unchanged.all.size).toBe(0);
    expect(unchanged.token).toBe(first.token);

    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", event("a", undefined, undefined, "LOCATION:x\r\n"));
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", event("a", undefined, undefined, "LOCATION:y\r\n"));
    await put(env, auth, "/dav/calendars/alice/calendar/c.ics", event("c"));
    await call(env, "DELETE", "/dav/calendars/alice/calendar/b.ics", { auth });
    const second = await run(env, auth, first.token);
    expect([...second.all.keys()].sort()).toEqual([
      "/dav/calendars/alice/calendar/a.ics",
      "/dav/calendars/alice/calendar/b.ics",
      "/dav/calendars/alice/calendar/c.ics",
    ]);
    expect(second.all.get("/dav/calendars/alice/calendar/b.ics")!.status).toContain("404");
    expect(second.all.get("/dav/calendars/alice/calendar/a.ics")!.props.has("{DAV:}getetag")).toBe(true);
  });

  it("matches getctag and changes it on every write", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const ctag = async () =>
      responses(
        await xml(
          await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", {
            auth,
            headers: { Depth: "0" },
            body: `<propfind xmlns="DAV:"><prop><getctag xmlns="http://calendarserver.org/ns/"/></prop></propfind>`,
          }),
        ),
      )
        .get("/dav/calendars/alice/calendar/")!
        .props.get("{http://calendarserver.org/ns/}getctag")!.text;
    const c1 = await ctag();
    expect((await run(env, auth, "")).token).toBe(c1);
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", event("a"));
    expect(await ctag()).not.toBe(c1);
  });

  it("truncates to the requested limit and continues from the returned token", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const start = await run(env, auth, "");
    for (const u of ["a", "b", "c"]) await put(env, auth, `/dav/calendars/alice/calendar/${u}.ics`, event(u));
    const page = await run(env, auth, start.token, "<D:limit><D:nresults>2</D:nresults></D:limit>");
    expect(page.all.get("/dav/calendars/alice/calendar/")!.status).toContain("507");
    expect(page.all.size).toBe(3);
    const rest = await run(env, auth, page.token);
    expect([...rest.all.keys()]).toEqual(["/dav/calendars/alice/calendar/c.ics"]);
  });

  it("rejects tokens from another collection, from the future and from before pruning", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const tasksToken = responses(
      await xml(
        await call(env, "PROPFIND", "/dav/calendars/alice/tasks/", {
          auth,
          headers: { Depth: "0" },
          body: `<propfind xmlns="DAV:"><prop><sync-token/></prop></propfind>`,
        }),
      ),
    ).get("/dav/calendars/alice/tasks/")!.props.get("{DAV:}sync-token")!.text;
    const bad = async (token: string) => (await report(env, auth, "/dav/calendars/alice/calendar/", sync(token), "0")).status;
    expect(await bad(tasksToken)).toBe(403);
    expect(await bad("urn:caldav-cloudflare:sync:1:999999")).toBe(403);
    expect(await bad("garbage")).toBe(403);
    const { token } = await run(env, auth, "");
    await put(env, auth, "/dav/calendars/alice/calendar/a.ics", event("a"));
    await env.DB.prepare("UPDATE collections SET pruned_revision = sync_revision WHERE slug = 'calendar'").run();
    const res = await report(env, auth, "/dav/calendars/alice/calendar/", sync(token), "0");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("valid-sync-token");
  });
});

describe("calendar-query", () => {
  const q = (filter: string, props = "<D:getetag/>") =>
    `<C:calendar-query ${NSDECL}><D:prop>${props}</D:prop><C:filter><C:comp-filter name="VCALENDAR">${filter}</C:comp-filter></C:filter></C:calendar-query>`;

  const names = async (env: AppEnv, auth: string, coll: string, filter: string) => {
    const res = await report(env, auth, `/dav/calendars/alice/${coll}/`, q(filter));
    expect(res.status).toBe(207);
    return [...responses(await xml(res)).keys()].map((h) => h.split("/").pop()!).sort();
  };

  const range = (start: string, end: string, comp = "VEVENT") =>
    `<C:comp-filter name="${comp}"><C:time-range start="${start}" end="${end}"/></C:comp-filter>`;

  it("filters events by time range, including recurring ones and moved overrides", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/calendar/oct.ics", event("oct"));
    await put(env, auth, "/dav/calendars/alice/calendar/dec.ics", event("dec", "20261210T100000Z", "20261210T110000Z"));
    await put(env, auth, "/dav/calendars/alice/calendar/override.ics", fixture("rfc4791-recurring-override.ics"));
    await put(
      env,
      auth,
      "/dav/calendars/alice/calendar/weekly.ics",
      event("weekly", "20240101T090000Z", "20240101T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO\r\nEXDATE:20261019T090000Z\r\n"),
    );
    expect(await names(env, auth, "calendar", range("20261001T000000Z", "20261101T000000Z"))).toEqual(["oct.ics", "weekly.ics"]);
    expect(await names(env, auth, "calendar", range("20261201T000000Z", "20261231T000000Z"))).toEqual(["dec.ics", "weekly.ics"]);
    // only the excluded Monday falls in this window
    expect(await names(env, auth, "calendar", range("20261019T000000Z", "20261020T000000Z"))).toEqual([]);
    // RFC 4791 Appendix B: the 01-04 instance moved from 17:00Z to 19:00Z
    expect(await names(env, auth, "calendar", range("20060104T170000Z", "20060104T180000Z"))).toEqual([]);
    expect(await names(env, auth, "calendar", range("20060104T190000Z", "20060104T193000Z"))).toEqual(["override.ics"]);
    expect(await names(env, auth, "calendar", range("20060103T170000Z", "20060103T173000Z"))).toEqual(["override.ics"]);
    expect(await names(env, auth, "calendar", range("20060107T000000Z", "20060201T000000Z"))).toEqual([]);
  });

  it("matches tasks by the RFC 4791 §9.9 rules: due-only, completed, undated", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/tasks/due.ics", fixture("rfc4791-todo-due.ics"));
    await put(env, auth, "/dav/calendars/alice/tasks/done.ics", fixture("rfc4791-todo-completed.ics"));
    await put(env, auth, "/dav/calendars/alice/tasks/undated.ics", fixture("davx5-undated-todo.ics"));
    await put(env, auth, "/dav/calendars/alice/tasks/apple.ics", fixture("apple-reminder-subtask.ics"));
    // DUE;VALUE=DATE:20060104 (floating, read as UTC): start < DUE AND end >= DUE
    expect(await names(env, auth, "tasks", range("20060103T000000Z", "20060105T000000Z", "VTODO"))).toEqual(["due.ics", "undated.ics"]);
    // done.ics has DUE (2006-01-06) as well as COMPLETED, so the DUE row of the table applies
    expect(await names(env, auth, "tasks", range("20051223T000000Z", "20051224T000000Z", "VTODO"))).toEqual(["undated.ics"]);
    expect(await names(env, auth, "tasks", range("20060105T000000Z", "20060107T000000Z", "VTODO"))).toEqual(["done.ics", "undated.ics"]);
    // COMPLETED only: start <= COMPLETED AND end >= COMPLETED
    await put(
      env,
      auth,
      "/dav/calendars/alice/tasks/completed-only.ics",
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VTODO\r\nUID:co\r\nDTSTAMP:20261016T000000Z\r\nCOMPLETED:20261001T120000Z\r\nEND:VTODO\r\nEND:VCALENDAR\r\n",
    );
    expect(await names(env, auth, "tasks", range("20261001T000000Z", "20261001T120000Z", "VTODO"))).toEqual(["completed-only.ics", "undated.ics"]);
    expect(await names(env, auth, "tasks", range("20261001T120001Z", "20261002T000000Z", "VTODO"))).toEqual(["undated.ics"]);
    // DTSTART and DUE both 2026-10-18 18:00 Nicosia (15:00Z)
    expect(await names(env, auth, "tasks", range("20261018T140000Z", "20261018T160000Z", "VTODO"))).toEqual(["apple.ics", "undated.ics"]);
    expect(await names(env, auth, "tasks", range("20300101T000000Z", "20300102T000000Z", "VTODO"))).toEqual(["undated.ics"]);
  });

  it("filters by component, property text and is-not-defined", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await put(env, auth, "/dav/calendars/alice/tasks/open.ics", fixture("davx5-undated-todo.ics"));
    await put(env, auth, "/dav/calendars/alice/tasks/done.ics", fixture("rfc4791-todo-completed.ics"));
    await put(env, auth, "/dav/calendars/alice/tasks/apple.ics", fixture("apple-reminder-subtask.ics"));
    // the Tasks.org "open tasks" query
    expect(
      await names(env, auth, "tasks", `<C:comp-filter name="VTODO"><C:prop-filter name="COMPLETED"><C:is-not-defined/></C:prop-filter></C:comp-filter>`),
    ).toEqual(["apple.ics", "open.ics"]);
    expect(
      await names(env, auth, "tasks", `<C:comp-filter name="VTODO"><C:prop-filter name="SUMMARY"><C:text-match>COFFEE</C:text-match></C:prop-filter></C:comp-filter>`),
    ).toEqual(["apple.ics"]);
    expect(
      await names(
        env,
        auth,
        "tasks",
        `<C:comp-filter name="VTODO"><C:prop-filter name="SUMMARY"><C:text-match collation="i;octet">COFFEE</C:text-match></C:prop-filter></C:comp-filter>`,
      ),
    ).toEqual([]);
    expect(
      await names(
        env,
        auth,
        "tasks",
        `<C:comp-filter name="VTODO"><C:prop-filter name="STATUS"><C:text-match negate-condition="yes">COMPLETED</C:text-match></C:prop-filter></C:comp-filter>`,
      ),
    ).toEqual(["apple.ics", "open.ics"]);
    expect(
      await names(
        env,
        auth,
        "tasks",
        `<C:comp-filter name="VTODO"><C:prop-filter name="RELATED-TO"><C:param-filter name="RELTYPE"><C:text-match>parent</C:text-match></C:param-filter></C:prop-filter></C:comp-filter>`,
      ),
    ).toEqual(["apple.ics"]);
    expect(await names(env, auth, "tasks", `<C:comp-filter name="VTODO"><C:comp-filter name="VALARM"/></C:comp-filter>`)).toEqual(["apple.ics"]);
    expect(await names(env, auth, "tasks", `<C:comp-filter name="VEVENT"/>`)).toEqual([]);
    expect(await names(env, auth, "tasks", ``)).toEqual(["apple.ics", "done.ics", "open.ics"]);
  });

  it("returns calendar data and reads floating times in the request time zone", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    // floating 09:00-10:00 on 2026-11-02
    await put(env, auth, "/dav/calendars/alice/calendar/f.ics", event("f", "20261102T090000", "20261102T100000"));
    const tz = fixture("apple-reminder-subtask.ics").match(/BEGIN:VTIMEZONE[\s\S]*END:VTIMEZONE\r\n/)![0];
    const body = (start: string, end: string) =>
      `<C:calendar-query ${NSDECL}><D:prop><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR">${range(start, end)}</C:comp-filter></C:filter><C:timezone>BEGIN:VCALENDAR&#13;\nVERSION:2.0&#13;\n${tz.replace(/\r/g, "&#13;")}END:VCALENDAR&#13;\n</C:timezone></C:calendar-query>`;
    // in Nicosia (UTC+2 in November) the event is 07:00-08:00Z
    const hit = responses(await xml(await report(env, auth, "/dav/calendars/alice/calendar/", body("20261102T070000Z", "20261102T073000Z"))));
    expect(hit.get("/dav/calendars/alice/calendar/f.ics")!.props.get(CAL)!.text).toContain("UID:f");
    const miss = responses(await xml(await report(env, auth, "/dav/calendars/alice/calendar/", body("20261102T090000Z", "20261102T093000Z"))));
    expect(miss.size).toBe(0);
  });

  it("rejects unknown collations and malformed time ranges", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const bad = await report(
      env,
      auth,
      "/dav/calendars/alice/tasks/",
      q(`<C:comp-filter name="VTODO"><C:prop-filter name="SUMMARY"><C:text-match collation="x-unknown">a</C:text-match></C:prop-filter></C:comp-filter>`),
    );
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain("supported-collation");
    expect((await report(env, auth, "/dav/calendars/alice/tasks/", q(range("2026-01-01", "20260102T000000Z", "VTODO")))).status).toBe(403);
  });

  it("refuses unknown reports", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await report(env, auth, "/dav/calendars/alice/calendar/", `<D:principal-property-search ${NSDECL}/>`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("supported-report");
  });
});
