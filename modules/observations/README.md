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

Bootstrap behavior remains in `scripts/analyze-wait-times.mjs` under characterization tests. The V1 normalized contract, PostgreSQL persistence, and default standby analysis view now support historical backfill.

## Known Gaps

The formal normalization use case, a policy-version upgrade, and replay of raw-only dates remain incomplete.
