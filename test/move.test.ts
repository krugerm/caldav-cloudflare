import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { call, makeEnv, userWithPassword } from "./helpers";

const ics = { "Content-Type": "text/calendar; charset=utf-8" };
const event = (uid: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261016T000000Z\r\nDTSTART:20261020T100000Z\r\nSUMMARY:${uid}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const MKCOL = `<mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype></prop></set></mkcol>`;

async function setup() {
  const { env, queue } = makeEnv();
  const { auth } = await userWithPassword(env);
  await call(env, "MKCOL", "/dav/calendars/alice/work/", { auth, body: MKCOL });
  const etag = (await call(env, "PUT", "/dav/calendars/alice/calendar/a.ics", { auth, headers: ics, body: event("a") })).headers.get("ETag")!;
  queue.sent.length = 0;
  return { env, queue, auth, etag };
}

const move = (env: AppEnv, auth: string, from: string, to: string, headers: Record<string, string> = {}) =>
  call(env, "MOVE", from, { auth, headers: { Destination: `https://cal.example.com${to}`, ...headers } });

describe("MOVE", () => {
  it("moves an object to another collection, keeping body and ETag, and logs delete + create", async () => {
    const { env, queue, auth, etag } = await setup();
    const res = await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/work/a.ics");
    expect(res.status).toBe(201);
    expect((await call(env, "GET", "/dav/calendars/alice/calendar/a.ics", { auth })).status).toBe(404);
    const moved = await call(env, "GET", "/dav/calendars/alice/work/a.ics", { auth });
    expect(moved.headers.get("ETag")).toBe(etag);
    expect(await moved.text()).toBe(event("a"));
    expect(queue.sent.map((e) => [e.type, e.collection, e.object])).toEqual([
      ["object.deleted", "calendar", "a.ics"],
      ["object.created", "work", "a.ics"],
    ]);
  });

  it("renames within a collection", async () => {
    const { env, auth } = await setup();
    expect((await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/calendar/b.ics")).status).toBe(201);
    expect((await call(env, "GET", "/dav/calendars/alice/calendar/b.ics", { auth })).status).toBe(200);
  });

  it("honours Overwrite and If-Match", async () => {
    const { env, auth } = await setup();
    // the same UID: replacing an object with a different UID is refused (no-uid-conflict)
    await call(env, "PUT", "/dav/calendars/alice/work/b.ics", { auth, headers: ics, body: event("a").replace("SUMMARY:", "SUMMARY:old ") });
    expect((await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/work/b.ics", { Overwrite: "F" })).status).toBe(412);
    expect((await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/work/b.ics", { "If-Match": '"x"' })).status).toBe(412);
    expect((await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/work/b.ics")).status).toBe(204);
    expect(await (await call(env, "GET", "/dav/calendars/alice/work/b.ics", { auth })).text()).toBe(event("a"));
  });

  it("refuses wrong components, UID clashes, other users and other hosts", async () => {
    const { env, auth } = await setup();
    expect((await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/tasks/a.ics")).status).toBe(403);
    await call(env, "PUT", "/dav/calendars/alice/work/other.ics", { auth, headers: ics, body: event("a") });
    expect((await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/work/a.ics")).status).toBe(403);
    expect((await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/bob/calendar/a.ics")).status).toBe(403);
    const res = await call(env, "MOVE", "/dav/calendars/alice/calendar/a.ics", { auth, headers: { Destination: "https://elsewhere.example/dav/calendars/alice/work/z.ics" } });
    expect(res.status).toBe(502);
    expect((await move(env, auth, "/dav/calendars/alice/calendar/a.ics", "/dav/calendars/alice/nope/a.ics")).status).toBe(409);
  });

  it("does not support COPY", async () => {
    const { env, auth } = await setup();
    const res = await call(env, "COPY", "/dav/calendars/alice/calendar/a.ics", { auth, headers: { Destination: "/dav/calendars/alice/work/a.ics" } });
    expect(res.status).toBe(405);
  });
});
