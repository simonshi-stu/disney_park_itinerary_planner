# Dependency and Boundary Rules

## Layering Inside a Module

Each domain module should converge on this internal shape when implementation begins:

```text
module/
├── public/          # documented types and entrypoints
├── domain/          # entities, value objects, deterministic rules
├── application/     # use cases and ports
├── adapters/        # database, HTTP, files, vendor SDKs
└── tests/
```

`domain` depends on nothing outside the language standard library and shared domain primitives. `application` may depend on domain and contracts. Adapters depend inward and implement application ports. Composition roots instantiate adapters.

## Forbidden Dependencies

- Domain to adapters, frameworks, filesystem, network, or database.
- One module to another module's `internal`, `adapters`, or database models.
- Web to ingestion, forecasting implementation, planning implementation, or persistence.
- Planning to vendor payloads or source-specific identifiers.
- Forecasting to UI state, browser cache, route presentation models, or raw vendor JSON.
- Generic `utils` packages containing business rules from multiple owners.

## Public Contract Discipline

- Cross-module payloads are versioned schemas or typed interfaces in `packages/contracts`.
- A module exposes the smallest interface needed by consumers.
- Database models are private adapter details.
- Events use past-tense domain names and include event ID, schema version, occurred time, producer, and correlation metadata.
- Consumers must tolerate documented additive fields.

## Automated Enforcement Plan

The first CI check validates governance structure without introducing runtime dependencies. Later implementation stages must add:

- TypeScript import-boundary linting;
- Python import-linter rules;
- generated client/schema drift checks;
- OpenAPI compatibility checks;
- migration ordering and immutability checks;
- dependency-cycle detection.

No architecture rule should remain prose-only when a deterministic check can enforce it.
