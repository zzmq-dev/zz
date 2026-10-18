// Demo-level, end-to-end walkthrough of the two stretch-goal concepts:
// Committee/Vote/VETO/Policy/lazy-consensus, and Whistleblow/STOP-DROP-
// ROLL incident response (engine/lane.ts, agent/tools.ts). Runs against
// your real logged-in account on the deployed Worker (`zz login` first)
// -- not a unit test, a live, recordable run of the real CLI/protocol
// primitives, narrated step by step.
//
// Usage: npx tsx demo/governance-and-incident-demo.ts [repo-name]
// (default repo name: "governance-demo-<timestamp>")
import { apiFetch } from "../cli/lib/api.js";
import { resolveIdentity, releaseIdentity, type ResolvedIdentity } from "../cli/lib/identity.js";
import { setActiveToken } from "../cli/lib/api.js";
import { callRemoteTool } from "../cli/lib/remoteTools.js";
import { requireCredentials } from "../cli/lib/credentials.js";
import type { AskEntry, Lane, RepoPolicy } from "../engine/types.js";
import type { VoteTally, IncidentResult } from "../engine/lane.js";

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function step(text: string): void {
  console.log(`-> ${text}`);
}

async function createAgent(displayName: string): Promise<string> {
  const { username } = await apiFetch<{ username: string }>("POST", "/api/agents", { display_name: displayName });
  return username;
}

// resolveIdentity's own --as convention already passes a name through
// unchanged once it contains "@" or "[" (identity.ts: that's what
// marks it as already-full rather than needing "<you>[name]" expansion)
// -- the agent usernames createAgent() hands back always do, so this
// is just resolveIdentity by another name, not a re-derivation.
async function identityFor(username: string): Promise<ResolvedIdentity> {
  return resolveIdentity(username);
}

async function main() {
  const human = requireCredentials().username;
  const runId = Date.now();
  const repoName = process.argv[2] ?? `governance-demo-${runId}`;

  section("Setup");
  step(`Creating repo "${repoName}" as ${human}`);
  const repo = await apiFetch<{ slug: string }>("POST", "/api/repos", { name: repoName, description: "zz governance/incident-response demo" });
  const slug = repo.slug;
  console.log(`   ${slug}`);

  // Display names carry runId -- agents never get deleted (no "zz
  // agent delete" exists), so a plain "alice" would collide with any
  // earlier run's and get a server-appended "-2" suffix, which is
  // harmless but clutters the account across repeat runs.
  step("Creating four peer Agents: alice, bob (the Committee), mallory (does the tainted work), dan (whistleblower)");
  const alice = await createAgent(`alice-${runId}`);
  const bob = await createAgent(`bob-${runId}`);
  const mallory = await createAgent(`mallory-${runId}`);
  const dan = await createAgent(`dan-${runId}`);
  console.log(`   ${alice}, ${bob}, ${mallory}, ${dan}`);

  const aliceId = await identityFor(alice);
  const bobId = await identityFor(bob);
  const malloryId = await identityFor(mallory);
  const danId = await identityFor(dan);

  // The root "_repo" Lane is normally created lazily, the first time
  // something posts to it through the dedicated `/api/repos/.../ask`
  // REST route (zz repo ask) -- Scenario B posts straight through the
  // generic ask_post tool instead, which requires the Lane to already
  // exist (withLane throws on a missing one), so it's created
  // explicitly here. coordinators defaults to [[human]], which is what
  // makes "only the coordinator can resolve a whistleblow" demonstrable.
  await callRemoteTool(slug, "lane_propose", { repo: slug, id: "_repo", name: slug, objective: `the ${slug} repository`, scope: ["**"], actor: human });

  // ---------------------------------------------------------------
  section("Scenario A: Committee Vote on a Policy change");
  // ---------------------------------------------------------------
  step(`Granting mallory Coordinator on ${slug} -- she's a trusted contributor today, which is exactly what makes Scenario B interesting later`);
  setActiveToken(requireCredentials().token);
  await apiFetch("POST", `/api/repos/${slug.split("/")[0]}/${slug.split("/")[1]}/roles`, { principal: mallory, role: "coordinator" });

  step("Proposing a Lane with alice+bob as its Committee -- every other path defaults a new Lane's committee to just its proposer");
  setActiveToken(aliceId.token);
  const govLane = (await callRemoteTool(slug, "lane_propose", {
    repo: slug,
    name: "Policy Committee",
    objective: "Decide on Policy changes for this repo",
    scope: ["**"],
    actor: alice,
    committee: [alice, bob],
  })) as Lane;
  console.log(`   Lane ${govLane.id} -- committee: ${govLane.committee.join(", ")}`);

  step('Posting a vote_request: "require a different approver than the author, repo-wide" (a Policy change -- never lazy consensus, only a real Vote)');
  const voteAsk = (await callRemoteTool(slug, "ask_post", {
    repo: slug,
    lane_id: govLane.id,
    kind: "vote_request",
    from: alice,
    payload: { decisionKind: "policy", proposal: { policies: [{ path: "**", mode: "other_approver" }] }, description: "Require a different approver than the author for every changeset, repo-wide" },
  })) as AskEntry;
  console.log(`   Ask ${voteAsk.id}`);

  step("alice votes +1");
  await callRemoteTool(slug, "ask_answer", { repo: slug, lane_id: govLane.id, ask_id: voteAsk.id, actor: alice, action: "vote", payload: { ballot: "+1" } });
  let tally = (await callRemoteTool(slug, "vote_tally", { repo: slug, lane_id: govLane.id, ask_id: voteAsk.id, actor: alice })) as VoteTally;
  console.log(`   tally so far: resolved=${tally.resolved}, missing=[${tally.missing.join(", ")}]`);

  step("bob votes +1 -- that's every Committee member, so this closes the vote for real");
  setActiveToken(bobId.token);
  await callRemoteTool(slug, "ask_answer", { repo: slug, lane_id: govLane.id, ask_id: voteAsk.id, actor: bob, action: "vote", payload: { ballot: "+1" } });
  tally = (await callRemoteTool(slug, "vote_tally", { repo: slug, lane_id: govLane.id, ask_id: voteAsk.id, actor: bob })) as VoteTally;
  console.log(`   VOTE CLOSED: approved=${tally.approved}, ballots=${JSON.stringify(tally.ballots)}`);
  console.log("   The Policy change is now live -- Backend.writePolicy was called as the direct result of this vote passing, not a side promise.");

  step("For contrast: mallory (not on the Committee) tries to vote -- rejected");
  try {
    setActiveToken(malloryId.token);
    const voteAsk2 = (await callRemoteTool(slug, "ask_post", { repo: slug, lane_id: govLane.id, kind: "vote_request", from: mallory, payload: { decisionKind: "other" } })) as AskEntry;
    await callRemoteTool(slug, "ask_answer", { repo: slug, lane_id: govLane.id, ask_id: voteAsk2.id, actor: mallory, action: "vote", payload: { ballot: "+1" } });
    console.log("   UNEXPECTED: that should have failed");
  } catch (e) {
    console.log(`   Rejected as expected: ${(e as Error).message.slice(0, 100)}`);
  }

  // ---------------------------------------------------------------
  section("Scenario A continued: Policy's own teeth -- path-scoped rules, and who may change them");
  // ---------------------------------------------------------------
  step(`${human} (the repo's Owner) tightens README.md directly to "vote_quorum" -- the unilateral override, no vote needed`);
  setActiveToken(requireCredentials().token);
  const policy = (await callRemoteTool(slug, "policy_set", { repo: slug, actor: human, path_rule: { path: "README.md", mode: "vote_quorum" } })) as RepoPolicy;
  console.log(`   README.md's own rule is now "${policy.policies.find((r) => r.path === "README.md")?.mode}"`);

  step(`For contrast: mallory (Coordinator, not Owner) tries the same thing herself -- rejected, since "_repo" itself defaults to "vote_quorum"`);
  try {
    setActiveToken(malloryId.token);
    await callRemoteTool(slug, "policy_set", { repo: slug, actor: mallory, path_rule: { path: "README.md", mode: "direct" } });
    console.log("   UNEXPECTED: that should have failed");
  } catch (e) {
    console.log(`   Rejected as expected: ${(e as Error).message.slice(0, 160)}`);
  }

  step("A changeset touching README.md now needs a real Vote, not just a review -- mallory submits one and it's blocked on exactly that");
  setActiveToken(malloryId.token);
  const policyLane = (await callRemoteTool(slug, "lane_propose", { repo: slug, name: "README update", objective: "Tweak the README", scope: ["README.md"], actor: mallory })) as Lane;
  const gatedVote = (await callRemoteTool(slug, "ask_post", {
    repo: slug,
    lane_id: policyLane.id,
    kind: "vote_request",
    from: mallory,
    payload: { decisionKind: "other", files: [{ path: "README.md", content: "# updated\n" }], message: "Tweak the README" },
  })) as AskEntry;
  const gatedSubmit = (await callRemoteTool(slug, "ask_post", {
    repo: slug,
    lane_id: policyLane.id,
    kind: "submit_changeset",
    from: mallory,
    payload: { files: [{ path: "README.md", content: "# updated\n" }], message: "Tweak the README" },
    depends_on: [gatedVote.id],
  })) as AskEntry;
  try {
    await callRemoteTool(slug, "ask_answer", { repo: slug, lane_id: policyLane.id, ask_id: gatedSubmit.id, actor: mallory, action: "complete" });
    console.log("   UNEXPECTED: that should have failed");
  } catch (e) {
    console.log(`   Blocked as expected -- the merge backstop itself enforces this, not just the UI: ${(e as Error).message.slice(0, 160)}`);
  }

  // ---------------------------------------------------------------
  section("Scenario A continued: VETO");
  // ---------------------------------------------------------------
  step("Posting a changeset_review in the Committee Lane, then alice VETOes it over a design disagreement (distinct from a plain deny)");
  setActiveToken(bobId.token);
  const reviewAsk = (await callRemoteTool(slug, "ask_post", { repo: slug, lane_id: govLane.id, kind: "changeset_review", from: bob, payload: { description: "Proposed: rewrite the storage layer" } })) as AskEntry;
  setActiveToken(aliceId.token);
  await callRemoteTool(slug, "ask_answer", { repo: slug, lane_id: govLane.id, ask_id: reviewAsk.id, actor: alice, action: "veto", payload: { reason: "Wrong direction entirely -- we're not rewriting storage this quarter." } });
  const govLaneAfter = (await callRemoteTool(slug, "lane_get", { repo: slug, lane_id: govLane.id })) as Lane;
  console.log(`   Lane status: "${govLaneAfter.status}"`);

  // ---------------------------------------------------------------
  section("Scenario B: tainted work and the STOP/DROP/ROLL incident runbook");
  // ---------------------------------------------------------------
  step("mallory commits directly to README.md -- a real commit, by a trusted Coordinator, that turns out to be bad (e.g. a leaked secret)");
  setActiveToken(malloryId.token);
  const currentReadme = (await callRemoteTool(slug, "git_show_file", { repo: slug, sha: "HEAD", path: "README.md" })) as string;
  const taintedReadme = `${currentReadme}\n<!-- oops: API_KEY=sk-live-not-a-real-secret-but-pretend-it-is -->\n`;
  const { commitOid: badSha } = (await callRemoteTool(slug, "commit_changeset", {
    repo: slug,
    files: [{ path: "README.md", content: taintedReadme }],
    message: "docs: tweak README",
    author_name: "mallory",
    author_email: `${mallory}@zzmq.dev`,
  })) as { commitOid: string };
  console.log(`   Tainted commit: ${badSha}`);

  step("mallory also posts an (unrelated) work Ask into the root Lane -- this is what DROP will cancel once the incident is confirmed");
  const pendingWork = (await callRemoteTool(slug, "ask_post", { repo: slug, lane_id: "_repo", kind: "work", from: mallory, payload: { description: "Add a new feature" } })) as AskEntry;
  console.log(`   Ask ${pendingWork.id}, still unanswered`);

  step("dan notices the leaked secret and files a whistleblow report -- anyone can file one, filing it doesn't act on it yet");
  setActiveToken(danId.token);
  const wbAsk = (await callRemoteTool(slug, "ask_post", {
    repo: slug,
    lane_id: "_repo",
    kind: "whistleblow",
    from: dan,
    payload: { reportKind: "tainted", targetAgent: mallory, targetCommit: badSha, reason: "Leaked a live-looking API key in README.md" },
  })) as AskEntry;
  console.log(`   Ask ${wbAsk.id}`);

  step("dan (not this Lane's coordinator) tries to resolve it himself -- rejected: only the coordinator can run the runbook");
  try {
    await callRemoteTool(slug, "whistleblow_resolve", { repo: slug, lane_id: "_repo", ask_id: wbAsk.id, actor: dan, target_agent: mallory, target_commit: badSha, reason: "Leaked a live-looking API key in README.md" });
    console.log("   UNEXPECTED: that should have failed");
  } catch (e) {
    console.log(`   Rejected as expected: ${(e as Error).message.slice(0, 100)}`);
  }

  step(`${human} (the repo's coordinator) resolves the report -- this runs STOP, DROP, and ROLL in one action`);
  setActiveToken(requireCredentials().token);
  const result = (await callRemoteTool(slug, "whistleblow_resolve", {
    repo: slug,
    lane_id: "_repo",
    ask_id: wbAsk.id,
    actor: human,
    target_agent: mallory,
    target_commit: badSha,
    reason: "Leaked a live-looking API key in README.md",
  })) as IncidentResult;

  const rootLane = (await callRemoteTool(slug, "lane_get", { repo: slug, lane_id: "_repo" })) as Lane;
  console.log(`   STOP: root Lane status is now "${rootLane.status}"`);
  console.log(`   DROP: denied ${result.dropped.length} other pending ask(s) from mallory (${result.dropped.join(", ") || "none"})`);
  console.log(result.rolled ? `   ROLL: reverted ${result.rolled.commit} as a real new commit ${result.rolled.revertCommit}` : "   ROLL: nothing to revert");

  const insight = rootLane.history[rootLane.history.length - 1];
  console.log(`   Insight posted: ${JSON.stringify(insight)}`);

  const revertedReadme = (await callRemoteTool(slug, "git_show_file", { repo: slug, sha: "HEAD", path: "README.md" })) as string;
  console.log(`   README.md back to its pre-taint content: ${revertedReadme === currentReadme ? "yes" : "NO -- check manually"}`);

  section("Done");
  console.log(`Everything above happened for real against ${slug}. Clean up with: zz repo delete ${slug}`);

  await releaseIdentity(aliceId);
  await releaseIdentity(bobId);
  await releaseIdentity(malloryId);
  await releaseIdentity(danId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
