// Time-range matching (RFC 4791 §9.9): a coarse span for the SQL index, and
// the exact per-instance test, with recurrence expansion.
import ICAL from "ical.js";
import { FLOATING_SLACK, isFloating, type ParsedCalendar } from "./calendar";

/** Unix seconds; null means unbounded on that side. */
export interface Span {
  start: number | null;
  end: number | null;
}

/** A query range in Unix seconds, end exclusive. Either side may be open. */
export interface Range {
  start: number;
  end: number;
}

const DAY = 86400;
/** Iteration cap per object; hitting it counts as a match (a false positive is safe). */
export const MAX_STEPS = 100_000;

/**
 * Seconds for a time. Floating times (and DATE values) are read in
 * `floatingZone` when given, else as UTC; index callers widen them instead.
 */
export function seconds(t: ICAL.Time, floatingZone?: ICAL.Timezone): number {
  if (floatingZone && isFloating(t)) {
    const c = t.clone();
    c.zone = floatingZone;
    return c.toUnixTime();
  }
  return t.toUnixTime();
}

const prop = (c: ICAL.Component, name: string) => c.getFirstPropertyValue(name) as ICAL.Time | ICAL.Duration | null;
const time = (c: ICAL.Component, name: string) => {
  const v = prop(c, name);
  return v instanceof ICAL.Time ? v : null;
};
const duration = (c: ICAL.Component) => {
  const v = prop(c, "duration");
  return v instanceof ICAL.Duration ? v.toSeconds() : null;
};

/**
 * One instance's times in seconds, after any recurrence shift. Fields are
 * absent when the property is.
 */
interface Instance {
  start?: number;
  startIsDate?: boolean;
  end?: number;
  duration?: number;
  due?: number;
  completed?: number;
  created?: number;
  floating: boolean;
}

function instanceOf(c: ICAL.Component, shift: number, zone?: ICAL.Timezone): Instance {
  const ds = time(c, "dtstart");
  const de = time(c, "dtend");
  const due = time(c, "due");
  const completed = time(c, "completed");
  const created = time(c, "created");
  const inst: Instance = { floating: [ds, de, due].some((t) => t && isFloating(t)) };
  if (ds) {
    inst.start = seconds(ds, zone) + shift;
    inst.startIsDate = ds.isDate;
  }
  if (de) inst.end = seconds(de, zone) + shift;
  const dur = duration(c);
  if (dur !== null) inst.duration = dur;
  if (due) inst.due = seconds(due, zone) + shift;
  if (completed) inst.completed = seconds(completed, zone);
  if (created) inst.created = seconds(created, zone);
  return inst;
}

/** The exact §9.9 test for one instance against [rs, re). */
function matches(kind: string, i: Instance, rs: number, re: number): boolean {
  if (kind === "VEVENT") {
    if (i.start === undefined) return false;
    const end = i.end ?? (i.duration !== undefined ? i.start + i.duration : i.startIsDate ? i.start + DAY : i.start);
    return end > i.start ? rs < end && re > i.start : rs <= i.start && re > i.start;
  }
  if (kind === "VTODO") {
    const s = i.start;
    if (s !== undefined && i.duration !== undefined) {
      const e = s + i.duration;
      return rs <= e && (re > s || re >= e);
    }
    if (s !== undefined && i.due !== undefined) return (rs < i.due || rs <= s) && (re > s || re >= i.due);
    if (s !== undefined) return rs <= s && re > s;
    if (i.due !== undefined) return rs < i.due && re >= i.due;
    if (i.completed !== undefined && i.created !== undefined) {
      return (rs <= i.created || rs <= i.completed) && (re >= i.created || re >= i.completed);
    }
    if (i.completed !== undefined) return rs <= i.completed && re >= i.completed;
    if (i.created !== undefined) return re > i.created;
    return true;
  }
  // VJOURNAL
  if (i.start === undefined) return false;
  return i.startIsDate ? rs < i.start + DAY && re > i.start : rs <= i.start && re > i.start;
}

/** The span §9.9 could match for one instance, before floating slack. */
function instanceSpan(kind: string, i: Instance): Span {
  if (kind === "VEVENT") {
    if (i.start === undefined) return { start: null, end: null };
    const end = i.end ?? (i.duration !== undefined ? i.start + i.duration : i.startIsDate ? i.start + DAY : i.start);
    return { start: i.start, end: Math.max(end, i.start) };
  }
  if (kind === "VTODO") {
    const s = i.start;
    if (s !== undefined && i.duration !== undefined) return { start: s, end: s + i.duration };
    if (s !== undefined && i.due !== undefined) return { start: Math.min(s, i.due), end: Math.max(s, i.due) };
    if (s !== undefined) return { start: s, end: s };
    if (i.due !== undefined) return { start: i.due, end: i.due };
    if (i.completed !== undefined && i.created !== undefined) {
      return { start: Math.min(i.created, i.completed), end: Math.max(i.created, i.completed) };
    }
    if (i.completed !== undefined) return { start: i.completed, end: i.completed };
    if (i.created !== undefined) return { start: i.created, end: null };
    return { start: null, end: null };
  }
  if (i.start === undefined) return { start: null, end: null };
  return { start: i.start, end: i.startIsDate ? i.start + DAY : i.start };
}

const isRecurring = (c: ICAL.Component) => c.hasProperty("rrule") || c.hasProperty("rdate");

/** Widen a span for floating times, which may be in any zone. */
function widen(s: Span, floating: boolean): Span {
  if (!floating) return s;
  return { start: s.start === null ? null : s.start - FLOATING_SLACK, end: s.end === null ? null : s.end + FLOATING_SLACK };
}

function union(a: Span | null, b: Span): Span {
  if (!a) return b;
  return {
    start: a.start === null || b.start === null ? null : Math.min(a.start, b.start),
    end: a.end === null || b.end === null ? null : Math.max(a.end, b.end),
  };
}

/** Length of the master instance, used to bound the end of a recurrence set. */
function instanceLength(kind: string, i: Instance): number {
  const sp = instanceSpan(kind, i);
  return sp.start !== null && sp.end !== null ? Math.max(0, sp.end - sp.start) : 0;
}

/**
 * Coarse span of the whole object for the SQL pre-filter. It may be wider
 * than the truth, never narrower: finite rules end at UNTIL (or the COUNTth
 * instance) plus the instance length; open-ended rules have no end.
 */
export function indexSpan(cal: ParsedCalendar): { span: Span; recurring: boolean } {
  const kind = cal.component;
  let span: Span | null = null;
  let floating = false;
  const recurring = cal.master !== null && isRecurring(cal.master);
  if (cal.master) {
    const inst = instanceOf(cal.master, 0);
    floating ||= inst.floating;
    span = instanceSpan(kind, inst);
    if (recurring) {
      // an RDATE may come before DTSTART, and may be floating when DTSTART isn't
      floating ||= hasFloatingRdate(cal.master);
      const earliest = Math.min(...rdates(cal.master).map((r) => r.start));
      const start = span.start === null ? null : Math.min(span.start, earliest);
      span = union(span, { start, end: recurrenceEnd(cal.master, kind, inst) });
    }
  }
  for (const o of cal.overrides) {
    const inst = instanceOf(o, 0);
    floating ||= inst.floating;
    span = union(span, instanceSpan(kind, inst));
  }
  return { span: widen(span ?? { start: null, end: null }, floating), recurring };
}

/** An RDATE instance: its start, and for VALUE=PERIOD its own end. */
interface RDateInstance {
  start: number;
  end?: number;
}

/** RecurExpansion yields an ICAL.Period for RDATE;VALUE=PERIOD and an ICAL.Time otherwise. */
const startOf = (v: ICAL.Time | ICAL.Period) => (v instanceof ICAL.Period ? v.start : v);

function periodEnd(p: ICAL.Period, zone?: ICAL.Timezone): number {
  if (p.end) return seconds(p.end, zone);
  return seconds(p.start, zone) + (p.duration ? p.duration.toSeconds() : 0);
}

function rdates(master: ICAL.Component, zone?: ICAL.Timezone): RDateInstance[] {
  return master.getAllProperties("rdate").flatMap((p) =>
    p.getValues().flatMap((v: unknown) => {
      if (v instanceof ICAL.Period) return [{ start: seconds(v.start, zone), end: periodEnd(v, zone) }];
      return v instanceof ICAL.Time ? [{ start: seconds(v, zone) }] : [];
    }),
  );
}

const hasFloatingRdate = (master: ICAL.Component) =>
  master.getAllProperties("rdate").some((p) => p.getValues().some((v: unknown) => {
    const t = v instanceof ICAL.Period ? v.start : v;
    return t instanceof ICAL.Time && isFloating(t);
  }));

/** Upper bound for the end of a recurrence set, or null when it is open-ended. */
function recurrenceEnd(master: ICAL.Component, kind: string, inst: Instance): number | null {
  const length = instanceLength(kind, inst);
  let last = inst.start ?? null;
  for (const p of master.getAllProperties("rrule")) {
    const rule = p.getFirstValue() as ICAL.Recur;
    if (rule.until) last = Math.max(last ?? 0, seconds(rule.until));
    else if (rule.count) {
      const n = lastByCount(master);
      if (n === null) return null;
      last = Math.max(last ?? 0, n);
    } else return null;
  }
  let end = last === null ? null : last + length;
  for (const r of rdates(master)) end = Math.max(end ?? 0, r.end ?? r.start + length);
  return end;
}

function lastByCount(master: ICAL.Component): number | null {
  const dtstart = time(master, "dtstart");
  if (!dtstart) return null;
  const it = new ICAL.RecurExpansion({ component: master, dtstart });
  let last: ICAL.Time | null = null;
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const next = it.next() as ICAL.Time | ICAL.Period | null;
    if (!next) return last ? seconds(last) : null;
    last = startOf(next);
  }
  return null;
}

/** One instance of an object: an override, a non-recurring master, or a master occurrence. */
export interface Occurrence {
  component: ICAL.Component;
  /** The instance's original start; null for a non-recurring master. */
  recurrenceId: ICAL.Time | null;
  /** Seconds the master's times move by for this instance; 0 for overrides and non-recurring masters. */
  shift: number;
  times: Instance;
  /** The end an RDATE;VALUE=PERIOD gives this instance, replacing DTEND or DURATION. */
  periodEnd?: number;
}

/** What a visitor returns: true stops the walk. */
type Visit = (o: Occurrence) => boolean | void;

/**
 * Walk the object's instances: every override, every RDATE (they may precede
 * DTSTART, and a PERIOD carries its own end), then the rule's occurrences
 * starting in [from, to). EXDATEs and overridden instances are skipped.
 * Returns "stopped" when the visitor stopped, "truncated" at MAX_STEPS.
 */
export function eachOccurrence(cal: ParsedCalendar, from: number, to: number, zone: ICAL.Timezone | undefined, visit: Visit): "done" | "stopped" | "truncated" {
  const overridden = new Set<number>();
  for (const o of cal.overrides) {
    const rid = time(o, "recurrence-id");
    if (rid) overridden.add(seconds(rid, zone));
    if (visit({ component: o, recurrenceId: rid, shift: 0, times: instanceOf(o, 0, zone) })) return "stopped";
  }
  const master = cal.master;
  if (!master) return "done";
  const base = instanceOf(master, 0, zone);
  // a task without DTSTART recurs from its DUE, as CalendarServer and most clients read it
  const anchor = time(master, "dtstart") ?? (cal.component === "VTODO" ? time(master, "due") : null);
  const anchorSeconds = base.start ?? base.due;
  if (!isRecurring(master) || !anchor || anchorSeconds === undefined) {
    return visit({ component: master, recurrenceId: null, shift: 0, times: base }) ? "stopped" : "done";
  }
  const occurrence = (t: ICAL.Time, end?: number): Occurrence => {
    const shift = seconds(t, zone) - anchorSeconds;
    const times = instanceOf(master, shift, zone);
    if (end === undefined) return { component: master, recurrenceId: t, shift, times };
    times.end = end;
    delete times.duration;
    return { component: master, recurrenceId: t, shift, times, periodEnd: end };
  };

  const excluded = new Set(
    master.getAllProperties("exdate").flatMap((p) => p.getValues().flatMap((v: unknown) => (v instanceof ICAL.Time ? [seconds(v, zone)] : []))),
  );
  const rdateStarts = new Set<number>();
  for (const p of master.getAllProperties("rdate")) {
    for (const v of p.getValues() as unknown[]) {
      const t = v instanceof ICAL.Period ? v.start : v;
      if (!(t instanceof ICAL.Time)) continue;
      const start = seconds(t, zone);
      rdateStarts.add(start);
      if (overridden.has(start) || excluded.has(start)) continue;
      if (visit(occurrence(t, v instanceof ICAL.Period ? periodEnd(v, zone) : undefined))) return "stopped";
    }
  }

  const it = new ICAL.RecurExpansion({ component: master, dtstart: anchor });
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const next = it.next() as ICAL.Time | ICAL.Period | null;
    if (!next) return "done";
    if (next instanceof ICAL.Period) continue; // visited with the RDATEs
    const occ = seconds(next, zone);
    if (occ >= to) return "done";
    if (occ < from || overridden.has(occ) || rdateStarts.has(occ)) continue;
    if (visit(occurrence(next))) return "stopped";
  }
  return "truncated";
}

/** Length of the master's instances, so callers can start a walk early enough. */
export function masterLength(cal: ParsedCalendar, zone?: ICAL.Timezone): number {
  return cal.master ? instanceLength(cal.component, instanceOf(cal.master, 0, zone)) : 0;
}

/** The exact §9.9 test for one instance. */
export const occurrenceMatches = (kind: string, o: Occurrence, range: Range) => matches(kind, o.times, range.start, range.end);

/**
 * Exact test: does any instance of this object fall in the range and, when
 * `also` is given, satisfy it (the comp-filter's other tests, applied to the
 * component that defines that instance)? `floatingZone` interprets floating
 * times (the collection or query zone). Hitting the iteration cap counts as a match.
 */
export function objectMatchesRange(
  cal: ParsedCalendar,
  range: Range,
  floatingZone?: ICAL.Timezone,
  also: (component: ICAL.Component) => boolean = () => true,
): boolean {
  const from = range.start - masterLength(cal, floatingZone);
  const result = eachOccurrence(cal, from, range.end, floatingZone, (o) => occurrenceMatches(cal.component, o, range) && also(o.component));
  return result !== "done";
}

/** Start and end of an instance in seconds, as §9.9 reads them; undefined when it has no start. */
export function instanceBounds(kind: string, i: Instance): { start: number; end: number } | undefined {
  if (kind === "VTODO") {
    const sp = instanceSpan(kind, i);
    return sp.start !== null && sp.end !== null ? { start: sp.start, end: sp.end } : undefined;
  }
  if (i.start === undefined) return undefined;
  const end = i.end ?? (i.duration !== undefined ? i.start + i.duration : i.startIsDate ? i.start + DAY : i.start);
  return { start: i.start, end: Math.max(end, i.start) };
}

/** Upper limit on REPEAT, so a hostile value can't spin the evaluator. */
const MAX_REPEAT = 1000;

/**
 * §9.9 for a VALARM inside `parent` (the master or an override): does any
 * trigger, including repetitions, fall in [start, end) for some instance?
 * Relative triggers are anchored on each instance's start, or its end
 * (DTEND, DUE, or start plus DURATION) with RELATED=END.
 */
export function alarmMatchesRange(cal: ParsedCalendar, parent: ICAL.Component, alarm: ICAL.Component, range: Range, zone?: ICAL.Timezone): boolean {
  const trigger = alarm.getFirstProperty("trigger");
  const value = trigger?.getFirstValue() as unknown;
  const repeatDuration = alarm.getFirstPropertyValue("duration") as unknown;
  const repeat = repeatDuration instanceof ICAL.Duration ? Math.min(Number(alarm.getFirstPropertyValue("repeat") ?? 0) || 0, MAX_REPEAT) : 0;
  const step = repeatDuration instanceof ICAL.Duration ? repeatDuration.toSeconds() : 0;
  const fires = (first: number) => {
    for (let k = 0; k <= repeat; k++) {
      const t = first + k * step;
      if (range.start <= t && t < range.end) return true;
    }
    return false;
  };
  if (value instanceof ICAL.Time) return fires(seconds(value, zone));
  if (!(value instanceof ICAL.Duration)) return false;

  const offset = value.toSeconds();
  const relatedEnd = trigger!.getParameter("related") === "END";
  const kind = cal.component;
  const anchor = (o: Occurrence) => {
    if (!relatedEnd) return o.times.start;
    if (kind === "VTODO") return o.times.due ?? (o.times.start !== undefined && o.times.duration !== undefined ? o.times.start + o.times.duration : undefined);
    return instanceBounds(kind, o.times)?.end;
  };
  const hit = (o: Occurrence) => {
    const a = anchor(o);
    return a !== undefined && fires(a + offset);
  };
  if (parent !== cal.master) {
    // an override is one instance; overrides are visited first
    let found = false;
    eachOccurrence(cal, 0, 0, zone, (o) => (o.component === parent ? ((found = hit(o)), true) : false));
    return found;
  }
  // triggers fire at start + lead + k * step, so only starts in this window can hit the range
  const lead = offset + (relatedEnd ? masterLength(cal, zone) : 0);
  const spread = repeat * Math.abs(step);
  const result = eachOccurrence(cal, range.start - lead - spread, range.end - lead + spread, zone, (o) => o.component === parent && hit(o));
  return result !== "done";
}

/** §9.9 for a date-valued property inside a prop-filter: start <= value < end. */
export function propertyMatchesRange(value: ICAL.Time, range: Range, floatingZone?: ICAL.Timezone): boolean {
  const v = seconds(value, floatingZone);
  return range.start <= v && range.end > v;
}
