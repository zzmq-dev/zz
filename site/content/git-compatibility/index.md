---
layout: docs
title: "Git compatibility"
description: "What ordinary git commands work against a zz-hosted repo, what doesn't, and why."
---
# Git compatibility

A zz repo is a real git repo (Cloudflare Artifacts underneath), reachable at `https://<domain>/<account>/<repo>` -- no `.git` suffix needed, though git accepts one too. This page is the honest, complete account of what ordinary git does and doesn't do against that URL.

## Why the coverage is total, not command-by-command

Git's HTTP transport has exactly two services, not one per porcelain command: **`git-upload-pack`** carries every fetch-side operation (`clone`, `fetch`, `pull`, `ls-remote`, submodule updates), and **`git-receive-pack`** carries every push-side operation (`push`, new branches, deletes, force-pushes -- all the same endpoint). zz's Worker proxies both as raw byte streams to the real Artifacts git server, with no inspection of the protocol content itself. Nothing needed command-specific handling; whatever rides on these two services works, because the proxy never knows or cares which porcelain command produced the bytes.

## Supported

Verified live, not assumed, against a real deployed repo:

| Command | Works | Notes |
|---|---|---|
| `git clone <url>` | Yes | No token in the URL -- see Authentication below. |
| `git fetch` | Yes | |
| `git pull` | Yes | Fetch + local merge; no server-side difference from `fetch`. |
| `git ls-remote <url>` | Yes | Lists every branch, including `refs/heads/zz-meta` -- it's a real branch (see [Data format](/data-format/)). |
| `git push` | Yes | Gated -- see RBAC below. |
| `git push origin <new-branch>` | Yes | |
| `git push origin --delete <branch>` | Yes | Same endpoint as any other push; a ref-delete update. |
| `git push --force` | Yes | Proxied like any other push. zz places no server-side protection on `main` beyond the RBAC gate itself -- a force-push from someone with Maintainer+ is not blocked. |
| `git push --tags`, fetching tags | Expected to work | Capability negotiation happens inside the pack protocol dialogue, which is forwarded verbatim -- not specifically tested, but nothing about the proxy treats tags differently from branches. |
| Shallow (`--depth`) / partial clone | Expected to work | Same reasoning: these are negotiated capabilities inside the proxied dialogue, not separate endpoints. Depends on Cloudflare Artifacts' own upstream support, which the proxy doesn't add to or restrict. |
| Submodules pointing at another zz repo | Expected to work | A submodule fetch is an ordinary `git-upload-pack` request against its own URL. |

## Not supported

- **`git archive --remote=<url>`** -- a third, separate git service (`git-upload-archive`) that isn't proxied. Most git hosts don't support this either (GitHub included); use the repo page's "download as .zip" link instead.
- **Git LFS** -- an entirely separate protocol layered on top of core git, unrelated to the smart-HTTP services above. Not proxied, not planned.

## Authentication

Git carries no session cookie, so it never uses the browser login (Cloudflare or Google OAuth, see [accounts and the web app](/data-format/#accounts-and-the-web-app)). Instead:

- **Reading a public repo** needs no credentials at all. `git clone https://<domain>/<account>/<repo>` just works.
- **Reading a private repo, or pushing to any repo**, needs an **agent token** -- minted on `/profile`, the same token an agent uses to call the protocol's own tools. Use it as the HTTP Basic Auth username (the password can be left blank), either embedded in the URL --

  ```
  git clone https://<token>@<domain>/<account>/<repo>
  ```

  -- or entered when git prompts for a username/password. There is no separate "personal access token" concept for a human: a human who wants to push directly creates an agent for themselves (e.g. "my-laptop") on `/profile` and uses its token, the same as any other agent would.
- An unauthenticated request that needs credentials gets a real `401` with `WWW-Authenticate: Basic`, so git prompts or retries with whatever a credential helper has, rather than failing silently. A request with credentials that aren't sufficient gets `404`, not `403` -- a private repo's existence and "your credentials don't grant access to it" are deliberately indistinguishable from outside.

## RBAC: what push actually requires

Reading is governed by `visibility` in the repo's `meta.json` (public by default) and, for a private repo, an explicit grant in `roles.json` -- see [Data format](/data-format/) for the shape.

**Pushing is always gated at Maintainer or above**, regardless of a repo's visibility -- a public repo is publicly *readable*, never publicly *writable*, the same rule GitHub itself applies. This bar is deliberate, not arbitrary: a raw `git push` bypasses the per-changeset `changeset_review` a Contributor would otherwise need before a change merges (see [Governance](/governance/)), so push is held to the same authority that could grant that review anyway. A Contributor can propose a Lane and submit a changeset through the protocol; a Contributor cannot `git push` directly.

## What this means for the protocol

Direct git push is an escape hatch, not the primary way code is meant to land in a zz repo -- the normal path is `work` -> `submit_changeset` -> `changeset_review` -> `commit_changeset`, enforced by the engine itself (see [Protocol](/protocol/)), the same mechanism this whole project is about. Git push exists so a Maintainer or Owner has the same direct-commit ability any git host gives its admins, not as a way around the coordination layer for anyone without that standing.
