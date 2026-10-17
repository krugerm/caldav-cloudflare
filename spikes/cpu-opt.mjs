// Spike 1b: same expansion, skipping occurrence details until near the window.
import ICAL from "ical.js";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./cpu.mjs", import.meta.url), "utf8");
// reuse generators by evaluating the top half of cpu.mjs
const gen = src.split("// What a PUT does")[0].replace('import ICAL from "ical.js";', "");
const { recurringEvent } = new Function("ICAL", "Buffer", gen + "; return { recurringEvent };")(ICAL, Buffer);

function expandFast(text, from, to) {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const tz of comp.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);
  const events = comp.getAllSubcomponents("vevent");
  const master = new ICAL.Event(events.find((e) => !e.hasProperty("recurrence-id")));
  for (const e of events) if (e.hasProperty("recurrence-id")) master.relateException(e);
  const dur = master.duration;
  const neg = dur.clone(); neg.isNegative = !neg.isNegative; const lead = from.clone(); lead.addDuration(neg); // earliest start that can still overlap
  const it = master.iterator();
  let hits = 0, next, guard = 0;
  while ((next = it.next()) && guard++ < 100000) {
    if (next.compare(to) >= 0) break;
    if (next.compare(lead) < 0 && !master.exceptions[next.toString()]) continue;
    const det = master.getOccurrenceDetails(next);
    if (det.endDate.compare(from) > 0 && det.startDate.compare(to) < 0) hits++;
  }
  return hits;
}
function cpuMs(fn, reps) { for (let i = 0; i < 2; i++) fn(); const t0 = process.cpuUsage(); for (let i = 0; i < reps; i++) fn(); const d = process.cpuUsage(t0); return (d.user + d.system) / 1000 / reps; }
const from = ICAL.Time.fromDateTimeString("2026-10-01T00:00:00Z");
const to = ICAL.Time.fromDateTimeString("2026-11-01T00:00:00Z");
for (const n of [100, 300, 500]) {
  const objs = Array.from({ length: n }, (_, i) => recurringEvent(i, i % 3));
  console.log(`${cpuMs(() => objs.forEach((o) => expandFast(o, from, to)), 3).toFixed(1).padStart(8)} ms  ${n} recurring, skip details before window`);
}
// iterator cost alone, daily since 2024 (~1000 steps)
const daily = recurringEvent(0, 0);
console.log(`${cpuMs(() => expandFast(daily, from, to), 50).toFixed(2).padStart(8)} ms  one DAILY since 2024`);
