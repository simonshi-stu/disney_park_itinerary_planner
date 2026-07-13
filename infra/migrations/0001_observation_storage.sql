BEGIN;

CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS ingestion;
CREATE SCHEMA IF NOT EXISTS observations;

CREATE TABLE IF NOT EXISTS catalog.parks (
  park_id text PRIMARY KEY,
  park_name text NOT NULL,
  timezone text NOT NULL CHECK (timezone = 'America/Los_Angeles')
);

CREATE TABLE IF NOT EXISTS catalog.attractions (
  canonical_attraction_id text PRIMARY KEY,
  park_id text NOT NULL REFERENCES catalog.parks (park_id),
  canonical_name text NOT NULL,
  category text NOT NULL CHECK (category IN ('attraction', 'entertainment'))
);

CREATE TABLE IF NOT EXISTS catalog.attraction_aliases (
  park_id text NOT NULL REFERENCES catalog.parks (park_id),
  alias_name text NOT NULL,
  canonical_attraction_id text NOT NULL REFERENCES catalog.attractions (canonical_attraction_id),
  notes text NOT NULL DEFAULT '',
  PRIMARY KEY (park_id, alias_name)
);

CREATE TABLE IF NOT EXISTS ingestion.raw_archives (
  raw_archive_id char(64) PRIMARY KEY CHECK (raw_archive_id ~ '^[a-f0-9]{64}$'),
  sha256 char(64) NOT NULL UNIQUE CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  object_uri text NOT NULL UNIQUE CHECK (object_uri ~ '^(s3|gs|az)://'),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  source_name text NOT NULL,
  schema_version text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingestion.raw_wait_observations (
  raw_observation_id char(64) PRIMARY KEY CHECK (raw_observation_id ~ '^[a-f0-9]{64}$'),
  raw_archive_id char(64) NOT NULL REFERENCES ingestion.raw_archives (raw_archive_id),
  source_row_number integer NOT NULL CHECK (source_row_number > 0),
  snapshot_utc timestamptz NOT NULL,
  snapshot_park_datetime timestamp NOT NULL,
  snapshot_park_date date NOT NULL,
  snapshot_timezone text NOT NULL CHECK (snapshot_timezone = 'America/Los_Angeles'),
  park_id text NOT NULL REFERENCES catalog.parks (park_id),
  park_name text NOT NULL,
  land text NOT NULL,
  ride_id text NOT NULL,
  ride_name text NOT NULL,
  is_open boolean NOT NULL,
  wait_time_minutes integer CHECK (wait_time_minutes >= 0),
  source_last_updated_utc timestamptz NOT NULL,
  source_last_updated_park_datetime timestamp NOT NULL,
  source_url text NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_archive_id, source_row_number)
);

CREATE TABLE IF NOT EXISTS observations.normalized_wait_observations (
  normalized_observation_id char(64) PRIMARY KEY CHECK (normalized_observation_id ~ '^[a-f0-9]{64}$'),
  raw_observation_id char(64) NOT NULL REFERENCES ingestion.raw_wait_observations (raw_observation_id),
  canonical_attraction_id text NOT NULL REFERENCES catalog.attractions (canonical_attraction_id),
  canonical_match_source text NOT NULL,
  access_mode text NOT NULL CHECK (access_mode IN ('standby', 'single_rider', 'virtual_queue', 'other')),
  is_open boolean NOT NULL,
  observed_wait_time_minutes numeric CHECK (observed_wait_time_minutes >= 0),
  source_age_minutes numeric CHECK (source_age_minutes >= 0),
  quality_flags text[] NOT NULL DEFAULT '{}',
  training_eligibility text NOT NULL,
  transformation_version text NOT NULL,
  generated_at timestamptz NOT NULL,
  CHECK (is_open OR observed_wait_time_minutes IS NULL),
  UNIQUE (raw_observation_id, transformation_version)
);

CREATE INDEX IF NOT EXISTS raw_wait_park_time_idx
  ON ingestion.raw_wait_observations (park_id, snapshot_utc);
CREATE INDEX IF NOT EXISTS normalized_attraction_time_idx
  ON observations.normalized_wait_observations (canonical_attraction_id, raw_observation_id);

CREATE OR REPLACE VIEW observations.standby_wait_analysis AS
SELECT
  raw.snapshot_utc,
  raw.snapshot_park_date,
  raw.snapshot_timezone,
  raw.park_id,
  normalized.canonical_attraction_id,
  normalized.observed_wait_time_minutes,
  normalized.quality_flags,
  normalized.transformation_version,
  normalized.generated_at
FROM observations.normalized_wait_observations AS normalized
JOIN ingestion.raw_wait_observations AS raw USING (raw_observation_id)
WHERE normalized.access_mode = 'standby'
  AND normalized.is_open
  AND normalized.observed_wait_time_minutes IS NOT NULL
  AND normalized.training_eligibility = 'standby_wait_model';

CREATE OR REPLACE FUNCTION ingestion.reject_raw_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'raw ingestion records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS raw_archives_are_immutable ON ingestion.raw_archives;
CREATE TRIGGER raw_archives_are_immutable
BEFORE UPDATE OR DELETE ON ingestion.raw_archives
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_raw_mutation();

DROP TRIGGER IF EXISTS raw_wait_observations_are_immutable ON ingestion.raw_wait_observations;
CREATE TRIGGER raw_wait_observations_are_immutable
BEFORE UPDATE OR DELETE ON ingestion.raw_wait_observations
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_raw_mutation();

COMMIT;
