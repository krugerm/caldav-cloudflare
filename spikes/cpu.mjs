// Spike 1: CPU cost of ical.js parsing and recurrence expansion.
// Runs in Node (same V8 engine as workerd); Worker CPU time excludes I/O,
// so process.cpuUsage() around pure computation is a fair proxy.
import ICAL from "ical.js";

const TZ = `BEGIN:VTIMEZONE
TZID:Europe/Nicosia
BEGIN:DAYLIGHT
TZOFFSETFROM:+0200
TZOFFSETTO:+0300
TZNAME:EEST
DTSTART:19700329T030000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0300
TZOFFSETTO:+0200
TZNAME:EET
DTSTART:19701025T040000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`;

function simpleEvent(i) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//spike//EN\r\n${TZ}\r\nBEGIN:VEVENT\r\nUID:simple-${i}@spike\r\nDTSTAMP:20261017T090000Z\r\nDTSTART;TZID=Europe/Nicosia:20261020T100000\r\nDTEND;TZID=Europe/Nicosia:20261020T110000\r\nSUMMARY:Meeting ${i}\r\nDESCRIPTION:Some description text for the meeting.\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

function recurringEvent(i, overrides = 0) {
  const freq = ["DAILY", "WEEKLY;BYDAY=MO,WE,FR", "WEEKLY", "MONTHLY;BYMONTHDAY=15"][i % 4];
  let s = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//spike//EN\r\n${TZ}\r\nBEGIN:VEVENT\r\nUID:rec-${i}@spike\r\nDTSTAMP:20261017T090000Z\r\nDTSTART;TZID=Europe/Nicosia:20240101T090000\r\nDTEND;TZID=Europe/Nicosia:20240101T093000\r\nRRULE:FREQ=${freq}\r\nEXDATE;TZID=Europe/Nicosia:20240103T090000\r\nSUMMARY:Recurring ${i}\r\nEND:VEVENT\r\n`;
  for (let k = 0; k < overrides; k++) {
    const d = String(10 + k).padStart(2, "0");
    s += `BEGIN:VEVENT\r\nUID:rec-${i}@spike\r\nDTSTAMP:20261017T090000Z\r\nRECURRENCE-ID;TZID=Europe/Nicosia:202610${d}T090000\r\nDTSTART;TZID=Europe/Nicosia:202610${d}T140000\r\nDTEND;TZID=Europe/Nicosia:202610${d}T143000\r\nSUMMARY:Moved ${k}\r\nEND:VEVENT\r\n`;
  }
  return s + "END:VCALENDAR\r\n";
}

function attachEvent(bytes) {
  const b64 = Buffer.alloc(Math.floor((bytes * 3) / 4), 7).toString("base64");
  // fold at 75 octets as RFC 5545 requires
  const line = `ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=application/pdf:${b64}`;
  const folded = line.match(/.{1,74}/g).join("\r\n ");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//spike//EN\r\nBEGIN:VEVENT\r\nUID:attach@spike\r\nDTSTAMP:20261017T090000Z\r\nDTSTART:20261020T100000Z\r\nDTEND:20261020T110000Z\r\nSUMMARY:With attachment\r\n${folded}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

// What a PUT does: parse, find components, read UID and date span.
function indexObject(text) {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const tz of comp.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(tz);
  }
  const subs = comp.getAllSubcomponents().filter((c) => c.name !== "vtimezone");
  const master = subs.find((c) => !c.hasProperty("recurrence-id")) ?? subs[0];
  const ev = new ICAL.Event(master);
  const start = ev.startDate?.toUnixTime();
  let end = ev.endDate?.toUnixTime();
  if (ev.isRecurring()) {
    const rrule = master.getFirstPropertyValue("rrule");
    end = rrule?.until ? rrule.until.toUnixTime() : null;
  }
  return { uid: master.getFirstPropertyValue("uid"), start, end };
}

// What calendar-query does per recurring object: expand within [from, to).
function expandInRange(text, from, to) {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const tz of comp.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(tz);
  }
  const events = comp.getAllSubcomponents("vevent");
  const master = new ICAL.Event(events.find((e) => !e.hasProperty("recurrence-id")));
  for (const e of events) if (e.hasProperty("recurrence-id")) master.relateException(e);
  const it = master.iterator();
  let hits = 0;
  let next;
  let guard = 0;
  while ((next = it.next()) && guard++ < 100000) {
    if (next.compare(to) >= 0) break;
    const det = master.getOccurrenceDetails(next);
    if (det.endDate.compare(from) > 0) hits++;
  }
  return hits;
}

function cpuMs(fn, reps) {
  // warm up so JIT state resembles a warm isolate
  for (let i = 0; i < 3; i++) fn();
  const t0 = process.cpuUsage();
  for (let i = 0; i < reps; i++) fn();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000 / reps;
}

function cpuMsCold(fn) {
  const t0 = process.cpuUsage();
  fn();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

const simple = simpleEvent(1);
const rec5 = recurringEvent(1, 5);
const big = attachEvent(1024 * 1024);

const coldPut = cpuMsCold(() => indexObject(simpleEvent(999)));
const results = {
  "PUT simple event (first call, cold JIT)": coldPut,
  "PUT simple event": cpuMs(() => indexObject(simple), 200),
  "PUT recurring event + 5 overrides": cpuMs(() => indexObject(rec5), 200),
  "PUT 1 MB inline ATTACH": cpuMs(() => indexObject(big), 10),
};

const from = ICAL.Time.fromDateTimeString("2026-10-01T00:00:00Z");
const to = ICAL.Time.fromDateTimeString("2026-11-01T00:00:00Z");
for (const n of [100, 300, 500]) {
  const objs = Array.from({ length: n }, (_, i) => recurringEvent(i, i % 3));
  results[`calendar-query 1 month, ${n} recurring (since 2024-01-01)`] = cpuMs(
    () => objs.forEach((o) => expandInRange(o, from, to)),
    3,
  );
}

for (const [k, v] of Object.entries(results)) console.log(`${v.toFixed(2).padStart(9)} ms  ${k}`);
