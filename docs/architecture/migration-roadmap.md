# Governance and Migration Roadmap

## Phase 0 - Governance Foundation

Status: current phase.

- Establish project and subtree rules.
- Document current reality, target boundaries, data ownership, and decisions.
- Add dependency and governance test skeletons.
- Preserve runtime code and collector behavior.

Exit: governance CI passes and the diff contains no runtime behavior change.

## Phase 1 - Characterization

- Add tests around current collection windows, CSV parsing, canonical mapping, closed/zero waits, stale data, Single Rider, and optimizer-row selection.
- Create small representative fixtures.
- Record current outputs before extraction.

Exit: current behavior can be refactored with regression protection.

## Phase 2 - Extract Current Modules

- Extract source adapters and pure transforms from the existing collectors.
- Extract catalog resolution and observation-quality rules from the analysis script.
- Split browser API/cache logic from rendering.
- Keep output formats and runtime commands stable.

Exit: thousand-line entrypoints become composition layers and tests remain green.

## Phase 3 - Storage Migration

- Introduce raw object storage and PostgreSQL/time-series schema.
- Backfill repository history through versioned contracts.
- Compare file and database outputs.
- Stop committing live and derived data to the application branch.

Exit: the operational source of truth is outside Git and replay remains possible.

## Phase 4 - Product API and Web

- Introduce FastAPI around catalog and observation use cases.
- Generate web types from versioned contracts.
- Migrate the static experience incrementally to the PWA.
- Remove direct browser dependencies on vendor APIs.

Exit: web reads owned APIs and displays explicit source/fallback status.

## Phase 5 - Forecasting and Planning

- Implement reproducible historical baselines before ML.
- Add versioned forecasts and backtests.
- Implement rule planner and evaluation baselines before OR-Tools optimization.
- Add rolling replanning with tested degradation paths.

Exit: historical replay demonstrates measurable improvement over fixed and nearest-attraction baselines.
