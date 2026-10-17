// Parse and validate an iCalendar object resource (RFC 4791 §4.1). Parsing
// feeds the index and query filters only; the stored body is never rewritten.
import ICAL from "ical.js";

export const OBJECT_COMPONENTS = ["VEVENT", "VTODO", "VJOURNAL"] as const;
export const MAX_UID_BYTES = 1024;

export class InvalidCalendar extends Error {
  /** RFC 4791 precondition element name to report. */
  constructor(
    readonly precondition: "valid-calendar-data" | "valid-calendar-object-resource" | "supported-calendar-component",
    message: string,
  ) {
    super(message);
  }
}

export interface ParsedCalendar {
  vcalendar: ICAL.Component;
  /** VEVENT, VTODO or VJOURNAL. */
  component: string;
  uid: string;
  /** The component without RECURRENCE-ID, if any. */
  master: ICAL.Component | null;
  /** Components with RECURRENCE-ID. */
  overrides: ICAL.Component[];
}

/**
 * Parse a calendar object. VTIMEZONE definitions inside it are registered
 * with ical.js for the duration of synchronous use: the registry is reset
 * on every parse, so one object's definitions never leak into another's.
 */
export function parseCalendar(text: string): ParsedCalendar {
  let vcalendar: ICAL.Component;
  try {
    // ical.js rejects a byte order mark; the stored body keeps it
    vcalendar = new ICAL.Component(ICAL.parse(text.replace(/^﻿/, "")));
  } catch (e) {
    throw new InvalidCalendar("valid-calendar-data", `not valid iCalendar: ${(e as Error).message}`);
  }
  if (vcalendar.name !== "vcalendar") throw new InvalidCalendar("valid-calendar-data", "top-level component must be VCALENDAR");
  // RFC 4791 §4.1: stored objects are not iTIP messages
  if (vcalendar.hasProperty("method")) throw new InvalidCalendar("valid-calendar-object-resource", "calendar object resources must not have a METHOD property");
  registerTimezones(vcalendar);
  const subs = vcalendar.getAllSubcomponents().filter((c) => c.name !== "vtimezone");
  if (subs.length === 0) throw new InvalidCalendar("valid-calendar-object-resource", "no calendar component");
  const names = new Set(subs.map((c) => c.name.toUpperCase()));
  if (names.size > 1) throw new InvalidCalendar("valid-calendar-object-resource", "mixed component types in one resource");
  const component = [...names][0]!;
  if (!(OBJECT_COMPONENTS as readonly string[]).includes(component)) {
    throw new InvalidCalendar("supported-calendar-component", `${component} is not supported`);
  }
  const uids = new Set(subs.map((c) => c.getFirstPropertyValue("uid")));
  const uid = [...uids][0];
  if (uids.size !== 1 || typeof uid !== "string" || uid === "") {
    throw new InvalidCalendar("valid-calendar-object-resource", "every component needs the same, non-empty UID");
  }
  // UIDs travel in every event message, and Queues caps a message at 128 KB
  if (new TextEncoder().encode(uid).byteLength > MAX_UID_BYTES) {
    throw new InvalidCalendar("valid-calendar-object-resource", `UID longer than ${MAX_UID_BYTES} bytes`);
  }
  const masters = subs.filter((c) => !c.hasProperty("recurrence-id"));
  if (masters.length > 1) throw new InvalidCalendar("valid-calendar-object-resource", "more than one component without RECURRENCE-ID");
  return { vcalendar, component, uid, master: masters[0] ?? null, overrides: subs.filter((c) => c.hasProperty("recurrence-id")) };
}

export function registerTimezones(vcalendar: ICAL.Component): void {
  ICAL.TimezoneService.reset();
  for (const tz of vcalendar.getAllSubcomponents("vtimezone")) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      // a broken VTIMEZONE leaves times in that zone floating, which the index widens for
    }
  }
}

/**
 * A VCALENDAR holding exactly one valid VTIMEZONE and nothing else
 * (calendar-timezone, C:timezone; RFC 4791 §5.2.2), or null if it isn't one.
 */
export function parseTimezone(text: string): ICAL.Timezone | null {
  try {
    const vcal = new ICAL.Component(ICAL.parse(text.replace(/^﻿/, "")));
    const subs = vcal.name === "vcalendar" ? vcal.getAllSubcomponents() : [];
    const tz = subs.length === 1 && subs[0]!.name === "vtimezone" ? subs[0]! : null;
    if (!tz?.getFirstPropertyValue("tzid")) return null;
    const observances = tz.getAllSubcomponents().filter((c) => c.name === "standard" || c.name === "daylight");
    if (observances.length === 0) return null;
    for (const o of observances) {
      if (!o.hasProperty("dtstart") || !o.hasProperty("tzoffsetfrom") || !o.hasProperty("tzoffsetto")) return null;
      // ical.js decodes values lazily and throws on malformed ones
      for (const p of o.getAllProperties()) p.getValues();
    }
    return new ICAL.Timezone(tz);
  } catch {
    return null;
  }
}

/** True for DATE values and for DATE-TIMEs with no zone or an unknown TZID. */
export function isFloating(t: ICAL.Time): boolean {
  if (t.isDate) return true;
  const zone = t.zone;
  return !zone || zone === ICAL.Timezone.localTimezone || zone.tzid === "floating";
}

/** Floating times can be anywhere from UTC-12 to UTC+14 (RFC 4791 §9.9 leaves them to the server). */
export const FLOATING_SLACK = 14 * 3600;
