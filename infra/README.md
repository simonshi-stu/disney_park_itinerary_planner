# Infrastructure

## Purpose

Own deployment definitions, database migrations, raw object storage configuration, queues/caches, monitoring, and local development composition.

## Target Direction

- PostgreSQL with appropriate time-series support for normalized observations.
- Object storage for immutable raw payloads and model artifacts.
- Redis only for justified cache, session, lock, or short-lived coordination needs.
- Separate credentials and environments with least privilege.

## Current Status

The active collection mechanism is GitHub Actions plus repository data files. No infrastructure migration occurs in the governance phase.
