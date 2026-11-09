-- A tracker is one person's workspace. Its secret key is shown once and stored only as a hash.
CREATE TABLE IF NOT EXISTS trackers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A stream is one extension install. seq counts every round that install ever captured, so a
-- retried upload never stores a round twice. gap_before marks missed rounds before this one.
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

-- Fixed-window request counters for rate limiting (bucket = what is limited, e.g. "ingest:<tracker>").
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
