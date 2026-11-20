-- Stored responses for client-supplied Idempotency-Key headers on money-adjacent POSTs.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL,
  request_method   TEXT NOT NULL,
  request_path     TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  PRIMARY KEY (user_id, idempotency_key)
);
