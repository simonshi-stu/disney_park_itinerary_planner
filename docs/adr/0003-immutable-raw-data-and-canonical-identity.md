# ADR 0003: Immutable Raw Data and Canonical Identity

- Status: Accepted
- Date: 2026-07-10

## Context

Vendor identifiers, attraction names, status semantics, and payload shapes can change. Forecasting and historical replay require source evidence and stable entity identity.

## Decision

Store raw source envelopes immutably with hashes and adapter versions. Resolve vendor identities through the catalog-owned canonical ID mapping. Normalized and derived records retain lineage to raw inputs and producing versions.

## Consequences

- Source bugs and mapping changes can be replayed and audited.
- Storage volume is higher than keeping only the latest normalized state.
- Canonical mapping becomes a governed domain capability rather than a collection-script convention.
