# ADR 0008: R2 Raw and Neon Normalized-Only Persistence

Status: Accepted

Supersedes ADR-0006's PostgreSQL raw-observation destination **only for future production writes**. ADR-0006 remains the historical record of the earlier design and is not edited.

## Context

ADR-0006 stores immutable raw archives in S3-compatible object storage and their manifests/source observations in PostgreSQL. The 04c hosted validation exercised that existing raw persistence path. Future production storage should retain replayable raw evidence without duplicating full source observations in Neon. Normalized consumers also need event time, park-local interpretation, identity, quality, and lineage without joining a raw payload row.

## Decision

- R2 is the immutable source of truth for complete raw payload bytes. A raw archive is addressed by its stable URI and verified by its content SHA-256 (and byte size).
- Future production writes store normalized observations and only the minimum required catalog, source-health, and archive-line-reference metadata in Neon. They do **not** insert new rows into `ingestion.raw_wait_observations` or copy raw payload/source fields into normalized storage.
- `normalized-wait-observation.v2` is the persisted normalized-record contract. It carries UTC `observed_at_utc` and `generated_at`, operator/resort/park identity, the park's IANA timezone, canonical attraction identity, structured access mode, open/wait semantics, quality flags, `raw_observation_id`, and transformation version.
- `raw-archive-line-reference.v1` is reference metadata, not a raw observation. It maps `raw_observation_id` to an R2 URI, archive SHA-256/byte size, archive identity, source name/schema version, and one-based logical source-record ordinal. The exact lineage formula is:
  ```text
  raw_observation_id=SHA-256(UTF-8 `${archive_sha256}:${one_based_data_row_ordinal}`)
  ```
  `one_based_data_row_ordinal` starts at 1 and counts data rows only; any archive header is excluded. The normalized-v2 record and its archive-line v1 reference must carry the same resulting ID.
- Normalized consumers must be able to recover the event timestamp, park-local interpretation, identity, quality, transformation version, and stable archive lineage from normalized records plus the lightweight reference. They must not need a PostgreSQL raw observation row or R2 payload read for ordinary normalized queries.
- This is a contract and future-write decision only. It does not apply a migration, rewrite existing storage, enable a workflow, or authorize cloud access/write activity.

## Compatibility and migration plan

1. Keep `normalized-wait-observation.v1`, `raw-wait-observation.v1`, and `raw-archive.v1` unchanged and readable under their existing semantics. A v1-to-v2 shape/lineage change is breaking; publish and select v2 by `contract_version`, never silently widen or repurpose v1.
2. Preserve all existing validation/history rows, including the 04c validation branch's raw archives and raw-observation rows. Do not delete, update, re-key, or backfill those rows as part of this decision. Historical v1 normalized rows, if present, continue to use their original v1 lineage.
3. Before any v2 hosted write, add a new additive migration for normalized v2 fields and the reference-only lineage relation. Do not edit or replace applied migrations `0001`–`0003`; migration application and validation writes require separate explicit human authorization.
4. During any later cutover, readers must handle the contract versions actually stored. New writes may select v2 only after the new schema, adapters, idempotency, and read compatibility have passed validation. Any conversion/replay of historical v1 data is a separate, lineage-preserving and human-approved operation; absent that approval, retain and read the original v1 rows rather than rewriting them.
5. Keep Git fallback active through validation and production cutover. Neither this ADR nor validation acceptance authorizes production credentials, schema application, hosted writes, stopping collection, or a provider-plan upgrade.

## Consequences

- R2 holds full immutable source evidence; Neon contains normalized query records and small lineage/source-health/catalog metadata only.
- Normalized data remains independently useful for local-day queries and model eligibility without denormalizing raw payload columns into Neon.
- Existing raw tables and validation data remain as historical compatibility storage. Storage cleanup or retention changes require their own reviewed decision and authorization.
- The v2 contract and later additive migration must evolve together; contract publication alone does not make a database ready for v2 writes.
