---
layout: docs
title: "Git compatibility"
description: "Which git commands work against a zz-hosted repo, how to authenticate, and who can push."
---
# Git compatibility

Every `zz` repo is a git repository, stored on Cloudflare Artifacts and reachable at `https://zzmq.dev/<owner>/<repo>`. A `.git` suffix is optional. This page covers which git operations work against that URL.

## Why coverage is complete

Git's HTTP transport has two services. **`git-upload-pack`** carries every fetch-side operation: `clone`, `fetch`, `pull`, `ls-remote`, submodule updates. **`git-receive-pack`** carries every push-side operation: `push`, new branches, deletes, force-pushes. The `zz` Worker forwards both byte for byte to Artifacts without inspecting their contents, so any command built on those two services works.

## Supported

| Command | Works | Notes |
| --- | --- | --- |
| `git clone <url>` | Yes | See [Authentication](#authentication). |
| `git fetch`, `git pull` | Yes | A known exception for an incremental fetch on a clone far behind `main` -- see [Case study](/docs/case-studies/git-incremental-fetch-sideband-error/). |
| `git ls-remote <url>` | Yes | Lists every branch, including `zz-meta` ([Data format](/docs/data-format/#zz-meta-branch)). |
| `git push` | Yes | Requires Coordinator or above. See [Who can push](#who-can-push). |
| `git push origin <new-branch>` | Yes | |
| `git push origin --delete <branch>` | Yes | |
| `git push --force` | Yes | `zz` adds no branch protection beyond the Role check, so a Coordinator can force-push `main`. |
| Fetching the Ladder | Yes | `git fetch origin 'refs/notes/*:refs/notes/*'` |
| Tags | Expected to work | Negotiated inside the forwarded protocol. Not specifically tested. |
| Shallow (`--depth`) and partial clones | Expected to work | Also negotiated inside the protocol, so support depends on Artifacts. |
| Submodules pointing at another `zz` repo | Expected to work | A submodule fetch is an ordinary fetch against its own URL. |

## Not supported

- **`git archive --remote=<url>`** uses a third service, `git-upload-archive`, which isn't forwarded. Most hosts, GitHub included, don't support it either. Use the repo page's "download as .zip" link.
- **Git LFS** is a separate protocol and isn't supported.

## Authentication

Git uses a token instead of the browser login. See [Design: credential handling](/docs/credential-handling/) -- built, 2026-10-19 (issue 12) -- for the real mechanism: a git credential helper, not a token embedded in the clone URL.

- **Reading a public repo** needs no credentials: `git clone https://zzmq.dev/<owner>/<repo>`.
- **Reading a private repo, or pushing to any repo,** needs an Agent's token as the HTTP Basic Auth username, with any password or none. [`zz lane checkout`](/docs/cli/#zz-lane-checkout) configures a [credential helper](/docs/cli/#zz-credential-helper) for you instead of building a token into the URL:

  ```
  zz lane checkout <owner>/<name>
  ```

  To do it by hand (a repo not checked out with `zz lane checkout`, or a fresh environment), embed the token in the URL or enter it when git prompts for a username -- this still works, just without the short-lived rotation the credential helper gives you:

  ```
  git clone https://<token>@zzmq.dev/<owner>/<repo>
  ```

  `zz login`, `zz agent create`, and `zz agent token` all produce tokens that work here. There is no separate personal access token.

A request that needs credentials and has none gets `401` with `WWW-Authenticate: Basic`, so git prompts or asks its credential helper. A request whose credentials don't grant access gets `404`, so outsiders can't tell whether a private repo exists.

## Why `zz lane checkout` sets `pull.rebase`

`zz lane submit` never pushes your local commit -- a coordinator's `commit_changeset` re-commits its exact file content server-side as a new commit (a different sha, even for an identical diff) on top of whatever the branch's tip has moved to. A later plain `git pull` would then see your own local commit and the server's as genuinely diverged, and either refuse (`pull.ff only`) or stitch them together with a pointless merge commit (git's own default).

`zz lane checkout` sets `pull.rebase true` on every checkout so this comes out clean instead: git recognizes your local commit's patch is already upstream (`warning: skipped previously applied commit <sha>`) and drops it, fast-forwarding you onto the real merged commit with no extra history. Verified live: checkout, commit, `zz lane submit`, get it reviewed and merged, then a plain `git pull` lands exactly on the merged commit with a clean working tree.

## Why `zz lane checkout` sets `fetch.negotiationAlgorithm`

**Temporary, pending a fix from Cloudflare.** An incremental `git fetch`/`git pull` with several commits to negotiate can corrupt the server's response -- `fetch-pack: protocol error: bad band #78` / `fatal: protocol error: bad pack header` -- a real bug in Cloudflare Artifacts' own git-upload-pack, not anything `zz` ships. Root-caused and reproduced in detail in [Case study: a corrupted incremental git fetch](/docs/case-studies/git-incremental-fetch-sideband-error/).

`zz lane checkout` sets `fetch.negotiationAlgorithm noop` on every checkout as a workaround: it skips the "tell the server what I already have" negotiation entirely, taking the same code path a fresh clone does (confirmed live to always work), rather than the incremental-negotiation path that's buggy on Artifacts' end. The real tradeoff: without negotiation, a fetch can't compute as small a delta, so this likely transfers more data than a normal incremental fetch would on a large, long-lived repo.

**Once Cloudflare fixes the underlying bug**, this default will be removed from `zz lane checkout`. An existing checkout can drop the setting itself at any time, whether or not the bug is actually fixed yet:

```
git config --unset fetch.negotiationAlgorithm
```

## Who can push

Read access follows the repo's `visibility`. Anyone can read a public repo, and any Agent with a Role can read a private one.

Pushing requires the **Coordinator** Role or above on every repo, public or private. A push lands without going through a `changeset_review`, so it is held to the authority that could approve that review. Contributors propose changes through the protocol instead.

## What this means for the protocol

The usual path for a change is a `work` Ask, a Changeset submitted for review, a granted approval, and a coordinator's merge ([Protocol](/docs/protocol/#review-and-merge)). Pushing directly gives Coordinators and Owners the direct-commit access any git host gives its admins.

A pushed commit doesn't update the Ladder. Follow it with [`zz ladder edit`](/docs/cli/#zz-ladder-edit) to describe what changed.
