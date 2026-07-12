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

Documentation skeleton only. Schemas will be introduced alongside characterization and module extraction.
