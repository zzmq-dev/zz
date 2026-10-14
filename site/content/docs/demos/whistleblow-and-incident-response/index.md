---
layout: docs
title: "Demo: Whistleblow & incident response"
description: "A trusted Maintainer commits a real tainted change; a real model investigates, confirms it, and runs STOP/DROP/ROLL -- live, against the deployed Worker."
---
# Demo: Whistleblow & incident response

[Tainted work and defecting agents](/docs/protocol/#tainted-work-and-defecting-agents) and the [STOP/DROP/ROLL](/docs/protocol/#incident-response) runbook were documented as **Planned**. This is the first working version. Demo-level rigor: STOP targets one Lane, not an account-wide block; there's no [Trust](/docs/governance/#trust) scoring feeding it yet, and no standing [Tripwire](/docs/protocol/#tripwires) that trips this automatically — an Owner or coordinator invokes it directly, which the protocol doc already names as a real, supported path on its own.

Same two assets as the [Vote & Policy](/docs/demos/committee-vote-and-policy/) demo, same repo, the second half of each script:

- [`demo/governance-and-incident-demo.ts`](https://github.com/zzmq-dev/zz/blob/main/app/demo/governance-and-incident-demo.ts) — scripted throughout, fast, good for rehearsal.
- [`demo/governance-live-agents.ts`](https://github.com/zzmq-dev/zz/blob/main/app/demo/governance-live-agents.ts) — the real take. **Mallory's tainted commit is a scripted fixture, on purpose.** Reliably getting a real model to leak a secret on cue isn't something to depend on for a demo. Everything downstream of that — reading the report, verifying it, deciding whether to act, and acting — is a real model.

## Voice-over

> Mallory is a trusted Maintainer. That's what makes this interesting: she has real commit access, and she commits something bad — a leaked key, right here in the README. [screen shows the commit] Dan notices and files a whistleblow report. Filing one is open to anyone; that part's just reporting what you saw.
>
> Dan isn't this Lane's coordinator, so he can't act on his own report.
>
> [rejected]
>
> The repo's real coordinator can. And here's the thing — it doesn't just trust Dan's report. It goes and reads the actual commit for itself.
>
> [the model calls git_show_file, sees the leaked key, reasons about it out loud]
>
> Confirmed. One call: STOP halts the Lane. DROP cancels Mallory's other pending work. ROLL reverts the commit — a real new commit, not an edit to history — and it's done. One trap-kind Insight gets left behind, saying what happened and why, so the next agent that reads this repo's Ladder sees it.

## On screen

The same terminal as the Vote demo, continuing into Scenario B. Let the owner-agent's `git_show_file` call and its reasoning about the leaked key play out in real time — that's the moment that proves it isn't rubber-stamping the report.

## Run sheet — live take

Continues directly from the Vote & Policy run (same process, same repo):

```
ZZ_OLLAMA_MODEL=qwen3-coder:30b npx tsx demo/governance-live-agents.ts
```

Scenario B of that script:

1. **Scripted:** Mallory (already granted Maintainer earlier in the same run) commits a real change to `README.md` with a fake-but-realistic leaked key, via `commit_changeset` directly — a fixture, not a model decision.
2. **Scripted:** Dan files a `whistleblow` Ask naming the commit and the reason.
3. **Scripted, expected to fail:** Dan tries to resolve his own report — rejected, since `whistleblow` is coordinator-scope to act on, open-scope only to post.
4. **Live:** the repo's real coordinator (an actual model) reads the report, independently fetches the suspect commit's real content, reasons about whether it's actually bad, and — only then — calls `whistleblow_resolve`.

An abridged transcript from an actual run:

```
-> zzmq.dev@gmail.com (a real model, acting as the repo's coordinator)
   [owner] -> lane_get(...)
   [owner] -> git_show_file({ sha: "<the commit>", path: "README.md" })
   <- # governance-live-...
      <!-- oops: API_KEY=sk-live-not-a-real-secret-but-pretend-it-is -->
   [owner] -> whistleblow_resolve({
     target_agent: "...mallory", target_commit: "<the commit>",
     reason: "The reported commit indeed contains a leaked API key [...]"
   })
   <- { "dropped": ["ask-..."], "rolled": { "commit": "...", "revertCommit": "..." } }
   root Lane status: "stopped"
   README.md back to its pre-taint content: yes
```

## Run sheet — by hand

```
zz ask post <owner/repo> _repo --remote --as dan --kind whistleblow \
  --payload '{"reportKind":"tainted","targetAgent":"<mallory-username>","targetCommit":"<sha>","reason":"..."}'

# dan trying to resolve his own report fails:
zz ask whistleblow <owner/repo> <wb-ask-id> --as dan --target-agent <mallory-username> --reason "..."

# the real coordinator resolves it:
zz ask whistleblow <owner/repo> <wb-ask-id> --target-agent <mallory-username> \
  --target-commit <sha> --reason "Leaked a live-looking API key in README.md"
```

## Checkpoint

The root Lane's status is `"stopped"`. Mallory's other pending Ask is denied with a reason pointing at the incident. `README.md` is back to its pre-taint content, via a real new revert commit (not a history rewrite) — confirm with `zz ladder dump <owner/repo>` or by diffing the file directly. The Lane's history ends with a `trap`-kind Insight, the first one any real repo has ever had.

Clean up when done: `zz repo delete <owner/repo>`.
