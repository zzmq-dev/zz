# Releasing

A version/changelog discipline, not a deploy trigger -- building (`hyperctl build complete -c site.yaml`) and deploying (`wrangler deploy`) both stay manual, local steps (hyperctl has no public package, so it can't run in CI -- see `.github/workflows/release-site.yml`'s own header). Cutting a release just means: here's a tagged, changelogged point to call "the site as of here".

## Cutting a release

From `site/`:

1. Move `CHANGELOG.md`'s `[Unreleased]` section's entries under a new `## [x.y.z] - YYYY-MM-DD` heading (today's date), leaving `[Unreleased]` empty above it.
2. `npm version patch --tag-version-prefix=site-v` (or `minor`/`major`, per [semver](https://semver.org/)) -- bumps `package.json`, commits, and tags `site-vX.Y.Z` locally.
3. `git push --follow-tags`.
4. Whenever you're actually ready to ship it: `hyperctl build complete -c site.yaml -i current && npx wrangler deploy`.
