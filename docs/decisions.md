# Decisions

Calls made during the build where the design doc was silent or ambiguous, or where a spike changed the plan. One entry per decision.

## D-001 Test runner package

- **Question:** The design names the Workers Vitest pool. Which package?
- **Options:** `@cloudflare/vitest-pool-workers` (named in docs until 2026); `@cloudflare/vitest-plugin`.
- **Choice:** `@cloudflare/vitest-plugin` with Vitest 4.1.
- **Why:** The pool package's README marks it deprecated and renamed to the plugin. Same runtime (Miniflare, local D1/R2/Queues), maintained.

## D-002 Recurrence expansion at query time

- **Question:** Spike 1 showed ical.js iteration costs about 10 µs per instance, so a time-range query over hundreds of open-ended series costs seconds of CPU. Expand at query time, or materialise instances at write time?
- **Options:** (a) expand at query time with an SQL pre-filter; (b) store every instance in an `instances` table at PUT time and query it with SQL; (c) write a faster RRULE engine.
- **Choice:** (a), plus skipping occurrence details before the window and a 100,000-step cap per object.
- **Why:** Normal sync (`sync-collection` + `calendar-multiget`) never expands, so the cost only lands on explicit time-range queries, and those fit the paid plan with a wide margin. (b) needs a horizon for open-ended rules, multiplies D1 rows written (a daily series since 2024 is 1,000+ rows, against a free-plan budget of 100,000 rows written per day), and moves the CPU cost to every PUT. (c) is a large correctness risk for little gain.

## D-003 Spike 2 compiled from reference servers

- **Question:** Spike 2 asks for a recorded Apple Reminders session. The build runs unattended with no Apple device configured.
- **Options:** block until the owner records one; compile the behaviour from servers that support Reminders.
- **Choice:** Compile from Radicale, sabre/dav, rustical, Baïkal and DAViCal behaviour and issue history; the owner verifies with the manual checklist.
- **Why:** The goal forbids pausing. The requirements Reminders imposes (404 propstats for unknown properties, `current-user-privilege-set`, stable ETags, VTODO-only collections, dead properties on PROPPATCH) are well documented by those projects.

## D-004 Dead properties on collections

- **Question:** RFC 4918 allows a server to refuse PROPPATCH of properties it doesn't model. Apple clients set several calendarserver.org and apple.com properties.
- **Options:** refuse with 403; store them.
- **Choice:** Store unknown properties per collection as XML fragments in a JSON column, and return them on PROPFIND.
- **Why:** Radicale and sabre/dav store them, and Apple retries refused PROPPATCHes on every sync.

## D-005 Conditional writes inside one batch

- **Question:** `If-Match` and `If-None-Match` must hold at the moment of the write, and every write must be one `db.batch()`. D1 has no `BEGIN`, so a read-then-write has a race window.
- **Options:** read, check, then batch (racy); a `write_guard` table whose CHECK constraint rejects every row, with a first statement that inserts a row only when the precondition is false.
- **Choice:** The guard table. A batch starts with `INSERT INTO write_guard SELECT 1 WHERE NOT (<condition>)`; when the object changed since the handler read it, the CHECK fails and D1 rolls back the whole batch. The handler maps that to 412 (or retries once when the client sent no precondition).
- **Why:** It makes the precondition part of the transaction with no extra round trip, and the same guard serves PUT, DELETE and MOVE.

## D-006 PROPFIND Depth: infinity

- **Question:** RFC 4918 treats a missing `Depth` as infinity and lets servers refuse it with `propfind-finite-depth`.
- **Options:** refuse with 403; treat infinity and missing as 1.
- **Choice:** Treat a missing header as 1. An explicit `Depth: infinity` was also treated as 1 until D-023, which refuses it with `403` and `propfind-finite-depth`.
- **Why:** The URL tree is at most two levels below any resource a client PROPFINDs in practice, and Radicale and sabre/dav do the same. Refusing a missing header breaks clients that omit it during discovery.

## D-007 User creation in one batch

- **Question:** A new user gets two default collections, and their change rows need the collection ids, which need the user id.
- **Options:** two batches (user, then collections); random user ids chosen in the Worker so one batch can insert all of it.
- **Choice:** Random positive 48-bit user ids; collections are referenced by `(user_id, slug)` inside the batch.
- **Why:** Keeps "every write is one batch". A collision is negligible and would fail the batch on the primary key.

## D-008 Default collections

- **Question:** The design doesn't say whether new users start with any collections.
- **Options:** none (clients create them); one mixed VEVENT+VTODO collection; one of each.
- **Choice:** `calendar` (VEVENT) and `tasks` (VTODO).
- **Why:** Apple Reminders and Calendar each list only collections whose component set includes their type, and some clients can't create collections. Separate collections match what Baïkal and Nextcloud create.

## D-009 Events per change, not per request

- **Question:** "One event per write" needs a definition for MOVE, which removes an object from one place and adds it to another.
- **Options:** one `object.moved` event; a deleted event for the source and a created (or updated) event for the destination.
- **Choice:** One change row and one message per affected resource. MOVE logs two.
- **Why:** The design's event types have no move, and consumers keyed on `(collection, object)` need the deletion at the old address to stay correct. The tests assert one message per logged change row on every request.

## D-010 No MKCALENDAR; collections are created with extended MKCOL or the admin page

- **Question:** The design lists `MKCALENDAR`. During the build, workerd (1.20261012) rejected the method: `new Request(url, { method: "MKCALENDAR" })` throws, and under `wrangler dev` an incoming `MKCALENDAR` gets `501 Unrecognized request method` from the runtime before the Worker runs. `PROPFIND`, `REPORT`, `MKCOL` and `MOVE` all reach the Worker. Production runs the same runtime, so the same result is expected there (not verified on a deployed Worker).
- **Options:** drop collection creation from clients; support extended MKCOL (RFC 5689) and admin-side creation.
- **Choice:** Extended MKCOL with a `calendar` resource type creates calendar collections (DAVx⁵ uses this). The admin page and API also create collections. `MKCALENDAR` is left out of `Allow`, and `extended-mkcol` is added to the `DAV` header.
- **Why:** RFC 4791 §5.3.1 makes MKCALENDAR support RECOMMENDED, so leaving it out is compliant. Apple Calendar and Reminders create new calendars and lists with MKCALENDAR, so on Apple devices "New List" and "New Calendar" will fail; users create collections in the admin page instead, and the README and compatibility checklist say so. If workerd adds the method, a route can be added back.

## D-011 Bodies stored as exact UTF-8 text

- **Question:** The anti-goal requires byte-for-byte storage. Store bodies as BLOB or TEXT?
- **Options:** BLOB (exact for any bytes, but D1 returns BLOBs as number arrays and they can't be embedded in REPORT XML without decoding); TEXT, accepting only valid UTF-8.
- **Choice:** TEXT. PUT decodes with `TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`, which round-trips valid UTF-8 exactly, including a byte order mark. Bodies that aren't UTF-8 get `415` with `supported-calendar-data`.
- **Why:** RFC 5545 §3.1.4 makes UTF-8 the iCalendar charset, so refusing other encodings loses no valid data, and nothing stored can ever be altered by a lossy decode. R2 bodies are stored as the original bytes. The fixture suite checks the exact bytes, including a BOM file and an LF-only file.

## D-012 ETags from content

- **Question:** How to form ETags.
- **Options:** a revision counter; a hash of the body.
- **Choice:** The first 128 bits of the body's SHA-256, quoted. R2 keys use the full hash plus a per-PUT suffix (D-020).
- **Why:** Strong ETags must change whenever the bytes change; a content hash does that by construction, and a client that PUTs identical bytes again sees an unchanged ETag, which is correct.

## D-013 Status codes for rejected PUTs

- **Question:** RFC 4791 lists preconditions but leaves most status codes to the server.
- **Choice:** `403` for invalid data, wrong component and other calendar preconditions; `409` with `no-uid-conflict` (and the conflicting href) for a duplicate UID, as the design specifies; `413` for an oversized body; `415` for a non-`text/calendar` type or non-UTF-8 bytes; `409` when the parent collection doesn't exist (RFC 4918 §9.7.1); `412` when `If-Match` or `If-None-Match` fails.
- **Why:** These match sabre/dav and Radicale, which the target clients are tested against.

## D-014 Floating times and time zones in the index

- **Question:** Floating times (no zone, or a TZID without a VTIMEZONE) have no fixed UTC instant, but the index stores UTC seconds.
- **Choice:** The index reads floating times as UTC and widens the span by 14 hours each side. The exact time-range test reads them in the collection's `calendar-timezone` when set, else UTC. ical.js's timezone registry is reset and loaded with the object's own VTIMEZONEs on every parse.
- **Why:** The widened span can only add candidates, never drop one, which keeps the pre-filter safe. Resetting the registry stops one object's definition of a TZID from affecting another object in the same isolate.

## D-015 calendar-data is always the whole object

- **Question:** RFC 4791 §9.6 lets a client ask for part of an object (`comp`/`prop` children of `calendar-data`) or for expanded instances (`expand`, `limit-recurrence-set`, which the design lists as out of scope).
- **Options:** implement partial retrieval by rewriting iCalendar; return the stored object.
- **Choice:** Return the stored object, byte-for-byte, whatever the `comp`/`prop` selectors say. `expand` and `limit-recurrence-set` were added later (D-022).
- **Why:** None of the target clients use partial retrieval, and rewriting iCalendar is the kind of transformation the anti-goals exist to prevent. A client that asks for a subset and gets the whole object still has every property it asked for.

## D-016 Carriage returns in XML responses

- **Question:** XML parsers turn a raw CRLF in text into LF, so calendar data inside a REPORT reaches the client with different line endings from GET.
- **Choice:** CR is written as `&#13;` in all XML text. The request parser decodes numeric character references itself (fast-xml-parser leaves them), in the same pass as the predefined entities, so `&amp;#13;` stays literal.
- **Why:** The client then sees the exact stored bytes through every read path.

## D-017 sync-collection limits and time-range semantics for recurring objects

- **Question:** RFC 6578 `limit` handling, and whether a comp-filter's time-range and prop-filters must hold for the same recurrence instance.
- **Choice:** Incremental syncs over the limit are truncated in revision order with a `507` response for the collection and a token for the last included change. An initial sync over the limit returns `507` with `number-of-matches-within-limits`, because no token can describe a partial initial listing. For recurring objects the time-range was first evaluated over the whole recurrence set and the prop-filters over any component; D-023 replaced this with per-instance evaluation.
- **Why:** Truncation by revision gives a valid resumable token; the initial listing has no revision order once the log is pruned.

## D-018 Admin page scope and safety

- **Question:** The design asks for user and app-password management and a collection list. How much more, and how to protect a Basic-auth admin page from cross-site requests?
- **Choice:** The page and API also create and delete collections (needed because of D-010). A user can be deleted only once their collections are deleted and every event about them has been published, so no event is lost to the cascade. State-changing admin requests must carry an `Origin` equal to the server's origin, or a same-origin `Sec-Fetch-Site`; requests with neither header (curl, scripts) are allowed. Pages are served with a CSP that allows no scripts, and every interpolated value is HTML-escaped. Tokens appear once, on the page that issues them, and are never stored.
- **Why:** Browsers replay Basic credentials on cross-site form posts, so an origin check is the CSRF defence that works without sessions. Collection deletion publishes `collection.deleted` events, which a user deletion couldn't do after the cascade.

## D-019 Bootstrap admin login

- **Question:** The design creates the bootstrap admin from `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Is that password also a CalDAV login?
- **Choice:** No. The secrets authenticate `/admin` only (compared in constant time); the admin's user row is created on the first request with the default collections, and CalDAV access for it, as for every user, uses app passwords issued on the admin page.
- **Why:** The design says CalDAV clients authenticate with per-device app passwords. Keeping the deploy secret out of device configuration means rotating a device never touches the admin secret.

## D-020 Fixes from the code review

An independent review of the finished code found five P2 and four P3 issues. Each fix has a regression test in `test/regressions.test.ts` that fails on the code before the fix.

- **Control characters:** ical.js accepts C0 controls such as vertical tab, but XML 1.0 can't carry them even as character references, so one such object broke every REPORT returning it. PUT now refuses bodies containing them (`403 valid-calendar-data`). Refusing keeps the byte-for-byte rule; rewriting the character would break it.
- **Writes racing a collection DELETE:** object and collection batches now begin with a guard that the collection is still live, and change rows only attach to live collections. A PUT that loses the race gets `409` with nothing stored and no event; a second concurrent DELETE gets `404` and logs no second `collection.deleted`.
- **RDATE;VALUE=PERIOD and RDATEs before DTSTART:** ical.js yields a Period from the recurrence iterator for period RDATEs, which crashed the time-range test. RDATEs are now tested directly with their own end, and the index span starts at the earliest RDATE. As a backstop, an object the evaluator can't handle is included in calendar-query results instead of failing the whole report.
- **Byte order mark in R2 bodies:** `R2ObjectBody.text()` strips a leading BOM; bodies are now decoded with `ignoreBOM: true`, so GET returns the exact bytes and the declared `Content-Length`.
- **Slug reuse and the event dedupe rule:** consumers keep the highest revision per `(collection slug, object)`. A collection re-created under a deleted one's slug now continues that slug's revision sequence, so its events are never mistaken for stale ones. This holds while the deleted collection's row exists (until its change log ages out, 90 days by default).
- **Concurrent PROPPATCHes (P3):** the update batch requires the collection's dead properties to be unchanged since they were read; the handler re-reads and re-applies once, so dead properties aren't lost to a stale copy. A second review round pointed out that guarding on the revision instead would fail PROPPATCHes whenever objects were written meanwhile, so the guard compares the stored dead properties.
- **calendar-timezone (P3):** PROPPATCH and MKCOL refuse a value that isn't a VCALENDAR with a VTIMEZONE; an invalid stored value is ignored by queries instead of failing them.
- **DELETE retry (P3):** a second guard failure now returns `412` or `404` instead of `500`. The admin API's collection delete maps a lost race to `404` as well.
- **Floating RDATEs (P3, second round):** an RDATE without a zone on a master with one now widens the index span like any other floating time.

## D-021 Fixes from the third review

A third full review targeted platform limits, strict-client responses, security and pruning. It found four P2 issues; each fix has a regression test in `test/regressions.test.ts` ("third review round") that fails on the code before the fix. The schema changes went into `0001_initial.sql`, since nothing had been deployed.

- **Unsendable events blocked the re-send cron:** Queues cap a message at 128 KB and a batch at 256 KB, and the local emulation doesn't enforce either, so the tests couldn't see it. UIDs are now capped at 1 KB at PUT. Batches are split at 100 messages or 200 KB. When a batch fails, its rows are sent one at a time; a row that keeps failing has its `publish_attempts` counted and is parked after 10, so it can't hold up the rows behind it. A parked row stays unpublished and visible in `changes` for an operator.
- **`pruned_revision` could move backwards:** a row published after an earlier prune lowered the mark, reviving sync tokens whose change rows were gone. The prune now takes the maximum of the current mark and the new one.
- **ETag-only syncs read every body:** sync-collection and calendar-multiget now select bodies only when `calendar-data` is requested. A calendar-query whose filter only names component types (or is a bare VCALENDAR filter) answers from the index with no bodies; other queries load and evaluate bodies 50 at a time. This keeps normal syncing within the free plan's limits for large collections.
- **Control characters in property values:** PROPPATCH and MKCOL refuse values containing characters XML 1.0 can't carry (`403` per property), as PUT already did for bodies, so one bad value can't break a user's collection listing.
- **Lower-priority notes also fixed:** hrefs keep RFC 3986 path characters (`@ : + ! $ & ' ( ) * , ; =`) unencoded, so clients see the names they PUT; collection ids use `AUTOINCREMENT`, so a hard-deleted collection's id is never reused by a new one; `objects.body_r2_key` has an index for the R2 sweep.
- **Not changed:** the home PROPFIND runs two quota queries per collection (acceptable for typical collection counts), the R2 sweep restarts from the first page daily, and an open-ended `FREQ=SECONDLY` rule costs up to 100,000 iterations per query for its owner only.
- **R2 sweep race (P3):** keys were content-addressed, so a PUT of identical bytes could reuse a key the daily sweep was about to delete. Keys are now the content hash plus a random per-PUT suffix, so an unreferenced key older than a day can never become referenced. This gives up deduplication of identical large bodies, which saved little.

## D-022 free-busy-query, expand and VALARM time ranges

- **Question:** python-caldav's `caldav-server-tester` reported three gaps against RFC 4791: no `free-busy-query`, no `expand`, and VALARM time ranges that always matched. RFC 4791 §2 requires every report in Section 7, and the design had left the first two out of scope.
- **Choice:** Implement all three on one occurrence walker (`eachOccurrence` in `src/ical/timerange.ts`), which the time-range test already needed.
  - **VALARM time ranges (§9.9):** a trigger is anchored on each instance's start, or its end with `RELATED=END` (DTEND, DUE, or start plus DURATION), plus every `REPEAT`. Absolute triggers are tested once. Overrides use their own alarms.
  - **free-busy-query (§7.10):** only VEVENTs count. `TRANSP:TRANSPARENT` and `STATUS:CANCELLED` instances are free, and `STATUS:TENTATIVE` is `BUSY-TENTATIVE`. Instances with no duration are skipped. Periods are clipped to the range, merged per type, and written one `FREEBUSY` line each, in UTC. The report needs DAV:read, which aggregates `CALDAV:read-free-busy`, now listed in the privilege properties.
  - **expand (§9.6.5):** each instance overlapping the range becomes its own component with `RECURRENCE-ID`, no RRULE, RDATE or EXDATE, and times in UTC. VTIMEZONEs are dropped. Floating times stay floating unless a calendar or query time zone places them.
  - **limit-recurrence-set (§9.6.6):** overrides that neither overlap the range nor have a `RECURRENCE-ID` in it are removed. When nothing is removed, the stored body is sent unchanged.
- **Why the rewrite is allowed:** the anti-goal is about stored bodies and plain reads. `expand` and `limit-recurrence-set` build a new representation for one REPORT response only when the client asks for it. GET and every other read still return the stored bytes, and an object that can't be parsed is sent as stored.
- **Also fixed:** an EXDATE on an RDATE instance was ignored, so the removed instance still matched time-range queries.
- **Still not done:** `comp`/`prop` selectors (D-015), principal search (RFC 3744 §9.4), and initial sync with a `limit` (D-017).

## D-023 Fixes from Apple's CalDAVTester

- **Question:** Apple's CalDAVTester (archived, Python 2.7) runs about 700 scripted checks. Which of its failures are spec violations here, and which are CalendarServer behaviour?
- **How it was run:** against `wrangler dev` in Docker, with ten test users. The scratch copy of the tester sends extended MKCOL in place of MKCALENDAR, which the Workers runtime rejects (D-010); without that, seven scripts never got past setup. `errors.xml` runs last, because it stores objects CalendarServer rejects and this server accepts, and its cleanup doesn't remove them.
- **Result:** 726 checks. Before the fixes, 299 passed and 180 failed; after them, 346 passed, 133 failed, and nothing newly failed. Each fix has a test in `test/conformance.test.ts` that fails on the code before it.
- **Fixed:**
  - PUT or MOVE that replaces an object with one that has a different UID is refused with `no-uid-conflict` (RFC 4791 §5.3.2.1). UID conflicts now answer `403`, like the other preconditions, where they answered `409`.
  - PUT of a non-calendar media type answers `403 supported-calendar-data`, and non-UTF-8 data `403 valid-calendar-data`, both previously `415`.
  - An object with a `METHOD` property is refused (§4.1). A client that sends iTIP-style `METHOD:PUBLISH` objects will now see `403`; the spec forbids them, and rewriting the body to strip it would break the byte-for-byte guarantee.
  - Filters that test what can't exist are refused with `valid-filter` (§9.7): time ranges on VCALENDAR, VTIMEZONE or its observances; components nested where RFC 5545 doesn't allow them, such as VEVENT in VEVENT or anything inside VALARM; and prop-filter time ranges on properties that aren't dates.
  - `calendar-data` with a content type other than `text/calendar` or a version other than `2.0` is refused with `supported-calendar-data` (§9.6).
  - `calendar-timezone` and `C:timezone` must hold exactly one VTIMEZONE and no other component, with decodable observances (§5.2.2).
  - A sync-collection or REPORT asking for no properties gets a propstat with an empty `prop` and `200` for each member; a response with neither propstat nor status is invalid (RFC 4918 §14.24). `sync-level` must be `1` or `infinite` (RFC 6578 §6.3).
  - PROPFIND with an explicit `Depth: infinity` is refused with `propfind-finite-depth` (D-006); `allprop` with `propname` is `400`.
  - calendar-multiget, calendar-query and free-busy-query work on the calendar home. With Depth 1 or infinity, queries search every collection the password can see; with Depth 0 they return nothing.
  - With a time-range, a comp-filter's prop-filters and nested filters must hold for the same instance that falls in the range (replacing the looser D-017 test).
  - A recurring VTODO with DUE and no DTSTART recurs from DUE.
  - `xml:lang` on a dead property is stored and returned (RFC 4918 §4.3); `/.well-known/caldav/` with a trailing slash redirects like the bare form.
- **Not changed (CalendarServer behaviour, configuration or out of scope):** scheduling (RFC 6638), inbox and outbox; MKCALENDAR-specific status codes; the 100 MB quota the tests expect; `data:` sync tokens and the collection itself in initial sync results; `getcontentlength` on collections; `Location` headers on MOVE; `Last-Modified` on PROPFIND; a directory listing at `/.well-known/`; CalendarServer's attendee and attachment limits; refusing one UID in two calendars of a home; `RANGE=THISANDFUTURE` overrides; and a missing Depth header, which stays 1 (D-006).
- **Kept lenient on purpose:** PUTs whose TZIDs have no VTIMEZONE (read as floating, D-014), unknown escape sequences, and RECURRENCE-IDs that match no instance. Clients produce all three, and refusing them would lose data a client thinks it saved.
