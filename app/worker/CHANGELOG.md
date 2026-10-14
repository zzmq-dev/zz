# Changelog

All notable changes to the zz web app (the Cloudflare Worker deployed as `zz-maintainer`, serving `zzmq.dev`'s `/explore`, `/login`, `/<owner>/<repo>`, and the JSON API everything else talks to) are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org/).

Deploys are manual (`wrangler deploy` from `app/worker/`) and not tied to this version number one-to-one -- a deploy can happen between releases. This file and its version number exist so there's a meaningful point to say "the web app as of here" when something needs referring to, not to gate when `wrangler deploy` is actually run.

## [Unreleased]

### Added
- Directory navigation in the file browser (`/<owner>/<repo>/tree/<ref>/<path>`) -- a directory used to render as plain, unclickable text.
- Blob/tree browsing is ref-aware: a file or directory reached from a historical commit's own tree stays pinned to that commit instead of silently jumping to HEAD, all the way down (`/tree/<ref>/...`, `/blob/<ref>/...`, `/download/<ref>/...`).
- Viewing a file at a historical (non-HEAD) commit shows an inline line diff against its parent, with that commit's own filechange summary for context, instead of just the plain current-state file view every ref used to get.
- The Commits tab pages (`?commitsPage=<n>`, newer/older nav) instead of silently cutting off at a fixed 30; the Ladder tab is fixed-height with its own scrollbar (and now a client-side search box) instead of growing the whole page.
- A repo mid-import (`zz ladder push`/`zz ladder sync`) isn't discoverable via search/listing until it's actually done, unless you're its owner -- its own page still loads, with a banner.
- A repo's description: editable from its settings page (previously set once at creation and never again), and any URL in one renders as a real link everywhere descriptions show.
- `/login` redirects straight into your profile if you're already authenticated, instead of showing the login buttons again.
- `DELETE /api/repos/:owner/:repo`: the token-authenticated counterpart to the settings page's own delete button, backing the CLI's new `zz repo delete`.
- `POST /api/repos/:owner/:repo/ingest-status`: lets an import in progress mark itself not-ready and flip back once it's done.

### Fixed
- The Ladder tab's new search box wasn't actually hiding anything it filtered out -- `.row`'s own `display:flex` silently beat the browser's default `[hidden]` styling every time, regardless of what the filter itself correctly computed.

## [0.1.0] - 2026-10-14

Baseline tag -- the version number starts tracking from here. Not a record of everything built before this point (the Worker has been live and iterating for a while already); see the repo's own commit history for that.
