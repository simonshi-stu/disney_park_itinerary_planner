# Project Rules

These rules apply to the entire repository. A closer `AGENTS.md` may add stricter rules for its subtree but may not weaken these rules.

## Product Direction

- Use Disneyland Park and Disney California Adventure at Disneyland Resort in California as the current product scope, development target, data collection environment, and end-to-end validation environment.
- Shanghai Disney Resort, Hong Kong Disneyland, Orlando Disney parks, Universal parks, and other operators are future expansion possibilities, not current product requirements.
- Keep domain identifiers and contracts capable of representing multiple parks and operators without adding implementation complexity for future parks prematurely.
- Current scope is one park and one day per itinerary. Multi-park data support does not imply multi-park itinerary support.

## Current Transition Constraint

- Preserve the existing static site and Node.js collectors until characterization tests and replacement storage are ready.
- Do not move, rewrite, or change the behavior of `scripts/collect-wait-times.mjs`, `scripts/analyze-wait-times.mjs`, or `scripts/update-cache.mjs` as part of governance-only work.
- Git-based data collection is a temporary bootstrap mechanism. Do not expand it into the permanent storage architecture.

## Required Change Workflow

1. Read this file, `docs/ai/context-map.zh-CN.md`, and the nearest module `README.zh-CN.md` before editing. Agents should use the Chinese documentation path by default; English files are compatibility translations for human readers.
2. State the intended module and public contract affected by the change.
3. Keep a change inside one owning module whenever possible.
4. If multiple modules are affected, change the shared contract first and update consumers separately.
5. Add or update tests for every business rule or public behavior change.
6. Run `npm run check` before considering the change complete.
7. Update the owning README or an ADR when a public boundary or architectural decision changes.

## Dependency Rules

- Organize new business logic by domain capability, not by generic utility or framework layer.
- Other modules may use only a module's documented public interface. Imports from another module's `internal/` path are forbidden.
- Domain code must not depend on UI frameworks, HTTP clients, database drivers, queues, file formats, or vendor SDKs.
- Third-party park APIs may be called only from ingestion adapters.
- Web code must not implement canonical identity, observation-quality, forecasting, or route-planning rules.
- Planning must consume catalog, observation, and forecast contracts; it must not call data sources directly.
- Forecasting must consume versioned observation contracts; it must not read browser caches or UI state.
- API entrypoints coordinate use cases and dependency injection; they must not become the owner of domain rules.

## Data Invariants

- `canonical_attraction_id` is the stable cross-source identity for an attraction or attraction family.
- Vendor/source IDs are evidence and adapter identifiers, not cross-module primary keys.
- Persist event timestamps in UTC and retain the park timezone needed for local-day interpretation.
- A closed attraction does not have an observed zero-minute standby wait.
- Standby, Single Rider, virtual queue, and future access modes are distinct values, not name suffix conventions.
- Raw source observations are immutable. Corrections create new normalized or derived records and retain lineage to the raw record.
- Every derived dataset must identify the producing code/schema version and be reproducible from owned inputs.
- Forecast and route outputs must include generation time and model/algorithm version.

## Contract Rules

- Define shared request, response, event, and persisted-record shapes in `packages/contracts` before consumers depend on them.
- Prefer OpenAPI, JSON Schema, or typed schemas as the source of truth; prose examples are explanatory only.
- Breaking contract changes require an explicit version or migration plan.
- The web application may depend on API contracts, never on database tables.
- Database schema changes must be additive migrations; do not edit an applied migration.

## Repository and Merge Safety

- Do not mix generated data refreshes with application or architecture changes.
- Do not edit `latest_snapshot.json`, processed CSVs, quality reports, or cache files manually.
- Keep production history out of test suites; use small, representative fixtures.
- Avoid central registries and barrel files that every feature must edit.
- Do not perform unrelated cleanup, repository-wide formatting, or opportunistic refactors.
- Never commit credentials, tokens, cookies, private endpoints, or personal data.

## Documentation Rules

- `README.md` is a navigation and current-state summary, not the full architecture specification.
- Architecture facts live under `docs/architecture/`.
- Durable decisions live under `docs/adr/` and are not silently rewritten.
- A business invariant lives in the README of its owning module and is referenced elsewhere rather than duplicated.
- Volatile progress must not be copied into multiple module READMEs.
- Documentation must describe current reality separately from target architecture.

## Definition of Done

- Relevant tests pass.
- Formatting, lint, type, contract, and architecture checks pass when available.
- No forbidden cross-module dependency is introduced.
- Public behavior and contract changes are documented.
- Generated artifacts and unrelated user changes are absent from the diff.
- Failure and fallback behavior is tested for data-source, forecasting, and planning changes.
