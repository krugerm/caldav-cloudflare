// REPORT: calendar-multiget, calendar-query, free-busy-query (RFC 4791 §7) and sync-collection (RFC 6578).
import type ICAL from "ical.js";
import { HttpError, pre } from "../http/errors";
import { readXml } from "../http/body";
import { xmlResponse } from "../http/response";
import { InvalidCalendar, parseCalendar, parseTimezone } from "../ical/calendar";
import { expandCalendar, limitRecurrenceSet } from "../ical/expand";
import { FilterError, calendarMatches, filterIsComponentsOnly, parseBoundedRange, parseFilter, prefilterOf } from "../ical/filter";
import { busyPeriods, freeBusyCalendar, type BusyPeriod } from "../ical/freebusy";
import type { Range } from "../ical/timerange";
import { nowSeconds } from "../util/time";
import { getCollection, type CollectionRow } from "../store/collections";
import { getObjectsByName, listObjects, queryCandidates, readBody, type ObjectRow, type ObjectWithBody } from "../store/objects";
import type { DavContext, Resource } from "./context";
import { multistatus, propResponse, statusResponse } from "./multistatus";
import { href, parseHref } from "./paths";
import { allPropKeys } from "./props";
import { childrenOf, propKeys } from "./propfind";
import { resolve } from "./resolve";
import { parseSyncToken, syncToken } from "./sync";
import { NS, child, children, clark, d, type XmlElement } from "./xml";

const CALENDAR_DATA = clark(NS.CALDAV, "calendar-data");
/** calendar-query bodies are loaded and evaluated this many at a time. */
const QUERY_PAGE = 50;

interface Requested {
  keys: string[];
  calendarData: boolean;
  allprop: boolean;
  /** calendar-data's expand (§9.6.5) or limit-recurrence-set (§9.6.6) range. */
  expand?: Range;
  limitRecurrence?: Range;
}

/** A required start/end pair; a malformed one is a bad request. */
function boundedRange(el: XmlElement | undefined): Range | undefined {
  try {
    return parseBoundedRange(el);
  } catch (e) {
    if (e instanceof FilterError) throw new HttpError(400, e.message);
    throw e;
  }
}

/** Requested property keys; calendar-data is served from the body, the rest from the property table. */
function requestedKeys(body: XmlElement): Requested {
  const prop = child(body, NS.DAV, "prop");
  if (!prop) return { keys: [], calendarData: false, allprop: true };
  const keys = propKeys(prop);
  const data = child(prop, NS.CALDAV, "calendar-data");
  // §9.6: iCalendar 2.0 is the only representation offered
  const contentType = (data?.attrs["content-type"] ?? "text/calendar").trim().toLowerCase();
  if (contentType !== "text/calendar" || (data?.attrs.version ?? "2.0").trim() !== "2.0") {
    throw new HttpError(403, "only text/calendar version 2.0 calendar data is supported", pre.caldav("supported-calendar-data"));
  }
  return {
    keys: keys.filter((k) => k !== CALENDAR_DATA),
    calendarData: keys.includes(CALENDAR_DATA),
    allprop: false,
    expand: boundedRange(child(data, NS.CALDAV, "expand")),
    limitRecurrence: boundedRange(child(data, NS.CALDAV, "limit-recurrence-set")),
  };
}

type ObjectResource = Extract<Resource, { kind: "object" }>;

const collectionZone = (coll: CollectionRow) => (coll.timezone ? parseTimezone(coll.timezone) ?? undefined : undefined);

/**
 * calendar-data as requested: the stored body, or with expand or
 * limit-recurrence-set a rewritten copy for this response. An object that
 * can't be parsed is sent as stored. comp/prop selectors are not applied (D-015).
 */
function calendarData(text: string, req: Requested, zone?: ICAL.Timezone): string {
  if (!req.expand && !req.limitRecurrence) return text;
  try {
    const cal = parseCalendar(text);
    return req.expand ? expandCalendar(cal, req.expand, zone) : (limitRecurrenceSet(cal, req.limitRecurrence!, zone) ?? text);
  } catch (e) {
    console.error("calendar-data: could not rewrite object; sending it as stored", e);
    return text;
  }
}

async function objectResponse(ctx: DavContext, r: ObjectResource, req: Requested, body?: string, zone = collectionZone(r.coll)) {
  const keys = req.allprop ? allPropKeys(r) : req.keys;
  const extra = req.calendarData ? [{ key: CALENDAR_DATA, value: calendarData(body ?? (await readBody(ctx.env, r.obj)), req, zone) }] : [];
  return propResponse(ctx, href.object(r.user, r.coll.slug, r.obj.name), r, keys, extra);
}

/** Bodies of `candidates`, loaded a page at a time so a large collection doesn't sit in memory at once. */
async function* withBodies(ctx: DavContext, collectionId: number, candidates: ObjectRow[]): AsyncGenerator<{ obj: ObjectWithBody; text: string }> {
  for (let i = 0; i < candidates.length; i += QUERY_PAGE) {
    const page = candidates.slice(i, i + QUERY_PAGE);
    const loaded = await getObjectsByName(ctx.env.DB, collectionId, page.map((o) => o.name), true);
    for (const obj of loaded.sort((a, b) => (a.name < b.name ? -1 : 1))) yield { obj, text: await readBody(ctx.env, obj) };
  }
}

async function multiget(ctx: DavContext, target: Resource, body: XmlElement): Promise<Response> {
  // hrefs are resolved one by one, so the request URI may be any collection in the user's tree
  if (target.kind !== "collection" && target.kind !== "object" && target.kind !== "home") {
    throw new HttpError(403, "calendar-multiget needs a calendar collection or calendar home");
  }
  const req = requestedKeys(body);
  const hrefs = children(body, NS.DAV, "href").map((h) => h.text.trim());
  if (hrefs.length === 0) throw new HttpError(400, "calendar-multiget needs at least one href");

  // group by collection so bodies load in a few queries
  const byCollection = new Map<string, { coll: CollectionRow; names: { href: string; name: string }[] }>();
  const responses = [];
  for (const h of hrefs) {
    const a = parseHref(h, ctx.url.href);
    if (a?.kind !== "object") {
      responses.push(statusResponse(h, 404));
      continue;
    }
    const parent = await collectionFor(ctx, a.user, a.collection);
    if (!parent) {
      responses.push(statusResponse(h, 404));
      continue;
    }
    const entry = byCollection.get(parent.slug) ?? { coll: parent, names: [] };
    entry.names.push({ href: h, name: a.object });
    byCollection.set(parent.slug, entry);
  }
  for (const { coll, names } of byCollection.values()) {
    const found = new Map((await getObjectsByName(ctx.env.DB, coll.id, names.map((n) => n.name), req.calendarData)).map((o) => [o.name, o]));
    for (const n of names) {
      const obj = found.get(n.name);
      responses.push(
        obj ? await objectResponse(ctx, { kind: "object", user: ctx.principal.username, coll, obj }, req, obj.body_inline ?? undefined) : statusResponse(n.href, 404),
      );
    }
  }
  return xmlResponse(multistatus(responses));
}

const collectionCache = new WeakMap<DavContext, Map<string, CollectionRow | null>>();

async function collectionFor(ctx: DavContext, user: string, slug: string): Promise<CollectionRow | null> {
  const cache = collectionCache.get(ctx) ?? new Map<string, CollectionRow | null>();
  collectionCache.set(ctx, cache);
  if (!cache.has(slug)) {
    const r = await resolve(ctx, { kind: "collection", user, collection: slug });
    cache.set(slug, r?.kind === "collection" ? r.coll : null);
  }
  return cache.get(slug)!;
}

/**
 * The zone for floating times: the request's C:timezone (an invalid one is the
 * client's error), else the collection's calendar-timezone (an invalid stored
 * one is ignored, so it can't break every query on the collection).
 */
function floatingZone(body: XmlElement, coll: CollectionRow): ICAL.Timezone | undefined {
  const requested = child(body, NS.CALDAV, "timezone")?.text;
  if (requested !== undefined) {
    const tz = parseTimezone(requested);
    if (!tz) throw new HttpError(403, "calendar timezone is not a valid VTIMEZONE", pre.caldav("valid-calendar-data"));
    return tz;
  }
  return collectionZone(coll);
}

/**
 * The calendar collections a calendar-query or free-busy-query searches: the
 * target's own collection, or on a calendar home with Depth 1 or infinity,
 * every collection the password can see (RFC 4791 §7.8, §7.10).
 */
async function searchedCollections(ctx: DavContext, target: Resource, report: string): Promise<CollectionRow[]> {
  if (target.kind === "collection" || target.kind === "object") return [target.coll];
  if (target.kind !== "home") throw new HttpError(403, `${report} needs a calendar collection or calendar home`);
  if ((ctx.request.headers.get("Depth") ?? "0").trim() === "0") return [];
  return (await childrenOf(ctx, target)).flatMap((r) => (r.kind === "collection" ? [r.coll] : []));
}

/** Candidate objects in one collection: just the target object, or the index pre-filter's matches. */
const candidatesIn = (ctx: DavContext, target: Resource, coll: CollectionRow, components: string[] | null, range: Range | null) =>
  target.kind === "object" ? Promise.resolve([target.obj]) : queryCandidates(ctx.env.DB, coll.id, components, range);

async function query(ctx: DavContext, target: Resource, body: XmlElement): Promise<Response> {
  let filter;
  try {
    filter = parseFilter(child(body, NS.CALDAV, "filter"));
  } catch (e) {
    if (e instanceof FilterError) throw new HttpError(403, e.message, pre.caldav(e.precondition));
    throw e;
  }
  const req = requestedKeys(body);
  const { components, range } = prefilterOf(filter);
  const responses = [];
  for (const coll of await searchedCollections(ctx, target, "calendar-query")) {
    const zone = floatingZone(body, coll);
    const candidates = await candidatesIn(ctx, target, coll, components, range);
    const asResource = (obj: ObjectRow) => ({ kind: "object" as const, user: ctx.principal.username, coll, obj });

    // A filter that only names component types is settled by the SQL pre-filter; an
    // ETag-only answer to it (the common "list my tasks" query) needs no bodies at all.
    if (filterIsComponentsOnly(filter) && !req.calendarData && target.kind !== "object") {
      responses.push(...(await Promise.all(candidates.map((obj) => objectResponse(ctx, asResource(obj), req)))));
      continue;
    }

    for await (const { obj, text } of withBodies(ctx, coll.id, candidates)) {
      let matched: boolean;
      try {
        // parse and evaluate together: parsing loads this object's time zones
        matched = calendarMatches(filter, parseCalendar(text), zone);
      } catch (e) {
        // One object the evaluator can't handle must not fail the whole report. It is
        // included: a false positive costs the client a download, a false negative hides data.
        console.error(`calendar-query: could not evaluate ${obj.name}; including it`, e);
        matched = !(e instanceof InvalidCalendar);
      }
      if (matched) responses.push(await objectResponse(ctx, asResource(obj), req, req.calendarData ? text : undefined, zone));
    }
  }
  return xmlResponse(multistatus(responses));
}

/** free-busy-query (§7.10): a VFREEBUSY of the VEVENTs in the range, read privilege required. */
async function freeBusy(ctx: DavContext, target: Resource, body: XmlElement): Promise<Response> {
  const range = boundedRange(child(body, NS.CALDAV, "time-range"));
  if (!range) throw new HttpError(400, "free-busy-query needs a time-range");
  const periods: BusyPeriod[] = [];
  for (const coll of await searchedCollections(ctx, target, "free-busy-query")) {
    const zone = collectionZone(coll);
    for await (const { obj, text } of withBodies(ctx, coll.id, await candidatesIn(ctx, target, coll, ["VEVENT"], range))) {
      try {
        periods.push(...busyPeriods(parseCalendar(text), range, zone));
      } catch (e) {
        console.error(`free-busy-query: could not evaluate ${obj.name}; leaving it out`, e);
      }
    }
  }
  return new Response(freeBusyCalendar(periods, range, nowSeconds()), { headers: { "Content-Type": "text/calendar; charset=utf-8" } });
}

async function syncCollection(ctx: DavContext, target: Resource, body: XmlElement): Promise<Response> {
  if (target.kind !== "collection") throw new HttpError(403, "sync-collection needs a calendar collection");
  // re-read so the token reflects the state the change query sees
  const coll = (await getCollection(ctx.env.DB, target.coll.user_id, target.coll.slug)) ?? target.coll;
  const req = requestedKeys(body);
  // RFC 6578 §6.3: 1 or infinite; a calendar collection has no child collections, so both mean the same here
  const level = child(body, NS.DAV, "sync-level")?.text.trim() ?? "1";
  if (level !== "1" && level !== "infinite") throw new HttpError(400, "sync-level must be 1 or infinite");
  const tokenText = child(body, NS.DAV, "sync-token")?.text.trim() ?? "";
  const limitText = child(child(body, NS.DAV, "limit"), NS.DAV, "nresults")?.text.trim();
  const limit = limitText ? Number(limitText) : null;
  if (limit !== null && !(Number.isInteger(limit) && limit > 0)) throw new HttpError(400, "invalid nresults");
  const self = href.collection(target.user, coll.slug);
  const invalidToken = () => new HttpError(403, "sync token is invalid or too old", pre.dav("valid-sync-token"));

  let changed: { name: string; revision: number }[];
  let listing: ObjectRow[] | null = null;
  if (tokenText === "") {
    listing = await listObjects(ctx.env.DB, coll.id);
    if (limit !== null && listing.length > limit) {
      throw new HttpError(507, "initial sync exceeds the requested limit", pre.dav("number-of-matches-within-limits"));
    }
    changed = listing.map((o) => ({ name: o.name, revision: coll.sync_revision }));
  } else {
    const token = parseSyncToken(tokenText);
    if (!token || token.collectionId !== coll.id || token.revision > coll.sync_revision || token.revision < coll.pruned_revision) {
      throw invalidToken();
    }
    const { results } = await ctx.env.DB.prepare(
      `SELECT object_name AS name, MAX(revision) AS revision FROM changes
       WHERE collection_id = ? AND revision > ? AND revision <= ? AND object_name IS NOT NULL
       GROUP BY object_name ORDER BY revision`,
    )
      .bind(coll.id, token.revision, coll.sync_revision)
      .all<{ name: string; revision: number }>();
    changed = results;
  }

  let newToken = syncToken(coll);
  const extra = [];
  if (limit !== null && changed.length > limit) {
    changed = changed.slice(0, limit);
    newToken = syncToken({ id: coll.id, sync_revision: changed.at(-1)!.revision });
    // RFC 6578 §3.6: a 507 response for the collection marks the result as truncated
    extra.push(statusResponse(self, 507));
  }

  // bodies only when calendar-data was asked for; the initial listing already has the metadata
  const rows: ObjectWithBody[] =
    listing && !req.calendarData
      ? listing.map((o) => ({ ...o, body_inline: null }))
      : await getObjectsByName(ctx.env.DB, coll.id, changed.map((c) => c.name), req.calendarData);
  const objects = new Map(rows.map((o) => [o.name, o]));
  const responses = [];
  for (const c of changed) {
    const obj = objects.get(c.name);
    responses.push(
      obj
        ? await objectResponse(ctx, { kind: "object", user: target.user, coll, obj }, req, obj.body_inline ?? undefined)
        : statusResponse(href.object(target.user, coll.slug, c.name), 404),
    );
  }
  return xmlResponse(multistatus([...responses, ...extra], [d("sync-token", newToken)]));
}

export async function report(ctx: DavContext, target: Resource): Promise<Response> {
  const body = await readXml(ctx.request);
  if (!body) throw new HttpError(400, "REPORT needs a body");
  const key = clark(body.ns, body.name);
  if (key === clark(NS.CALDAV, "calendar-multiget")) return multiget(ctx, target, body);
  if (key === clark(NS.CALDAV, "calendar-query")) return query(ctx, target, body);
  if (key === clark(NS.DAV, "sync-collection")) return syncCollection(ctx, target, body);
  if (key === clark(NS.CALDAV, "free-busy-query")) return freeBusy(ctx, target, body);
  throw new HttpError(403, `unsupported report ${key}`, pre.dav("supported-report"));
}
