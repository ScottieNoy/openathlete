# Detailed activity analysis through MCP

The read scope offers `get_activity` and `get_activity_streams`. Both use the
existing athlete/coaching scope and CASL event read permissions. They only read
stored data and never call a provider or a model.

## Consumer sequence

1. Find an activity's `eventId` with `get_activities` or `get_calendar`.
2. Call `get_activity({"eventId":123})`. This returns summary metrics, feedback,
   stored segments, `streams` availability and `timeSeries`, a bounded page of actual original samples. The default is the first 200 original samples, not the complete workout. `streamOffset` and `streamLimit` page this data after the client refreshes its input definition. The eventId-only call remains compatible with older clients and still returns actual values. `lapPage.total` counts all stored
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
leave an empty stream. New Strava imports also request the original `/activities/{id}/laps` resource; failure to read laps does not discard the activity summary or streams. Manual
activities and Apple Health summary imports may have no samples. Existing imported
segments are exposed; no laps are invented and no broad provider backfill runs.
The additive lap-provenance migration stores provider identities and original
timing metadata. These MCP reads remain read-only.

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

## Original provider laps and targeted repair

Original Strava lap IDs are unique per activity and provider. Provider order is
normalized to zero-based orderIndex, supporting both zero- and one-based source
indices. The import preserves source names, UTC start dates, elapsed durations,
original index references, zero metrics and numeric precision. It does not turn
metric-distance splits or detected efforts into recorded laps/workout steps.

`source.timing.basis` is `provider_start_date_and_elapsed_time`. Boundaries use
the original lap UTC clock relative to the original source activity start, plus
the provider's elapsed duration. Source stream indices are retained as provenance
and are not assumed to index an independently stored stream. Source lap clocks
can disagree with the activity summary or extend beyond available recording time.
Such original values are retained, with `endWithinRecordedTimeRange` reporting
whether the endpoint is inside the available time axis; no tail samples are invented.

`StravaProviderService.importOriginalLaps(account,eventId)` is an explicit,
operator-scoped repair path. It resolves the same athlete's durable Strava source,
fetches original data outside the transaction, rechecks source/athlete identity
under a row lock, and appends missing provider identities idempotently. It never
updates existing rows or touches summary, stream, user notes or unrelated activities.
Legacy/manual/workout-step segments with unknown/different provenance protect
the existing collection from automatic enrichment. Ordinary duplicate imports
remain unchanged; this method is not a broad history sync or a new MCP write tool.

Strava access tokens expire. The provider now records the supplied expiry and
uses the existing OAuth refresh grant when a token is expired or its legacy
expiry is unknown. It retains scope/status and fails closed on denied renewal.

## Client metadata and current conversations

MCP initialize reports server version 1.1.0. This identifies the implementation;
it does not by itself force a client to import new tools. For a direct dev-mode
connection, use the app's **Refresh tools** control, verify the action definition
actually lists `get_activity_streams`, and start a new conversation with the app.
An existing conversation can retain its old schema even after the registered app
list has updated. A published plugin has a different continuous-review path.
The default sample page in `get_activity` remains useful with the old eventId-only
input, but the full recording still requires pagination through a current schema.
