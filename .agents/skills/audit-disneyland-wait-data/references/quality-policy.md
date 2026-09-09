# Wait-Time Quality Policy

## Interpretation

| Signal | Meaning | Forecast treatment |
| --- | --- | --- |
| `closed` | Source reports the attraction unavailable | Keep for availability modeling; no standby wait target |
| `open_zero` | Source explicitly reports zero while open | Keep as a valid wait observation |
| `missing_wait` | Attraction is open but no wait value exists | Keep as missing evidence; exclude from wait target |
| `stale_source` | Source timestamp exceeds the policy age | Retain for audit; exclude from the current wait target |
| `single_rider` | Separate access mode | Keep separately; never mix with standby training |

## Default Audit Thresholds

- Expected sampling interval: 15 minutes, matching the current GitHub workflow.
- Complete operating day: at least 95% of expected snapshots and no gap above 30.5 minutes.
- Full-day unavailable candidate: at least 90% of observations closed on a complete operating day.
- Sustained unavailability review: 7 consecutive complete operating days meeting the full-day threshold.
- Minimum operational evidence: 3 service days with at least one open observation.
- Initial history readiness gate: 42 distinct service days. This is only a baseline gate; production forecasting still needs longer seasonal coverage and time-based backtesting.

Pass overrides explicitly when experimenting. Changing production policy requires a new policy version, focused tests, and owning-module documentation.

## Limits

Queue-Times provenance and timestamps can establish source consistency, not real-world accuracy. Validate accuracy independently against time-matched official-app observations or another authoritative source. A sustained closed pattern cannot distinguish refurbishment, seasonal closure, bad source mapping, or retirement; catalog lifecycle metadata must make that decision.
