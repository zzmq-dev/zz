# .zz/

This directory is the portable, committed half of zz's coordination state — see [docs/05-data-format.md](../docs/05-data-format.md) for the full format. It's checked into git on purpose: decisions, Lane history, and cascade provenance should be visible in a plain file browser on any git host, not hidden behind a special command the way git notes are.

This repo doesn't have a live Maintainer yet, so there's nothing else here to commit — once implementation starts, `lanes/`, `decisions/`, `cascades/`, and `credit/` will populate automatically as Lanes run.
