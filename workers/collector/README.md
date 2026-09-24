# Collector Worker

## Purpose

Schedule source acquisition and hand raw source envelopes to ingestion use cases.

## Current Status

The operating bootstrap collector remains at `scripts/collect-wait-times.mjs`, with cache refresh in `scripts/update-cache.mjs` and scheduling in `.github/workflows/collect-wait-times.yml`.

The worker directory now contains the opt-in dual-write sidecar; it does not replace the bootstrap runtime.

`dual-write.mjs` exposes `runDualWrite` and executes the Git fallback before an optional hosted writer. `COLLECTOR_DUAL_WRITE_ENABLED` must be `true` to call hosted storage. Payload-bearing envelopes use `payload_sha256` as their idempotency key; outage envelopes fall back to `envelope_id`. Hosted failures do not block the existing Git path.

The workflow commits the new Git snapshot before invoking the sidecar and passes the commit outcome as `COLLECTOR_GIT_FALLBACK_OUTCOME`; a failed Git commit prevents hosted persistence. When `DATABASE_URL` is available, `run-dual-write.mjs` also upserts `ingestion.source_health`. It runs only for a newly written snapshot; collection skips do not re-archive the previous snapshot or create a false healthy run. A collector failure records an outage without reading the previous snapshot. It records source and hosted failure metadata even when raw hosted upload fails; source-health persistence errors are returned as `source_health.status=failed` and signal a failed job after the Git path is preserved. Git fallback failures also attempt to persist source-health evidence before the sidecar exits nonzero.

## Migration Preconditions

- Characterization tests for current collection windows and output.
- Versioned raw envelope and observation contracts.
- Raw object storage and database destinations.
- Backfill and dual-run comparison plan.
- Explicit cutover and rollback criteria.
