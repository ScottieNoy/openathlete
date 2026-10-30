# Detailed activity analysis through MCP

The read scope offers `get_activity` and `get_activity_streams`. Both use the
existing athlete/coaching scope and CASL event read permissions. They only read
stored data and never call a provider or a model.

## Consumer sequence

1. Find an activity's `eventId` with `get_activities` or `get_calendar`.
2. Call `get_activity({"eventId":123})`. This returns summary metrics, feedback,
   stored segments, and `streams` availability. `lapPage.total` counts all stored
   segments. Follow `lapPage.nextOffset` with `lapOffset` to read further segments
   (default/maximum `lapLimit`: 100).
3. Call `get_activity_streams({"eventId":123,"channels":["heartrate","distance","speed","pace"],"limit":500})`.
   Follow `nextOffset` by passing it as `offset` until it is null. The default page
   is 200 original samples; the maximum is 500. There is no downsampling, and
   channel values keep the same indices as `timeSeconds` on every page.

Available recorded scalar channels: `distance` (m), `heartrate` (bpm), `cadence`
(provider-recorded revolutions or steps/minute), `watts` (W), `altitude` (m),
`temp` (degrees Celsius), `gap` and `norm` (grade-adjusted and normalized speeds,
m/s). Cadence is not automatically doubled for running. GPS coordinates are not
part of this tool's contract.

`speed` (m/s) and `pace` (s/km) are **derived**, using the distance change divided
by elapsed seconds since the previous original sample. This includes pauses and
is not a provider's smoothed or moving pace. The first sample has no preceding
interval, so both derived values are null. Duplicate timestamps and distance
resets also produce null. Stationary speed is zero and stationary pace is null.
The first sample on a later page still uses its actual preceding sample.

## Missing data and segments

Availability is independent of the requested channels and lists every supported
channel. `stored` says whether any stream JSON is stored; an empty object is not a
recording. `timeStatus` describes the recorded elapsed time axis. Each channel has
a status:

- `available`: valid numeric data aligned to the time axis;
- `missing`: no stored values (or, for speed/pace, no distance values);
- `misaligned`: its sample count differs from the valid time axis;
- `invalid`: malformed numeric/compressed data, or no valid time axis with which
  to align existing channel data.

Unavailable channels return an empty `values` array. A stored channel that was
not requested is still visible in availability. A count mismatch is never fixed
by interpolating, shortening, or independently resampling channels. Negative
temperature/elevation and valid zeros are preserved. Compressed runs are inspected
and sliced without expanding the entire recording in memory.

`laps` contains stored segments of their stated type (`lap`, `workout_step`,
`manual`, `auto_split`), rather than implying every segment came from a lap button.
Each segment includes its id, order, start/end seconds from activity start,
elapsed seconds, and moving seconds when recorded. End boundaries follow storage:
exclusive except the final segment may include its endpoint. Existing rounded
summary fields remain; numeric speed and pace fields state their units. The
legacy `minutes` field uses moving time when known, otherwise elapsed time.

**An empty lap array does not mean time-series data is absent.** Conversely,
summary heart rate or pace does not establish that samples exist. This API cannot
distinguish every ingestion cause from storage alone. In the current importer,
Strava requests streams for non-manual activities, but stream-fetch failures can
leave an empty stream, and the Strava path does not import provider laps. Manual
activities and Apple Health summary imports may have no samples. Existing imported
segments are exposed; no laps are invented, no provider backfill runs, and no
schema migration is needed for these MCP reads.

## Validation

`activity-streams.spec.ts` covers compressed runs, irregular timestamps, page
boundaries, all scalar channels, missing/malformed/misaligned data, pauses,
distance resets, payload limits and coordinate omission. `mcp-tools.int-spec.ts`
exercises the actual MCP client/server transport with disposable PostgreSQL
fixtures, including owner/coached/stranger access, scope gating, input validation,
independent stream/lap availability, and more than 100 stored segments.

After deploying the API code, a consumer may need to reconnect or refresh its MCP
tool list to discover `get_activity_streams`. Local implementation alone does not
update an already deployed server or ingest absent provider data.
