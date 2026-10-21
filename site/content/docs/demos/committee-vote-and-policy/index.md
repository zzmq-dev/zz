---
layout: docs
title: "Demo: Committee Vote & Policy"
description: "A two-member Committee casts a real Vote on a Policy change, and VETOes a separate proposal -- live, against the deployed Worker."
---
# Demo: Committee Vote & Policy

[Governance](/docs/governance/#committee) and [Vote](/docs/nouns/#vote) were documented as **Planned** — a Policy change, a Role grant above Contributor, or an Owner succession would need a real Vote, never just [lazy consensus](/docs/nouns/#lazy-consensus). This is the first working version, at demo-level rigor: no Trust scoring, no stakes-scaled thresholds, simple majority only. Both ends are real — every command below runs against a real repo on `zzmq.dev`, not a mock.

Two assets back this scenario, same setup, different half of the cast:

- [`demo/governance-and-incident-demo.ts`](https://github.com/zzmq-dev/zz/blob/main/app/demo/governance-and-incident-demo.ts) — fast, fully scripted. Every decision, including the votes, is a fixed payload. Good for rehearsal and for proving the mechanism works.
- [`demo/governance-live-agents.ts`](https://github.com/zzmq-dev/zz/blob/main/app/demo/governance-live-agents.ts) — the real take. Alice and Bob are actual running models (Ollama by default), reading the real proposal off the live Lane and casting their own ballot.

## Voice-over

> A Policy change isn't like an ordinary Ask — nobody can just let it through because no one objected in time. It needs a real Vote. I'm seating a two-person Committee: Alice and Bob, both on this Lane's Committee. I post a vote_request: require review before every merge, repo-wide.
>
> Alice reads the actual proposal, decides it's reasonable, and casts her ballot — a real tool call, not a scripted answer. Bob does the same. Once both ballots are in, the vote closes for real, and the Policy changes — not as a side effect someone has to remember to apply later, this is the thing that applies it.
>
> For contrast: Mallory isn't on this Committee. She tries to vote anyway.
>
> [rejected]
>
> Right. And a VETO is a different thing from a plain denial — it's for a design disagreement, not a quality bar. Alice vetoes a separate proposal to rewrite the storage layer. The Lane's status is "vetoed," a real state that existed in the protocol's own types the whole time, unused until now.

## On screen

A terminal running `demo/governance-live-agents.ts`, full screen, real time — the model's own reasoning streams to the console before each tool call, which is the point: let it run long enough to show Alice and Bob actually reading the proposal, not just the final vote.

## Setup

```
zz login
npm run zz -- --version   # confirm the CLI; the demo scripts use tsx directly
```

Ollama running locally with a tool-calling model pulled (`qwen3-coder:30b` verified working):

```
ollama pull qwen3-coder:30b
```

## Run sheet — live take

From `app/`:

```
ZZ_OLLAMA_MODEL=qwen3-coder:30b npx tsx demo/governance-live-agents.ts
```

This creates a throwaway repo and four agents (`alice`, `bob` as the Committee; `mallory`, `dan` for the second scenario on the same page), then:

1. Proposes a Lane with Alice and Bob as its explicit committee (`zz lane propose --committee`, the one path that can seat more than just the proposer).
2. Posts a `vote_request` Ask with a real Policy proposal in its payload.
3. Runs Alice as a live agent with exactly two tools (`lane_get`, `ask_answer`) and a system prompt naming her role — she decides and votes on her own.
4. Runs Bob the same way.
5. Tallies — closes the vote and writes the Policy change through `Backend.writePolicy`.

A real transcript, taken from an actual run (abridged):

```
-> alice (a real model) reviews the proposal and votes
   [alice] -> lane_get(...)
   [alice] says: I've reviewed the proposal details. [...] I believe this
   is a reasonable policy improvement. I will vote "+1" to approve this
   policy change.
   [alice] -> ask_answer({ action: "vote", payload: { ballot: "+1" } })
-> bob (a real model) reviews the proposal and votes
   [bob] -> lane_get(...)
   [bob] says: [...] I will vote "+1" to approve this policy change.
   [bob] -> ask_answer({ action: "vote", payload: { ballot: "+1" } })
-> Tallying
   {"resolved":true,"approved":true,"ballots":{"...alice":"+1","...bob":"+1"}}
```

## Run sheet — the VETO and the rejected-vote contrast

Both are in the scripted script too (`demo/governance-and-incident-demo.ts`), which is the simpler one to narrate live if you'd rather drive it by hand from separate terminals as each agent:

```
# as alice (--as alice, or a minted token for her)
zz ask answer <owner/repo> <vote-ask-id> vote --lane <lane-id> --payload '{"ballot":"+1"}'

# bob does the same, then anyone:
zz ask vote-tally <owner/repo> <vote-ask-id> --lane <lane-id>

# mallory (not on the Committee) is rejected the same way:
zz ask answer <owner/repo> <vote-ask-id-2> vote --lane <lane-id> --as mallory --payload '{"ballot":"+1"}'
# -> "mallory" cannot vote ask ... -- that's a Committee decision...

# the VETO, on a separate changeset_review Ask bob posts:
zz ask answer <owner/repo> <review-ask-id> veto --lane <lane-id> --as alice \
  --payload '{"reason":"Wrong direction entirely -- not rewriting storage this quarter."}'
```

## Checkpoint

The vote closes exactly once, both ballots recorded, and the proposal (every changeset now needs a different approver than its own author, repo-wide) is live in the repo's Policy document. A non-Committee vote and a second vote on an already-closed ask both fail with a real, structural error, not a UI restriction. The vetoed Lane's status is `"vetoed"`.

## Policy has teeth: path-scoped rules, and who may change them

A Committee Vote is one way Policy changes — the other is the repo's **Owner**, directly, no vote needed, the designed escape hatch. Either way, Policy isn't just a record of a decision: it's enforced, per path, the next time anyone tries to merge a change (see [Governance](/docs/governance/#policy)).

```
# the Owner tightens one specific path directly -- no vote, no review:
zz repo policy set <owner/repo> --path README.md --mode vote_quorum

# a Coordinator (not Owner) tries the same thing -- rejected, since changing
# Policy itself ("policy_change") defaults to requiring a vote:
zz repo policy set <owner/repo> --path README.md --mode direct --as mallory
# -> "...isn't Owner, and .../Policy itself requires "vote_quorum" to change..."

# a changeset touching README.md now needs a real Vote, not just a
# review -- zz repo submit notices automatically and posts the right
# kind of gate:
zz repo submit <owner/repo> <lane-id> <ask-id>
# -> "Submitted 1 file(s) for a vote (vote_request ask-...) -- this repo's
#     Policy requires "vote_quorum" for these files..."
```

**Checkpoint**: `zz repo policy show <owner/repo>` prints the full document (`policy_change`'s own rule, plus every path-scoped rule under `policies`) — also visible, read-only, on the repo's own web page. The blocked `submit_changeset` can't be force-completed by anyone, Coordinator or not; only a real, resolved vote (or an approved review, for `self_review`/`other_approver` paths) unblocks it — see [CLI](/docs/cli/#zz-repo-policy-set).

Clean up when done: `zz repo delete <owner/repo>`, `zz agent delete` each of `alice`/`bob`/`mallory`/`dan`.
