BEGIN;

CREATE TABLE IF NOT EXISTS ingestion.source_health (
  source_health_id char(64) PRIMARY KEY CHECK (source_health_id ~ '^[a-f0-9]{64}$'),
  contract_version text NOT NULL CHECK (contract_version = 'source-health.v1'),
  source_name text NOT NULL CHECK (btrim(source_name) <> ''),
  run_id text NOT NULL CHECK (btrim(run_id) <> ''),
  envelope_id char(64) NOT NULL CHECK (envelope_id ~ '^[a-f0-9]{64}$'),
  source_status text NOT NULL CHECK (source_status IN ('ok', 'stale', 'outage')),
  requested_at timestamptz NOT NULL,
  observed_at timestamptz,
  source_observed_at timestamptz,
  ingested_at timestamptz NOT NULL,
  source_age_minutes numeric CHECK (source_age_minutes IS NULL OR source_age_minutes >= 0),
  payload_sha256 char(64) CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload_byte_size bigint CHECK (payload_byte_size IS NULL OR payload_byte_size >= 0),
  record_count integer NOT NULL CHECK (record_count >= 0),
  adapter_version text NOT NULL CHECK (btrim(adapter_version) <> ''),
  schema_version text NOT NULL CHECK (btrim(schema_version) <> ''),
  error_type text,
  error_message text,
  fallback_status text NOT NULL CHECK (fallback_status IN ('written', 'failed', 'not_attempted')),
  hosted_write_status text NOT NULL CHECK (hosted_write_status IN ('disabled', 'written', 'failed', 'not_attempted')),
  hosted_failure_reason text,
  hosted_failure_message text,
  generated_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_name, run_id)
);

CREATE INDEX IF NOT EXISTS source_health_source_time_idx
  ON ingestion.source_health (source_name, ingested_at);

CREATE INDEX IF NOT EXISTS source_health_status_time_idx
  ON ingestion.source_health (source_status, ingested_at);

COMMIT;
