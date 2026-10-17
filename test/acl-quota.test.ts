import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { call, makeEnv, propfindBody, responses, userWithPassword, xml } from "./helpers";

const ics = { "Content-Type": "text/calendar; charset=utf-8" };
const event = (uid: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261016T000000Z\r\nDTSTART:20261020T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

const get = async (env: AppEnv, auth: string, path: string, ...props: [string, string][]) =>
  responses(await xml(await call(env, "PROPFIND", path, { auth, headers: { Depth: "0" }, body: propfindBody(...props) }))).get(path)!;

describe("quota properties (RFC 4331)", () => {
  it("reports bytes used per user and per collection against the configured quota", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/calendar/a.ics", { auth, headers: ics, body: event("a") });
    const size = new TextEncoder().encode(event("a")).byteLength;
    const home = await get(env, auth, "/dav/calendars/alice/", ["d", "quota-used-bytes"], ["d", "quota-available-bytes"]);
    expect(Number(home.props.get("{DAV:}quota-used-bytes")!.text)).toBe(size);
    expect(Number(home.props.get("{DAV:}quota-available-bytes")!.text)).toBe(1073741824 - size);
    const tasks = await get(env, auth, "/dav/calendars/alice/tasks/", ["d", "quota-used-bytes"]);
    expect(tasks.props.get("{DAV:}quota-used-bytes")!.text).toBe("0");
    const obj = await get(env, auth, "/dav/calendars/alice/calendar/a.ics", ["d", "quota-used-bytes"]);
    expect(obj.missing.has("{DAV:}quota-used-bytes")).toBe(true);
  });

  it("counts only a scoped password's own collections and leaves out the remaining space", async () => {
    const { env } = makeEnv();
    const owner = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/calendar/a.ics", { auth: owner.auth, headers: ics, body: event("a") });
    const todo = event("b").replaceAll("VEVENT", "VTODO");
    expect((await call(env, "PUT", "/dav/calendars/alice/tasks/b.ics", { auth: owner.auth, headers: ics, body: todo })).status).toBe(201);
    const tasksSize = new TextEncoder().encode(todo).byteLength;
    const { auth } = await userWithPassword(env, "alice", JSON.stringify({ collections: ["tasks"] }));
    for (const path of ["/dav/calendars/alice/", "/dav/calendars/alice/tasks/"]) {
      const r = await get(env, auth, path, ["d", "quota-used-bytes"], ["d", "quota-available-bytes"]);
      expect(Number(r.props.get("{DAV:}quota-used-bytes")!.text), path).toBe(tasksSize);
      expect(r.missing.has("{DAV:}quota-available-bytes"), path).toBe(true);
    }
  });
});

describe("access control properties (RFC 3744, read-only)", () => {
  it("reports owner, privileges and the supported privilege tree", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/calendar/a.ics", { auth, headers: ics, body: event("a") });
    const obj = await get(env, auth, "/dav/calendars/alice/calendar/a.ics", ["d", "owner"], ["d", "current-user-privilege-set"], ["d", "supported-privilege-set"], ["d", "acl"]);
    expect(obj.props.get("{DAV:}owner")!.children[0]!.text).toBe("/dav/principals/alice/");
    expect(obj.props.get("{DAV:}current-user-privilege-set")!.children.map((p) => p.children[0]!.name)).toEqual(
      expect.arrayContaining(["read", "write", "write-content"]),
    );
    const tree = obj.props.get("{DAV:}supported-privilege-set")!.children[0]!;
    expect(tree.children[0]!.children[0]!.name).toBe("all");
    // the ACL itself isn't exposed
    expect(obj.missing.has("{DAV:}acl")).toBe(true);
  });

  it("reports read-only privileges for a read-only app password everywhere", async () => {
    const { env } = makeEnv();
    const owner = await userWithPassword(env);
    await call(env, "PUT", "/dav/calendars/alice/calendar/a.ics", { auth: owner.auth, headers: ics, body: event("a") });
    const { auth } = await userWithPassword(env, "alice", JSON.stringify({ access: "read" }));
    for (const path of ["/dav/calendars/alice/", "/dav/calendars/alice/calendar/", "/dav/calendars/alice/calendar/a.ics"]) {
      const r = await get(env, auth, path, ["d", "current-user-privilege-set"]);
      const privs = r.props.get("{DAV:}current-user-privilege-set")!.children.map((p) => p.children[0]!.name);
      expect(privs, path).toEqual(["read", "read-current-user-privilege-set", "read-free-busy"]);
    }
  });

  it("does not grant bind on the home to a password limited to some collections", async () => {
    const { env } = makeEnv();
    const { auth } = await userWithPassword(env, "alice", JSON.stringify({ collections: ["tasks"] }));
    const home = await get(env, auth, "/dav/calendars/alice/", ["d", "current-user-privilege-set"]);
    expect(home.props.get("{DAV:}current-user-privilege-set")!.children.map((p) => p.children[0]!.name)).not.toContain("bind");
    const tasks = await get(env, auth, "/dav/calendars/alice/tasks/", ["d", "current-user-privilege-set"]);
    expect(tasks.props.get("{DAV:}current-user-privilege-set")!.children.map((p) => p.children[0]!.name)).toContain("write");
  });
});
