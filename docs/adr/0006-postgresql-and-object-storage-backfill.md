# ADR 0006: Backfill to PostgreSQL and Immutable Object Storage

Status: Accepted

## Context

The bootstrap collector stores daily CSV and JSON artifacts in Git. Characterization tests now protect its behavior, and versioned persisted-record contracts are required before storage migration. Raw evidence must remain immutable, normalized records must retain lineage, and closed source rows must not become observed zero-minute waits.

## Decision

- Store raw CSV archives in S3-compatible object storage, addressed by SHA-256.
- Store the archive manifest and source rows in PostgreSQL under `ingestion`; reject updates and deletes on raw tables.
- Store canonical catalog data under `catalog` and normalized observations under `observations`.
- Generate stable raw IDs from archive content hash plus source row number, and link every normalized record to one raw ID.
- Keep Single Rider distinct and exclude it from the default standby analysis view.
- Represent full-day or maintenance closure as status/quality metadata. A closed normalized record has no observed wait, even when its raw source value is zero.
- Preserve the bootstrap collector and Git write path until hosted credentials, historical replay, dual-run comparison, cutover, and rollback checks pass.

## Consequences

Migration can be rehearsed locally and repeated without overwriting raw evidence. Existing cleaned rows remain safe when a raw daily file was appended after cleaning because lineage is matched by source identity rather than current row position. A production cutover still requires hosted PostgreSQL/object-storage credentials and an explicit validation window.

## Follow-up

- Replay normalization for raw dates without a current cleaned artifact.
- Add live ingestion/normalization use cases without changing protected bootstrap commands.
- Compare file and database counts and semantics for a bounded dual-run period.
- Disable Git data commits only after the rollback checkpoint is accepted.
