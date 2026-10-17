// calendar-query filters (RFC 4791 §9.7): parse from XML, evaluate on a parsed object.
import ICAL from "ical.js";
import { NS, child, children, type XmlElement } from "../dav/xml";
import type { ParsedCalendar } from "./calendar";
import { alarmMatchesRange, objectMatchesRange, propertyMatchesRange, type Range } from "./timerange";

export type Collation = "i;ascii-casemap" | "i;octet" | "i;unicode-casemap";
const COLLATIONS: Collation[] = ["i;ascii-casemap", "i;octet", "i;unicode-casemap"];

export interface TextMatch {
  value: string;
  collation: Collation;
  negate: boolean;
}

export interface ParamFilter {
  name: string;
  isNotDefined: boolean;
  textMatch?: TextMatch;
}

export interface PropFilter {
  name: string;
  isNotDefined: boolean;
  timeRange?: Range;
  textMatch?: TextMatch;
  paramFilters: ParamFilter[];
}

export interface CompFilter {
  name: string;
  isNotDefined: boolean;
  timeRange?: Range;
  propFilters: PropFilter[];
  compFilters: CompFilter[];
}

export class FilterError extends Error {
  constructor(
    readonly precondition: "valid-filter" | "supported-collation" | "supported-filter",
    message: string,
  ) {
    super(message);
  }
}

const MIN = -8.64e12;
const MAX = 8.64e12;

/** Parse an iCalendar UTC date-time attribute ("20060104T000000Z") to seconds. */
function parseUtc(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim());
  if (!m) throw new FilterError("valid-filter", `time-range values must be UTC date-times: ${value}`);
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000;
}

function parseTimeRange(el: XmlElement | undefined): Range | undefined {
  if (!el) return undefined;
  if (el.attrs.start === undefined && el.attrs.end === undefined) throw new FilterError("valid-filter", "time-range needs start or end");
  const range = {
    start: el.attrs.start !== undefined ? parseUtc(el.attrs.start) : MIN,
    end: el.attrs.end !== undefined ? parseUtc(el.attrs.end) : MAX,
  };
  if (range.end <= range.start) throw new FilterError("valid-filter", "time-range end must be after start");
  return range;
}

/** A range element whose start and end are both required: expand, limit-recurrence-set, free-busy-query's time-range. */
export function parseBoundedRange(el: XmlElement | undefined): Range | undefined {
  if (!el) return undefined;
  if (el.attrs.start === undefined || el.attrs.end === undefined) throw new FilterError("valid-filter", `${el.name} needs start and end`);
  return parseTimeRange(el);
}

function parseTextMatch(el: XmlElement | undefined): TextMatch | undefined {
  if (!el) return undefined;
  const collation = (el.attrs.collation ?? "i;ascii-casemap") as Collation;
  if (!COLLATIONS.includes(collation)) throw new FilterError("supported-collation", `unsupported collation ${collation}`);
  return { value: el.text, collation, negate: el.attrs["negate-condition"] === "yes" };
}

const nameOf = (el: XmlElement) => {
  const name = el.attrs.name;
  if (!name) throw new FilterError("valid-filter", `${el.name} needs a name`);
  return name.toUpperCase();
};

function parseParamFilter(el: XmlElement): ParamFilter {
  return {
    name: nameOf(el),
    isNotDefined: !!child(el, NS.CALDAV, "is-not-defined"),
    textMatch: parseTextMatch(child(el, NS.CALDAV, "text-match")),
  };
}

function parsePropFilter(el: XmlElement): PropFilter {
  return {
    name: nameOf(el),
    isNotDefined: !!child(el, NS.CALDAV, "is-not-defined"),
    timeRange: parseTimeRange(child(el, NS.CALDAV, "time-range")),
    textMatch: parseTextMatch(child(el, NS.CALDAV, "text-match")),
    paramFilters: children(el, NS.CALDAV, "param-filter").map(parseParamFilter),
  };
}

export function parseCompFilter(el: XmlElement): CompFilter {
  return {
    name: nameOf(el),
    isNotDefined: !!child(el, NS.CALDAV, "is-not-defined"),
    timeRange: parseTimeRange(child(el, NS.CALDAV, "time-range")),
    propFilters: children(el, NS.CALDAV, "prop-filter").map(parsePropFilter),
    compFilters: children(el, NS.CALDAV, "comp-filter").map(parseCompFilter),
  };
}

/** Parse <C:filter>; its single child must be the VCALENDAR comp-filter. */
export function parseFilter(filter: XmlElement | undefined): CompFilter {
  const top = children(filter, NS.CALDAV, "comp-filter");
  if (top.length !== 1) throw new FilterError("valid-filter", "filter needs exactly one comp-filter");
  const parsed = parseCompFilter(top[0]!);
  if (parsed.name !== "VCALENDAR") throw new FilterError("valid-filter", "the top comp-filter must name VCALENDAR");
  validate(parsed);
  return parsed;
}

const isExtension = (name: string) => name.startsWith("X-");
/** Components each component may contain (RFC 5545 §3.6); extension components only where RFC 5545 allows them. */
const NESTING: Record<string, (name: string) => boolean> = {
  VCALENDAR: (n) => ["VEVENT", "VTODO", "VJOURNAL", "VFREEBUSY", "VTIMEZONE", "VAVAILABILITY"].includes(n) || isExtension(n),
  VEVENT: (n) => n === "VALARM" || isExtension(n),
  VTODO: (n) => n === "VALARM" || isExtension(n),
  VTIMEZONE: (n) => n === "STANDARD" || n === "DAYLIGHT",
  VAVAILABILITY: (n) => n === "AVAILABLE",
};
/** §9.9 defines time-range for these components only. */
const TIME_RANGE_COMPONENTS = new Set(["VEVENT", "VTODO", "VJOURNAL", "VFREEBUSY", "VALARM"]);
/** Date and date-time valued properties (RFC 5545 §3.8), the only ones a prop-filter time-range can test. */
const DATE_PROPERTIES = new Set([
  "DTSTART", "DTEND", "DUE", "COMPLETED", "CREATED", "DTSTAMP", "LAST-MODIFIED", "RECURRENCE-ID", "EXDATE", "RDATE", "ACKNOWLEDGED",
]);

/** §9.7: reject filters that test what can't exist, so a client's mistake isn't answered with "no matches". */
function validate(cf: CompFilter) {
  if (cf.timeRange && !TIME_RANGE_COMPONENTS.has(cf.name)) throw new FilterError("valid-filter", `time-range is not defined for ${cf.name}`);
  for (const pf of cf.propFilters) {
    if (pf.timeRange && !DATE_PROPERTIES.has(pf.name) && !isExtension(pf.name)) {
      throw new FilterError("valid-filter", `time-range is not defined for property ${pf.name}`);
    }
  }
  const allowed = NESTING[cf.name] ?? (() => false);
  for (const child of cf.compFilters) {
    if (!allowed(child.name)) throw new FilterError("valid-filter", `${child.name} cannot appear inside ${cf.name}`);
    validate(child);
  }
}

/**
 * What the SQL pre-filter can use: the object component types the query
 * asks for and, when there is exactly one, its time range.
 */
export function prefilterOf(f: CompFilter): { components: string[] | null; range: Range | null } {
  const wanted = f.compFilters.filter((c) => !c.isNotDefined);
  if (f.isNotDefined || wanted.length === 0 || wanted.length !== f.compFilters.length) return { components: null, range: null };
  return { components: wanted.map((c) => c.name), range: wanted.length === 1 ? (wanted[0]!.timeRange ?? null) : null };
}

/**
 * True when the filter only selects component types (each child comp-filter
 * is just a name), so the SQL pre-filter on the component column decides it.
 */
export function filterIsComponentsOnly(f: CompFilter): boolean {
  if (f.isNotDefined || f.propFilters.length > 0) return false;
  if (f.compFilters.length === 0) return true; // a bare VCALENDAR filter matches every object
  const { components } = prefilterOf(f);
  return (
    components !== null &&
    f.compFilters.every((c) => !c.timeRange && c.propFilters.length === 0 && c.compFilters.length === 0 && c.name !== "VTIMEZONE")
  );
}

function fold(s: string, collation: Collation): string {
  if (collation === "i;octet") return s;
  if (collation === "i;ascii-casemap") return s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  return s.normalize("NFKD").toLowerCase();
}

/** RFC 4791 §9.7.5: substring match, optionally negated. */
function textMatches(tm: TextMatch, values: string[]): boolean {
  const needle = fold(tm.value, tm.collation);
  const hit = values.some((v) => fold(v, tm.collation).includes(needle));
  return tm.negate ? !hit : hit;
}

function propertyText(p: ICAL.Property): string[] {
  return p.getValues().map((v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)));
}

function paramMatches(pf: ParamFilter, p: ICAL.Property): boolean {
  const v = p.getParameter(pf.name.toLowerCase());
  if (pf.isNotDefined) return v === undefined || v === null;
  if (v === undefined || v === null) return false;
  const values = Array.isArray(v) ? v.map(String) : [String(v)];
  return pf.textMatch ? textMatches(pf.textMatch, values) : true;
}

function propMatches(pf: PropFilter, c: ICAL.Component, zone?: ICAL.Timezone): boolean {
  const props = c.getAllProperties(pf.name.toLowerCase());
  if (pf.isNotDefined) return props.length === 0;
  return props.some((p) => {
    if (pf.timeRange) {
      const v = p.getFirstValue();
      if (!(v instanceof ICAL.Time) || !propertyMatchesRange(v, pf.timeRange, zone)) return false;
    }
    if (pf.textMatch && !textMatches(pf.textMatch, propertyText(p))) return false;
    return pf.paramFilters.every((f) => paramMatches(f, p));
  });
}

/** Filters on components inside an object component (VALARM). */
function nestedMatches(cf: CompFilter, cal: ParsedCalendar, parent: ICAL.Component, zone?: ICAL.Timezone): boolean {
  const comps = parent.getAllSubcomponents(cf.name.toLowerCase());
  if (cf.isNotDefined) return comps.length === 0;
  return comps.some(
    (c) =>
      // §9.9 defines a time-range only for VALARM among nested components
      (!cf.timeRange || cf.name !== "VALARM" || alarmMatchesRange(cal, parent, c, cf.timeRange, zone)) &&
      cf.propFilters.every((p) => propMatches(p, c, zone)) &&
      cf.compFilters.every((n) => nestedMatches(n, cal, c, zone)),
  );
}

/** Evaluate the VCALENDAR comp-filter against a parsed object. Call right after parseCalendar. */
export function calendarMatches(f: CompFilter, cal: ParsedCalendar, zone?: ICAL.Timezone): boolean {
  if (f.isNotDefined) return false;
  if (!f.propFilters.every((p) => propMatches(p, cal.vcalendar, zone))) return false;
  return f.compFilters.every((cf) => {
    if (cf.name === "VTIMEZONE") {
      const tzs = cal.vcalendar.getAllSubcomponents("vtimezone");
      return cf.isNotDefined ? tzs.length === 0 : tzs.length > 0;
    }
    const comps = cal.component === cf.name ? [cal.master, ...cal.overrides].filter((c): c is ICAL.Component => c !== null) : [];
    if (cf.isNotDefined) return comps.length === 0;
    if (comps.length === 0) return false;
    const fits = (c: ICAL.Component) => cf.propFilters.every((p) => propMatches(p, c, zone)) && cf.compFilters.every((n) => nestedMatches(n, cal, c, zone));
    // with a time-range, the other tests apply to the instance inside the range, not to any component (D-023)
    return cf.timeRange ? objectMatchesRange(cal, cf.timeRange, zone, fits) : comps.some(fits);
  });
}
