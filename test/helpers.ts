import { env } from "cloudflare:test";
import { expect } from "vitest";
import { setBootstrappedForTests } from "../src/auth/auth";
import type { AppEnv } from "../src/env";
import type { ChangeEvent } from "../src/events/event";
import { handle } from "../src/index";
import { issueAppPassword, createUser } from "../src/store/users";
import { nowSeconds } from "../src/util/time";
import { parseXml, type XmlElement } from "../src/dav/xml";

export const BASE = "https://cal.example.com";

/** A Queue double that records messages and can be told to fail. */
export class RecordingQueue {
  sent: ChangeEvent[] = [];
  failing = false;
  /** Reject any batch holding a message this matches, as Queues does for an oversized message. */
  rejects: ((ev: ChangeEvent) => boolean) | null = null;
  async send(body: ChangeEvent) {
    await this.sendBatch([{ body }]);
  }
  async sendBatch(messages: Iterable<{ body: ChangeEvent }>) {
    const list = [...messages];
    if (this.failing || list.some((m) => this.rejects?.(m.body))) throw new Error("queue unavailable");
    for (const m of list) this.sent.push(m.body);
  }
}

/** A fresh env with a recording queue. The bootstrap admin is skipped unless asked for. */
export function makeEnv(opts: { bootstrap?: boolean } = {}): { env: AppEnv; queue: RecordingQueue } {
  setBootstrappedForTests(!opts.bootstrap);
  const queue = new RecordingQueue();
  return { env: { ...(env as unknown as AppEnv), CHANGES: queue as unknown as Queue<ChangeEvent> }, queue };
}

const lastChangeRowid = async (e: AppEnv) =>
  (await e.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM changes").first<{ n: number }>())!.n;

/** Change rows inserted after `rowid` (deletions such as pruning don't affect the count). */
const changesSince = async (e: AppEnv, rowid: number) =>
  (await e.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE rowid > ?").bind(rowid).first<{ n: number }>())!.n;

/**
 * Send a request through the Worker and wait for its background work.
 * Every call also checks the event-stream invariant: each change row the
 * request logged produced exactly one Queue message, unless the queue is
 * set to fail.
 */
export async function call(e: AppEnv, method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit; auth?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.auth) headers.set("Authorization", init.auth);
  const req = new Request(new URL(path, BASE), { method, headers, body: init.body });
  const pending: Promise<unknown>[] = [];
  const before = await lastChangeRowid(e);
  const queue = e.CHANGES as unknown as RecordingQueue;
  const sentBefore = queue.sent.length;
  const res = await handle(req, e, { waitUntil: (p) => void pending.push(p) });
  await Promise.all(pending);
  // every published change row was sent exactly once; with a healthy queue, every row is published
  const published = (await e.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE rowid > ? AND published = 1").bind(before).first<{ n: number }>())!.n;
  expect(queue.sent.length - sentBefore, `${method} ${path}: one message per published change`).toBe(published);
  if (!queue.failing && !queue.rejects) {
    expect(published, `${method} ${path}: every logged change published`).toBe(await changesSince(e, before));
  }
  return res;
}

export const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

/** Create a user with one app password; returns the Authorization header value and password id. */
export async function userWithPassword(e: AppEnv, username = "alice", scope: string | null = null) {
  const at = nowSeconds();
  const existing = await e.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: number }>();
  const userId = existing?.id ?? (await createUser(e.DB, username, { actor: "admin", at })).user.id;
  const { id, token } = await issueAppPassword(e.DB, userId, "test", scope, at);
  // creating the user logged collection.created changes; mark them published so they don't skew counts
  await e.DB.prepare("UPDATE changes SET published = 1").run();
  return { auth: basic(username, token), passwordId: id, userId, token };
}

export async function xml(res: Response): Promise<XmlElement> {
  return parseXml(await res.text());
}

const DAV = "DAV:";

/** Map href → { "{ns}name": text or child names } for 200 propstats in a multistatus. */
export function responses(ms: XmlElement): Map<string, { props: Map<string, XmlElement>; missing: Set<string>; status?: string }> {
  const out = new Map<string, { props: Map<string, XmlElement>; missing: Set<string>; status?: string }>();
  for (const r of ms.children.filter((c) => c.ns === DAV && c.name === "response")) {
    const href = r.children.find((c) => c.name === "href")!.text;
    const entry = { props: new Map<string, XmlElement>(), missing: new Set<string>(), status: r.children.find((c) => c.name === "status")?.text };
    for (const ps of r.children.filter((c) => c.name === "propstat")) {
      const status = ps.children.find((c) => c.name === "status")!.text;
      for (const p of ps.children.find((c) => c.name === "prop")!.children) {
        const key = `{${p.ns}}${p.name}`;
        if (status.includes(" 200")) entry.props.set(key, p);
        else entry.missing.add(key);
      }
    }
    out.set(decodeURIComponent(href), entry);
  }
  return out;
}

export const propfindBody = (...props: [string, string][]) =>
  `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props
    .map(([p, n]) => `<${p}:${n}/>`)
    .join("")}</d:prop></d:propfind>`;
