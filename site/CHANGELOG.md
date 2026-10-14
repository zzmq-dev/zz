# Changelog

All notable changes to the zz website (`site/`, deployed as the `zzbin-docs` Worker -- the landing page at the bare `zzmq.dev/` root plus the docs under `zzmq.dev/docs/*`, built with hyperctl) are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org/).

Building (`hyperctl build complete -c site.yaml`) and deploying (`wrangler deploy`) are both manual, local steps -- see the root [README.md](../README.md). This file and its version number exist so there's a meaningful point to say "the site as of here" when something needs referring to, not to gate when a deploy actually happens.

## [Unreleased]

### Added
- Cleanup instructions on every demo page: Stages 1-6 each note that they deliberately carry into the next stage with nothing to clean up yet, and link to Stage 7's checkpoint, which now gives the real `zz repo delete`/`zz agent delete` commands for the whole shared `mathkit` repo and fleet. The Whistleblow demo's own cleanup now also covers its agents, not just the repo. A new "Cleaning up" section on the [Demos index](https://zzmq.dev/docs/demos/) explains the rule across all nine pages.
- A copy button on every code block in the docs, same style/positioning as the web app's own (a small circular button pinned to the block's top-right corner) -- `copy-code.js`, injected site-wide via the docs layout, needs no markup of its own on any individual page.
- A new "Deleting a repo, or making it private" section on the [Governance](https://zzmq.dev/docs/governance/) page: deleting or privatizing a repo never blocks on or cascades onto its shards -- one is promoted to take over as the new root instead, picked by fewest commits behind the old origin, then most recent protocol activity. Cross-linked from the [Shard](https://zzmq.dev/docs/nouns/#shard) entry on Core Concepts.
- `zz review`'s new `--ask <id>` flag, on the [CLI reference](https://zzmq.dev/docs/cli/#zz-review) page. The [By hand](https://zzmq.dev/docs/demos/by-hand/) demo's Correction 1 now uses it instead of relying on the wait loop having exactly one thing to review.
- `zz review`/`zz work`'s new `--no-wait`, and `zz work`'s new `--ask <id>`, on the [CLI reference](https://zzmq.dev/docs/cli/#zz-work) page.
- A new "Why `zz repo clone` sets `pull.rebase`" section on the [Git compatibility](https://zzmq.dev/docs/git-compatibility/) page: `zz repo submit` never pushes your local commit, so a later plain `git pull` needs rebase (not merge or `--ff-only`) to land cleanly on the coordinator's real merged commit.
- `zz work --assist` now merges `submit_changeset` Asks directly (`/merge`), documented on the [CLI reference](https://zzmq.dev/docs/cli/#zz-work-assist) page. The [Assisted](https://zzmq.dev/docs/demos/assisted/) demo's run sheet now merges from the same `--assist` session instead of a separate terminal.

### Fixed
- The Demos index still said "there's no `zz agent delete` yet" -- it's existed since the CLI's own `v1.0.0`.
- The install page's quickstart created an agent named `claude` and then ran it with `--provider groq` -- renamed the agent to `groq` throughout so the example doesn't name one model while running another.
- A highlighted code block's own line numbers rendered with zero horizontal space before the code -- turned off entirely (`.chroma .ln { display: none }`) rather than patched with padding.
- Two more stale `require_changeset_review` mentions, on the Data format and Core Concepts (nouns) pages -- missed in the earlier pass since they weren't inside the Governance/CLI/Agent-tools/demo pages that pass specifically audited.
- The CLI reference's `zz top` tab table still named the old **activity**/**protocol** tabs and said the activity feed reads newest-at-the-bottom -- stale since this session's own TUI rename/reorder (now **live feed**/**activity**, newest-at-top), caught only now while adding `--no-wait`/`--ask` nearby.
- The [Assisted](https://zzmq.dev/docs/demos/assisted/) demo said approving a changeset_review inside `--assist` merges it -- found live by a reader stuck exactly there: `--assist`'s own picker never offered `submit_changeset` at all, so the Ask was just sitting open with no way to act on it from that view. Fixed properly rather than just documented: see `--assist`'s new `/merge` support above.

## [0.2.0] - 2026-10-14

### Added
- A new "Policy" section on the [Governance](https://zzmq.dev/docs/governance/) page: the five approval modes (`direct`/`self_review`/`other_approver`/`vote_quorum`/`vote_expiring`), the `_repo`/`policies` document shape, and the Owner-unilateral-override escape hatch -- Policy previously had no dedicated section at all, just passing mentions.
- `zz repo policy show`/`set` on the [CLI](https://zzmq.dev/docs/cli/) reference page; `policy_show`/`policy_set` on the [Agent tools](https://zzmq.dev/docs/agent-tools/) page, plus a note on the merge backstop as a real enforcement layer beyond Ask-kind scope checks.
- Extended the [Committee Vote & Policy demo](https://zzmq.dev/docs/demos/committee-vote-and-policy/) with the Owner-override/Maintainer-vote-gated walkthrough, and fixed its own checkpoint, which still cited the retired `RepoPolicy.require_changeset_review` flag.

### Fixed
- The CLI reference page never mentioned `zz lane log --full`.
- The Agent tools page's Lanes/Asks table was missing `lane_grant`, `vote_tally`, and `whistleblow_resolve` entirely, and `ask_answer`'s own row didn't mention its `veto`/`vote` actions -- all added as part of the governance/incident-response protocol, found stale while auditing the site against the just-retconned `v1.0.0`.

## [0.1.0] - 2026-10-14

Baseline tag -- the version number starts tracking from here. Not a record of everything built before this point; see the repo's own commit history for that.
