# ADR 0002: Multi-Park Domain, Single-Park Itinerary Scope

- Status: Accepted
- Date: 2026-07-10

## Context

California Disneyland Resort supplies the current two-park validation data. The intended initial product markets are Shanghai and Hong Kong, with possible expansion to Orlando, Universal, and other operators. At the same time, multi-park itinerary optimization would materially increase product and algorithm scope.

## Decision

Represent operator, resort, park, timezone, source mapping, and park-owned entities explicitly in all durable contracts. Keep the current itinerary use case limited to exactly one park and one local service date.

## Consequences

- Data can be collected for multiple parks without hard-coding a California product.
- Shanghai and Hong Kong adapters can be added without replacing core identities.
- Cross-park travel, ticketing, and hopping constraints remain out of scope until a new ADR and use case are approved.
