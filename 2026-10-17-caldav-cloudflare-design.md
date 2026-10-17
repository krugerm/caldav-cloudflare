# CalDAV on Cloudflare: design

Status: draft, 2026-10-17. Author: Mike Kruger.

## Intent

An open source CalDAV server for calendars and tasks that runs entirely on a Cloudflare account: Workers, D1, R2 and Queues. Anyone can deploy it to their own account with no server to run, patch or back up by hand. It sits in the same niche as Radicale and Baïkal, minus the server.

It also publishes an event stream of every change, so other applications can keep their own copy of calendar and task data in sync with this server.

## Why now

No usable option exists. A search on 2026-10-17 found two prototypes:

- [onlca/CF-Workers-CalDAV](https://github.com/onlca/CF-Workers-CalDAV): MIT, about 20 KB of JavaScript, single user, 5 commits, last push October 2025. It has no `calendar-query`, time-range filtering or recurrence expansion.
- [William-Tong/cloudflare-worker-caldav](https://github.com/William-Tong/cloudflare-worker-caldav): no license (so its code can't be reused), about 45 KB of JavaScript, multi-user, has `sync-collection`, also lacks time-range queries and recurrence.

Code from the onlca repo may be reused under MIT. Mature servers (Radicale, sabre/dav, rustical) are references for protocol behaviour and client quirks.

## Goals

1. Real clients work for daily use: Apple Calendar and Reminders (macOS, iOS), DAVx⁵ with Tasks.org and jtx Board (Android), Thunderbird.
2. Calendars (VEVENT) and tasks (VTODO), multiple users, multiple collections per user.
3. Efficient sync: ETags, ctag, and RFC 6578 `sync-collection` so clients fetch only changes.
4. Correct recurrence: RRULE, RDATE, EXDATE, RECURRENCE-ID overrides and timezones, including server-side expansion for time-range queries.
5. A change event for every write, published to a Cloudflare Queue, whatever client made it.
6. One-command deploy (`wrangler deploy` after creating the D1 database, R2 bucket and Queue), with a Deploy to Cloudflare button in the README.
7. MIT license.

## Non-goals (v1)

- CardDAV (contacts).
- Scheduling between users or by email (iTIP/iMIP, CalDAV Scheduling RFC 6638): no invitations, no inbox/outbox.
- Sharing a collection between users, and ACL editing (`ACL` method). Read-only ACL properties are in scope (see Protocol scope).
- A web calendar UI. A minimal admin page for users and app passwords is in scope (see Administration).
- Importing from other servers. Clients can copy data across themselves.

## Anti-goals

These would make the project a failure even if it passes tests:

- Losing or silently rewriting client data. The server stores the iCalendar object exactly as the client sent it and returns it byte-for-byte on GET. Parsing feeds the index only.
- A client that "mostly works" with duplicates, lost edits or endless re-syncs. Apple Reminders and DAVx⁵ are the bar.
- Requiring a paid third-party service.
- Events that are lost or that report a change the database doesn't hold.

## Users and auth

- A **user** has a username and one or more **app passwords**. CalDAV clients only reliably support HTTP Basic auth, so each device gets its own app password.
- App passwords are server-generated random tokens (at least 128 bits), stored as SHA-256 hashes. Their entropy makes a slow hash unnecessary, which keeps CPU per request low. Each one has a label, a created time, a last-used time, and can be revoked.
- Each app password records its own id on every write it makes (see Event stream: `actor`).
- Optional per-app-password scoping to a set of collections, read-only or read-write, for machine consumers such as event-stream subscribers.

## Administration

- A bootstrap admin is created from a Worker secret on first request (`ADMIN_USERNAME`, `ADMIN_PASSWORD`).
- A small admin page at `/admin`, protected by the admin login, to create users, issue and revoke app passwords, and list collections. Plain server-rendered HTML.
- The same operations through a JSON admin API (`/admin/api/...`) for scripts.

## Protocol scope

| Area | Spec | v1 |
|---|---|---|
| Discovery | RFC 6764 `/.well-known/caldav`, RFC 5397 `current-user-principal` | yes |
| WebDAV core | RFC 4918 `OPTIONS`, `PROPFIND` (depth 0 and 1), `PROPPATCH`, `GET`, `HEAD`, `PUT`, `DELETE` | yes |
| | `MOVE` and `COPY` of calendar objects | `MOVE` within one user's collections only |
| | `LOCK`/`UNLOCK` | no (clients that need it: none of the target list) |
| CalDAV | RFC 4791 `MKCALENDAR`, `calendar-home-set`, `supported-calendar-component-set`, `calendar-multiget`, `calendar-query` with comp, prop and time-range filters | yes |
| | `free-busy-query`, `expand` and `limit-recurrence-set` in `calendar-data`, VALARM time ranges | yes, added after the build because RFC 4791 §2 requires every Section 7 report (`docs/decisions.md` D-022) |
| Sync | RFC 6578 `sync-collection`, `sync-token` | yes |
| | `getctag` (calendarserver.org extension) | yes |
| Conditional writes | `If-Match`, `If-None-Match: *`, `412 Precondition Failed` | yes |
| Properties | `displayname`, `calendar-description`, `calendar-color` (Apple), `calendar-order` (Apple), `calendar-timezone` | yes |
| Quotas | RFC 4331 `quota-available-bytes`, `quota-used-bytes` | yes, reporting only |
| Access control | RFC 3744 `current-user-privilege-set`, `owner`, `supported-privilege-set` (required by RFC 4791 §2; Apple clients read `current-user-privilege-set` to mark a collection read-only) | read-only properties; no `ACL` method |
| Capabilities | `DAV:` header on `OPTIONS` advertises `1, 3, calendar-access`; omits `calendar-auto-schedule` so clients know scheduling is absent | yes |

URL layout: `/dav/principals/<user>/`, `/dav/calendars/<user>/<collection>/`, `/dav/calendars/<user>/<collection>/<object>.ics`.

## Architecture

- **One Worker**, TypeScript. Builder's choice of router; it must pass custom WebDAV methods through.
- **D1** holds users, app passwords, collections, objects and the change log.
- **R2** holds calendar object bodies above a size threshold (start at 256 KB; inline `ATTACH` data is the usual cause). Below it, the body lives in D1. D1 caps a row at 2 MB.
- **Queues** carry the change events.
- **ical.js** (Mozilla) parses objects and expands recurrence. It runs on Workers.

### Writes are atomic

D1 rejects `BEGIN`/`COMMIT`, but `db.batch()` runs its statements as one transaction. Every write is one batch: upsert the object row, update its index rows, insert the change-log row, bump the collection's sync revision. If the body goes to R2, it is written to R2 first under a content-addressed key, then the batch runs. An orphaned R2 object after a failed batch is harmless and gets swept by a daily cron.

### Data model (sketch)

- `users(id, username, created_at)`
- `app_passwords(id, user_id, label, token_hash, scope_json, created_at, last_used_at, revoked_at)`
- `collections(id, user_id, slug, displayname, description, color, sort_order, timezone, components, sync_revision, created_at, deleted_at)`
- `objects(id, collection_id, name, uid, etag, component, body_inline, body_r2_key, size, dtstart_utc, dtend_utc, is_recurring, recur_until_utc, created_at, updated_at)`: `dtstart_utc`/`dtend_utc` span the whole recurrence set (open-ended RRULE: `recur_until_utc` NULL), so a time-range query can pre-filter in SQL, then expand precisely with ical.js.
- `changes(collection_id, revision, object_name, uid, kind, etag, actor, at)`: drives `sync-collection` and the event stream.

### Time-range matching

`dtstart_utc` and `dtend_utc` hold a coarse span used only to pre-filter in SQL. NULL means unbounded on that side. The exact match then runs in code against RFC 4791 §9.9.

VEVENT span: DTSTART to DTEND, or DTSTART + DURATION, or for a date-only DTSTART with neither, one day. Recurring events span from the first instance to `recur_until_utc` (NULL if open-ended).

VTODO span, following the §9.9 table:

| Properties present | Span |
|---|---|
| DTSTART and DURATION | DTSTART to DTSTART + DURATION |
| DTSTART and DUE | DTSTART to DUE |
| DTSTART only | DTSTART to DTSTART |
| DUE only | DUE to DUE |
| COMPLETED and/or CREATED, no DTSTART or DUE | earliest to latest of CREATED and COMPLETED; CREATED alone spans CREATED to unbounded |
| none of the above | unbounded on both sides, so the task matches every time range |

A recurring VTODO (RRULE requires DTSTART) spans from its first instance to `recur_until_utc`, as for events. The SQL pre-filter treats span bounds as inclusive, so it never drops a task the exact §9.9 test would match. Tests cover each row of the table, with Tasks.org and Apple Reminders fixtures for the DUE-only and undated cases.

The sync token is `<collection_id>:<revision>`. Deleted objects stay in `changes` so `sync-collection` reports them. Change-log rows older than 90 days are pruned; a client presenting an older token gets `403` with `valid-sync-token`, which makes it do a full resync.

### Validation on PUT

- Body parses as iCalendar, has exactly one UID, and its component types are allowed by the collection.
- UID unique within the collection (`409` with `no-uid-conflict` otherwise).
- Size limit (start at 10 MB per object).
- The server stores the body as sent. It never adds or rewrites properties.

## Event stream

Every successful write (create, update, delete, and collection create, update, delete) produces one message on the `caldav-changes` Queue after the D1 batch commits.

```json
{
  "v": 1,
  "id": "<collection_id>:<revision>",
  "type": "object.created | object.updated | object.deleted | collection.created | collection.updated | collection.deleted",
  "user": "<username>",
  "collection": "<slug>",
  "object": "<name>.ics",
  "uid": "<iCalendar UID>",
  "component": "VTODO | VEVENT | VJOURNAL",
  "etag": "<new etag, absent on delete>",
  "revision": 1234,
  "actor": "<app password id>",
  "at": "2026-10-17T09:00:00Z"
}
```

- Messages carry identifiers only. A consumer that needs the content GETs the object with its own app password, or reads it in a batch through `calendar-multiget`.
- Delivery is at least once and may arrive out of order. Revisions increase monotonically per collection, so consumers keep the highest `revision` seen per object (`collection` + `object`) and drop an event for that object whose revision is older or equal. Deduplicating per collection would lose a re-sent older event for one object behind a newer event for another.
- `actor` lets a consumer skip echoes of its own writes.
- Gap recovery: if `queue.send()` fails after the batch commits, the change is still in `changes`. Consumers can catch up with `sync-collection` from their last token, and the server's every-minute cron re-sends events for change rows marked unsent. A `published` flag on `changes` tracks this.
- The Queue is the only delivery mechanism in v1. Consumers are Workers on the same account (Queue consumer binding) or HTTP pull consumers.

## Testing

- Unit tests for parsing, the index, recurrence expansion and sync-token logic, run under the Workers Vitest pool against a local D1.
- Protocol integration tests driving the Worker with [tsdav](https://github.com/natelindev/tsdav) and with recorded request/response pairs from each target client.
- A manual compatibility checklist per client (create, edit, complete, delete, recurring task, recurring event with one exception, offline edit then sync, two devices editing one task) run before each release. Results go in `docs/compatibility.md`.
- Apple's CalDAVTester, if it can run against the deployed Worker, as a later addition.

## Spikes before building

1. **CPU cost of parsing and recurrence.** Measure Worker CPU time for two cases: (a) ical.js expansion of a few hundred recurring items for a one-month `calendar-query`; (b) a single PUT, which parses the body to validate it and build index rows, for a typical event, a recurring event with several overrides, and a 1 MB object with inline `ATTACH`. Free plan allows 10 ms CPU per request, paid 30 s. Pass: both cases fit on the paid plan comfortably; record whether free is viable for each, since a free plan that can't accept PUTs is not viable at all.
2. **Apple Reminders behaviour.** Record a real Reminders session against a stub server and list every request and property it needs. Reminders is the strictest client on the target list.
3. **Event stream gap recovery.** Kill the Worker between D1 commit and `queue.send()` (simulated) and confirm the cron re-sends.

## References

Implemented in v1:

| Spec | Covers |
|---|---|
| [RFC 4791](https://www.rfc-editor.org/rfc/rfc4791) | CalDAV: `MKCALENDAR`, `calendar-query`, `calendar-multiget`, time-range matching (§9.9) |
| [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918) | WebDAV: methods, properties, ETags, multistatus XML |
| [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) | iCalendar: VEVENT, VTODO, RRULE, VTIMEZONE |
| [RFC 6578](https://www.rfc-editor.org/rfc/rfc6578) | `sync-collection` and sync tokens |
| [RFC 6764](https://www.rfc-editor.org/rfc/rfc6764) | `/.well-known/caldav` discovery |
| [RFC 5397](https://www.rfc-editor.org/rfc/rfc5397) | `current-user-principal` |
| [RFC 3744](https://www.rfc-editor.org/rfc/rfc3744) | WebDAV ACL, read-only properties only |
| [RFC 4331](https://www.rfc-editor.org/rfc/rfc4331) | Quota properties |
| [caldav-ctag-02](https://github.com/apple/ccs-calendarserver/blob/master/doc/Extensions/caldav-ctag.txt) | `getctag` (Apple extension, not an RFC) |
| [RFC 7986](https://www.rfc-editor.org/rfc/rfc7986) | Newer iCalendar properties (`COLOR` and others); stored as sent |

Out of scope in v1, listed so the builder knows what is deliberately absent:

| Spec | Covers |
|---|---|
| [RFC 6638](https://www.rfc-editor.org/rfc/rfc6638) | CalDAV scheduling (iTIP inbox/outbox) |
| [RFC 6352](https://www.rfc-editor.org/rfc/rfc6352) | CardDAV |

Conformance testing: [Apple CalDAVTester](https://github.com/apple/ccs-caldavtester), an XML-scripted suite. The repo is archived but the suite still runs.

## Left to the builder

- Router library, XML parser and builder, project layout, test harness details.
- Exact index columns and D1 indexes.
- Admin page styling.
- R2 threshold and size limits within the ranges above.

## Open questions

1. **Free plan support.** Depends on spike 1. If the free plan can't serve recurrence queries, the README says paid plan required.

## Calls made in this document

The draft's author chose these without the project owner's sign-off. All are open to change:

- TypeScript; ical.js for parsing and recurrence.
- App passwords as hashed random tokens; no OAuth in v1.
- Bodies in D1 below 256 KB, R2 above.
- Change log kept 90 days.
- Event messages carry identifiers only.
- MIT license.
- Event deduplication per object, keyed on collection revision.
- No PATCH-style field-level update API; clients PUT whole objects.
- Scheduling (RFC 6638, iMIP) stays out of v1 and is a v2 candidate. It requires the server to modify stored objects (`SCHEDULE-STATUS`, organiser `PARTSTAT` updates), which conflicts with the byte-for-byte anti-goal, and iMIP ties each deployment to an email domain. A v2 design must state the exception to the anti-goal explicitly.
