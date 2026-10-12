# Releasing

Cutting a release is a manual, deliberate step -- nothing publishes itself just because `main` moved. CI (`.github/workflows/ci.yml`) runs typecheck + build on every push/PR; the release workflow (`.github/workflows/release.yml`) only runs when a `v*` tag is pushed.

## One-time setup

- `npm` package name is `zzmq` (the `zz` binary name is unaffected -- see `package.json`'s own `bin` field). Needs an `NPM_TOKEN` repo secret (a npm "Automation" token with publish rights to `zzmq`) before the first release can actually publish.
- The release workflow publishes with `--provenance`, which needs the repo to be public (or a GitHub plan that supports provenance for private repos) and `id-token: write` permission, already set in the workflow.

## Cutting a release

From `app/`:

1. Move the `CHANGELOG.md` `[Unreleased]` section's entries under a new `## [x.y.z] - YYYY-MM-DD` heading (today's date), leaving `[Unreleased]` empty above it.
2. `npm version patch` (or `minor`/`major`, per [semver](https://semver.org/): patch for fixes, minor for backward-compatible features, major for breaking changes) -- bumps `package.json`, commits, and tags `vX.Y.Z` locally.
3. `git push --follow-tags`.

Pushing the tag is what triggers the release workflow: it verifies the tag matches `package.json`'s version, typechecks, builds, `npm publish`es, and creates a GitHub Release with auto-generated notes from the commits since the last tag.

## Verifying a release landed

- `npm view zzmq version` should show the new version within a minute or two of the workflow finishing.
- `npm install -g zzmq@latest && zz --version` should match.
