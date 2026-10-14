# Changelog

All notable changes to the `zzmq` package (the `zz` CLI) are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org/).

## [Unreleased]

### Added
- Deleting a repo, or making it private, no longer blocks on or cascades onto its shards: one surviving shard is promoted to take over as the shard tree's new root (fewest commits behind the old origin, ties broken by most recent protocol activity), and every other shard -- regardless of who owns it -- is repointed at the promoted one. Same behavior GitHub itself uses for a deleted/privatized repo's forks. See [Governance](https://zzmq.dev/docs/governance/#deleting-a-repo-or-making-it-private).
- Creating a repo (`zz repo create`), or claiming a `work` Ask (which forks a shard), now auto-tracks it for its creator/claimer -- it shows up in `zz top` immediately, instead of needing a separate manual `zz repo track` first.
- `zz top`/`zz work`'s TUI: the Protocol tab is renamed **Activity** (`zz work`'s old raw-log Activity tab is now **Live feed**, to free up the name), reads newest-first instead of oldest-first, and its row format changes from `[TIME] [REPO] [LANE] [VERB] [KIND] from [USER]` to `[TIME] [VERB] [KIND] on [REPO] [LANE] by [USER]`. Two new entries show as `LANE`, not yet real protocol verbs but displayed as one since they likely will be: `create` (a repo's own creation, via a new `repo_info` tool) and `merge` (the ANSWER that actually completes a `submit_changeset`, today's real merge moment). A deleted repo has no equivalent `LANE delete` yet -- there's no durable record of a deletion to read back once the repo is gone, so this is left for later.
- `zz top`'s Lanes tab: pressing enter on an ask (previously a no-op there, since zz top has nothing to claim) now opens its full contents as pretty-printed, scrollable JSON -- the only place to see a payload in full; the row list itself truncates it to one line.
- `zz review --ask <id>`: reviews one specific changeset_review and exits, instead of the default wait loop -- for a one-off command-line step (a demo's own script, say) rather than a person sitting at a terminal continuously reviewing whatever shows up next.

## [1.1.0] - 2026-10-14

### Added
- **Policy has teeth**: a repo's Policy document now actually gates merges instead of just recording a decision. `_repo` (an Owner may always change it unilaterally, no vote, no review -- the designed escape hatch) and `policies` (path-glob rules for everything else, most-specific match wins, strictest mode wins across a changeset) replace the old, never-enforced `require_changeset_review` flag. Five modes: `direct` (no gate), `self_review` (today's existing behavior, unchanged default), `other_approver` (a changeset_review, but the approver must differ from the author), `vote_quorum` (a real Committee Vote), and `vote_expiring` (the same Vote, opted into lazy consensus -- unanswered past its deadline auto-approves instead of staying open forever). New commands: `zz repo policy show`/`set`. Enforced in the one place a `submit_changeset` can actually complete (`engine/lane.ts`'s merge backstop), not just the CLI or the UI -- `zz repo submit`/`zz work` resolve the right gate automatically and post it without being asked. See [Governance](https://zzmq.dev/docs/governance/#policy) and the extended [Committee Vote & Policy demo](https://zzmq.dev/docs/demos/committee-vote-and-policy/).

## [1.0.0] - 2026-10-14

### Added
- A first, demo-level implementation of governance and incident response: `vote_request`/`whistleblow` Ask kinds, `veto`/`vote` Answer actions, Policy (`Backend.readPolicy`/`writePolicy`), and the STOP/DROP/ROLL incident runbook. New commands: `zz ask answer`, `zz ask vote-tally`, `zz ask whistleblow`, `zz lane propose`, `zz lane grant`, `zz ask post --remote`. See [Demos](https://zzmq.dev/docs/demos/).
- `zz agent delete`: permanently deletes a managed agent you created. Releases every claim it holds, deletes its own shards, revokes its remaining Role grants, then removes its tokens/identities/sessions. Lane history is never touched.
- `zz lane log --full`: shows a payload's complete JSON in the text format instead of cutting it off at 80 chars.
- **Decomposition**: a `work` Ask can be split into independent sub-tasks, each posted as its own Ask in a new sibling Lane and recorded on the parent Lane's `related_lanes`. `zz repo ask --decompose` forces it; otherwise the agent that claims the Ask judges for itself whether it has independent parts. Autonomous `zz work` only (not `--assist`).
- **`zz work --assist` reworked**: now opens on a Lane picker (sorted busiest-first) with a **lanes** tab and an **unclaimed** tab (every claimable Ask across your watched repos, no need to pick through Lanes one at a time). Either tab's own Ask list can be filtered by status (`s`), posts a new Ask (`n`, lanes tab), and claims an Ask directly (`c`) without a separate confirmation step. `ctrl+/` (or typing `!`) opens a real shell in the current shard, `ctrl+y` copies.
- `zz ask claim` and `zz ladder edit`: the manual, by-hand counterparts to an agent's own claim and Ladder-write steps, for doing the whole protocol yourself from the CLI with no TUI.
- `zz top`: login/logout in place (`l`), a Lane picker you can post a new Ask from, and a responsive protocol feed (one line per event on a wide terminal, two on a narrow one). Its Explore tab shows the zz wordmark while idle.
- An ASCII banner on `--help`/`--version` (plain `--version --simple` for scripts) and at the top of `zz work --stdio`'s own output; every `--stdio` log line is now timestamped.
- Real subdirectory support in commits and the initial commit of a new repo -- previously only flat, single-segment paths worked.
- **Importing a real GitHub repo**: `zz ladder build <owner/repo>` onboards one from its real git history and issue/PR/release data (now with `--provider groq`/`gemini`/`cloudflare`, not just local Ollama), `zz ladder push <local-repo> <owner/repo>` does the one-time transfer onto a real remote repo, and `zz ladder sync <local-repo> <owner/repo>` keeps an already-imported repo caught up with its real source afterward -- fetches the latest commits, re-summarizes only what actually changed, and picks up new issues/PRs/releases/contributors/dependencies for free.
- `zz repo delete <owner/repo>`: was previously only possible from the web UI's settings page. Asks you to type the slug back to confirm (`-y`/`--yes` to skip) -- a real, irreversible delete.

### Fixed
- The TUI's protocol view (`zz top`/`zz work`'s "protocol" tab) never showed an event's timestamp at all, unlike `zz lane log` and the web app's own Lane history -- added `HH:MM:SS.mmm` to each row.
- A repo-level Role grant (`zz repo grant`) had no effect on any Lane's own claim/review/merge authority -- confirmed live, this left a granted Maintainer able to claim open-scope work forever but never review or merge any of it. `zz lane grant` adds an agent to an existing Lane's `coordinators`/`maintainers` directly.
- A changeset submitted from a task shard carries a `baseCommit` that only exists in the shard's own git history; the three-way merge diffed it against the origin repo's local clone, which never had those objects unless fetched first -- failed with a real `fatal: bad object` on a self-merge's second changeset in a row.
- `git merge-file`'s exit code is the number of conflicting hunks it found, not a fixed 0/1 -- a file with more than one conflicting region crashed the whole `zz work` process instead of reporting a normal conflict.
- `zz ladder edit --kind function` (and `lines`/`package`/`filechange`/`linechange`) was always rejected -- those kinds have no git object of their own to anchor to and can only be written nested inside a parent rung's `children`. The `--kind` help text listed them as valid and was missing `directory`/`ask`, which do work.
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
