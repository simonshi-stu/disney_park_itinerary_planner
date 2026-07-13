# Ingestion Module

## Purpose

Acquire source data reliably and preserve sufficient evidence for replay, attribution, and health monitoring.

## Owns

Source adapters, rate limits, retries, raw envelopes, source timestamps, payload hashes, attribution metadata, and source-health signals.

## Does Not Own

Canonical identity policy, normalized wait semantics, forecasts, or itinerary decisions.

## Public Interfaces

Target interfaces are source envelope ingestion, adapter health, and collection-window commands.

## Dependencies

Catalog identity-resolution port, raw object storage port, clock, and source-specific HTTP adapters.

## Invariants

- Raw payloads are immutable.
- Every payload records source, requested/observed/ingested times, version, and hash.
- Source outages and stale data are explicit states, not empty successful responses.

## Current Status

Bootstrap implementation is in `scripts/collect-wait-times.mjs`, `scripts/update-cache.mjs`, and `.github/workflows/collect-wait-times.yml`. It remains behaviorally stable. V1 raw contracts, S3-compatible archival, and PostgreSQL raw persistence now support historical backfill.

## Known Gaps

Live source-envelope ingestion, source-health persistence, hosted storage, and cutover remain incomplete.
