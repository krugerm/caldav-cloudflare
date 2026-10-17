import { describe, expect, it } from "vitest";
import { call, makeEnv, propfindBody, responses, userWithPassword, xml } from "./helpers";

const MKCOL = `<?xml version="1.0" encoding="utf-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:set><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Work</D:displayname>
    <C:calendar-description>Work things</C:calendar-description>
    <A:calendar-color>#FF2968FF</A:calendar-color>
    <A:calendar-order>3</A:calendar-order>
    <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
  </D:prop></D:set>
</D:mkcol>`;

const MINIMAL = `<mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype></prop></set></mkcol>`;

const props = (env: Parameters<typeof call>[0], auth: string, path: string) =>
  call(env, "PROPFIND", path, {
    auth,
    headers: { Depth: "0" },
    body: propfindBody(
      ["d", "displayname"],
      ["c", "calendar-description"],
      ["a", "calendar-color"],
      ["a", "calendar-order"],
      ["c", "supported-calendar-component-set"],
      ["cs", "getctag"],
    ),
  }).then(async (r) => responses(await xml(r)).get(path)!);

describe("extended MKCOL", () => {
  it("creates a collection with the requested properties and logs one event", async () => {
    const { env, queue } = makeEnv();
    const { auth, passwordId } = await userWithPassword(env);
    const res = await call(env, "MKCOL", "/dav/calendars/alice/work/", { auth, body: MKCOL });
    expect(res.status).toBe(201);
    const p = await props(env, auth, "/dav/calendars/alice/work/");
    expect(p.props.get("{DAV:}displayname")!.text).toBe("Work");
    expect(p.props.get("{urn:ietf:params:xml:ns:caldav}calendar-description")!.text).toBe("Work things");
    expect(p.props.get("{http://apple.com/ns/ical/}calendar-color")!.text).toBe("#FF2968FF");
    expect(p.props.get("{http://apple.com/ns/ical/}calendar-order")!.text).toBe("3");
    expect(p.props.get("{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set")!.children.map((c) => c.attrs.name)).toEqual(["VTODO"]);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({ v: 1, type: "collection.created", user: "alice", collection: "work", revision: 1, actor: passwordId });
  });

  it("defaults to VEVENT and VTODO without a component set", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    expect((await call(env, "MKCOL", "/dav/calendars/alice/plain/", { auth, body: MINIMAL })).status).toBe(201);
    const p = await props(env, auth, "/dav/calendars/alice/plain/");
    expect(p.props.get("{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set")!.children.map((c) => c.attrs.name)).toEqual(["VEVENT", "VTODO"]);
    expect(p.props.get("{DAV:}displayname")!.text).toBe("plain");
  });

  it("refuses an existing URL, a foreign home and unsupported components", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    expect((await call(env, "MKCOL", "/dav/calendars/alice/calendar/", { auth, body: MINIMAL })).status).toBe(405);
    expect((await call(env, "MKCOL", "/dav/calendars/bob/x/", { auth, body: MINIMAL })).status).toBe(404);
    const bad = MKCOL.replace('name="VTODO"', 'name="VFREEBUSY"');
    const res = await call(env, "MKCOL", "/dav/calendars/alice/bad/", { auth, body: bad });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("supported-calendar-component");
    expect((await call(env, "PROPFIND", "/dav/calendars/alice/bad/", { auth, headers: { Depth: "0" } })).status).toBe(404);
  });

  it("refuses an app password limited to some collections", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env, "alice", JSON.stringify({ collections: ["tasks"] }));
    expect((await call(env, "MKCOL", "/dav/calendars/alice/new/", { auth, body: MINIMAL })).status).toBe(403);
  });

  it("allows re-creating a deleted collection's URL", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    expect((await call(env, "DELETE", "/dav/calendars/alice/calendar/", { auth })).status).toBe(204);
    expect((await call(env, "MKCOL", "/dav/calendars/alice/calendar/", { auth, body: MINIMAL })).status).toBe(201);
  });
  it("creates a calendar the way DAVx5 does", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = `<?xml version="1.0"?><mkcol xmlns="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav"><set><prop>
      <resourcetype><collection/><CAL:calendar/></resourcetype><displayname>Android</displayname>
      <CAL:supported-calendar-component-set><CAL:comp name="VEVENT"/></CAL:supported-calendar-component-set>
    </prop></set></mkcol>`;
    expect((await call(env, "MKCOL", "/dav/calendars/alice/android/", { auth, body })).status).toBe(201);
    const p = await props(env, auth, "/dav/calendars/alice/android/");
    expect(p.props.get("{DAV:}displayname")!.text).toBe("Android");
  });

  it("refuses a plain collection", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    expect((await call(env, "MKCOL", "/dav/calendars/alice/folder/", { auth })).status).toBe(403);
  });

  it("does not offer MKCALENDAR, which workerd rejects", async () => {
    const { env } = makeEnv();
    const res = await call(env, "OPTIONS", "/dav/calendars/alice/");
    expect(res.headers.get("Allow")).not.toContain("MKCALENDAR");
    expect(res.headers.get("Allow")).toContain("MKCOL");
  });
});

describe("PROPPATCH", () => {
  const update = (inner: string) =>
    `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:A="http://apple.com/ns/ical/" xmlns:X="http://example.com/ns/">${inner}</D:propertyupdate>`;

  it("sets and removes live and dead properties and changes the ctag", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    const before = (await props(env, auth, "/dav/calendars/alice/calendar/")).props.get("{http://calendarserver.org/ns/}getctag")!.text;
    const res = await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", {
      auth,
      body: update(
        `<D:set><D:prop><D:displayname>Home</D:displayname><A:calendar-color>#00FF00</A:calendar-color><X:custom attr="1">kept <X:inner/></X:custom></D:prop></D:set>`,
      ),
    });
    expect(res.status).toBe(207);
    const statuses = responses(await xml(res)).get("/dav/calendars/alice/calendar/")!;
    expect(statuses.props.size).toBe(3);
    const after = await props(env, auth, "/dav/calendars/alice/calendar/");
    expect(after.props.get("{DAV:}displayname")!.text).toBe("Home");
    expect(after.props.get("{http://calendarserver.org/ns/}getctag")!.text).not.toBe(before);
    expect(queue.sent.at(-1)).toMatchObject({ type: "collection.updated", collection: "calendar" });

    const dead = responses(
      await xml(
        await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", {
          auth,
          headers: { Depth: "0" },
          body: `<propfind xmlns="DAV:"><prop><custom xmlns="http://example.com/ns/"/></prop></propfind>`,
        }),
      ),
    ).get("/dav/calendars/alice/calendar/")!;
    const custom = dead.props.get("{http://example.com/ns/}custom")!;
    expect(custom.attrs.attr).toBe("1");
    expect(custom.children[0]!.name).toBe("inner");

    await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", {
      auth,
      body: update(`<D:remove><D:prop><A:calendar-color/><X:custom/></D:prop></D:remove>`),
    });
    const removed = await props(env, auth, "/dav/calendars/alice/calendar/");
    expect(removed.missing.has("{http://apple.com/ns/ical/}calendar-color")).toBe(true);
  });

  it("applies nothing when one property is protected", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", {
      auth,
      body: update(`<D:set><D:prop><D:displayname>Nope</D:displayname><D:getetag>"x"</D:getetag></D:prop></D:set>`),
    });
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain("424 Failed Dependency");
    expect(text).toContain("403 Forbidden");
    expect((await props(env, auth, "/dav/calendars/alice/calendar/")).props.get("{DAV:}displayname")!.text).toBe("Calendar");
    expect(queue.sent).toHaveLength(0);
  });

  it("caps dead property storage with 507 and applies nothing", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const big = "x".repeat(70 * 1024);
    const res = await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", {
      auth,
      body: update(`<D:set><D:prop><D:displayname>Renamed</D:displayname><X:big>${big}</X:big></D:prop></D:set>`),
    });
    const text = await res.text();
    expect(text).toContain("507 Insufficient Storage");
    expect(text).toContain("424 Failed Dependency");
    expect((await props(env, auth, "/dav/calendars/alice/calendar/")).props.get("{DAV:}displayname")!.text).toBe("Calendar");
    const many = Array.from({ length: 65 }, (_, i) => `<X:p${i}>v</X:p${i}>`).join("");
    const res2 = await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", { auth, body: update(`<D:set><D:prop>${many}</D:prop></D:set>`) });
    expect(await res2.text()).toContain("507 Insufficient Storage");
  });

  it("refuses a read-only app password", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env, "alice", JSON.stringify({ access: "read" }));
    const res = await call(env, "PROPPATCH", "/dav/calendars/alice/calendar/", {
      auth,
      body: update(`<D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set>`),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE collection", () => {
  it("removes it and publishes collection.deleted", async () => {
    const { env, queue } = makeEnv();
    const { auth } = await userWithPassword(env);
    expect((await call(env, "DELETE", "/dav/calendars/alice/tasks/", { auth })).status).toBe(204);
    expect((await call(env, "PROPFIND", "/dav/calendars/alice/tasks/", { auth, headers: { Depth: "0" } })).status).toBe(404);
    expect(queue.sent).toEqual([expect.objectContaining({ type: "collection.deleted", collection: "tasks" })]);
  });
});
