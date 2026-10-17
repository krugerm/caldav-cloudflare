// calendar-data expand and limit-recurrence-set (RFC 4791 §9.6.5, §9.6.6). These
// build a new representation for one REPORT response; the stored body is untouched.
import ICAL from "ical.js";
import { isFloating, type ParsedCalendar } from "./calendar";
import { eachOccurrence, masterLength, occurrenceMatches, seconds, type Occurrence, type Range } from "./timerange";

const DAY = 86400;

const clone = (c: ICAL.Component) => new ICAL.Component(structuredClone(c.toJSON()));
const time = (c: ICAL.Component, name: string) => {
  const v = c.getFirstPropertyValue(name) as unknown;
  return v instanceof ICAL.Time ? v : null;
};
const serialise = (c: ICAL.Component) => `${c.toString()}\r\n`;

/** A time at `sec`, in UTC; floating stays floating when no zone can place it. */
function fromSeconds(sec: number, floating: boolean): ICAL.Time {
  const t = ICAL.Time.fromJSDate(new Date(sec * 1000), true);
  if (floating) t.zone = ICAL.Timezone.localTimezone;
  return t;
}

/** `t` moved by `shift` seconds and written in UTC. DATE values move by whole days and stay DATEs. */
function moved(t: ICAL.Time, shift: number, zone?: ICAL.Timezone): ICAL.Time {
  if (t.isDate) {
    const c = t.clone();
    c.adjust(Math.round(shift / DAY), 0, 0, 0);
    return c;
  }
  return fromSeconds(seconds(t, zone) + shift, isFloating(t) && !zone);
}

function setTime(c: ICAL.Component, name: string, t: ICAL.Time) {
  c.removeAllProperties(name);
  c.addPropertyWithValue(name, t);
}

/** One instance as a standalone component: no rules, times in UTC, RECURRENCE-ID for recurring ones. */
function instanceComponent(o: Occurrence, zone?: ICAL.Timezone): ICAL.Component {
  const c = clone(o.component);
  for (const name of ["rrule", "rdate", "exdate", "exrule"]) c.removeAllProperties(name);
  for (const name of ["dtstart", "dtend", "due"]) {
    const t = time(o.component, name);
    if (t) setTime(c, name, moved(t, o.shift, zone));
  }
  if (o.periodEnd !== undefined) {
    const start = time(o.component, "dtstart")!;
    c.removeAllProperties("duration");
    setTime(c, "dtend", fromSeconds(o.periodEnd, isFloating(start) && !zone));
  }
  if (o.recurrenceId) setTime(c, "recurrence-id", moved(o.recurrenceId, 0, zone));
  return c;
}

/** A VCALENDAR with the calendar-level properties of `cal` and no components. */
function emptyLike(cal: ParsedCalendar): ICAL.Component {
  const out = new ICAL.Component("vcalendar");
  for (const p of cal.vcalendar.getAllProperties()) out.addProperty(new ICAL.Property(structuredClone(p.toJSON())));
  return out;
}

/**
 * §9.6.5: every instance overlapping the range as its own component, times
 * in UTC, VTIMEZONEs dropped. A non-recurring object comes back as one
 * component converted the same way.
 */
export function expandCalendar(cal: ParsedCalendar, range: Range, zone?: ICAL.Timezone): string {
  const instances: { start: number; c: ICAL.Component }[] = [];
  eachOccurrence(cal, range.start - masterLength(cal, zone), range.end, zone, (o) => {
    if (occurrenceMatches(cal.component, o, range)) instances.push({ start: o.times.start ?? o.times.due ?? 0, c: instanceComponent(o, zone) });
  });
  const out = emptyLike(cal);
  for (const { c } of instances.sort((a, b) => a.start - b.start)) out.addSubcomponent(c);
  return serialise(out);
}

/**
 * §9.6.6: the master and only the overrides that overlap the range or whose
 * RECURRENCE-ID falls in it. Returns null when nothing would be dropped, so
 * the caller can send the stored body unchanged.
 */
export function limitRecurrenceSet(cal: ParsedCalendar, range: Range, zone?: ICAL.Timezone): string | null {
  const dropped = new Set<number>();
  eachOccurrence(cal, 0, 0, zone, (o) => {
    if (o.component === cal.master || !o.recurrenceId) return;
    const rid = seconds(o.recurrenceId, zone);
    if (!occurrenceMatches(cal.component, o, range) && !(range.start <= rid && rid < range.end)) dropped.add(rid);
  });
  if (dropped.size === 0) return null;
  const out = clone(cal.vcalendar);
  for (const c of out.getAllSubcomponents(cal.component.toLowerCase())) {
    const rid = time(c, "recurrence-id");
    if (rid && dropped.has(seconds(rid, zone))) out.removeSubcomponent(c);
  }
  return serialise(out);
}
