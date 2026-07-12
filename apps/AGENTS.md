# Application Rules

- Applications are composition and delivery layers, not owners of core domain rules.
- Web code consumes versioned API contracts and presentation models only.
- API code validates transport input, invokes use cases, and maps results to contracts.
- Do not expose persistence models or vendor payloads through an application boundary.
- Preserve the existing static application until its replacement is covered by tests and an incremental migration plan.
