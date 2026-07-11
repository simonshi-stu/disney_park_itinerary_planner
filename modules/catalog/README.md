# Catalog Module

## Purpose

Provide stable identities and metadata for operators, resorts, parks, attractions, entertainment, entrances, and access modes.

## Owns

- `operator_id`, `resort_id`, `park_id`, and `canonical_attraction_id`.
- Source aliases and source-to-canonical mappings.
- Park timezone and durable attraction metadata.
- Access-mode vocabulary.

## Does Not Own

Live waits, source fetching, forecasts, walking costs, or itinerary scoring.

## Public Interfaces

Target interfaces include catalog lookup, alias resolution, versioned catalog snapshots, and mapping-review events. Schemas will live in `packages/contracts` before implementation moves here.

## Dependencies

Shared domain primitives and persistence ports only. Vendor adapters consume catalog interfaces; catalog does not call vendors.

## Invariants

- Canonical IDs remain stable across rename, seasonal overlay, and vendor-ID changes.
- Every park has an explicit operator, resort, and IANA timezone.
- Access mode is structured data, not inferred permanently from display names.

## Current Status

Current mappings are implemented in `data/catalog/attraction-aliases.csv`, `src/data.js`, and analysis-script logic. They remain in place during governance.

## Known Gaps

No versioned catalog schema, mapping-review workflow, or persistence layer exists yet.
