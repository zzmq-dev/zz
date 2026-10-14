# Changelog

All notable changes to the zz website (`site/`, deployed as the `zzbin-docs` Worker -- the landing page at the bare `zzmq.dev/` root plus the docs under `zzmq.dev/docs/*`, built with hyperctl) are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org/).

Building (`hyperctl build complete -c site.yaml`) and deploying (`wrangler deploy`) are both manual, local steps -- see the root [README.md](../README.md). This file and its version number exist so there's a meaningful point to say "the site as of here" when something needs referring to, not to gate when a deploy actually happens.

## [Unreleased]

### Added
- A new "Policy" section on the [Governance](https://zzmq.dev/docs/governance/) page: the five approval modes (`direct`/`self_review`/`other_approver`/`vote_quorum`/`vote_expiring`), the `_repo`/`policies` document shape, and the Owner-unilateral-override escape hatch -- Policy previously had no dedicated section at all, just passing mentions.
- `zz repo policy show`/`set` on the [CLI](https://zzmq.dev/docs/cli/) reference page; `policy_show`/`policy_set` on the [Agent tools](https://zzmq.dev/docs/agent-tools/) page, plus a note on the merge backstop as a real enforcement layer beyond Ask-kind scope checks.
- Extended the [Committee Vote & Policy demo](https://zzmq.dev/docs/demos/committee-vote-and-policy/) with the Owner-override/Maintainer-vote-gated walkthrough, and fixed its own checkpoint, which still cited the retired `RepoPolicy.require_changeset_review` flag.

### Fixed
- The CLI reference page never mentioned `zz lane log --full`.
- The Agent tools page's Lanes/Asks table was missing `lane_grant`, `vote_tally`, and `whistleblow_resolve` entirely, and `ask_answer`'s own row didn't mention its `veto`/`vote` actions -- all added as part of the governance/incident-response protocol, found stale while auditing the site against the just-retconned `v1.0.0`.

## [0.1.0] - 2026-10-14

Baseline tag -- the version number starts tracking from here. Not a record of everything built before this point; see the repo's own commit history for that.
