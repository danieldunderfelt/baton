-- Keep start history after redemption so signing in cannot bypass throttling.
-- Client addresses are hashed by the Worker, never stored as raw IP addresses.
ALTER TABLE device_codes ADD COLUMN client_hash TEXT;
CREATE INDEX device_codes_client ON device_codes(client_hash, expires_at);
CREATE TABLE device_starts (
  device_code_hash TEXT PRIMARY KEY,
  client_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX device_starts_client ON device_starts(client_hash, created_at);
CREATE INDEX device_starts_created ON device_starts(created_at);

-- Derive bytes from the document so old deployments and existing rows are
-- accounted for without a separate counter to backfill or keep in sync.
ALTER TABLE profiles ADD COLUMN document_bytes INTEGER GENERATED ALWAYS AS (length(CAST(document AS BLOB))) VIRTUAL;
CREATE INDEX profiles_storage ON profiles(user_id, name, document_bytes);
-- Creation order stays stable when an existing share is refreshed.
DROP INDEX profiles_user;
CREATE INDEX profiles_page ON profiles(user_id, created_at DESC, code DESC);
