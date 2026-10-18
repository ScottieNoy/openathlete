# Companion integration fork

This fork preserves the OpenAthlete API changes used by the Apple Health companion integration.
`main` follows upstream; `deployment/companion` contains the integration changes and is the fork's default branch.
Initial upstream base: `aad3ba3ff45d91e15b24a1b76ef16244c2488b0f`.

## Changes

- OAuth Client ID Metadata Documents: accept an explicitly supported public-client (`none`) capability while retaining client-id and redirect validation. Metadata that supports only other authentication methods remains unsupported.
- MCP `get_metrics`: return stored numeric precision without display rounding.
- MCP `log_metrics`: permit genuine zero counts/scores/durations and signed skin-temperature deviations while rejecting invalid zero, negative and non-finite measurements.
- MCP `import_wearable_workout`: import original Apple Health summaries and supplied lap segments for the token owner's athlete only. Source UUIDs provide idempotency. Activity processing uses the existing queue.
- Apple Health and Strava use shared cross-provider duplicate detection and durable, athlete-scoped source identities. Either arrival order, retries and concurrent imports resolve to one activity. Existing activity content and user edits are preserved.

The workout importer requires write scope and self access. It does not synthesize GPS or sensor streams. No new metric fields are introduced. The additive `20261018120000_activity_import_sources` migration stores secondary provider identities and cascades them when an activity is deleted.

## Workout duplicates

An exact source identity always takes precedence, including after the athlete edits the calendar entry. New Apple Health/Strava identities are matched only within the same athlete, within 30 seconds of the start, with compatible sports, elapsed durations within 2% (minimum 30 seconds, maximum 120 seconds), and distances within 3% (minimum 100 metres) when both are available. Running/trail running and conventional cycling subtypes are compatible; electric and virtual cycling remain distinct. Moving time is not used as elapsed time.

New Strava primary storage IDs include provider and athlete (`strava:<athlete>:<activity>`), so independently assigned numeric Garmin/Strava IDs cannot collide with the legacy global uniqueness constraint. Existing Strava rows remain readable without rewriting them. Calendar responses expose Strava's original numeric ID so provider links remain valid.

A single unambiguous match links the new source ID to the existing activity. Multiple candidates are kept separate. Per-athlete PostgreSQL transaction locks serialize both import paths, and event creation plus source registration commit atomically. Strava historical import and webhook receipts also recognize secondary IDs.

The first recording's content remains authoritative: this change does not replace Apple Health summaries with later Strava streams, overwrite notes, merge ambiguous matches, or delete pre-existing duplicates. Apple Health still protects matching existing recordings from other providers, but arrival-order guarantees currently cover the Apple Health and Strava import paths. Other providers do not yet take the shared import lock.

## Separate companion project

The native iPhone app, Open Wearables gateway, account enrollment, history import, webhook handling and installation instructions live in [openathlete-wearables-bridge](https://github.com/ScottieNoy/openathlete-wearables-bridge/tree/feat/companion-app).
Production configuration, credentials, user mappings and health records are not part of this fork.

## Updates and deployment

Keep `main` aligned with `openathleteorg/openathlete:main`. Merge reviewed upstream changes into `deployment/companion` and rerun validation before building new API images. Retire patches when their equivalent is accepted upstream. Keep deployment configuration separate from source control.

Creating this branch does not redeploy live services. Build from a pinned, tested integration commit using the existing deployment configuration, preserving the previous image for rollback. The web app has no companion source changes in this fork; the deployment's reverse-proxy configuration routes the companion service separately.

## CI and delivery

See [CI-CD.md](CI-CD.md) for automatic validation, checked image publishing and the manual production-release procedure.

## Validation

Follow CONTRIBUTING.md for the full repository checks. Focused API checks:

```sh
pnpm api test --runInBand src/modules/mcp
pnpm api tsc:check
pnpm api exec eslint 'src/modules/mcp/**/*.ts' --max-warnings 0
pnpm api exec prettier --check 'src/modules/mcp/**/*.ts'
```

The metric regression tests also fail against the unmodified upstream implementation. Real-device HealthKit, background delivery and end-to-end companion validation belong to the companion project.
