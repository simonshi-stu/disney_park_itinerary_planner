---
name: audit-disneyland-wait-data
description: Audit and interpret Disneyland Park and Disney California Adventure wait-time history, cleaning semantics, operating-day coverage, downtime, sustained unavailability, and forecast eligibility. Use when Codex needs to assess repository CSV or PostgreSQL observation quality, decide whether data is ready for forecasting, investigate missing or zero waits, review long-running closures or refurbishment candidates, or prepare a safe data-quality report without modifying production history.
---

# Audit Disneyland Wait Data

## Workflow

1. Read `AGENTS.md`, `docs/ai/context-map.zh-CN.md`, `modules/observations/README.zh-CN.md`, and the affected contracts before acting.
2. Synchronize remote data only when the worktree is clean and the current branch can be updated safely. Never mix generated data commits with code or architecture changes.
3. Run `npm.cmd run audit:data -- --summary` from the repository root. Add `--date=YYYY-MM-DD` for one service day.
4. Read [references/quality-policy.md](references/quality-policy.md) before interpreting flags, coverage, or attraction dispositions.
5. Use `node scripts/backfill-wait-times-to-postgres.mjs --check` to compare raw and normalized artifact coverage. This is read-only and does not require database credentials.
6. Report evidence separately from conclusions:
   - Data integrity: parse failures, invalid timestamps/timezones, and lineage.
   - Collection coverage: scheduled operating windows, missing intervals, and partial days.
   - Observation semantics: closed, explicit open zero, missing wait, stale source, and access mode.
   - Attraction eligibility: temporary downtime, sustained unavailability review, and forecast candidates.
   - Forecast readiness: history duration, full-day coverage, canonical identity, and independent accuracy validation.
7. Keep raw rows immutable. Create new normalized or derived records with lineage and policy/version metadata.

## Guardrails

- Treat `is_open=false, wait_time=0` as closed evidence with a normalized wait of `null`.
- Treat an empty wait while open as `null` and `missing_wait`; never coerce it to zero.
- Preserve an explicit zero only when the attraction is open.
- Keep Single Rider, virtual queue, and standby structurally distinct.
- Retain short downtime as status evidence; exclude closed moments from standby wait targets.
- Exclude sustained-unavailability candidates from forecast training, but do not label them refurbishment, permanent closure, or retirement without catalog evidence.
- Do not manually edit raw CSV, cleaned CSV, quality reports, cache files, or `latest_snapshot.json`.
- Do not stop the GitHub collector until hosted storage, replay, dual-run comparison, cutover, and rollback checks pass.

## Output

Use the `wait-time-history-audit.v1` contract. Lead with whether the data is fit for:

- integrity analysis,
- a limited descriptive baseline,
- forecast training,
- route planning.

Name the exact blockers and the next smallest safe action.
