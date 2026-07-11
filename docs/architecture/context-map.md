# Domain Context Map

## Allowed Relationships

```text
External park sources
        |
        v
    Ingestion -----> Catalog
        |
        v
   Observations ----> Forecasting
        |                  |
        +--------+---------+
                 v
              Planning <---- visitor preferences / walking graph
                 |
                 v
                API <---- Web
```

Arrows indicate knowledge or data flow, not permission to reach into internal files.

## Ownership Matrix

| Concept | Owner | Consumers |
| --- | --- | --- |
| Operator, resort, park | Catalog | All modules |
| Canonical attraction and aliases | Catalog | Ingestion, observations, forecasting, planning, web via API |
| Vendor payload and source health | Ingestion | Observations, operations |
| Wait/status observation | Observations | Forecasting, planning, API |
| Forecast and uncertainty interval | Forecasting | Planning, API, web via API |
| Walking edge and itinerary | Planning | API, web via API |
| Visitor preference request | Planning contract | API, web |
| HTTP request/response | Contracts/API | Web and external clients |

## Integration Rules

- Ingestion maps vendor identifiers to catalog identities through an explicit catalog port.
- Observations accept source envelopes from ingestion and publish normalized versioned records.
- Forecasting sees normalized observations and catalog attributes, not vendor-specific JSON.
- Planning sees catalog entities, current observations, forecasts, schedules, and walking constraints through public contracts.
- Web sees API response DTOs and presentation models, not module internals or database rows.

## Cross-Park Model

Every park-owned entity carries an explicit `operator_id`, `resort_id`, and `park_id` where applicable. The system must not infer a park from a source name, timezone, or globally hard-coded constant.

Itinerary scope is represented explicitly. The current scope accepts one `park_id` and one local service date. A future multi-park itinerary must be introduced as a new use case and ADR rather than hidden inside the existing planner.
