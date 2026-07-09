# Wait-Time Quality Report: 2026-07-08

Generated at: 2026-07-09T04:20:52.555Z
Source file: data/wait_times/wait_times_2026-07-08.csv

## Summary

- Rows: 4937
- Snapshots: 57
- Rides: 87
- Canonical attractions: 80
- Closed rows: 1306
- Zero wait rows: 2281
- Open zero rows: 975
- Stale rows: 35
- Standby wait model rows: 3302
- Optimizer-ready rows: 4845
- Optimizer conflicts resolved: 92
- Optimizer stale selected rows: 0

## By Park

| Park | Rows | Snapshots | Closed | Zero | Open Zero | Stale |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| disneyland | 3192 | 57 | 887 | 1518 | 631 | 0 |
| dca | 1745 | 57 | 419 | 763 | 344 | 35 |

## Single Rider

- Groups: 5
- Optimizer usable groups: 0
- Availability-only groups: 5

| Park | Base ride | Rows | Open | Positive waits | Zero waits | Optimizer use |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| dca | Incredicoaster | 57 | 27 | 0 | 57 | availability_only |
| dca | Radiator Springs Racers | 57 | 52 | 0 | 57 | availability_only |
| dca | WEB SLINGERS: A Spider-Man Adventure | 57 | 52 | 0 | 57 | availability_only |
| disneyland | Millennium Falcon: Smugglers Run | 57 | 53 | 0 | 57 | availability_only |
| disneyland | Tiana's Bayou Adventure | 57 | 53 | 0 | 57 | availability_only |

## Data Issues

- Duplicate snapshot/name groups: 57
- Canonical conflict groups: 92
- Stale source groups: 1
- Possible full-day closed rides: 10
- Temporary downtime candidates: 49
- Missing expected park snapshots: 0
- Unexpected park snapshots: 0

## Recommendations

- Exclude stale_source rows from wait-time training until the source timestamp becomes fresh again.
- Add duplicate ride names to the future canonical attraction mapping review list.
- Review canonical conflict groups and choose the freshest eligible row for downstream optimizer inputs.
- Keep Single Rider availability, but do not use all-zero Single Rider waits as optimizer wait-time weights.
- Use observed_wait_time_minutes as the modeling target; raw wait_time_minutes remains available for audits.

