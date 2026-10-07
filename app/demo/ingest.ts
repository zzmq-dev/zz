// Onboards superagent + supertest: walks their real git history and writes
// a starting "history" Lane per repo, whose INSIGHT entries are hand-authored
// here (no API key configured; see the plan) but every one of them traces
// back to a real commit, real HISTORY.md text, or a real GitHub issue —
// nothing invented. This is what "onboarding into zz" gets you for free.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeLane, writeRoles } from "../engine/store.js";
import type { InsightEntry, Lane } from "../engine/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

function gitLogStats(cloneDir: string) {
  const count = execFileSync("git", ["-C", cloneDir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
  // `git log -1 --reverse` applies -1 before reversing (returns HEAD, not the
  // oldest commit) on many git versions, so pull the full date list instead.
  const dates = execFileSync("git", ["-C", cloneDir, "log", "--format=%ad", "--date=short"], { encoding: "utf8" })
    .trim()
    .split("\n");
  return { count: Number(count), first: dates[dates.length - 1], last: dates[0] };
}

function insight(kind: "norm" | "trap", text: string, at: string): InsightEntry {
  return { type: "INSIGHT", kind, text, from: "zz-onboarding", at };
}

function onboard(opts: {
  repo: string;
  cloneDir: string;
  stateDir: string;
  maintainer: string;
  insights: InsightEntry[];
}) {
  const stats = gitLogStats(opts.cloneDir);
  const lane: Lane = {
    id: "history",
    repo: opts.repo,
    origin: null,
    name: "Onboarding history",
    objective: `Real history prior to onboarding into zz: ${stats.count} commits, ${stats.first} to ${stats.last}.`,
    status: "merged",
    scope: ["."],
    trigger: {
      kind: "manual",
      proposed_by: "zz-onboarding",
      reason: "initial ingestion from real git history, HISTORY.md, and GitHub issues",
    },
    coordinators: [opts.maintainer],
    history: opts.insights,
    related_lanes: [],
  };
  writeLane(opts.stateDir, lane);
  writeRoles(opts.stateDir, {
    agent: opts.maintainer,
    grants: [{ role: "maintainer", scope: ".", granted_by: "zz-onboarding", at: new Date().toISOString() }],
  });
  console.log(`onboarded ${opts.repo}: ${stats.count} commits (${stats.first} to ${stats.last}), ${opts.insights.length} Insights`);
}

onboard({
  repo: "ladjs/superagent",
  cloneDir: join(appRoot, "demo-repos/superagent"),
  stateDir: join(appRoot, "state/superagent"),
  maintainer: "superagent-maintainer",
  insights: [
    insight(
      "trap",
      "v4.0.0 (2018-11-17) changed `.end()` to return `undefined` instead of the request object, a real breaking change recorded in HISTORY.md. Code that needs the request after calling `.end()` has to save it in a variable first.",
      "2018-11-17T00:00:00Z",
    ),
    insight(
      "norm",
      "Since v4.0.0, promise-based `.then()` is the recommended pattern over `.end()` callbacks (HISTORY.md).",
      "2018-11-17T00:00:00Z",
    ),
    insight(
      "trap",
      "A vanilla-JS bundle bug (issue #1743, filed 2022-09-30) went through a false-start fix, closed 2022-10-03 then reopened 2022-10-05 because the fix was incomplete, before actually landing 2022-10-24, 24 days total. supertest had no visibility into any of this and only discovered the same symptom independently 23 days in (supertest#798).",
      "2022-10-24T19:50:30Z",
    ),
  ],
});

onboard({
  repo: "visionmedia/supertest",
  cloneDir: join(appRoot, "demo-repos/supertest"),
  stateDir: join(appRoot, "state/supertest"),
  maintainer: "supertest-maintainer",
  insights: [
    insight(
      "trap",
      "supertest pins superagent tightly (`^10.3.0`) rather than a wide range, because past superagent releases have broken supertest silently without warning (see #798, 2022).",
      "2025-07-07T18:47:18Z",
    ),
    insight(
      "trap",
      "The ephemeral per-test server lifecycle has needed repeated hardening (commits on 2025-07-07, 'SuperAgent v10 compatibility,' and 2026-09-22, 'stabilize ephemeral server requests and assertions'); two related issues (#909, #911) are still open as of October 2026 around request/server timing.",
      "2026-09-22T12:30:57Z",
    ),
    insight(
      "norm",
      "The real precedent for reacting to an upstream breaking change: commit 25122e65 (2022-10-24) pinned supertest to the last-known-good superagent version the same day the real fix landed upstream, rather than waiting.",
      "2022-10-24T20:30:29Z",
    ),
  ],
});
