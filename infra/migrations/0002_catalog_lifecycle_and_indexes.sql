BEGIN;

-- Helper: check that a text array has no duplicate values (immutable, SQL)
CREATE OR REPLACE FUNCTION catalog.text_array_has_unique_values(input_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_length(input_values, 1), 0) = (
    SELECT count(DISTINCT v) FROM unnest(input_values) AS v
  );
$$;

-- Catalog lifecycle records (effective-dated, linked to canonical_attraction_id)
CREATE TABLE IF NOT EXISTS catalog.lifecycle_records (
  lifecycle_record_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_version text NOT NULL
    CHECK (contract_version = 'catalog-attraction-lifecycle.v1'),
  canonical_attraction_id text NOT NULL
    REFERENCES catalog.attractions (canonical_attraction_id),
  park_id text NOT NULL
    REFERENCES catalog.parks (park_id),
  park_timezone text NOT NULL
    CHECK (park_timezone = 'America/Los_Angeles'),
  wait_capability text NOT NULL
    CHECK (wait_capability IN ('posted_standby', 'schedule_only', 'no_queue', 'unknown')),
  supported_access_modes text[] NOT NULL
    CHECK (
      supported_access_modes <@ ARRAY['standby', 'single_rider', 'virtual_queue', 'other']
      AND catalog.text_array_has_unique_values(supported_access_modes)
    ),
  operational_state text NOT NULL
    CHECK (operational_state IN ('operating', 'refurbishment', 'seasonal', 'retired', 'unknown')),
  training_disposition text NOT NULL
    CHECK (training_disposition IN ('eligible', 'ineligible_no_wait', 'ineligible_lifecycle', 'review_required')),
  planning_disposition text NOT NULL
    CHECK (planning_disposition IN ('eligible', 'schedule_constraint', 'ineligible_lifecycle', 'review_required')),
  valid_from date NOT NULL,
  valid_to date,
  catalog_version text NOT NULL
    CHECK (btrim(catalog_version) <> ''),
  generated_at timestamptz NOT NULL,
  -- Effective-dating: no overlapping records for the same attraction
  UNIQUE (canonical_attraction_id, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- Contract disposition rules
  CHECK (
    (operational_state IN ('refurbishment', 'retired')
      AND training_disposition = 'ineligible_lifecycle'
      AND planning_disposition = 'ineligible_lifecycle')
    OR
    (operational_state = 'unknown'
      AND training_disposition = 'review_required'
      AND planning_disposition = 'review_required')
    OR
    operational_state IN ('operating', 'seasonal')
  )
);

-- Evidence rows for lifecycle records (child table, no subqueries in CHECK)
CREATE TABLE IF NOT EXISTS catalog.lifecycle_evidence (
  lifecycle_evidence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lifecycle_record_id bigint NOT NULL
    REFERENCES catalog.lifecycle_records (lifecycle_record_id)
    ON DELETE RESTRICT,
  source_type text NOT NULL
    CHECK (source_type IN ('official_disney_page', 'official_disney_app', 'manual_review')),
  source_url text
    CHECK (source_url IS NULL OR source_url ~ '^https?://'),
  verified_at timestamptz NOT NULL,
  reviewed_by text NOT NULL
    CHECK (btrim(reviewed_by) <> ''),
  notes text NOT NULL DEFAULT '',
  -- Official Disney page evidence must have a non-blank URL
  CHECK (source_type <> 'official_disney_page' OR (source_url IS NOT NULL AND btrim(source_url) <> ''))
);

-- Deferred constraint trigger: require evidence for every lifecycle record,
-- and official evidence for operating/refurbishment/seasonal/retired states.
CREATE OR REPLACE FUNCTION catalog.validate_lifecycle_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  evidence_count integer;
  official_count integer;
BEGIN
  SELECT count(*)
    INTO evidence_count
    FROM catalog.lifecycle_evidence
   WHERE lifecycle_record_id = NEW.lifecycle_record_id;

  IF evidence_count = 0 THEN
    RAISE EXCEPTION 'lifecycle record % requires at least one evidence row',
      NEW.lifecycle_record_id;
  END IF;

  IF NEW.operational_state IN ('operating', 'refurbishment', 'seasonal', 'retired') THEN
    SELECT count(*)
      INTO official_count
      FROM catalog.lifecycle_evidence
     WHERE lifecycle_record_id = NEW.lifecycle_record_id
       AND source_type IN ('official_disney_page', 'official_disney_app');
    IF official_count = 0 THEN
      RAISE EXCEPTION 'lifecycle record % requires at least one official Disney evidence source',
        NEW.lifecycle_record_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lifecycle_requires_evidence ON catalog.lifecycle_records;
CREATE CONSTRAINT TRIGGER lifecycle_requires_evidence
AFTER INSERT OR UPDATE ON catalog.lifecycle_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION catalog.validate_lifecycle_evidence();

-- Immutable lifecycle history: corrections append new records
CREATE OR REPLACE FUNCTION catalog.reject_lifecycle_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'catalog lifecycle history is immutable; append a new effective record instead';
END;
$$;

DROP TRIGGER IF EXISTS lifecycle_records_are_immutable ON catalog.lifecycle_records;
CREATE TRIGGER lifecycle_records_are_immutable
BEFORE UPDATE OR DELETE ON catalog.lifecycle_records
FOR EACH ROW EXECUTE FUNCTION catalog.reject_lifecycle_mutation();

DROP TRIGGER IF EXISTS lifecycle_evidence_are_immutable ON catalog.lifecycle_evidence;
CREATE TRIGGER lifecycle_evidence_are_immutable
BEFORE UPDATE OR DELETE ON catalog.lifecycle_evidence
FOR EACH ROW EXECUTE FUNCTION catalog.reject_lifecycle_mutation();

-- Targeted indexes for the initial hot window (no partitioning yet)
CREATE INDEX IF NOT EXISTS lifecycle_records_attraction_valid_idx
  ON catalog.lifecycle_records (canonical_attraction_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS lifecycle_records_state_disposition_idx
  ON catalog.lifecycle_records (operational_state, training_disposition, planning_disposition);
CREATE INDEX IF NOT EXISTS lifecycle_evidence_record_idx
  ON catalog.lifecycle_evidence (lifecycle_record_id);

-- One composite raw observation index using only real columns from 0001
CREATE INDEX IF NOT EXISTS raw_wait_park_date_time_idx
  ON ingestion.raw_wait_observations (park_id, snapshot_park_date, snapshot_utc);

COMMIT;
