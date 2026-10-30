-- RateLimitRepository (agbossjs/agboss#483): a provider's limits shared by every instance. Each
-- key has a row that acquire and addToWindow lock (FOR UPDATE) before they count; a slot is a row
-- with a lease; a window is counted in buckets of one Clock millisecond; a pause (a 429, an open
-- circuit breaker) is a row.
CREATE TABLE agboss_rate_limit_keys (
  limit_key text PRIMARY KEY
);

CREATE TABLE agboss_rate_limit_slots (
  slot_id text PRIMARY KEY,
  slot_key text NOT NULL,
  holder_instance_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX agboss_rate_limit_slots_by_key ON agboss_rate_limit_slots (slot_key, expires_at);

CREATE TABLE agboss_rate_limit_window_buckets (
  window_key text NOT NULL,
  counted_at timestamptz NOT NULL,
  amount double precision NOT NULL,
  PRIMARY KEY (window_key, counted_at)
);

CREATE TABLE agboss_rate_limit_pauses (
  pause_key text PRIMARY KEY,
  paused_until timestamptz NOT NULL
);
