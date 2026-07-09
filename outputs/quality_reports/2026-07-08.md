# Wait-Time Quality Report: 2026-07-08

Generated at: 2026-07-09T02:34:40.467Z
Source file: data/wait_times/wait_times_2026-07-08.csv

## Summary

- Rows: 4421
- Snapshots: 51
- Rides: 87
- Closed rows: 1091
- Zero wait rows: 1998
- Open zero rows: 907
- Stale rows: 35
- Standby wait model rows: 3033

## By Park

| Park | Rows | Snapshots | Closed | Zero | Open Zero | Stale |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| disneyland | 2856 | 51 | 733 | 1328 | 595 | 0 |
| dca | 1565 | 51 | 358 | 670 | 312 | 35 |

## Single Rider

- Groups: 5
- Optimizer usable groups: 0
- Availability-only groups: 5

| Park | Base ride | Rows | Open | Positive waits | Zero waits | Optimizer use |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| dca | Incredicoaster | 51 | 25 | 0 | 51 | availability_only |
| dca | Radiator Springs Racers | 51 | 46 | 0 | 51 | availability_only |
| dca | WEB SLINGERS: A Spider-Man Adventure | 51 | 46 | 0 | 51 | availability_only |
| disneyland | Millennium Falcon: Smugglers Run | 51 | 47 | 0 | 51 | availability_only |
| disneyland | Tiana's Bayou Adventure | 51 | 47 | 0 | 51 | availability_only |

## Data Issues

- Duplicate snapshot/name groups: 306
- Stale source groups: 1
- Possible full-day closed rides: 10
- Temporary downtime candidates: 35
- Missing expected park snapshots: 0
- Unexpected park snapshots: 0

## Recommendations

- Exclude stale_source rows from wait-time training until the source timestamp becomes fresh again.
- Add duplicate ride names to the future canonical attraction mapping review list.
- Keep Single Rider availability, but do not use all-zero Single Rider waits as optimizer wait-time weights.
- Use observed_wait_time_minutes as the modeling target; raw wait_time_minutes remains available for audits.

