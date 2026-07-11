# ADR 0002: Multi-Park Domain, Single-Park Itinerary Scope

- Status: Accepted
- Date: 2026-07-10

## Context

Disneyland Park and Disney California Adventure at California Disneyland Resort are the current product scope, development target, and two-park validation data source. Shanghai, Hong Kong, Orlando, Universal, and other parks are possible future expansions rather than current product requirements. At the same time, multi-park itinerary optimization would materially increase product and algorithm scope.

## Decision

Represent operator, resort, park, timezone, source mapping, and park-owned entities explicitly in all durable contracts. Keep the current itinerary use case limited to exactly one park and one local service date.

## Consequences

- Data can be collected for multiple parks without hard-coding a California product.
- Future park adapters can be added without replacing core identities after the California product is validated.
- Cross-park travel, ticketing, and hopping constraints remain out of scope until a new ADR and use case are approved.
