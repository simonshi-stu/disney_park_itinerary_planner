BEGIN;

-- Keep normalized-only lineage separate from the legacy raw-row-backed tables in 0001.
CREATE TABLE IF NOT EXISTS ingestion.raw_archive_line_references (
  raw_observation_id char(64) PRIMARY KEY
    CHECK (raw_observation_id ~ '^[a-f0-9]{64}$'),
  contract_version text NOT NULL
    CHECK (contract_version = 'raw-archive-line-reference.v1'),
  raw_archive_id char(64) NOT NULL
    CHECK (raw_archive_id ~ '^[a-f0-9]{64}$'),
  r2_uri text NOT NULL
    CHECK (r2_uri ~ '^s3://[^/]+/.+'),
  archive_sha256 char(64) NOT NULL
    CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  archive_byte_size bigint NOT NULL CHECK (archive_byte_size > 0),
  source_line_number integer NOT NULL CHECK (source_line_number > 0),
  source_name text NOT NULL CHECK (btrim(source_name) <> ''),
  archive_schema_version text NOT NULL CHECK (btrim(archive_schema_version) <> '')
);

CREATE OR REPLACE FUNCTION ingestion.reject_archive_line_reference_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'archive-line references are immutable';
END;
$$;

DROP TRIGGER IF EXISTS raw_archive_line_references_are_immutable ON ingestion.raw_archive_line_references;
CREATE TRIGGER raw_archive_line_references_are_immutable
BEFORE UPDATE OR DELETE ON ingestion.raw_archive_line_references
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_archive_line_reference_mutation();

CREATE TABLE IF NOT EXISTS observations.normalized_wait_observations_v2 (
  normalized_observation_id char(64) PRIMARY KEY
    CHECK (normalized_observation_id ~ '^[a-f0-9]{64}$'),
  contract_version text NOT NULL
    CHECK (contract_version = 'normalized-wait-observation.v2'),
  raw_observation_id char(64) NOT NULL
    REFERENCES ingestion.raw_archive_line_references (raw_observation_id) ON DELETE RESTRICT,
  operator_id text NOT NULL CHECK (btrim(operator_id) <> ''),
  resort_id text NOT NULL CHECK (btrim(resort_id) <> ''),
  park_id text NOT NULL CHECK (btrim(park_id) <> ''),
  park_timezone text NOT NULL CHECK (btrim(park_timezone) <> ''),
  observed_at_utc timestamptz NOT NULL,
  canonical_attraction_id text NOT NULL CHECK (btrim(canonical_attraction_id) <> ''),
  canonical_attraction_name text NOT NULL CHECK (btrim(canonical_attraction_name) <> ''),
  canonical_category text NOT NULL CHECK (canonical_category IN ('attraction', 'entertainment')),
  canonical_match_source text NOT NULL CHECK (btrim(canonical_match_source) <> ''),
  access_mode text NOT NULL CHECK (access_mode IN ('standby', 'single_rider', 'virtual_queue', 'other')),
  is_open boolean NOT NULL,
  observed_wait_time_minutes numeric CHECK (observed_wait_time_minutes IS NULL OR observed_wait_time_minutes >= 0),
  quality_flags text[] NOT NULL CHECK (catalog.text_array_has_unique_values(quality_flags)),
  training_eligibility text NOT NULL CHECK (btrim(training_eligibility) <> ''),
  transformation_version text NOT NULL CHECK (btrim(transformation_version) <> ''),
  generated_at timestamptz NOT NULL,
  CHECK (is_open OR observed_wait_time_minutes IS NULL)
);

CREATE OR REPLACE FUNCTION observations.reject_normalized_v2_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'normalized v2 observations are immutable; corrections require a new transformation version';
END;
$$;

DROP TRIGGER IF EXISTS normalized_wait_observations_v2_are_immutable ON observations.normalized_wait_observations_v2;
CREATE TRIGGER normalized_wait_observations_v2_are_immutable
BEFORE UPDATE OR DELETE ON observations.normalized_wait_observations_v2
FOR EACH ROW EXECUTE FUNCTION observations.reject_normalized_v2_mutation();

CREATE INDEX IF NOT EXISTS normalized_v2_park_event_time_idx
  ON observations.normalized_wait_observations_v2 (park_id, observed_at_utc);

-- Store the versioned resolver contract as a catalog snapshot; never as raw wait payload.
CREATE TABLE IF NOT EXISTS catalog.catalog_entry_snapshots (
  catalog_entry_id char(64) PRIMARY KEY CHECK (catalog_entry_id ~ '^[a-f0-9]{64}$'),
  contract_version text NOT NULL CHECK (contract_version = 'catalog-entry.v1'),
  operator_id text NOT NULL CHECK (btrim(operator_id) <> ''),
  resort_id text NOT NULL CHECK (btrim(resort_id) <> ''),
  park_id text NOT NULL CHECK (btrim(park_id) <> ''),
  canonical_attraction_id text NOT NULL CHECK (btrim(canonical_attraction_id) <> ''),
  catalog_version text NOT NULL CHECK (btrim(catalog_version) <> ''),
  valid_from date NOT NULL,
  valid_to date,
  generated_at timestamptz NOT NULL,
  entry_document jsonb NOT NULL CHECK (jsonb_typeof(entry_document) = 'object'),
  UNIQUE (park_id, canonical_attraction_id, catalog_version, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (jsonb_typeof(entry_document -> 'aliases') IS NOT DISTINCT FROM 'array'),
  CHECK (jsonb_typeof(entry_document -> 'lifecycle') IS NOT DISTINCT FROM 'object'),
  CHECK (entry_document ->> 'contract_version' IS NOT DISTINCT FROM contract_version),
  CHECK (entry_document ->> 'operator_id' IS NOT DISTINCT FROM operator_id),
  CHECK (entry_document ->> 'resort_id' IS NOT DISTINCT FROM resort_id),
  CHECK (entry_document ->> 'park_id' IS NOT DISTINCT FROM park_id),
  CHECK (entry_document ->> 'canonical_attraction_id' IS NOT DISTINCT FROM canonical_attraction_id),
  CHECK (entry_document -> 'lifecycle' ->> 'contract_version' IS NOT DISTINCT FROM 'catalog-attraction-lifecycle.v1'),
  CHECK (entry_document -> 'lifecycle' ->> 'canonical_attraction_id' IS NOT DISTINCT FROM canonical_attraction_id),
  CHECK (entry_document -> 'lifecycle' ->> 'park_id' IS NOT DISTINCT FROM park_id),
  CHECK (entry_document -> 'lifecycle' ->> 'catalog_version' IS NOT DISTINCT FROM catalog_version),
  CHECK (entry_document -> 'lifecycle' ->> 'valid_from' IS NOT DISTINCT FROM valid_from::text),
  CHECK ((entry_document -> 'lifecycle' ->> 'valid_to') IS NOT DISTINCT FROM valid_to::text),
  CHECK ((entry_document -> 'lifecycle' ->> 'generated_at')::timestamptz IS NOT DISTINCT FROM generated_at)
);

CREATE OR REPLACE FUNCTION catalog.reject_catalog_entry_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'catalog entry snapshots are immutable; publish a new catalog version';
END;
$$;

DROP TRIGGER IF EXISTS catalog_entry_snapshots_are_immutable ON catalog.catalog_entry_snapshots;
CREATE TRIGGER catalog_entry_snapshots_are_immutable
BEFORE UPDATE OR DELETE ON catalog.catalog_entry_snapshots
FOR EACH ROW EXECUTE FUNCTION catalog.reject_catalog_entry_snapshot_mutation();

COMMIT;
