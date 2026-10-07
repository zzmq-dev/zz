// Sizing prototype: one real file (supertest's index.js), built out to
// line-level rungs, to see the real shape and effort of a full Ladder
// before committing to building one for the whole repo. Every summary below
// is hand-authored (no API key configured) but grounded in real `git log`,
// `git blame`, and GitHub PR data pulled while building this -- see the
// commit that adds this file for the research trail.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rung } from "../engine/ladder.js";

const here = dirname(fileURLToPath(import.meta.url));

const indexJs: Rung = {
  path: "index.js",
  kind: "file",
  summary:
    "The package's entry point. Wraps an app (a request handler function, or an already-listening Server) in an http(s) server and returns a chainable object with one method per HTTP verb; the actual request/response assertion logic lives in lib/test.js. Also re-exports Test, .agent(), and cookie assertions.",
  sources: [
    { kind: "commit", ref: "b1abb67", title: "Initial commit", author: "TJ Holowaychuk", at: "2012-06-26" },
    { kind: "commit", ref: "fbf3b1d", title: "move Test to lib/test.js", author: "TJ Holowaychuk", at: "2012-06-26" },
    { kind: "commit", ref: "da69243", title: "Added request.agent(app) support", author: "TJ Holowaychuk", at: "2013-03-14" },
    { kind: "commit", ref: "0956c37", title: "Expose `Test` to enable extensibility", author: "TJ Holowaychuk", at: "2013-03-20" },
    { kind: "commit", ref: "8741283", title: "Moved usage of 'del' to support the proper http verb 'delete'", author: "TJ Holowaychuk", at: "2014-03-24" },
    { kind: "pr", ref: "#477", title: "Updates dev libs to current versions.", author: "mikelax / Michael Holtzman", at: "2018-05-14" },
    { kind: "commit", ref: "64c8e79", title: "feat(global) force strict mode to be eslint compliant", author: "TJ Holowaychuk", at: "2019-10-02" },
    { kind: "commit", ref: "9ee6a1b", title: "Update index.js function definition", author: "David Thomason", at: "2020-04-20" },
    { kind: "commit", ref: "19dcd1e", title: "only use require in the top of the file", author: "Jimmy Wärting", at: "2022-01-04" },
    { kind: "commit", ref: "da57804", title: "feat: supports http2", author: "Lam Wei Li", at: "2022-10-04" },
    { kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" },
    { kind: "commit", ref: "71dc5fb", title: "fix: stabilize ephemeral server requests and assertions", author: "titanism", at: "2026-09-22" },
  ],
  children: [
    {
      path: "index.js#module.exports",
      kind: "function",
      summary:
        "Takes an app and returns an object with one method per HTTP verb. If given a function, starts a real server for it, http2 if options.http2 is set and supported, otherwise plain http. If given a Server, uses it directly. Each verb method constructs a new Test bound to that server.",
      sources: [
        { kind: "commit", ref: "9ee6a1b", title: "Update index.js function definition", author: "David Thomason", at: "2020-04-20" },
        { kind: "commit", ref: "da57804", title: "feat: supports http2", author: "Lam Wei Li", at: "2022-10-04" },
      ],
      children: [
        {
          path: "index.js:30-41",
          kind: "lines",
          summary:
            "Picks the transport for the implicit server. http2 support was added 2022-10-04 and throws explicitly if options.http2 is requested on a Node build without http2, rather than failing silently later.",
          sources: [{ kind: "commit", ref: "da57804", title: "feat: supports http2", author: "Lam Wei Li", at: "2022-10-04" }],
          children: [],
        },
        {
          path: "index.js:43-51",
          kind: "lines",
          summary: "Builds one chainable method per HTTP verb (from the methods npm package), each constructing a new Test for that verb/url pair.",
          sources: [{ kind: "commit", ref: "b1abb67", title: "Initial commit", author: "TJ Holowaychuk", at: "2012-06-26" }],
          children: [],
        },
        {
          path: "index.js:54",
          kind: "lines",
          summary:
            "obj.del = obj.delete, a backward-compatible alias kept since 2014, from before 'delete' was legal as a method name on every supported engine.",
          sources: [
            { kind: "commit", ref: "8741283", title: "Moved usage of 'del' to support the proper http verb 'delete'", author: "TJ Holowaychuk", at: "2014-03-24" },
            { kind: "commit", ref: "a6d8f28", title: "Access delete with brackets", author: "TJ Holowaychuk", at: "2014-04-14" },
          ],
          children: [],
        },
      ],
    },
  ],
};

// Kept brief; not the focus of this slice, just an anchor for the release
// and issue rungs below, which touch it without containing it.
const packageJson: Rung = {
  path: "package.json",
  kind: "file",
  summary: "Package manifest. Pins its superagent dependency tightly rather than a wide range (see the #798 issue rung).",
  sources: [{ kind: "commit", ref: "25122e6", title: "fix: bump superagent (closes #798)", author: "titanism", at: "2022-10-24" }],
  children: [],
};

// A repo-level artifact, not file-shaped, so it hangs off the repo rung
// directly instead of nesting in the directory tree.
const release_v6_3_1: Rung = {
  path: "releases/v6.3.1",
  kind: "release",
  summary: "Bumped the pinned superagent version to close #798, the same day the real upstream bug (superagent#1743) was finally fixed.",
  sources: [
    { kind: "commit", ref: "25122e6", title: "fix: bump superagent (closes #798)", author: "titanism", at: "2022-10-24" },
    { kind: "issue", ref: "#798", title: "pin superagent to 8.0.0", author: "smolinari", at: "2022-10-23" },
  ],
  touches: ["package.json"],
  children: [],
};

// Thread-shaped, not containment-shaped: each comment is a child rung, in
// order. Real comments, pulled via `gh api .../issues/798/comments`.
const issue_798: Rung = {
  path: "issues/798",
  kind: "issue",
  summary:
    "Filed 2022-10-23 by a user with no visibility into the already-three-weeks-old superagent#1743, hitting the same symptom from the supertest side. Closed the next day via release v6.3.1.",
  sources: [{ kind: "issue", ref: "#798", title: "pin superagent to 8.0.0", author: "smolinari", at: "2022-10-23" }],
  touches: ["package.json"],
  children: [
    {
      path: "issues/798/comments/1",
      kind: "comment",
      summary: "titanism: \"v6.3.1 released which bumps to superagent v8.0.3 which was released a bit ago today\" (links the release).",
      sources: [{ kind: "issue", ref: "#798", title: "pin superagent to 8.0.0", author: "titanism", at: "2022-10-24T20:31:15Z" }],
      children: [],
    },
    {
      path: "issues/798/comments/2",
      kind: "comment",
      summary: "smolinari: \"Thanks!\"",
      sources: [{ kind: "issue", ref: "#798", title: "pin superagent to 8.0.0", author: "smolinari", at: "2022-10-25T03:30:12Z" }],
      children: [],
    },
  ],
};

const repo: Rung = {
  path: ".",
  kind: "repo",
  summary: "visionmedia/supertest: a fluent assertion library for testing Node.js HTTP servers, built on superagent. 539 commits, 2012-06-26 to 2026-10-02.",
  sources: [],
  children: [indexJs, packageJson, release_v6_3_1, issue_798],
};

function render(rung: Rung, depth = 0): string {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}[${rung.kind}] ${rung.path}`, `${indent}  ${rung.summary}`];
  if (rung.sources.length) {
    lines.push(`${indent}  sources: ${rung.sources.map((s) => `${s.ref} (${s.at})`).join(", ")}`);
  }
  if (rung.touches?.length) {
    lines.push(`${indent}  touches: ${rung.touches.join(", ")}`);
  }
  for (const child of rung.children) lines.push(render(child, depth + 1));
  return lines.join("\n");
}

const output = render(repo);
console.log(output);
writeFileSync(join(here, "ladder-slice.output.txt"), output + "\n");
