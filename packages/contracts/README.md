# Shared Contracts

## Purpose

Provide versioned, machine-checkable schemas used across modules and application boundaries.

## Planned Contract Families

- catalog entities and identity mappings;
- raw source envelopes and source health;
- normalized observations and quality flags;
- forecasts and evaluation metadata;
- planning requests, itinerary versions, and execution events;
- public API requests and responses.

## Rules

- Contracts contain data shapes and compatibility policy, not business implementations.
- One format is authoritative for a contract; generated language types are not edited manually.
- Breaking changes require versioning or migration.

## Current Status

`schemas/v1/` contains the first persisted-data boundaries: immutable raw archives, raw wait observations, and normalized wait observations. They support historical backfill and the PostgreSQL adapter without changing the bootstrap CSV format.

## V1 Wait-Time Constraints

- A source-provided zero while closed remains raw evidence only.
- A closed normalized record has a null `observed_wait_time_minutes`; zero is valid only for an open observation.
- `access_mode` distinguishes standby, Single Rider, virtual queue, and other modes.
- Every normalized record references its raw record and records transformation version and generation time.
- Current park data uses `America/Los_Angeles` while event timestamps remain UTC.
