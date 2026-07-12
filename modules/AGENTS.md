# Domain Module Rules

- Each module owns one business capability and publishes the smallest useful interface.
- Do not import another module's adapters, persistence models, or internal files.
- Put deterministic business rules in domain code and I/O behind application ports.
- Cross-module schemas belong in `packages/contracts`.
- Every invariant documented in a module README requires a focused test when implemented.
- Do not create a generic shared utility for logic that has a clear domain owner.
