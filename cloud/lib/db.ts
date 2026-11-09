import postgres from 'postgres';

// One pool per server instance. Serverless hosts reuse it across warm invocations.
const g = globalThis as unknown as {__sql?: postgres.Sql; __migrated?: boolean};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trackers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rounds (
  id           bigserial PRIMARY KEY,
  tracker_id   uuid NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  stream       text NOT NULL,
  seq          integer NOT NULL,
  value        numeric(12, 2) NOT NULL CHECK (value >= 1),
  gap_before   boolean NOT NULL DEFAULT false,
  site         text,
  captured_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tracker_id, stream, seq)
);
CREATE INDEX IF NOT EXISTS rounds_live ON rounds (tracker_id, id);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
`;

export function db(): postgres.Sql {
  if (!g.__sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL;
    if (!url) throw new Error('DATABASE_URL, POSTGRES_URL, or STORAGE_URL is not set');
    g.__sql = postgres(url, {max: 5, idle_timeout: 20, onnotice: () => {}});
    if (!g.__migrated) {
      g.__migrated = true;
      g.__sql.unsafe(SCHEMA).catch(e => console.error('auto-migration notice:', e?.message || e));
    }
  }
  return g.__sql;
}
