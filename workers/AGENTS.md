# Worker Rules

- Workers are entrypoints that schedule and compose module use cases.
- Keep source-specific I/O in ingestion adapters and business rules in owning modules.
- Jobs must be idempotent or explicitly document their deduplication key.
- Record run ID, schema/code version, source health, and failure reason.
- Do not refactor the current Node collector until characterization tests exist.
