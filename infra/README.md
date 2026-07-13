# Infrastructure

## Purpose

Own deployment definitions, database migrations, raw object storage configuration, queues/caches, monitoring, and local development composition.

## Target Direction

- PostgreSQL with appropriate time-series support for normalized observations.
- Object storage for immutable raw payloads and model artifacts.
- Redis only for justified cache, session, lock, or short-lived coordination needs.
- Separate credentials and environments with least privilege.

## Current Status

`compose.yaml`, `migrations/0001_observation_storage.sql`, and the historical backfill command now establish PostgreSQL catalog/ingestion/observations schemas and S3-compatible immutable raw storage. The active hosted collector still writes repository files until hosted credentials, missing-date replay, dual-run comparison, and rollback validation are complete.

Run `node scripts/backfill-wait-times-to-postgres.mjs --check` for a database-free inventory and invariant check. Start the local stack with `docker compose -f infra/compose.yaml up -d` after supplying the required local-only credentials. The full command requires `DATABASE_URL` plus S3-compatible storage environment variables; it uploads raw archives before inserting idempotent database records.
