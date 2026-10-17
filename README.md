# CalDAV on Cloudflare

A CalDAV server for calendars and tasks that runs entirely on your own Cloudflare account: one Worker, a D1 database, an R2 bucket and a Queue. There is no server to run, patch or back up by hand. It fills the same role as Radicale or Baïkal.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/krugerm/caldav-cloudflare)

- Events (VEVENT), tasks (VTODO) and journals (VJOURNAL), for multiple users with multiple collections each.
- Efficient sync: strong ETags, `getctag`, and RFC 6578 `sync-collection`.
- Server-side time-range queries with recurrence (RRULE, RDATE, EXDATE, overrides, time zones).
- Objects are stored exactly as the client sent them and returned byte-for-byte.
- A change event on a Queue for every write, from any client, for other apps to consume.
- Per-device app passwords, optionally limited to some collections or to read-only access.
- MIT licensed.

## Deploy

### With the button

The Deploy to Cloudflare button above forks the repository into your GitHub account, creates the D1 database, R2 bucket and Queue, and asks for two secrets:

- `ADMIN_USERNAME`: the admin login and the first user's name.
- `ADMIN_PASSWORD`: a long random string. It protects `/admin` and is never used by calendar clients.

The repository's `deploy` script applies the D1 migrations after deploying. If `/admin` reports a missing table, the migrations didn't run; apply them once with `npx wrangler d1 migrations apply caldav --remote`.

### By hand

```sh
git clone https://github.com/krugerm/caldav-cloudflare && cd caldav-cloudflare
npm install
npx wrangler login
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npm run deploy        # wrangler deploy (creates D1, R2 and the Queue), then applies migrations
```

`wrangler deploy` creates the `caldav` database, `caldav-bodies` bucket and `caldav-changes` queue on the first run. To use existing resources, add their ids to `wrangler.jsonc`.

To use your own domain, add a custom domain or route to the Worker in the Cloudflare dashboard. Clients need HTTPS, which Cloudflare provides.

## Set up users and devices

1. Open `https://<your-worker>/admin` and log in with the admin secrets.
2. Create a user. Each new user gets a `calendar` collection for events and a `tasks` collection for tasks.
3. Issue an app password for each device, labelled with the device name. The password is shown once.
4. Add the account on the device:

| Client | Settings |
|---|---|
| Apple Calendar and Reminders (macOS, iOS) | Add a CalDAV account. Server `https://<your-worker>/`, username, app password. |
| DAVx⁵ (Android, with Tasks.org or jtx Board) | Log in with URL and user name. Base URL `https://<your-worker>/`. |
| Thunderbird | New calendar, on the network, location `https://<your-worker>/`, username, app password. |

Clients find the account through `/.well-known/caldav`. The URL layout is:

| Resource | URL |
|---|---|
| Principal | `/dav/principals/<user>/` |
| Calendar home | `/dav/calendars/<user>/` |
| Collection | `/dav/calendars/<user>/<collection>/` |
| Object | `/dav/calendars/<user>/<collection>/<name>.ics` |

### Creating calendars and task lists

Create new collections on the admin page. Apple Calendar and Reminders create calendars and lists with the `MKCALENDAR` method, which the Workers runtime rejects before the request reaches the server, so "New Calendar" and "New List" fail on Apple devices. DAVx⁵ creates collections with extended `MKCOL`, which works. See `docs/decisions.md` (D-010).

## Limitations

- **Scheduling:** no invitations, inbox or outbox (RFC 6638 / iMIP). Thunderbird sends invitations from your mail account instead.
- **Not included:** CardDAV (contacts), sharing between users, ACL editing, principal search, a web calendar.
- **METHOD property:** objects carrying `METHOD` (iTIP messages such as `METHOD:PUBLISH`) are refused with `403`, as RFC 4791 §4.1 requires. Import such files by removing the `METHOD` line first.
- **Partial retrieval:** `calendar-data` ignores `comp` and `prop` selectors and returns whole components. `expand` and `limit-recurrence-set` are supported.
- **Free plan:** normal syncing (sync-collection and multiget) fits the free plan's CPU limit. Time-range queries over many open-ended recurring items need the paid plan: a one-month query over 300 recurring series costs about 1.7 s of CPU (`docs/spikes.md`).

## Event stream

Every successful write (object created, updated or deleted; collection created, updated or deleted) puts one message on the `caldav-changes` Queue after the database commit:

```json
{
  "v": 1,
  "id": "17:1234",
  "type": "object.updated",
  "user": "alice",
  "collection": "tasks",
  "object": "milk.ics",
  "uid": "6C9E1F4A-2B3D-4E5F-8A7B-9C0D1E2F3A4B",
  "component": "VTODO",
  "etag": "\"4f6c0a1b2c3d4e5f60718293a4b5c6d7\"",
  "revision": 1234,
  "actor": "ap_Xk2c9Qe1v0Tz",
  "at": "2026-10-17T09:00:00Z"
}
```

- `type` is one of `object.created`, `object.updated`, `object.deleted`, `collection.created`, `collection.updated`, `collection.deleted`. Collection events have no `object`, `uid`, `component` or `etag`; deletions have no `etag`.
- Messages carry identifiers only. To read content, GET the object or use `calendar-multiget` with an app password, scoped to the collections you consume and read-only if you don't write.
- Delivery is at least once and may arrive out of order. `revision` increases per collection: keep the highest revision seen per `(collection, object)` and drop any event for that object with an older or equal revision.
- `actor` is the id of the app password that made the change (`admin` for admin-page changes), so a consumer can skip echoes of its own writes.
- A MOVE produces two events: `object.deleted` at the old address and `object.created` (or `object.updated`) at the new one.
- If sending fails after the commit, a cron job re-sends unpublished changes every minute. A change that fails 10 times is parked so it can't hold up the others; find parked changes with `SELECT * FROM changes WHERE published = 0 AND publish_attempts >= 10` and reset `publish_attempts` to retry them. A consumer that falls behind can also catch up with `sync-collection` from its last sync token.

Consume the queue from another Worker with a queue consumer binding, or with an HTTP pull consumer.

## Configuration

Variables in `wrangler.jsonc`:

| Variable | Default | Meaning |
|---|---|---|
| `QUOTA_BYTES` | 1 GiB | Per-user quota reported in `quota-available-bytes` (reported only, not enforced). App passwords limited to some collections see usage of those collections only, and no remaining space |
| `MAX_OBJECT_BYTES` | 10 MiB | Largest calendar object accepted |
| `R2_THRESHOLD_BYTES` | 256 KiB | Bodies at or above this size are stored in R2 instead of D1 |
| `CHANGE_RETENTION_DAYS` | 90 | How long the change log is kept; older sync tokens force a full resync |

Secrets: `ADMIN_USERNAME`, `ADMIN_PASSWORD`.

Crons: every minute (re-send unpublished events) and daily at 03:17 UTC (prune the change log, delete unreferenced R2 bodies).

## Admin API

The admin page's operations are also available as JSON, with the admin credentials over Basic auth:

```sh
A="admin:$ADMIN_PASSWORD"; H="https://<your-worker>"
curl -u "$A" "$H/admin/api/users"
curl -u "$A" -H 'Content-Type: application/json' -d '{"username":"bob"}' "$H/admin/api/users"
curl -u "$A" -H 'Content-Type: application/json' -d '{"label":"sync bot","scope":{"access":"read","collections":["tasks"]}}' "$H/admin/api/users/bob/passwords"
curl -u "$A" -X DELETE "$H/admin/api/users/bob/passwords/ap_..."
curl -u "$A" -H 'Content-Type: application/json' -d '{"slug":"work","displayname":"Work","components":["VEVENT","VTODO"]}' "$H/admin/api/users/bob/collections"
curl -u "$A" -X DELETE "$H/admin/api/users/bob/collections/work"
curl -u "$A" -X DELETE "$H/admin/api/users/bob"   # only once bob has no collections
```

## Development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev                  # local D1, R2 and Queue under wrangler dev
npm test                     # unit and protocol tests in the Workers runtime (Vitest)
npm run test:integration     # tsdav against a real wrangler dev
npm run typecheck
```

Layout:

| Path | What |
|---|---|
| `src/dav/` | WebDAV/CalDAV: routing, properties, PROPFIND, PROPPATCH, MKCOL, objects, MOVE, REPORTs, XML |
| `src/ical/` | iCalendar validation, index spans, time-range matching with recurrence, query filters |
| `src/store/` | D1 and R2 access; every write is one `db.batch()` |
| `src/events/` | Event schema and publishing |
| `src/admin/` | Admin page and JSON API |
| `src/auth/` | Basic auth with app passwords, scopes |
| `migrations/` | D1 schema |
| `tests/fixtures/` | iCalendar objects from RFC examples and client styles, checked byte-for-byte |
| `docs/` | Spike results, design decisions, client compatibility checklist |

The design is in `2026-10-17-caldav-cloudflare-design.md`. Decisions made during the build, where the design was silent or had to change, are in `docs/decisions.md`.

## License

MIT. See `LICENSE`.
