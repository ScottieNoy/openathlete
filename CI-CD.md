# CI and delivery

## Automatic checks

The inherited CI workflow runs on pull requests and pushes to `main` and `deployment/companion`. It can also be started manually. It checks lint, types, unit tests in three time zones, PostgreSQL integration tests, production builds, documentation and end-to-end behavior against freshly built Docker images. Tests use disposable CI databases, not production.

`Required checks` succeeds only when every validation job succeeds. The integration branch can use that check as its branch-protection requirement.

## Checked images

A successful push to `deployment/companion` in this fork publishes AMD64 images:

- `ghcr.io/scottienoy/openathlete-api:sha-<full-commit>` (also used by the worker)
- `ghcr.io/scottienoy/openathlete-web:sha-<full-commit>`

Pull requests, other repositories and failed checks cannot enter this publishing job. It receives package-write permission only for that job. No production credentials are configured in CI.

Each publish job records an immutable `image@sha256:...` reference and source commit in its summary and a `deployment-image-*` artifact. Deploy the digest reference, not a moving tag. Image publishing never restarts services.

The existing upstream release workflow is separate and still responds to version tags. Its store-release paths remain opt-in. Those workflows build OpenAthlete's own mobile app, not the native companion in the separate bridge repository.

## Manual production release

1. Choose a successful CI run for the exact integration commit and obtain both deployment-image artifacts. Confirm both images exist and the production host has approved read access to them. A private GHCR package needs separate registry authorization.
2. Review the changes since the currently deployed commit, especially database migrations and configuration requirements. Take and verify a database/state backup before an upgrade. Do not assume an old image can reverse a database migration.
3. Connect through the operator's existing local SSH configuration. Keep SSH keys on the operator's machine; no production SSH key or runner is installed in GitHub by this workflow.
4. Preserve the current image digest references and the deployment's compose override. Apply the selected image references to the existing service configuration, preserving private settings, proxy routes and volumes. Keep health-sync consent and write settings unchanged.
5. Pull images before restarting. Recreate the API/worker/web services with image builds disabled. No source build should run on the production VM.
6. Verify container health, public web/API availability and companion sign-in/status without importing health data as a deployment smoke test.
7. If verification fails, restore the previous image references and compose configuration, and verify health again. Database rollback needs its own reviewed recovery plan if migrations were applied.

Production releases remain a deliberate operator action. Automatic server deployment and automatic TestFlight upload are not configured.

## Companion pipeline

The [bridge repository](https://github.com/ScottieNoy/openathlete-wearables-bridge) checks Python tests, builds its container, runs Swift core tests and builds the iOS simulator app. It publishes a source-commit-tagged bridge image after all of those checks succeed. Native signing and TestFlight upload continue to use the local Apple signing setup.
