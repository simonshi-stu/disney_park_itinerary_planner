# ADR 0001: Use a Modular Monolith in a Monorepo

- Status: Accepted
- Date: 2026-07-10

## Context

The product needs web, API, collection, forecasting, and optimization capabilities, but the current team and codebase do not justify independent distributed services. Premature microservices would add deployment, networking, contract-versioning, and observability overhead.

## Decision

Use one repository with domain-owned modules and a small number of deployable entrypoints. Enforce dependencies through public contracts and automated architecture checks. Split a component into a remote service only when scaling, isolation, ownership, or runtime evidence requires it.

## Consequences

- Cross-module calls are local by default but still respect contracts.
- Refactors and end-to-end tests remain simpler.
- Module boundaries must be enforced in CI to prevent the monolith becoming an unstructured application.
- Deployable workers may use different runtimes without changing domain ownership.
