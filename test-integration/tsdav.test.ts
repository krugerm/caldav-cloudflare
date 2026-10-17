import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DAVClient, type DAVCalendar } from "tsdav";
import { beforeAll, describe, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const admin = inject("admin");
const adminAuth = "Basic " + Buffer.from(`${admin.username}:${admin.password}`).toString("base64");

async function adminApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/admin/api${path}`, {
    method,
    headers: { Authorization: adminAuth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const event = (uid: string, start: string, end: string, extra = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//tsdav integration//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261017T000000Z\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:${uid}\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;

const todo = (uid: string, extra = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//tsdav integration//EN\r\nBEGIN:VTODO\r\nUID:${uid}\r\nDTSTAMP:20261017T000000Z\r\nSUMMARY:${uid}\r\n${extra}END:VTODO\r\nEND:VCALENDAR\r\n`;

describe("tsdav against wrangler dev", () => {
  let client: DAVClient;
  let auth: string;
  let calendars: DAVCalendar[];
  const cal = () => calendars.find((c) => c.url.endsWith("/calendar/"))!;
  const tasks = () => calendars.find((c) => c.url.endsWith("/tasks/"))!;

  beforeAll(async () => {
    await adminApi("POST", "/users", { username: "ivy" });
    const { token } = await adminApi<{ token: string }>("POST", "/users/ivy/passwords", { label: "integration" });
    auth = "Basic " + Buffer.from(`ivy:${token}`).toString("base64");
    client = new DAVClient({
      serverUrl: baseUrl,
      credentials: { username: "ivy", password: token },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    await client.login();
    calendars = await client.fetchCalendars();
  });

  it("discovers the account through /.well-known/caldav", () => {
    expect(client.account?.principalUrl).toBe(`${baseUrl}/dav/principals/ivy/`);
    expect(client.account?.homeUrl).toBe(`${baseUrl}/dav/calendars/ivy/`);
  });

  it("lists the default collections with their component sets and sync tokens", () => {
    expect(calendars.map((c) => new URL(c.url).pathname).sort()).toEqual(["/dav/calendars/ivy/calendar/", "/dav/calendars/ivy/tasks/"]);
    expect(cal().components).toEqual(["VEVENT"]);
    expect(tasks().components).toEqual(["VTODO"]);
    expect(cal().ctag).toMatch(/^urn:caldav-cloudflare:sync:/);
    expect(cal().syncToken).toBe(cal().ctag);
    expect(cal().displayName).toBe("Calendar");
  });

  it("creates, fetches, updates and deletes an event", async () => {
    const created = await client.createCalendarObject({ calendar: cal(), filename: "dentist.ics", iCalString: event("dentist", "20261021T090000Z", "20261021T093000Z") });
    expect(created.status).toBe(201);
    const etag = created.headers.get("etag");

    const objects = await client.fetchCalendarObjects({ calendar: cal() });
    const obj = objects.find((o) => o.url.endsWith("/dentist.ics"))!;
    expect(obj.etag).toBe(etag);
    expect(obj.data).toBe(event("dentist", "20261021T090000Z", "20261021T093000Z"));

    const updated = await client.updateCalendarObject({
      calendarObject: { ...obj, data: event("dentist", "20261021T100000Z", "20261021T103000Z", "LOCATION:Main St\r\n") },
    });
    expect(updated.status).toBe(204);
    expect(updated.headers.get("etag")).not.toBe(etag);

    // a stale ETag is refused
    const stale = await client.updateCalendarObject({ calendarObject: { ...obj, data: event("dentist", "20261022T100000Z", "20261022T103000Z") } });
    expect(stale.status).toBe(412);

    const fresh = (await client.fetchCalendarObjects({ calendar: cal(), objectUrls: [obj.url], useMultiGet: true }))[0]!;
    expect(fresh.data).toContain("LOCATION:Main St");
    expect((await client.deleteCalendarObject({ calendarObject: fresh })).status).toBe(204);
    expect((await client.fetchCalendarObjects({ calendar: cal() })).some((o) => o.url.endsWith("/dentist.ics"))).toBe(false);
  });

  it("filters by time range, expanding recurrence on the server", async () => {
    await client.createCalendarObject({ calendar: cal(), filename: "standup.ics", iCalString: event("standup", "20260105T090000Z", "20260105T091500Z", "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n") });
    await client.createCalendarObject({ calendar: cal(), filename: "party.ics", iCalString: event("party", "20261231T200000Z", "20270101T020000Z") });
    const nov = await client.fetchCalendarObjects({ calendar: cal(), timeRange: { start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" } });
    expect(nov.map((o) => o.url.split("/").pop()).sort()).toEqual(["standup.ics"]);
    const nye = await client.fetchCalendarObjects({ calendar: cal(), timeRange: { start: "2026-12-31T00:00:00Z", end: "2027-01-01T00:00:00Z" } });
    expect(nye.map((o) => o.url.split("/").pop()).sort()).toEqual(["party.ics"]);
  });

  it("syncs only changes with sync-collection and notices ctag changes", async () => {
    const before = (await client.fetchCalendars()).find((c) => c.url === tasks().url)!;
    await client.createCalendarObject({ calendar: tasks(), filename: "milk.ics", iCalString: todo("milk") });
    expect((await client.isCollectionDirty({ collection: before })).isDirty).toBe(true);

    const changes = await client.syncCollection({ url: tasks().url, props: { "d:getetag": {} }, syncLevel: 1, syncToken: before.syncToken });
    const hrefs = changes.map((r) => r.href).filter(Boolean);
    expect(hrefs).toEqual(["/dav/calendars/ivy/tasks/milk.ics"]);

    const synced = await client.syncCalendars({ oldCalendars: [before], detailedResult: true });
    expect(synced.updated.map((c) => c.url)).toContain(tasks().url);
  });

  it("refuses to store a task in the events collection", async () => {
    const res = await client.createCalendarObject({ calendar: cal(), filename: "wrong.ics", iCalString: todo("wrong") });
    expect(res.status).toBe(403);
  });

  it("creates collections with extended MKCOL; MKCALENDAR is refused by the runtime", async () => {
    const mkcol = await fetch(`${baseUrl}/dav/calendars/ivy/projects/`, {
      method: "MKCOL",
      headers: { Authorization: auth, "Content-Type": "application/xml" },
      body: `<mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Projects</displayname></prop></set></mkcol>`,
    });
    expect(mkcol.status).toBe(201);
    expect((await client.fetchCalendars()).map((c) => c.displayName)).toContain("Projects");

    // workerd answers MKCALENDAR with 501 before the Worker runs; see D-010
    const mkcalendar = await fetch(`${baseUrl}/dav/calendars/ivy/viaMkcalendar/`, { method: "MKCALENDAR", headers: { Authorization: auth } });
    expect(mkcalendar.status).toBe(501);
  });

  it("published every change the suite made to the local Queue", async () => {
    // give waitUntil sends a moment to finish
    await new Promise((r) => setTimeout(r, 500));
    const out = execFileSync(
      join(process.cwd(), "node_modules", ".bin", "wrangler"),
      ["d1", "execute", "caldav", "--local", "--persist-to", inject("persistDir"), "--json", "--command",
        "SELECT COUNT(*) AS total, SUM(published) AS published FROM changes"],
      { env: { ...process.env, CI: "1" }, encoding: "utf8" },
    );
    const [{ results }] = JSON.parse(out) as [{ results: { total: number; published: number }[] }];
    // default collections for two users, the event and task writes above, and the MKCOL
    expect(results[0]!.total).toBeGreaterThanOrEqual(10);
    expect(results[0]!.published).toBe(results[0]!.total);
  });
});
