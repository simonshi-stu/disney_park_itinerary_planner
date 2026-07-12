# Data Flow and Lineage

## Target Pipeline

```text
vendor response
  -> immutable raw source envelope
  -> canonical identity resolution
  -> normalized observation + quality flags
  -> feature snapshot
  -> versioned forecast
  -> planning input snapshot
  -> versioned itinerary
  -> execution events and replan trigger
```

## Required Metadata

Every source envelope should retain:

- source name and source entity ID;
- request and observation timestamps;
- ingestion timestamp;
- park identity;
- payload hash and raw object location;
- adapter/schema version;
- attribution and source-policy metadata where required.

Every derived record should retain:

- upstream record IDs or immutable snapshot ID;
- producing schema/code/model version;
- generation timestamp;
- quality or fallback status;
- reproducibility parameters.

## Time Semantics

- Persist timestamps in UTC.
- Store each park's IANA timezone in catalog data.
- Derive service date and minutes-since-opening using the park timezone and operating schedule.
- Do not assume all future parks use `America/Los_Angeles`.
- Tests must cover daylight-saving transitions and operating windows crossing midnight.

## Bootstrap-to-Database Transition

Current Git CSV and JSON files remain an operational bootstrap input. They are not the permanent source of truth.

The database migration must be additive:

1. Define raw and normalized contracts.
2. Backfill existing files through the same ingestion/normalization interfaces used for new data.
3. Run dual-write or comparison checks for a bounded period.
4. Switch readers to the database.
5. Disable repository commits from the collector.
6. Retain only representative fixtures and documented archives in Git.

Do not delete or rewrite historical Git data during the governance phase.
