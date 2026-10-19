---
layout: docs
title: "Design: credential handling"
description: "No SSH on Artifacts, and token-in-the-URL isn't the secure default Cloudflare's own docs point at. A git credential helper, short-lived tokens, reusing storage zz already has."
---
# Design: credential handling

**Status: built, 2026-10-19 (issue 12).**

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

## What's actually built

- `zz credential-helper get`/`store`/`erase` (`cli/commands/credential-helper.ts`) implementing the real protocol over stdin/stdout. `store`/`erase` are no-ops -- `~/.zz/credentials.json` is the real store this reads from; there's nothing in git's own credential cache to add or remove.
- `zz repo clone` no longer builds a token-embedded URL. It clones with `-c credential.https://<host>.helper=!zz credential-helper` (there's no `.git/config` to set this in permanently until the clone finishes) and then persists the same helper *reference* -- never a token -- into the new clone's own config, so a later plain `git fetch`/`git push` run outside the `zz` CLI gets a credential transparently too.
- **Self-rotating, not a server-enforced TTL.** No expiry column exists on `agent_tokens` today, and adding one is a bigger, separate change to the core auth schema -- out of scope here. Instead, each `get` call revokes whatever token this helper minted last time for that host (tracked in a small local `~/.zz/credential-helper-state.json`) before minting a fresh one. At most one helper-minted token is ever alive at once, continuously rotating -- a leaked one is a liability for about as long as it takes the next git operation to run, not indefinitely.
- Public repos are genuinely unaffected -- confirmed live, a plain clone of a public repo never invokes the helper at all, since git only calls a credential helper on a 401.
- Migration note for existing clones, unchanged from the original design: a clone made before this exists still has the old URL-embedded token in its remote URL until re-cloned or the remote URL is manually rewritten. Not force-migrated.

Verified live against the real deployed Worker: `git remote -v` on a fresh `zz repo clone` shows the plain URL, no token; a real `git push` (unauthenticated past the public-read case) correctly triggered the helper, which minted a working token; a second invocation minted a genuinely different token; the first token was confirmed revoked server-side (a direct API call with it returned 401, not just locally forgotten).

## Tracked as

- [issue 12](https://github.com/zzmq-dev/zz/issues/12) Git credential helper: stop embedding tokens in the clone URL.
