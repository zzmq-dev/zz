# Changelog

All notable changes to the zz web app (the Cloudflare Worker deployed as `zz-maintainer`, serving `zzmq.dev`'s `/explore`, `/login`, `/<owner>/<repo>`, and the JSON API everything else talks to) are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org/).

Deploys are manual (`wrangler deploy` from `app/worker/`) and not tied to this version number one-to-one -- a deploy can happen between releases. This file and its version number exist so there's a meaningful point to say "the web app as of here" when something needs referring to, not to gate when `wrangler deploy` is actually run.

## [Unreleased]

## [0.1.0] - 2026-10-14

Baseline tag -- the version number starts tracking from here. Not a record of everything built before this point (the Worker has been live and iterating for a while already); see the repo's own commit history for that.
