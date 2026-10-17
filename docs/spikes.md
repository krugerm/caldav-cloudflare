# Spikes

Run on 2026-10-17 before building, per "Spikes before building" in the design doc.

## 1. CPU cost of parsing and recurrence

Scripts: `spikes/cpu.mjs`, `spikes/cpu-opt.mjs`, `spikes/cpu-iter.mjs`. Run with `node spikes/<name>.mjs`.

Method: ical.js 2.2.1 under Node 26 (V8, the engine workerd uses). Worker CPU time excludes I/O waits, so `process.cpuUsage()` around pure computation approximates it. Each figure is the mean over repeated runs after a warm-up, except the cold-JIT row. Recurring events use a `TZID` with a VTIMEZONE and start on 2024-01-01; the query window is October 2026, so a daily series iterates about 1,000 times before reaching it.

| Case | CPU per request |
|---|---|
| PUT, simple event, cold JIT (first request in a fresh isolate) | 10.8 ms |
| PUT, simple event | 1.2 ms |
| PUT, recurring event with 5 overrides | 0.9 ms |
| PUT, 1 MB object with inline `ATTACH` | 1.1 ms |
| calendar-query, 1 month, 100 open-ended recurring series | 970 ms (645 ms optimised) |
| calendar-query, 1 month, 300 open-ended recurring series | 2,900 ms (1,660 ms optimised) |
| calendar-query, 1 month, 500 open-ended recurring series | 4,760 ms (2,700 ms optimised) |
| one DAILY series since 2024, optimised | 11.8 ms |

"Optimised" skips `getOccurrenceDetails()` for instances that end before the window. `spikes/cpu-iter.mjs` shows the remaining cost is ical.js's `RecurIterator` itself: about 7 µs per step in UTC and 10 µs with a `TZID`. It has no fast-forward, so cost grows with the number of instances between DTSTART and the window.

### Findings

- **PUT fits the free plan** once the isolate is warm (about 1 ms). The first request in a cold isolate costs about 11 ms, which is at the free plan's 10 ms limit; Cloudflare applies that limit with some tolerance per request, so occasional cold PUTs should still succeed. This is unverified on a deployed Worker.
- **Typical sync needs no expansion.** Apple clients, DAVx⁵ and Thunderbird sync with `sync-collection` (or ctag plus `PROPFIND` of ETags) followed by `calendar-multiget`. None of these parse or expand anything, so the common path fits the free plan.
- **Time-range queries over recurring data need the paid plan.** A personal calendar with 20 to 50 open-ended series costs roughly 150 to 350 ms per one-month query; 500 series cost about 2.7 s. All are far inside the paid 30 s limit.

### Plan changes

- Implement the "skip details before the window" optimisation and the SQL pre-filter on `recur_until_utc`, so finite series that ended before the window are never parsed.
- Cap iteration per object (100,000 steps) so a pathological RRULE cannot exhaust the CPU budget; an object that hits the cap is included in results (a false positive is safe, a false negative loses data from the client's view).
- README states: free plan works for normal sync; time-range queries over many recurring items need the paid plan. This answers open question 1 in the design doc.
- An instance table materialised at PUT time was considered and rejected; see `docs/decisions.md` (D-002).

## 2. Apple Reminders behaviour

A live recording needs an Apple device with a CalDAV account configured against a stub server, which an unattended run cannot do. This spike instead compiles Reminders and Calendar behaviour from the source and issue trackers of servers that support them (Radicale, sabre/dav, rustical, Baïkal, DAViCal). The owner should confirm it with the manual checklist in `docs/compatibility.md`; see D-003.

### Requests Apple clients make, in order

1. `PROPFIND /.well-known/caldav` (Depth 0). Expects a redirect (301/302/307/308) to the DAV root, or a multistatus with `current-user-principal`.
2. `PROPFIND` on the root or principal for `current-user-principal`, `principal-URL`, `calendar-home-set`, `calendar-user-address-set`, `displayname`, `resourcetype`, `supported-report-set`, and Apple and calendarserver.org extensions (`email-address-set`, `dropbox-home-URL`, `notification-URL`, `schedule-inbox-URL`, `schedule-outbox-URL`, `calendar-proxy-read-for`, `calendar-proxy-write-for`).
3. `OPTIONS` on the calendar home. Reads the `DAV:` header for `calendar-access`; scheduling features are enabled only if `calendar-auto-schedule` is present.
4. `PROPFIND` Depth 1 on the calendar home, asking for about 30 properties per collection: `resourcetype`, `displayname`, `getctag`, `sync-token`, `supported-calendar-component-set`, `calendar-color`, `calendar-order`, `calendar-description`, `calendar-timezone`, `current-user-privilege-set`, `owner`, `supported-report-set`, `quota-available-bytes`, `quota-used-bytes`, `schedule-calendar-transp`, `pushkey`, `push-transports`, `source`, `refreshrate`, `invite`, `allowed-sharing-modes` and others.
5. For each changed collection: `REPORT sync-collection` (sync-level 1) when `supported-report-set` lists it, otherwise `PROPFIND` Depth 1 for `getetag`.
6. `REPORT calendar-multiget` for changed hrefs, asking for `getetag` and `calendar-data`.
7. Writes: `PUT` with `If-None-Match: *` for new objects and `If-Match` for updates; `DELETE` with `If-Match`. Reminders creates lists with `MKCALENDAR` restricted to `VTODO`, and edits list colour and name with `PROPPATCH`.

### Requirements this places on the server

- Every requested property the server doesn't support goes in a `404` propstat; the request still succeeds with 207. One unknown property must never fail a `PROPFIND`.
- `current-user-privilege-set` must include `write` (or `all`) or Apple marks the collection read-only.
- Reminders lists only collections whose `supported-calendar-component-set` contains `VTODO`; Calendar lists those containing `VEVENT`. A collection with both shows in both apps.
- `PUT` responses carry an `ETag` header only when the stored body equals the sent body byte-for-byte (RFC 4791 §5.3.4). This server never rewrites bodies, so it always returns one, and Apple skips the follow-up `GET`.
- `href` values must be consistent: collections end with `/`, the same percent-encoding on every response, and paths absolute.
- `PROPPATCH` of properties the server does not model (Apple sends several calendarserver.org and apple.com properties) should succeed and store them as dead properties; refusing them makes Apple retry on every sync.
- Reminders stores subtasks as `RELATED-TO` and ordering as `X-APPLE-SORT-ORDER`. Both survive because bodies are stored as sent.
- Apple sends `Depth: 1` `PROPFIND` requests with `Brief: t` or `Prefer: return=minimal`; honouring them is optional.

### Plan changes

- Store dead properties per collection (D-004).
- Return `404` propstats for every unknown property, in every `PROPFIND` and `REPORT`.
- Fixtures in `tests/fixtures/` include Apple-style VTODOs (with `X-APPLE-SORT-ORDER`, `RELATED-TO`, `VALARM` with `X-WR-ALARMUID`) and DAVx⁵/Tasks.org-style VTODOs (DUE-only, no dates).

## 3. Event stream gap recovery

An automated test covers this: `test/events.test.ts` ("recovers from a crash between the D1 commit and queue.send() through the cron") makes `queue.send()` throw after the D1 batch commits, checks that the change row stays unpublished, runs the scheduled handler, and checks that the cron sends the event and marks the row published.

Result: pass. The client's PUT returns 201 and the object is durable; the change row stays `published = 0`; a cron run inside the 30-second grace period sends nothing (so it can't race a request whose own send is still in flight); the next run sends exactly one message and marks the row; later runs don't re-send it. A second test fails the queue for 120 writes and confirms the cron drains them in pages of 100, oldest revision first.
