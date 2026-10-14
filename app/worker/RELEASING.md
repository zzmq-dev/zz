# Releasing

This is a version/changelog discipline, not a deploy trigger -- `wrangler deploy` from here stays a manual, local step whenever you're ready to actually ship, same as it's always been. Cutting a release just means: here's a tagged, changelogged point to call "the web app as of here". CI (`.github/workflows/ci.yml`) already runs typecheck + build on every push/PR; `.github/workflows/release-web.yml` only runs when a `web-v*` tag is pushed, and only verifies the tag + creates a GitHub Release -- it doesn't build, deploy, or publish anything.

## Cutting a release

From `app/worker/`:

1. Move `CHANGELOG.md`'s `[Unreleased]` section's entries under a new `## [x.y.z] - YYYY-MM-DD` heading (today's date), leaving `[Unreleased]` empty above it.
2. `npm version patch --tag-version-prefix=web-v` (or `minor`/`major`, per [semver](https://semver.org/)) -- bumps `package.json`, commits, and tags `web-vX.Y.Z` locally.
3. `git push --follow-tags`.
4. Whenever you're actually ready to ship it (now, or later -- not the same moment as the tag): `npm run deploy` from here.
