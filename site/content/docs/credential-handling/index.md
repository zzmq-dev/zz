---
layout: docs
title: "Design: credential handling"
description: "No SSH on Artifacts, and token-in-the-URL isn't the secure default Cloudflare's own docs point at. A git credential helper, short-lived tokens, reusing storage zz already has."
---
# Design: credential handling

**Status: designed, not built.**

## The problem

`zz repo clone` builds a git remote URL with the token embedded (`https://<token>@zzmq.dev/<owner>/<repo>`). That token then lives in `.git/config`'s `remote.origin.url` in plaintext for as long as the clone exists -- visible in `git remote -v`, copied wherever the repo directory is copied, logged by anything that prints the remote. [Git compatibility](/docs/git-compatibility/#authentication) documents this as the current mechanism; it isn't the one Cloudflare's own docs for Artifacts point at.

## What Artifacts actually offers

Confirmed directly against Cloudflare's docs, not assumed: Artifacts exposes a standard git smart-HTTP remote (`https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`), authenticated with repo-scoped Bearer tokens -- read scope for clone/fetch/pull, write scope for push. **No SSH.** Their own example for authenticated access is `git -c http.extraHeader="Authorization: Bearer <TOKEN>"` -- a header, not a URL-embedded credential.

That's better than what `zz` does today, but still not the fix on its own: setting `http.extraHeader` *persistently* in local config is the same long-lived plaintext secret under a different key, not a real improvement. The actual problem is two separable things -- *where* the secret is stored, and *how long* it's valid -- and both have standard answers.

## The design

**A git credential helper**, the mechanism `gh`/`glab`/Google Cloud's own git integration all use for exactly this problem: a small program git invokes on demand over stdin/stdout, so the secret never gets written into the repo's own config at all.

- `zz repo clone` configures `credential.https://zzmq.dev.helper` -- scoped to that one host, so it never touches whatever helper the user already has configured for `github.com` or anywhere else.
- The helper is the `zz` binary itself (`zz credential-helper`), implementing git's documented `get`/`store`/`erase` protocol.
- It reads from `~/.zz/credentials.json` -- the store `zz login` already writes. No new storage mechanism. A bare `git pull` run outside the `zz` CLI gets the same credential transparently, which is the actual UX complaint this design exists to fix: no copy-paste into a Basic Auth prompt, ever.

**Short-lived tokens, minted on demand, not stored long-lived.** `zz work --as <agent>` already mints a fresh token on start and revokes it on exit, using the logged-in session's own mint authority -- that discipline doesn't currently extend to a human's own plain `git pull`/`git push`. The credential helper should mint a fresh, scoped token per request (or per some short window, cached briefly to avoid minting on every single git subprocess call) rather than handing git one token that lives indefinitely. A leaked token is then a liability for minutes, not until someone notices and manually revokes it.

**Public repos are unaffected.** Reading one already needs no credential; git only invokes a credential helper at all on a 401, which a public read never triggers.

## Scope, for the issues

- `zz credential-helper get`/`store`/`erase` subcommands implementing the protocol.
- `zz repo clone` sets `credential.https://<host>.helper` instead of embedding a token in the URL.
- Token minting: short expiry by default, silent re-mint on expiry inside the helper, reusing the existing mint/revoke path `--as` already has.
- Migration note for existing clones: `git config --unset credential.helper` isn't needed, but a clone made before this exists still has the old URL-embedded token in its remote URL until re-cloned or the remote URL is manually rewritten -- worth a documented one-liner, not a forced migration.

## Tracked as

- [#12](https://github.com/zzmq-dev/zz/issues/12) Git credential helper: stop embedding tokens in the clone URL.
