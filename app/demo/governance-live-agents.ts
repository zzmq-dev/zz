// Same two scenarios as governance-and-incident-demo.ts, but the
// "good actor" decisions -- casting a Committee ballot, resolving a
// whistleblow report -- are made by a real, running LLM (runAgent,
// agent/loop.ts) reading the actual proposal/evidence off the live
// protocol state and calling the real tools itself, not a scripted
// payload. The bad actor (mallory's tainted commit) stays scripted on
// purpose: reliably getting a model to misbehave on cue isn't
// something to depend on for a demo, so that one part is a fixture.
//
// Usage: npx tsx demo/governance-live-agents.ts [repo-name]
// Needs Ollama running locally with a tool-calling-capable model
// pulled (ZZ_OLLAMA_MODEL, default qwen2.5:14b-instruct -- qwen3-coder
// models work well too). `zz login` first.
import { apiFetch } from "../cli/lib/api.js";
import { resolveIdentity, releaseIdentity } from "../cli/lib/identity.js";
import { setActiveToken } from "../cli/lib/api.js";
import { callRemoteTool, remoteCallTool } from "../cli/lib/remoteTools.js";
import { requireCredentials } from "../cli/lib/credentials.js";
import { resolveBackend as resolveChatBackend } from "../cli/lib/resolveChatBackend.js";
import { runAgent } from "../agent/loop.js";
import { ALL_TOOLS } from "../agent/tools.js";
import type { AskEntry, AnswerEntry, Lane } from "../engine/types.js";

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function step(text: string): void {
  console.log(`-> ${text}`);
}

function toolsNamed(...names: string[]) {
  return ALL_TOOLS.filter((t) => names.includes(t.name));
}

async function createAgent(displayName: string): Promise<string> {
  const { username } = await apiFetch<{ username: string }>("POST", "/api/agents", { display_name: displayName });
  return username;
}

const chatBackend = resolveChatBackend("ollama", process.env.ZZ_OLLAMA_MODEL);

// Runs a real model turn by turn against the live Worker, authenticated
// as the given token, narrating what it says and does.
async function runLiveAgent(token: string, label: string, systemPrompt: string, userMessage: string, tools: ReturnType<typeof toolsNamed>, isActuallyDone: () => Promise<boolean>): Promise<void> {
  setActiveToken(token);
  const result = await runAgent({
    systemPrompt,
    userMessage,
    tools,
    backend: chatBackend,
    executeTool: (tool, args) => remoteCallTool(tool.name, args),
    isActuallyDone,
    onLog: (line) => console.log(`   [${label}] ${line}`),
    maxTurns: 6,
  });
  console.log(`   [${label}] done after ${result.turns} turn(s): ${result.finalMessage.slice(0, 200)}`);
}

async function main() {
  const human = requireCredentials().username;
  const runId = Date.now();
  const repoName = process.argv[2] ?? `governance-live-${runId}`;

  section("Setup");
  step(`Creating repo "${repoName}" as ${human}`);
  const repo = await apiFetch<{ slug: string }>("POST", "/api/repos", { name: repoName, description: "zz governance/incident-response demo -- live agents" });
  const slug = repo.slug;
  console.log(`   ${slug}`);

  step("Creating four peer Agents: alice, bob (Committee), mallory (does the tainted work -- scripted), dan (whistleblower)");
  const alice = await createAgent(`alice-${runId}`);
  const bob = await createAgent(`bob-${runId}`);
  const mallory = await createAgent(`mallory-${runId}`);
  const dan = await createAgent(`dan-${runId}`);
  console.log(`   ${alice}, ${bob}, ${mallory}, ${dan}`);

  const aliceId = await resolveIdentity({ as: alice });
  const bobId = await resolveIdentity({ as: bob });
  const malloryId = await resolveIdentity({ as: mallory });
  const danId = await resolveIdentity({ as: dan });

  await callRemoteTool(slug, "lane_propose", { repo: slug, id: "_repo", name: slug, objective: `the ${slug} repository`, scope: ["**"], actor: human });

  // ---------------------------------------------------------------
  section("Scenario A: a real Committee actually votes on a Policy change");
  // ---------------------------------------------------------------
  setActiveToken(requireCredentials().token);
  await apiFetch("POST", `/api/repos/${slug.split("/")[0]}/${slug.split("/")[1]}/roles`, { principal: mallory, role: "coordinator" });

  setActiveToken(aliceId.token);
  const govLane = (await callRemoteTool(slug, "lane_propose", { repo: slug, name: "Policy Committee", objective: "Decide on Policy changes for this repo", scope: ["**"], actor: alice, committee: [alice, bob] })) as Lane;
  console.log(`   Lane ${govLane.id} -- committee: ${govLane.committee.join(", ")}`);

  const voteAsk = (await callRemoteTool(slug, "ask_post", {
    repo: slug,
    lane_id: govLane.id,
    kind: "vote_request",
    from: alice,
    payload: { decisionKind: "policy", proposal: { policies: [{ path: "**", mode: "other_approver" }] }, description: "Require a different approver than the author for every changeset, repo-wide. This is a reasonable, low-risk tightening of process -- it only adds a real second set of eyes, no one loses access." },
  })) as AskEntry;
  console.log(`   Ask ${voteAsk.id}: ${JSON.stringify(voteAsk.payload)}`);

  const votePrompt = (agentUsername: string) =>
    `You are ${agentUsername}, a Committee member on the Lane "${govLane.id}" in repo "${slug}". ` +
    `There is an open vote_request Ask (id "${voteAsk.id}") proposing a Policy change. ` +
    `Use lane_get to read its full payload (the proposal and description), decide for yourself whether it's a reasonable change, ` +
    `then cast your real ballot with ask_answer: repo "${slug}", lane_id "${govLane.id}", ask_id "${voteAsk.id}", actor "${agentUsername}", action "vote", payload {"ballot": "+1"} to approve or "-1" to reject. ` +
    `Vote only once. Explain your reasoning briefly before calling the tool.`;

  const hasVoted = (agentUsername: string) => async () => {
    const lane = (await callRemoteTool(slug, "lane_get", { repo: slug, lane_id: govLane.id })) as Lane;
    return lane.history.some((e): e is AnswerEntry => e.type === "ANSWER" && e.ask === voteAsk.id && e.action === "vote" && e.from === agentUsername);
  };

  step("alice (a real model) reviews the proposal and votes");
  await runLiveAgent(aliceId.token, "alice", "You are a careful, honest Committee member. You vote based on the actual merits of the proposal.", votePrompt(alice), toolsNamed("lane_get", "ask_answer"), hasVoted(alice));

  step("bob (a real model) reviews the proposal and votes");
  await runLiveAgent(bobId.token, "bob", "You are a careful, honest Committee member. You vote based on the actual merits of the proposal.", votePrompt(bob), toolsNamed("lane_get", "ask_answer"), hasVoted(bob));

  step("Tallying -- closes the vote once both ballots are in, and applies the Policy change if approved");
  setActiveToken(aliceId.token);
  const tally = await callRemoteTool(slug, "vote_tally", { repo: slug, lane_id: govLane.id, ask_id: voteAsk.id, actor: alice });
  console.log(`   ${JSON.stringify(tally)}`);

  // ---------------------------------------------------------------
  section("Scenario B: tainted work (scripted) and a real agent's incident response");
  // ---------------------------------------------------------------
  step("mallory (SCRIPTED -- a fixture, not a model) commits a tainted change directly");
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
  const pendingWork = (await callRemoteTool(slug, "ask_post", { repo: slug, lane_id: "_repo", kind: "work", from: mallory, payload: { description: "Add a new feature" } })) as AskEntry;
  console.log(`   Ask ${pendingWork.id}, still unanswered -- this is what DROP will cancel`);

  step("dan (SCRIPTED -- filing a report is just reporting an observed fact) files a whistleblow");
  setActiveToken(danId.token);
  const wbAsk = (await callRemoteTool(slug, "ask_post", {
    repo: slug,
    lane_id: "_repo",
    kind: "whistleblow",
    from: dan,
    payload: { reportKind: "tainted", targetAgent: mallory, targetCommit: badSha, reason: "A commit to README.md looks like it leaked something that reads as an API key." },
  })) as AskEntry;
  console.log(`   Ask ${wbAsk.id}`);

  step(`${human} (a real model, acting as the repo's coordinator) investigates and decides whether to act`);
  const ownerToken = requireCredentials().token;
  const wbPrompt =
    `You are ${human}, the coordinator of the root Lane "_repo" in repo "${slug}". ` +
    `There is an open whistleblow Ask (id "${wbAsk.id}") -- use lane_get to read its payload, which names a suspect commit. ` +
    `Investigate before acting: use git_show_file with sha "${badSha}" and path "README.md" to see what that commit actually contains, and judge for yourself whether the report is accurate. ` +
    `If it is, resolve the report for real with whistleblow_resolve: repo "${slug}", lane_id "_repo", ask_id "${wbAsk.id}", actor "${human}", target_agent "${mallory}", target_commit "${badSha}", and a reason in your own words. ` +
    `This runs the real incident runbook (stop the Lane, drop the reported Agent's other pending work, revert the commit) -- only call it if your own investigation actually supports it.`;
  await runLiveAgent(
    ownerToken,
    "owner",
    "You are a careful repo coordinator. You verify evidence yourself before taking an irreversible action.",
    wbPrompt,
    toolsNamed("lane_get", "git_show_file", "whistleblow_resolve"),
    async () => {
      const lane = (await callRemoteTool(slug, "lane_get", { repo: slug, lane_id: "_repo" })) as Lane;
      return lane.status === "stopped";
    },
  );

  const rootLane = (await callRemoteTool(slug, "lane_get", { repo: slug, lane_id: "_repo" })) as Lane;
  console.log(`   root Lane status: "${rootLane.status}"`);
  const revertedReadme = (await callRemoteTool(slug, "git_show_file", { repo: slug, sha: "HEAD", path: "README.md" })) as string;
  console.log(`   README.md back to its pre-taint content: ${revertedReadme === currentReadme ? "yes" : "NO -- check manually"}`);

  section("Done");
  console.log(`Everything above happened for real against ${slug}, including the model calls. Clean up with: zz repo delete ${slug}`);

  await releaseIdentity(aliceId);
  await releaseIdentity(bobId);
  await releaseIdentity(malloryId);
  await releaseIdentity(danId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
