# Changelog

All notable changes to the `zzmq` package (the `zz` CLI) are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-10-14

### Added
- **Decomposition**: a `work` Ask can be split into independent sub-tasks, each posted as its own Ask in a new sibling Lane and recorded on the parent Lane's `related_lanes`. `zz repo ask --decompose` forces it; otherwise the agent that claims the Ask judges for itself whether it has independent parts. Autonomous `zz work` only (not `--assist`).
- **`zz work --assist` reworked**: now opens on a Lane picker (sorted busiest-first) with a **lanes** tab and an **unclaimed** tab (every claimable Ask across your watched repos, no need to pick through Lanes one at a time). Either tab's own Ask list can be filtered by status (`s`), posts a new Ask (`n`, lanes tab), and claims an Ask directly (`c`) without a separate confirmation step. `ctrl+/` (or typing `!`) opens a real shell in the current shard, `ctrl+y` copies.
- `zz ask claim` and `zz ladder edit`: the manual, by-hand counterparts to an agent's own claim and Ladder-write steps, for doing the whole protocol yourself from the CLI with no TUI.
- `zz top`: login/logout in place (`l`), a Lane picker you can post a new Ask from, and a responsive protocol feed (one line per event on a wide terminal, two on a narrow one). Its Explore tab shows the zz wordmark while idle.
- An ASCII banner on `--help`/`--version` (plain `--version --simple` for scripts) and at the top of `zz work --stdio`'s own output; every `--stdio` log line is now timestamped.
- Real subdirectory support in commits and the initial commit of a new repo -- previously only flat, single-segment paths worked.
- **Importing a real GitHub repo**: `zz ladder build <owner/repo>` onboards one from its real git history and issue/PR/release data (now with `--provider groq`/`gemini`/`cloudflare`, not just local Ollama), `zz ladder push <local-repo> <owner/repo>` does the one-time transfer onto a real remote repo, and `zz ladder sync <local-repo> <owner/repo>` keeps an already-imported repo caught up with its real source afterward -- fetches the latest commits, re-summarizes only what actually changed, and picks up new issues/PRs/releases/contributors/dependencies for free.
- `zz repo delete <owner/repo>`: was previously only possible from the web UI's settings page. Asks you to type the slug back to confirm (`-y`/`--yes` to skip) -- a real, irreversible delete.

### Fixed
- `zz work --assist` fails fast with a plain error (missing API key, Ollama unreachable) before ever entering the TUI, instead of crashing mid-session.
- A long Ask description no longer breaks the picker/chat layout on a small terminal; chat output wraps instead of truncating.
- Claiming an Ask that's already been answered is now rejected outright (previously succeeded and only failed much later, at an impossible re-answer step) -- the message points at the real follow-up Ask a `changeset_review` denial already posts.
- `proposeReview` now re-runs the sandbox against a proposed changeset itself before judging it, instead of only trusting the contributor's own earlier pass -- a sandbox failure here denies automatically with the real failure as feedback, closing the retry loop within the same running `zz work` session.
- The model is now told what its sandbox actually provides (Node's own `node --test`/`node:assert`, real ESM) instead of writing Jest/Mocha-style tests or CommonJS that could never pass.
- Shard directory names on disk use `__` instead of literal brackets (`pants__foo__bar`, not `pants[foo][bar]`) -- the real slug, brackets included, is unchanged everywhere else.
- `zz ladder build` failed immediately on any repo that wasn't already present locally (`Could not find HEAD`) -- a stale, package-relative path convention in the local Ladder backend that had drifted from the real `~/.zz/repos/...` one everything else already used.
- A directory's own Ladder rung could go silently unreadable (or, worse, start reading back as a totally different rung) the first time anything re-touched an already-onboarded repo -- three compounding bugs in how a directory anchored and referenced its own git note, all now fixed; a real repo with subdirectories (not just a flat file list) is what it took to ever hit any of them.
- A `--force` rebuild of an already-onboarded repo silently dropped every already-onboarded ask/release/contributor/dependency from the repo root's own children list (their own notes were untouched, just unreachable from it).
- A cumulative rung's (repo/directory/file/release) stored summary could compound into the same paragraph repeated several times, reworded each round, across repeated writes to an already-imported repo -- fixed both the degraded fallback that caused it and, for `zz ladder sync`'s own re-summarize step, feeding the merge step an actual description of what changed instead of a second independent full redescription of the same content.
- A file rung's own commit source recorded the literal string `"HEAD"` instead of a real commit sha.
- `ladder_write_rung` now replies in well under a minute for a real, non-trivial repo instead of multiple hours -- it was doing one full git-notes fetch+push per rung even though most rungs share one ref; now batches per ref instead of per rung.

### Security
- The remote tools endpoint only checked that the caller was logged in, not the repo's own visibility or the caller's Role -- any authenticated account could read a private repo's content, or call any write tool on it. Now requires an actual Role grant for a private repo.
- `commit_changeset` and `ladder_write_rung` were only withheld from non-coordinators by `zz work`'s own choice of which tools to hand a model -- a direct API call bypassed that entirely. Both now require Maintainer+ on the target repo, enforced server-side.
- `engines.node` said `>=20`; the CLI loads `node:sqlite` at startup, which needs 22.13+. Now matches what the docs already said.

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
