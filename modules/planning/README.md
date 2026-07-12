# Planning Module

## Purpose

Create and revise a feasible, explainable one-park, one-day itinerary from preferences, time windows, walking costs, current state, and forecasts.

## Owns

Preference scoring, walking-graph use, time-window feasibility, route objectives, itinerary versioning, replanning triggers, and fallback planning.

## Does Not Own

Source fetching, observation cleaning, forecast training, map rendering, or API transport.

## Public Interfaces

Target contracts include planning requests, itinerary steps, cost/benefit breakdowns, confidence/fallback status, execution events, and replan requests.

## Dependencies

Catalog, observation, forecast, schedule, and walking-graph contracts.

## Invariants

- One planning request identifies exactly one park and one local service date in the current scope.
- A returned itinerary is time-feasible under its declared input snapshot.
- Replanning freezes explicitly committed actions according to policy.
- A deterministic rule-based fallback is available when prediction or optimization fails.

## Current Status

Not implemented beyond UI concepts and optimizer-ready observation projection.

## Known Gaps

Walking graph, preference schema, baseline planner, replay metrics, and optimizer interfaces remain to be built.
