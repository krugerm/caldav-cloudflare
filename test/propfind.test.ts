import { describe, expect, it } from "vitest";
import { call, makeEnv, propfindBody, responses, userWithPassword, xml } from "./helpers";

describe("discovery", () => {
  it("redirects /.well-known/caldav to the DAV root", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PROPFIND", "/.well-known/caldav");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/dav/");
  });

  it("finds the principal, then the calendar home", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const root = responses(
      await xml(await call(env, "PROPFIND", "/dav/", { auth, headers: { Depth: "0" }, body: propfindBody(["d", "current-user-principal"]) })),
    );
    expect(root.get("/dav/")!.props.get("{DAV:}current-user-principal")!.children[0]!.text).toBe("/dav/principals/alice/");

    const principal = responses(
      await xml(
        await call(env, "PROPFIND", "/dav/principals/alice/", {
          auth,
          headers: { Depth: "0" },
          body: propfindBody(["c", "calendar-home-set"], ["d", "principal-URL"], ["d", "displayname"], ["cs", "email-address-set"]),
        }),
      ),
    ).get("/dav/principals/alice/")!;
    expect(principal.props.get("{urn:ietf:params:xml:ns:caldav}calendar-home-set")!.children[0]!.text).toBe("/dav/calendars/alice/");
    expect(principal.props.get("{DAV:}displayname")!.text).toBe("alice");
    // unsupported properties are reported as 404 inside a 207, never as a failed request
    expect(principal.missing.has("{http://calendarserver.org/ns/}email-address-set")).toBe(true);
  });

  it("answers PROPFIND and OPTIONS on the host root as the DAV root", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await call(env, "PROPFIND", "/", { auth, headers: { Depth: "0" }, body: propfindBody(["d", "current-user-principal"]) });
    expect(res.status).toBe(207);
    expect(await res.text()).toContain("/dav/principals/alice/");
    expect((await call(env, "OPTIONS", "/")).headers.get("DAV")).toContain("calendar-access");
    expect((await call(env, "GET", "/")).status).toBe(200);
  });

  it("hides other users' principals and homes", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env, "alice");
    await userWithPassword(env, "bob");
    expect((await call(env, "PROPFIND", "/dav/principals/bob/", { auth, headers: { Depth: "0" } })).status).toBe(404);
    expect((await call(env, "PROPFIND", "/dav/calendars/bob/", { auth, headers: { Depth: "1" } })).status).toBe(404);
    expect((await call(env, "PROPFIND", "/dav/calendars/bob/calendar/", { auth, headers: { Depth: "0" } })).status).toBe(404);
  });
});

describe("PROPFIND on the calendar home", () => {
  it("lists collections with the properties Apple clients ask for", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await call(env, "PROPFIND", "/dav/calendars/alice/", {
      auth,
      headers: { Depth: "1" },
      body: propfindBody(
        ["d", "resourcetype"],
        ["d", "displayname"],
        ["cs", "getctag"],
        ["d", "sync-token"],
        ["c", "supported-calendar-component-set"],
        ["d", "current-user-privilege-set"],
        ["d", "supported-report-set"],
        ["a", "calendar-color"],
        ["d", "quota-used-bytes"],
        ["d", "quota-available-bytes"],
        ["cs", "pushkey"],
      ),
    });
    expect(res.status).toBe(207);
    const all = responses(await xml(res));
    expect([...all.keys()].sort()).toEqual(["/dav/calendars/alice/", "/dav/calendars/alice/calendar/", "/dav/calendars/alice/tasks/"]);

    const tasks = all.get("/dav/calendars/alice/tasks/")!;
    expect(tasks.props.get("{DAV:}resourcetype")!.children.map((c) => c.name).sort()).toEqual(["calendar", "collection"]);
    expect(tasks.props.get("{DAV:}displayname")!.text).toBe("Tasks");
    expect(tasks.props.get("{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set")!.children.map((c) => c.attrs.name)).toEqual(["VTODO"]);
    expect(tasks.props.get("{http://calendarserver.org/ns/}getctag")!.text).toMatch(/^urn:caldav-cloudflare:sync:\d+:\d+$/);
    expect(tasks.props.get("{DAV:}sync-token")!.text).toBe(tasks.props.get("{http://calendarserver.org/ns/}getctag")!.text);
    const privs = tasks.props.get("{DAV:}current-user-privilege-set")!.children.map((p) => p.children[0]!.name);
    expect(privs).toContain("write");
    const reports = tasks.props.get("{DAV:}supported-report-set")!.children.map((s) => s.children[0]!.children[0]!.name);
    expect(reports.sort()).toEqual(["calendar-multiget", "calendar-query", "free-busy-query", "sync-collection"]);
    expect(tasks.missing.has("{http://apple.com/ns/ical/}calendar-color")).toBe(true);
    expect(tasks.missing.has("{http://calendarserver.org/ns/}pushkey")).toBe(true);

    const home = all.get("/dav/calendars/alice/")!;
    expect(home.props.get("{DAV:}quota-used-bytes")!.text).toBe("0");
    expect(Number(home.props.get("{DAV:}quota-available-bytes")!.text)).toBeGreaterThan(0);
  });

  it("treats a missing body as allprop", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const all = responses(await xml(await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "0" } })));
    const cal = all.get("/dav/calendars/alice/calendar/")!;
    expect(cal.props.has("{DAV:}resourcetype")).toBe(true);
    expect(cal.props.has("{DAV:}displayname")).toBe(true);
  });

  it("answers propname with property names only", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = `<?xml version="1.0"?><propfind xmlns="DAV:"><propname/></propfind>`;
    const all = responses(await xml(await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "0" }, body })));
    const cal = all.get("/dav/calendars/alice/calendar/")!;
    expect(cal.props.has("{http://calendarserver.org/ns/}getctag")).toBe(true);
    expect(cal.props.get("{DAV:}displayname")!.text).toBe("");
  });

  it("limits a scoped app password to its collections and to read privileges", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env, "alice", JSON.stringify({ access: "read", collections: ["tasks"] }));
    const all = responses(
      await xml(
        await call(env, "PROPFIND", "/dav/calendars/alice/", {
          auth,
          headers: { Depth: "1" },
          body: propfindBody(["d", "current-user-privilege-set"]),
        }),
      ),
    );
    expect([...all.keys()].sort()).toEqual(["/dav/calendars/alice/", "/dav/calendars/alice/tasks/"]);
    const privs = all.get("/dav/calendars/alice/tasks/")!.props.get("{DAV:}current-user-privilege-set")!.children.map((p) => p.children[0]!.name);
    expect(privs).not.toContain("write");
    expect((await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "0" } })).status).toBe(404);
  });

  it("rejects malformed XML with 400", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const res = await call(env, "PROPFIND", "/dav/calendars/alice/", { auth, headers: { Depth: "0" }, body: "<propfind xmlns='DAV:'><prop>" });
    expect(res.status).toBe(400);
  });

  it("accepts any namespace prefix, including a default namespace", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    const body = `<propfind xmlns="DAV:" xmlns:Z="http://calendarserver.org/ns/"><prop><Z:getctag/><displayname/></prop></propfind>`;
    const cal = responses(await xml(await call(env, "PROPFIND", "/dav/calendars/alice/calendar/", { auth, headers: { Depth: "0" }, body }))).get(
      "/dav/calendars/alice/calendar/",
    )!;
    expect(cal.props.has("{http://calendarserver.org/ns/}getctag")).toBe(true);
    expect(cal.props.get("{DAV:}displayname")!.text).toBe("Calendar");
  });
});
