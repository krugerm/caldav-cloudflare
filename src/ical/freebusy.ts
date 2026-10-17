// free-busy-query (RFC 4791 §7.10): busy periods from VEVENTs, and the VFREEBUSY reply.
import type ICAL from "ical.js";
import type { ParsedCalendar } from "./calendar";
import { eachOccurrence, instanceBounds, masterLength, type Range } from "./timerange";

export type BusyType = "BUSY" | "BUSY-TENTATIVE";

export interface BusyPeriod {
  start: number;
  end: number;
  type: BusyType;
}

const upper = (c: ICAL.Component, name: string) => String(c.getFirstPropertyValue(name) ?? "").toUpperCase();

/**
 * Busy periods of one object inside the range, clipped to it. Per the §7.10
 * table: only VEVENTs count; transparent and cancelled instances are free;
 * a tentative one is BUSY-TENTATIVE; an instance with no duration is skipped.
 */
export function busyPeriods(cal: ParsedCalendar, range: Range, zone?: ICAL.Timezone): BusyPeriod[] {
  if (cal.component !== "VEVENT") return [];
  const out: BusyPeriod[] = [];
  eachOccurrence(cal, range.start - masterLength(cal, zone), range.end, zone, (o) => {
    const c = o.component;
    if (upper(c, "transp") === "TRANSPARENT") return;
    const status = upper(c, "status");
    if (status === "CANCELLED") return;
    const b = instanceBounds("VEVENT", o.times);
    if (!b || b.end <= b.start || b.end <= range.start || b.start >= range.end) return;
    out.push({ start: Math.max(b.start, range.start), end: Math.min(b.end, range.end), type: status === "TENTATIVE" ? "BUSY-TENTATIVE" : "BUSY" });
  });
  return out;
}

/** Merge overlapping or touching periods of the same type, sorted by start. */
export function mergePeriods(periods: BusyPeriod[]): BusyPeriod[] {
  const out: BusyPeriod[] = [];
  for (const type of ["BUSY", "BUSY-TENTATIVE"] as const) {
    const sorted = periods.filter((p) => p.type === type).sort((a, b) => a.start - b.start);
    for (const p of sorted) {
      const last = out.at(-1);
      if (last && last.type === type && p.start <= last.end) last.end = Math.max(last.end, p.end);
      else out.push({ ...p });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.type.localeCompare(b.type));
}

const utc = (s: number) => new Date(s * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** A VCALENDAR with one VFREEBUSY. One FREEBUSY line per period keeps every line short of the folding limit. */
export function freeBusyCalendar(periods: BusyPeriod[], range: Range, now: number): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//caldav-cloudflare//EN",
    "BEGIN:VFREEBUSY",
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(range.start)}`,
    `DTEND:${utc(range.end)}`,
    ...mergePeriods(periods).map((p) => `FREEBUSY;FBTYPE=${p.type}:${utc(p.start)}/${utc(p.end)}`),
    "END:VFREEBUSY",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}
