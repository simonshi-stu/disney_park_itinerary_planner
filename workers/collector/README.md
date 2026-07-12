# Collector Worker

## Purpose

Schedule source acquisition and hand raw source envelopes to ingestion use cases.

## Current Status

The operating bootstrap collector remains at `scripts/collect-wait-times.mjs`, with cache refresh in `scripts/update-cache.mjs` and scheduling in `.github/workflows/collect-wait-times.yml`.

No executable code has moved into this directory during governance.

## Migration Preconditions

- Characterization tests for current collection windows and output.
- Versioned raw envelope and observation contracts.
- Raw object storage and database destinations.
- Backfill and dual-run comparison plan.
- Explicit cutover and rollback criteria.
