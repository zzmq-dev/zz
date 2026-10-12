# Changelog

All notable changes to the `zzmq` package (the `zz` CLI) are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-12

Initial packaged release.

### Added
- `zz work`'s contributor flow now forks into a real task-shard repo (`<actor>/<parent>[<task-slug>]`), committing for real and writing its own Lane/Ladder before submitting back to the parent for review -- recursive, so a sub-task delegated to another agent just shards the shard.
- Remote-mode TUI: `zz work`'s lanes/ladder/protocol tabs now read live from the deployed server instead of only ever showing local state; the watched-repo set grows live as shards get created.
- A per-repo switcher on the Ladder tab (`r` to cycle) instead of concatenating every watched repo's tree into one list.
- Real npm packaging: a build step (`tsc` -> `dist/`), `zz` on `PATH` via `npm install -g`/`npm link`, no `tsx`/raw-TypeScript dependency at runtime.
- User-supplied paths (`ZZ_CONFIG`, `ZZ_CREDENTIALS`, `ZZ_ID_FILE`) are normalized to absolute paths, expanding `~`.

### Fixed
- `ink`/`react` were present in `node_modules` but never declared as real dependencies -- a fresh install would have been missing them entirely.
- Repo clones and local state resolved relative to wherever the package happened to be installed, instead of the user's own `~/.zz/` -- fixed to match the existing `~/.zz/credentials.json`/`~/.zz/config.json` convention.
- `zz work --repos`/`zz review --repos` silently accepted only a single repo (`--repos` wasn't actually split on commas).
