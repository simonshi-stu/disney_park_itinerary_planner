# ADR 0005: Treat Git-Based Operational Data as Transitional

- Status: Accepted
- Date: 2026-07-10

## Context

The scheduled collector currently commits changing snapshots and daily CSVs to the application repository. This bootstraps data ownership but creates large pulls, noisy history, repository growth, and merge-conflict risk.

## Decision

Do not delete or relocate existing history during governance. Treat Git writes as temporary. The storage phase will move immutable raw payloads to object storage and normalized observations to PostgreSQL/time-series storage. After verified cutover, the collector will stop committing operational and derived data to the application branch.

## Consequences

- Current collection remains uninterrupted.
- Application changes should avoid touching generated data paths.
- The storage migration needs backfill, comparison, and cutover criteria.
- Long-term Git contents are limited to small fixtures and intentional reference datasets.
