# Companion integration fork

This fork preserves the OpenAthlete API changes used by the Apple Health companion integration.
`main` follows upstream; `deployment/companion` contains the integration changes.
Initial upstream base: `aad3ba3ff45d91e15b24a1b76ef16244c2488b0f`.

## Changes

- OAuth Client ID Metadata Documents: accept an explicitly supported public-client (`none`) capability while retaining client-id and redirect validation. Metadata that supports only other authentication methods remains unsupported.
- MCP `get_metrics`: return stored numeric precision without display rounding.
- MCP `log_metrics`: permit genuine zero counts/scores/durations and signed skin-temperature deviations while rejecting invalid zero, negative and non-finite measurements.
- MCP `import_wearable_workout`: import original Apple Health summaries and supplied lap segments for the token owner's athlete only. Source UUIDs provide idempotency; nearby existing activities and user edits are protected. Activity processing uses the existing queue.

No database migration or new metric fields are introduced. The workout importer requires write scope and self access. It does not synthesize GPS or sensor streams.

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
