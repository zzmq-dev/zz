// Demo: a real, live-verified mediated conflict (#11).
//
// Two submissions collide on the same lines in math.js -- not just
// textually, but the actual shared-dependency case the design doc
// itself names as the motivating example (Governance's own
// gcd/lcm): the EXISTING gcd throws on a negative input; the NEW
// lcm needs gcd to accept one. A naive "keep both, unchanged"
// synthesis would ship a real bug -- lcm calling a gcd that still
// throws on exactly the input lcm's own comment says it needs to
// handle. The mediation step is a real model call (no-Jev path,
// #9) against the real deployed Worker, not a scripted outcome --
// only the two colliding submissions themselves are fixed payloads
// (same "the good actors' half is never pre-decided" rule every
// other demo in this project already holds to; here it's the
// mediator playing that role, not a Committee or a reviewer).
//
// Usage: npx tsx demo/mediated-conflict-demo.ts [repo-name]
// Needs GROQ_API_KEY (app/.env) and `zz login` first.
import { apiFetch } from "../cli/lib/api.js";
import { setActiveToken } from "../cli/lib/api.js";
import { callRemoteTool, remoteCallTool } from "../cli/lib/remoteTools.js";
import { requireCredentials, authedCloneUrl } from "../cli/lib/credentials.js";
import { resolveBackend as resolveChatBackend } from "../cli/lib/resolveChatBackend.js";
import { resolveRepo, ensureCloned } from "../cli/lib/repo.js";
import { runCoordinatorSubmitChangeset, runResolveConflict } from "../agent/scriptedWork.js";
import type { AskEntry, Lane } from "../engine/types.js";
import { registerLocalBackendFactory } from "../engine/backend.js";
import { createLocalBackend } from "../engine/localBackend.js";
import { execFileSync } from "node:child_process";

registerLocalBackendFactory(createLocalBackend);

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function step(text: string): void {
  console.log(`-> ${text}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EXISTING_MATH_JS = `export function gcd(a, b) {
  if (a < 0 || b < 0) throw new Error("gcd: only non-negative integers supported");
  return b === 0 ? a : gcd(b, a % b);
}
`;

// Both inserted right after the SAME anchor comment on purpose, so
// git's own three-way merge puts gcd's real (throwing) definition
// and lcm's own comment about what it actually needs in the SAME
// conflicted hunk -- everything the mediator needs to notice the
// contract gap is right there in the markers it already sees,
// nothing extra to wire up for this demo specifically.
const NEW_MATH_JS = `export function lcm(a, b) {
  // needs gcd to accept negative inputs -- the scheduler module
  // sometimes passes signed offsets through here
  return Math.abs(a * b) / gcd(a, b);
}
`;

async function main() {
  const token = requireCredentials().token;
  setActiveToken(token);
  const owner = requireCredentials().username;
  const runId = Date.now();
  const repoName = process.argv[2] ?? `mediated-conflict-${runId}`;

  section("Setup");
  step(`Creating repo "${repoName}"`);
  const repo = await apiFetch<{ slug: string }>("POST", "/api/repos", { name: repoName, description: "zz mediated-conflict-resolution demo" });
  const slug = repo.slug;
  console.log(`   ${slug}`);

  const resolved = resolveRepo(slug);
  ensureCloned(resolved, authedCloneUrl("https://zzmq.dev", token, slug));
  const sha0 = execFileSync("git", ["-C", resolved.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // A real repo would leave expiry_hours at its 72h default -- set
  // short here purely so this demo's own window closes inside a
  // single take instead of actually waiting three days.
  const demoWindowSeconds = Number(process.env.ZZ_DEMO_WINDOW_SECONDS ?? 8);
  step(`Setting conflict_policy for math.js to "mediate" (expiry_hours shortened to ${demoWindowSeconds}s for this demo take -- 72h by default)`);
  await callRemoteTool(slug, "policy_set", { repo: slug, actor: owner, conflict_path_rule: { path: "math.js", mode: "mediate", expiry_hours: demoWindowSeconds / 3600 } });

  section("Scenario: two real contract needs collide on the same lines");
  step("Contributor A (SCRIPTED -- a fixture, like every demo's own non-decision half) lands gcd, which throws on negative input");
  const commit1 = await callRemoteTool(slug, "commit_changeset", {
    repo: slug,
    files: [{ path: "math.js", content: EXISTING_MATH_JS }],
    message: "add gcd",
    author_name: owner,
    author_email: `${owner}@zzmq.dev`,
  }) as { commitOid: string };
  console.log(`   ${commit1.commitOid}: ${EXISTING_MATH_JS.trim().split("\n")[0]}...`);

  // threeWayMerge checks the LOCAL clone's own HEAD against baseCommit
  // -- commit_changeset above landed purely server-side, so without
  // this fetch the local clone would never actually see it and the
  // conflict below wouldn't be real.
  execFileSync("git", ["-C", resolved.repoDir, "fetch", "--quiet", "origin", "main"], { encoding: "utf8" });
  execFileSync("git", ["-C", resolved.repoDir, "reset", "--hard", "FETCH_HEAD"], { encoding: "utf8" });

  const lane = await callRemoteTool(slug, "lane_propose", { repo: slug, name: "mediated conflict demo", objective: "add lcm", scope: ["**"], actor: owner, origin_lane: "_repo" }) as Lane;
  const laneId = lane.id;

  step("Contributor B (SCRIPTED) submits lcm, based on the now-stale base, calling a gcd it assumes accepts negative input");
  const review = await callRemoteTool(slug, "ask_post", {
    repo: slug, lane_id: laneId, kind: "changeset_review", from: owner,
    payload: { taskDescription: "add an lcm helper to math.js", files: [{ path: "math.js", content: NEW_MATH_JS }], message: "add lcm", summary: "add an lcm helper; needs gcd to accept negative input for the scheduler module", baseCommit: sha0 },
  }) as AskEntry;
  await callRemoteTool(slug, "ask_answer", { repo: slug, lane_id: laneId, ask_id: review.id, actor: owner, action: "grant", payload: {} });
  const submit = await callRemoteTool(slug, "ask_post", {
    repo: slug, lane_id: laneId, kind: "submit_changeset", from: owner,
    payload: { files: [{ path: "math.js", content: NEW_MATH_JS }], message: "add lcm", summary: "add an lcm helper; needs gcd to accept negative input for the scheduler module", baseCommit: sha0 },
    depends_on: [review.id],
  }) as AskEntry;

  step("The real protocol (not scripted) detects the conflict and opens a resolve_conflict window");
  const backend = resolveChatBackend("groq", process.env.GROQ_MODEL);
  const onLog = (line: string) => console.log(`   ${line}`);
  await runCoordinatorSubmitChangeset({ resolved, laneId, theAsk: submit, agent: owner, alreadyClaimed: false, backend, onLog, callTool: remoteCallTool });

  let laneAfter = await callRemoteTool(slug, "lane_get", { repo: slug, lane_id: laneId }) as Lane;
  const resolveConflictAsk = laneAfter.history.find((e): e is AskEntry => e.type === "ASK" && e.kind === "resolve_conflict")!;
  console.log(`   resolve_conflict ${resolveConflictAsk.id}, deadline ${resolveConflictAsk.deadline}`);

  step(`Waiting ${demoWindowSeconds}s for the window to close`);
  await sleep((demoWindowSeconds + 2) * 1000);

  section("The mediation itself -- a real model call, no-Jev path");
  await runResolveConflict({ resolved, laneId, theAsk: resolveConflictAsk, agent: owner, alreadyClaimed: false, backend, onLog, callTool: remoteCallTool });

  laneAfter = await callRemoteTool(slug, "lane_get", { repo: slug, lane_id: laneId }) as Lane;
  const resolution = laneAfter.history.find((e) => e.type === "ANSWER" && e.ask === resolveConflictAsk.id);
  console.log(`   resolution: ${JSON.stringify(resolution)}`);
  const insight = laneAfter.history.find((e) => e.type === "INSIGHT");
  console.log(`   Insight written: ${JSON.stringify(insight)}`);

  execFileSync("git", ["-C", resolved.repoDir, "fetch", "--quiet", "origin", "main"], { encoding: "utf8" });
  const finalContent = execFileSync("git", ["-C", resolved.repoDir, "show", "origin/main:math.js"], { encoding: "utf8" });
  console.log(`\n   math.js, after mediation:\n${finalContent.split("\n").map((l) => `   ${l}`).join("\n")}`);

  section("The payoff: a later contributor's own pre-work search finds this before colliding the same way");
  step('ladder_search("gcd negative lcm") -- what any later contributor already runs before writing new code');
  const hits = await callRemoteTool(slug, "ladder_search", { repo: slug, query: "gcd negative lcm", limit: 5 }) as { path: string; kind: string; summary: string }[];
  for (const h of hits) console.log(`   - (${h.kind}) ${h.path}: ${h.summary}`);
  const surfaced = hits.some((h) => h.kind === "insight_norm" || h.kind === "insight_trap");
  console.log(`   Insight surfaced in search: ${surfaced}`);

  section("Done");
  console.log(`Everything above happened for real against ${slug}, including the mediation model call. Clean up with: zz repo delete ${slug}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
