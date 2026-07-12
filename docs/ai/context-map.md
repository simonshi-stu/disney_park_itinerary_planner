# AI Context Map

Use this file to minimize repository reading while preserving correctness.

## Always Read

1. Root `AGENTS.md`.
2. This context map.
3. The nearest applicable `AGENTS.md`.
4. The README of the owning module.
5. Public contracts and tests directly affected by the task.

Do not read all historical CSV/JSON data, generated reports, caches, or unrelated modules by default.

## Task Routing

| Task | Minimum context |
| --- | --- |
| External API or collection | `workers/collector/README.md`, `modules/ingestion/README.md`, catalog/observation contracts |
| Canonical IDs or attraction metadata | `modules/catalog/README.md`, catalog contracts and tests |
| Cleaning or data quality | `modules/observations/README.md`, observation contracts and fixtures |
| Forecasting | `modules/forecasting/README.md`, observation/forecast contracts, evaluation tests |
| Route optimization or replanning | `modules/planning/README.md`, catalog/forecast/planning contracts, replay tests |
| User interface | `apps/web/README.md`, API contracts, affected page/component tests |
| API endpoint | `apps/api/README.md`, owning module public interface, API contracts |
| Database or deployment | `infra/README.md`, data-flow and relevant ADRs |

## Current Implementation Map

- Static browser application: root HTML files and `src/app.js`, `src/data.js`, `src/styles.css`.
- Bootstrap collection: `scripts/collect-wait-times.mjs`.
- Bootstrap cache update: `scripts/update-cache.mjs`.
- Bootstrap quality/optimizer projection: `scripts/analyze-wait-times.mjs`.
- Scheduled collection: `.github/workflows/collect-wait-times.yml`.
- Historical and generated data: `data/`, `outputs/`, and `src/cache/`.

These paths are current implementation locations, not permission to add new architecture there indefinitely.

## Reading Budget Guidance

- Start with file lists, public symbols, and targeted searches.
- Open the smallest relevant code ranges.
- Use compact fixtures instead of production datasets.
- Treat schema files and tests as higher-authority context than prose examples.
- If documentation conflicts with executable behavior, report the conflict; do not silently choose one.

## Documentation Update Rule

Update only the owning source of truth:

- architecture boundary -> `docs/architecture/` or ADR;
- durable decision -> new ADR;
- module invariant or public interface -> module README;
- API/data shape -> contract schema;
- temporary implementation progress -> one designated status location, not every README.
