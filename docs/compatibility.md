# Client compatibility

Run this checklist against a deployed Worker before each release. Use a fresh user with the default `calendar` and `tasks` collections, plus one extra collection created on the admin page. Record the client version, OS version, date and result for each row.

Status values: `pass`, `fail` (with a note), `n/a`, `not yet run`.

## Checklist

Each client runs every step that applies to it.

1. **Add account:** discovery from the bare server URL finds the principal and both default collections.
2. **Create:** a new event (Calendar apps) or task (task apps) appears on a second device after sync.
3. **Edit:** a change to title, time or due date reaches the second device.
4. **Complete:** marking a task done sets `STATUS:COMPLETED` and `COMPLETED`, and the second device shows it done.
5. **Delete:** the item disappears on the second device.
6. **Recurring task:** a repeating task shows its next occurrence after completion.
7. **Recurring event with one exception:** moving one instance of a weekly event leaves the others in place on both devices.
8. **Offline edit, then sync:** an edit made in airplane mode syncs once online, with no duplicate.
9. **Two devices editing one task:** concurrent edits end in one version on both devices, with no duplicate and no endless re-sync (the server answers the loser with 412 and the client refetches).
10. **New collection from the client:** expected to fail on Apple clients (D-010); create it on the admin page and confirm it appears after a refresh.
11. **Read-only app password:** a password issued as read-only shows the collections as read-only and refuses edits.

## Results

| Client | Version | Steps 1-9 | Step 10 | Step 11 | Notes |
|---|---|---|---|---|---|
| Apple Calendar (macOS) | | not yet run | not yet run (expected fail) | not yet run | |
| Apple Calendar (iOS) | | not yet run | not yet run (expected fail) | not yet run | |
| Apple Reminders (macOS) | | not yet run | not yet run (expected fail) | not yet run | Subtasks (`RELATED-TO`) and list order (`X-APPLE-SORT-ORDER`) must survive edits from other clients |
| Apple Reminders (iOS) | | not yet run | not yet run (expected fail) | not yet run | |
| DAVx⁵ + Tasks.org (Android) | | not yet run | not yet run | not yet run | DAVx⁵ creates collections with extended MKCOL |
| DAVx⁵ + jtx Board (Android) | | not yet run | not yet run | not yet run | Also covers VJOURNAL in a journal collection |
| DAVx⁵ + Android calendar | | not yet run | not yet run | not yet run | |
| Thunderbird | | not yet run | n/a | not yet run | |

## What automated tests already cover

- `tsdav` against `wrangler dev`: discovery through `/.well-known/caldav`, collection listing, create, fetch, conditional update (including a refused stale ETag), multiget, delete, time-range queries with recurrence, `sync-collection`, ctag changes, extended MKCOL, and the runtime's `501` for MKCALENDAR (`test-integration/tsdav.test.ts`).
- Byte-for-byte storage of fixtures in Apple, DAVx⁵/Tasks.org and Thunderbird styles (`tests/fixtures/`, `test/objects.test.ts`).
- The request sequence compiled in `docs/spikes.md` (spike 2) is exercised by `test/propfind.test.ts`, `test/reports.test.ts` and `test/collections.test.ts`.

## External conformance suites

Run by hand against `wrangler dev`; none is part of `npm test`.

| Suite | Version | Date | Result |
|---|---|---|---|
| python-caldav `caldav-server-tester` | 1.5.0 | 2026-10-17 | No unexpected results after D-022 and D-023. Still reported: MKCALENDAR blocked (D-010), initial sync with a limit refused (D-017), principal search and scheduling unsupported |
| python-caldav functional tests (`tests/test_caldav.py`, `tests/test_async_integration.py`) | 3.5.0 | 2026-10-17 | 115 passed, 0 failed, 12 skipped (scheduling, principal search), using the feature profile the server-tester measured |
| Apple CalDAVTester, `CalDAV` scripts | archived 2024 | 2026-10-17 | 726 checks: 346 passed, 133 failed, 247 skipped by feature. The failures are scheduling, CalendarServer behaviour and configuration (D-023); the tester's MKCALENDAR requests were sent as extended MKCOL |

Automated tests can't confirm how a real client reacts to the server's responses, so this checklist stays manual.
