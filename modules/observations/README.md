# Observations Module

## Purpose

Transform source evidence into canonical, quality-scored time-series observations suitable for forecasting and planning.

## Owns

Wait/status semantics, normalization, deduplication, quality flags, staleness, observation lineage, and optimizer-safe observation projections.

## Does Not Own

Vendor HTTP calls, canonical ID policy, forecast models, or route scoring.

## Public Interfaces

Target interfaces include normalized observation schemas, quality reports, latest-state queries, and replay streams.

## Dependencies

Ingestion envelopes, catalog identities, schedules, and persistence ports.

## Invariants

- Closed does not mean a zero-minute observed wait.
- Stale values remain auditable but are excluded from training according to versioned policy.
- Access modes remain distinct.
- A normalized record retains raw lineage and transformation version.

## Current Status

Bootstrap behavior lives primarily in `scripts/analyze-wait-times.mjs` and generated data-quality outputs. Characterization tests are required before extraction.

## Known Gaps

No independent schema package, database, or policy-version mechanism exists.
