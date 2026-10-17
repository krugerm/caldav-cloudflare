import ICAL from "ical.js";
const TZ = (await import("node:fs")).readFileSync(new URL("./cpu.mjs", import.meta.url), "utf8").match(/const TZ = `([\s\S]*?)`;/)[1];
function cal(tzid) {
  const dt = tzid ? `DTSTART;TZID=Europe/Nicosia:20240101T090000` : `DTSTART:20240101T070000Z`;
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${tzid ? TZ + "\r\n" : ""}BEGIN:VEVENT\r\nUID:x\r\n${dt}\r\nDURATION:PT30M\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}
function cpu(fn, reps = 50) { for (let i = 0; i < 3; i++) fn(); const t = process.cpuUsage(); for (let i = 0; i < reps; i++) fn(); const d = process.cpuUsage(t); return ((d.user + d.system) / 1000 / reps).toFixed(2); }
const to = ICAL.Time.fromDateTimeString("2026-11-01T00:00:00Z");
for (const tz of [false, true]) {
  const comp = new ICAL.Component(ICAL.parse(cal(tz)));
  for (const t of comp.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(t);
  const ev = new ICAL.Event(comp.getFirstSubcomponent("vevent"));
  const toLocal = to.convertToZone(ev.startDate.zone);
  console.log(tz ? "TZID" : "UTC ", "steps only:", cpu(() => { const it = ev.iterator(); for (let i = 0; i < 1035; i++) it.next(); }),
    "| steps+compare(utc):", cpu(() => { const it = ev.iterator(); let n; while ((n = it.next()) && n.compare(to) < 0); }),
    "| steps+compareDateOnly local:", cpu(() => { const it = ev.iterator(); let n; while ((n = it.next()) && (n.year < 2026 || n.month < 11)); }));
}
