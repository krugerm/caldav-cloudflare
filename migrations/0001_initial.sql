-- Users, app passwords, collections, calendar objects and the change log.
-- Times are Unix seconds (UTC).

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE app_passwords (
  id TEXT PRIMARY KEY,                -- public id, recorded as the event actor
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,    -- hex SHA-256 of the token
  scope_json TEXT,                    -- NULL = full access; see src/auth/scope.ts
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX app_passwords_user ON app_passwords(user_id);

CREATE TABLE collections (
  -- AUTOINCREMENT: ids are never reused, so sync tokens and event ids of a
  -- hard-deleted collection can't collide with a new one
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  displayname TEXT,
  description TEXT,
  color TEXT,
  sort_order TEXT,
  timezone TEXT,                      -- VCALENDAR text from calendar-timezone
  components TEXT NOT NULL,           -- comma-separated, e.g. 'VEVENT,VTODO'
  dead_props TEXT NOT NULL DEFAULT '{}', -- JSON: {"{ns}name": "<xml fragment>"}
  sync_revision INTEGER NOT NULL DEFAULT 0,
  pruned_revision INTEGER NOT NULL DEFAULT 0, -- change rows at or below this are gone
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX collections_live_slug ON collections(user_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE objects (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  uid TEXT NOT NULL,
  etag TEXT NOT NULL,                 -- quoted strong ETag
  component TEXT NOT NULL,            -- VEVENT | VTODO | VJOURNAL
  body_inline TEXT,                   -- exact body when below the R2 threshold
  body_r2_key TEXT,                   -- content-addressed key otherwise
  size INTEGER NOT NULL,              -- body length in bytes
  dtstart_utc INTEGER,                -- time-range span; NULL = unbounded
  dtend_utc INTEGER,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (collection_id, name),
  UNIQUE (collection_id, uid)
);
CREATE INDEX objects_span ON objects(collection_id, component, dtstart_utc, dtend_utc);
CREATE INDEX objects_r2_key ON objects(body_r2_key) WHERE body_r2_key IS NOT NULL;

CREATE TABLE changes (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  type TEXT NOT NULL,                 -- event type, e.g. 'object.updated'
  object_name TEXT,                   -- NULL for collection events
  uid TEXT,
  component TEXT,
  etag TEXT,                          -- NULL on delete
  actor TEXT,                         -- app password id, or 'admin'
  at INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  publish_attempts INTEGER NOT NULL DEFAULT 0, -- failed sends; parked at MAX_ATTEMPTS
  PRIMARY KEY (collection_id, revision)
);
CREATE INDEX changes_unpublished ON changes(publish_attempts, at) WHERE published = 0;
CREATE INDEX changes_at ON changes(at);

-- Guard for conditional writes. A batch begins with
--   INSERT INTO write_guard SELECT 1 WHERE NOT (<precondition>)
-- which inserts nothing when the precondition holds and fails the CHECK
-- (rolling back the whole batch) when it doesn't.
CREATE TABLE write_guard (
  failed INTEGER,
  CONSTRAINT precondition_failed CHECK (failed IS NULL)
);
