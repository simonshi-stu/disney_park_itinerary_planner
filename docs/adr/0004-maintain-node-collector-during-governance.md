# ADR 0004: Maintain the Node Collector During Governance

- Status: Accepted
- Date: 2026-07-10

## Context

Historical wait-time collection is time-sensitive. The existing Node.js collector is already operating while the target architecture and constraints are being established.

## Decision

Maintain the current Node.js collector and GitHub Action without behavioral refactoring during the governance phase. Add characterization tests before extracting or migrating it. A future migration may implement collection in another runtime only after comparison and backfill paths exist.

## Consequences

- Data collection continues without a risky rewrite.
- Temporary duplication between current scripts and target module documentation is explicitly accepted.
- New permanent business capabilities must not accumulate inside the bootstrap entrypoint.
