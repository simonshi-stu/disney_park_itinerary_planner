# Architecture Overview

## Purpose

Build a park-agnostic itinerary planning product that combines live conditions, historical observations, forecasts, schedules, walking constraints, and visitor preferences into a feasible one-park, one-day plan that can be recalculated during the visit.

## Product and Validation Scope

- California Disneyland Park and Disney California Adventure are the current self-collected data and end-to-end validation environment.
- Shanghai Disney Resort and Hong Kong Disneyland are the first intended product markets.
- Orlando Disney parks, Universal parks, and other operators are future extensions, not current implementation commitments.
- The domain supports multiple operators and parks. The itinerary use case remains one park and one day until a later ADR changes that scope.

## Current Reality

The repository currently contains:

- a static multi-page browser application in the repository root and `src/`;
- direct browser reads from third-party APIs with local JSON fallbacks;
- Node.js collectors and data-quality scripts under `scripts/`;
- raw-ish wait snapshots, processed CSVs, caches, and reports stored in Git;
- a scheduled GitHub Action that commits observations back to the repository.

These components remain operational during the governance phase. The target directories document ownership boundaries before code is moved.

## Target Shape

The target is a modular monorepo and modular monolith, not a network of microservices.

```text
apps/web
    -> versioned API contracts
apps/api
    -> application use cases and dependency injection
modules/catalog
modules/ingestion
modules/observations
modules/forecasting
modules/planning
packages/contracts
packages/domain
workers/collector
infra
```

Deployable processes may be separated when their runtime needs differ, but logical ownership stays with the domain modules.

## Bounded Contexts

### Catalog

Owns operators, resorts, parks, attractions, shows, aliases, access modes, source identity mappings, and canonical IDs.

### Ingestion

Owns source adapters, source-specific payload handling, rate limits, retries, raw archival, attribution metadata, and source health.

### Observations

Owns normalization, quality flags, status interpretation, deduplication, time-series observations, and lineage from normalized records to raw source data.

### Forecasting

Owns feature generation, baselines, training, inference, backtesting, prediction versions, and evaluation metrics. It consumes observation contracts rather than vendor payloads.

### Planning

Owns visitor preferences, walking graph use, time windows, feasibility, route scoring, fallback planning, itinerary versions, and replanning triggers.

### Experience and Delivery

`apps/web` owns user interaction and presentation. `apps/api` owns transport, request validation, use-case coordination, and dependency injection. Neither owns core domain rules.

## Technology Direction

- Web: TypeScript and Next.js PWA when the product application is introduced.
- API and ML: Python and FastAPI, with forecasting and optimization libraries selected behind domain ports.
- Bootstrap collection: existing Node.js scripts remain maintained until a tested migration is scheduled.
- Operational storage: PostgreSQL with time-series support and object storage for immutable raw payloads.
- Cache/session state: Redis only where latency or ephemeral coordination justifies it.

Technology choices do not change module ownership. Framework code is an adapter around use cases and contracts.

## Architectural Principles

1. Raw input is immutable and replayable.
2. Canonical identity is source-independent.
3. Contracts precede cross-module integration.
4. Domain logic is deterministic where possible and isolated from I/O.
5. Forecasting and planning always have explicit baseline and fallback paths.
6. Target architecture and current implementation are documented separately.
7. Generalize identifiers and contracts for multiple parks, not every unvalidated business feature.

## Near-Term Exit Criteria

The governance phase is complete when:

- repository and module rules exist;
- target boundaries and current-to-target migration are documented;
- architectural decisions are recorded;
- governance checks run in CI without changing current runtime behavior;
- the next refactor can be limited to a named module and protected by characterization tests.
