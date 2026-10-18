// A full Ladder for supertest, the smaller of the two real demo repos.
// Every summary is written by reading the real source plus real git log,
// git blame, and GitHub issue/PR/release data (see the commit history on
// this file for the research trail). Covers all five real source files
// (1202 lines total). Artifact coverage (releases/issues/PRs) covers the
// ones actually significant to this code, not all ~950 real GitHub
// objects on the repo, which isn't a useful bar for "full."
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_RUNG_PATH, type Rung } from "../engine/ladder.js";
import { writeLadder } from "../engine/ladderNotes.js";
import { renderLadder } from "../engine/ladderRender.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, "..", "demo-repos", "supertest");
const stateDir = join(here, "..", "state", "supertest");

const indexJs: Rung = {
  path: "index.js",
  kind: "file",
  summary:
    "The package's entry point. Wraps an app (a request handler function, or an already-listening Server) in an http(s) server and returns a chainable object with one method per HTTP verb; the actual request/response assertion logic lives in lib/test.js. Also re-exports Test, .agent(), and cookie assertions.",
  sources: [
    { kind: "commit", ref: "b1abb67", title: "Initial commit", author: "TJ Holowaychuk", at: "2012-06-26" },
    { kind: "commit", ref: "fbf3b1d", title: "move Test to lib/test.js", author: "TJ Holowaychuk", at: "2012-06-26" },
    { kind: "pr", ref: "#477", title: "Updates dev libs to current versions.", author: "mikelax", at: "2018-05-14" },
    { kind: "commit", ref: "9ee6a1b", title: "Update index.js function definition", author: "David Thomason", at: "2020-04-20" },
    { kind: "commit", ref: "da57804", title: "feat: supports http2", author: "Lam Wei Li", at: "2022-10-04" },
    { kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" },
    { kind: "commit", ref: "71dc5fb", title: "fix: stabilize ephemeral server requests and assertions", author: "titanism", at: "2026-09-22" },
  ],
  children: [
    {
      path: "index.js/module.exports",
      kind: "function",
      summary:
        "Takes an app and returns an object with one method per HTTP verb. If given a function, starts a real server for it, http2 if options.http2 is set and supported, otherwise plain http. If given a Server, uses it directly. Each verb method constructs a new Test bound to that server.",
      sources: [
        { kind: "commit", ref: "9ee6a1b", title: "Update index.js function definition", author: "David Thomason", at: "2020-04-20" },
        { kind: "commit", ref: "da57804", title: "feat: supports http2", author: "Lam Wei Li", at: "2022-10-04" },
      ],
      children: [
        {
          path: "index.js/lines-30-41",
          kind: "lines",
          summary: "Picks the transport for the implicit server, throwing explicitly if http2 is requested on a Node build without it.",
          sources: [{ kind: "commit", ref: "da57804", title: "feat: supports http2", author: "Lam Wei Li", at: "2022-10-04" }],
          children: [],
        },
        {
          path: "index.js/lines-54",
          kind: "lines",
          summary: "obj.del = obj.delete, a backward-compatible alias kept since 2014.",
          sources: [{ kind: "commit", ref: "8741283", title: "Moved usage of 'del' to support the proper http verb 'delete'", author: "TJ Holowaychuk", at: "2014-03-24" }],
          children: [],
        },
      ],
    },
  ],
};

const agentJs: Rung = {
  path: "lib/agent.js",
  kind: "file",
  summary:
    "TestAgent: a persistent agent (cookie jar, TLS options) across multiple requests, inheriting from superagent's own Agent and overriding every HTTP verb to return a Test bound to this agent's server, cookie jar, and host header.",
  sources: [
    { kind: "commit", ref: "da69243", title: "Added request.agent(app) support", author: "Steffen Müller", at: "2013-03-14" },
    { kind: "commit", ref: "5e23869", title: "feat(TestAgent): decoupled TestAgent and superagent's Agent to support more than ca, key, cert", author: "Lam Wei Li", at: "2022-09-18" },
    { kind: "commit", ref: "6d9b9cb", title: "fix(TestAgent): attach cookies to agent after plugin is used", author: "Lam Wei Li", at: "2022-09-18" },
    { kind: "commit", ref: "f290431", title: "Fix TestAgent not inheriting Agent properties", author: "Bruce Berrios", at: "2024-04-23" },
    { kind: "commit", ref: "6d060e3", title: "feat: fix server lifecycle, callback handling, and SuperAgent v10 compatibility", author: "titanism", at: "2025-07-07" },
  ],
  children: [
    {
      path: "lib/agent.js/TestAgent",
      kind: "function",
      summary: "Constructor. Builds on a real superagent Agent (for its cookie jar and defaults), starts an implicit server the same way index.js does if given a function, and stores it as this.app.",
      sources: [{ kind: "commit", ref: "da57804", title: "feat: supports http2", author: "Lam Wei Li", at: "2022-10-04" }],
      children: [],
    },
    {
      path: "lib/agent.js/lines-64-89",
      kind: "function",
      summary:
        "Overrides every HTTP verb (except query, explicitly preserved) to return a Test that shares this agent's server, host header, and cookie jar, resaving cookies on every response and redirect so the agent behaves like a real browser session across requests.",
      sources: [
        { kind: "commit", ref: "5e23869", title: "feat(TestAgent): decoupled TestAgent and superagent's Agent to support more than ca, key, cert", author: "Lam Wei Li", at: "2022-09-18" },
        { kind: "commit", ref: "6d9b9cb", title: "fix(TestAgent): attach cookies to agent after plugin is used", author: "Lam Wei Li", at: "2022-09-18" },
      ],
      children: [],
    },
    {
      path: "lib/agent.js/lines-94",
      kind: "lines",
      summary: "TestAgent.prototype.del alias, the same backward-compatible pattern as index.js's own obj.del.",
      sources: [{ kind: "commit", ref: "8741283", title: "Moved usage of 'del' to support the proper http verb 'delete'", author: "TJ Holowaychuk", at: "2014-03-24" }],
      children: [],
    },
  ],
};

const cookiesIndexJs: Rung = {
  path: "lib/cookies/index.js",
  kind: "file",
  summary:
    "ExpectCookies: builds the cookie-assertion function, proxying every static method off a fresh Assertion instance so each call starts from a clean assertion chain. Adapted from gregl83/expect-cookies, a real, separate npm package (its copyright notice is preserved at the top of this file and of assertion.js).",
  sources: [
    { kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" },
    { kind: "commit", ref: "d4f04fb", title: "fix: correct case-sensitive require path for assertion module", author: "titanism", at: "2026-01-06" },
  ],
  children: [
    {
      path: "lib/cookies/index.js/ExpectCookies",
      kind: "function",
      summary: "Thin wrapper: ExpectCookies(secret, asserts) just calls Assertion(secret, asserts); the real work is proxying Assertion's static methods onto it below.",
      sources: [{ kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" }],
      children: [],
    },
  ],
};

const cookiesAssertionJs: Rung = {
  path: "lib/cookies/assertion.js",
  kind: "file",
  summary:
    "The real cookie-assertion engine ported from expect-cookies (Gregory Langlais, MIT, npm 'expect-cookies'). Parses Set-Cookie/Cookie headers and builds a chainable set of assertion verbs (.set, .reset, .new, .renew, .contain, .not) that check a response's cookies against expectations, including signed-cookie verification via cookie-signature.",
  sources: [
    { kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" },
    { kind: "commit", ref: "1954bcf", title: "fix: replace 'should' dependency with native assertions in cookies module", author: "titanism", at: "2026-01-06" },
    { kind: "commit", ref: "71dc5fb", title: "fix: stabilize ephemeral server requests and assertions", author: "titanism", at: "2026-09-22" },
  ],
  children: [
    {
      path: "lib/cookies/assertion.js/assert-helpers",
      kind: "function",
      summary:
        "Four small helpers (assertHasProperties, assertNotHasProperties, assertEqual, assertNotEqual), each throwing a plain Error on mismatch. Grouped here since they're structurally identical; this is the shape a rung takes for closely related trivial functions rather than one rung each.",
      sources: [{ kind: "commit", ref: "1954bcf", title: "fix: replace 'should' dependency with native assertions in cookies module", author: "titanism", at: "2026-01-06" }],
      children: [],
    },
    {
      path: "lib/cookies/assertion.js/module.exports",
      kind: "function",
      summary:
        "The Assertion factory. Returns a callable that, given a response, parses its request/response cookies and runs every registered assertion against them, short-circuiting on the first failure (returned as a string, not thrown, per the original expect-cookies design).",
      sources: [{ kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" }],
      children: [],
    },
    {
      path: "lib/cookies/assertion.js/Assertion.parse",
      kind: "function",
      summary:
        "Parses one Set-Cookie or Cookie header string into {name, value, options}. Cookie names are case-sensitive; Set-Cookie attribute names (domain, path, etc.) are lowercased. The first key=value pair is the cookie itself, everything after is an option.",
      sources: [{ kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" }],
      children: [],
    },
    {
      path: "lib/cookies/assertion.js/assertion-verbs",
      kind: "function",
      summary:
        "Assertion.set/.reset/.new/.renew/.contain: five verbs, each registering a closure that compares the request's and response's cookies. .set checks a cookie exists with given options; .reset checks it was sent and is still present after; .new checks it's present in the response but wasn't in the request; .renew checks expires/max-age increased; .contain checks specific option values, including unsigning a signed value against every configured secret. Grouped as one rung since they share one shape (build expectations, push a comparison closure, return Assertion for chaining); each differs only in what the closure checks.",
      sources: [{ kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" }],
      children: [],
    },
    {
      path: "lib/cookies/assertion.js/Assertion.not",
      kind: "function",
      summary: "Negation modifier: re-invokes the named verb with assert=false, so .not('set', ...) asserts a cookie is absent instead of present.",
      sources: [{ kind: "commit", ref: "4f89680", title: "feat(cookies): add cookie assertions", author: "Dolan Murvihill", at: "2025-08-25" }],
      children: [],
    },
  ],
};

const testJs: Rung = {
  path: "lib/test.js",
  kind: "file",
  summary:
    "The heart of the library. Test extends superagent's Request, deferring dispatch until an implicit server is actually listening, then running a chain of status/header/body assertions and handing (err, res) to a callback. 86 real commits, the most actively maintained file in the repo; several of its functions have their own multi-year fix history below.",
  sources: [
    { kind: "commit", ref: "d94ffbc", title: "refactor: Convert test to a class", author: "Jimmy Wärting", at: "2022-01-04" },
    { kind: "commit", ref: "6d060e3", title: "feat: fix server lifecycle, callback handling, and SuperAgent v10 compatibility", author: "titanism", at: "2025-07-07" },
    { kind: "commit", ref: "96c06e3", title: "fix: avoid server re-use race conditions", author: "alxndrsn", at: "2025-03-19" },
    { kind: "commit", ref: "71dc5fb", title: "fix: stabilize ephemeral server requests and assertions", author: "titanism", at: "2026-09-22" },
    { kind: "commit", ref: "b6f5995", title: "fix: match ephemeral server address family", author: "pnookala-godaddy", at: "2026-08-15" },
    { kind: "commit", ref: "e74a1e0", title: "fix: bind ephemeral server to the loopback address it connects to", author: "jh8459", at: "2026-09-29" },
  ],
  children: [
    {
      path: "lib/test.js/constructor",
      kind: "function",
      summary: "Builds the request, disables redirects (supertest asserts against the raw response, not a followed one) and buffers the body, then resolves this.url immediately if app is already listening, or defers to serverAddress otherwise.",
      sources: [{ kind: "commit", ref: "d94ffbc", title: "refactor: Convert test to a class", author: "Jimmy Wärting", at: "2022-01-04" }],
      children: [],
    },
    {
      path: "lib/test.js/serverAddress",
      kind: "function",
      summary:
        "Starts the implicit server at most once per app (tracked in a WeakMap so user-owned servers are never touched), binding explicitly to 127.0.0.1 rather than a wildcard address, since a wildcard bind can share its port with another process's own loopback listener on macOS and silently misroute the request. Three real fixes in 2026 (Aug 15, Sep 22, Sep 29) hardened exactly this address-family and binding behavior.",
      sources: [
        { kind: "commit", ref: "b6f5995", title: "fix: match ephemeral server address family", author: "pnookala-godaddy", at: "2026-08-15" },
        { kind: "commit", ref: "71dc5fb", title: "fix: stabilize ephemeral server requests and assertions", author: "titanism", at: "2026-09-22" },
        { kind: "commit", ref: "e74a1e0", title: "fix: bind ephemeral server to the loopback address it connects to", author: "jh8459", at: "2026-09-29" },
      ],
      children: [],
    },
    {
      path: "lib/test.js/formatServerUrl",
      kind: "function",
      summary: "Builds the request URL from a listening server's address, mapping wildcard addresses (:: or 0.0.0.0) to the IPv4 loopback so the client doesn't construct an IPv6 URL superagent can't resolve, while leaving an explicitly IPv6-only server's own address alone.",
      sources: [{ kind: "commit", ref: "71dc5fb", title: "fix: stabilize ephemeral server requests and assertions", author: "titanism", at: "2026-09-22" }],
      children: [],
    },
    {
      path: "lib/test.js/expect",
      kind: "function",
      summary:
        "Overloaded assertion registrar: dispatches on argument shape to status, body, header, status-array, or custom-function assertions, pushing each as a wrapped closure checked later in assert(). The array-of-statuses form (.expect([200, 404])) was added in 2021 and needed two follow-up fixes the same year for its interaction with JSON bodies and empty-array responses, a real small saga of a feature landing imperfectly and getting corrected in public.",
      sources: [
        { kind: "commit", ref: "ab252f3", title: "Allows expect to accept an array of statuses", author: "Juan M. Villegas", at: "2021-04-12" },
        { kind: "commit", ref: "5a6999a", title: "Mitigate array-of-statuses' impact on JSON bodies", author: "Svante Bengtson", at: "2021-07-26" },
        { kind: "commit", ref: "ed0f68d", title: "Add on to the mitigation ... to support empty array response body", author: "Benjos", at: "2021-08-12" },
      ],
      children: [],
    },
    {
      path: "lib/test.js/end",
      kind: "function",
      summary:
        "Defers superagent's real .end() until the implicit server is confirmed listening (or reports a start error), then runs it and decrements a shared pending-request count, closing the server only once every concurrent request against it has settled. This function's real history is the most consequential in the file: a 2025 attempt at automatic server closing had to be reverted per issue #651 after it broke manually-started-server usage, and the September 2026 stabilization commit fixed four more real issues against this exact lifecycle logic.",
      sources: [
        { kind: "commit", ref: "b6fd281", title: "fix: revert automatic server closing (per #651)", author: "titanism", at: "2025-07-07" },
        { kind: "commit", ref: "6d060e3", title: "feat: fix server lifecycle, callback handling, and SuperAgent v10 compatibility", author: "titanism", at: "2025-07-07" },
        { kind: "commit", ref: "96c06e3", title: "fix: avoid server re-use race conditions", author: "alxndrsn", at: "2025-03-19" },
        {
          kind: "commit",
          ref: "71dc5fb",
          title: "fix: stabilize ephemeral server requests and assertions (fixes #726, #876, #879, #891; supersedes 10 open PRs)",
          author: "titanism",
          at: "2026-09-22",
        },
      ],
      touches: ["asks/651"],
      children: [],
    },
    {
      path: "lib/test.js/assert",
      kind: "function",
      summary:
        "Runs every registered assertion against the response and calls the callback with the first failure (or null). Specifically distinguishes real connection-level system errors (ECONNREFUSED, ECONNRESET, EPIPE, ETIMEDOUT) from assertion failures, citing Node's own error documentation in a code comment.",
      sources: [{ kind: "commit", ref: "d94ffbc", title: "refactor: Convert test to a class", author: "Jimmy Wärting", at: "2022-01-04" }],
      children: [],
    },
    {
      path: "lib/test.js/bearer",
      kind: "function",
      summary: "Shortcut for .set('Authorization', `Bearer ${token}`). Added 2024-08-04; the September 2026 stabilization commit notes removing a duplicate implementation of this exact method that had crept in elsewhere.",
      sources: [
        { kind: "commit", ref: "411f7ce", title: "feat(bearer): bearer auth token method", author: "Vinicius", at: "2024-08-04" },
        { kind: "commit", ref: "71dc5fb", title: "fix: stabilize ephemeral server requests and assertions", author: "titanism", at: "2026-09-22" },
      ],
      children: [],
    },
    {
      path: "lib/test.js/assert-helpers",
      kind: "function",
      summary: "Five small helpers (_assertBody, _assertHeader, _assertStatus, _assertStatusArray, _assertFunction), each returning an Error or undefined for one expectation kind. Grouped for the same reason as assertion.js's small helpers: structurally identical, not worth a rung each.",
      sources: [{ kind: "commit", ref: "d94ffbc", title: "refactor: Convert test to a class", author: "Jimmy Wärting", at: "2022-01-04" }],
      children: [],
    },
    {
      path: "lib/test.js/wrapAssertFn",
      kind: "function",
      summary:
        "Captures a clean stack trace at registration time and splices it onto any assertion error's own stack, so a failed .expect() in test output points at the calling test code instead of disappearing into supertest's internals. Itself has a real, multi-year fix history: Node-version-dependent stack formats, and an error-object check that had to be added after a real reported bug (#700).",
      sources: [
        { kind: "commit", ref: "0288826", title: "produces edited stack that starts with error name", author: "JP Bochi", at: "2021-01-15" },
        { kind: "commit", ref: "d41d10b", title: "Wraps assert functions, updating stack trace of generated errors", author: "JP Bochi", at: "2020-12-03" },
        { kind: "commit", ref: "0a06ef1", title: "fix: Fix unappropriate stack trace issue on Node.js prior than 14", author: "Ketut Sandiarsa", at: "2021-01-24" },
        { kind: "commit", ref: "b628d34", title: "fix: Check error object before updating stack. (Fixes #700)", author: "Andres Torres", at: "2021-01-25" },
        { kind: "commit", ref: "3dba4e9", title: "fix: add stacktrace to failed expect function call", author: "Alexandre ABRIOUX", at: "2022-03-29" },
      ],
      children: [],
    },
    {
      path: "lib/test.js/error",
      kind: "function",
      summary: "Builds an Error carrying .expected/.actual/.showDiff, so a test runner can render a diff instead of just a message.",
      sources: [],
      children: [],
    },
  ],
};

// Non-file artifacts: hang directly off the repo rung, per ladder-design.
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

// No "issue" concept: a GitHub issue being filed is someone ASKing the
// Coordinator about something, and a reply is either an ANSWER or another
// ASK in the same thread, exactly the vocabulary native zz activity uses.
// smolinari's purely social "Thanks!" isn't dropped for space; it's dropped
// because it isn't answering anything, so it isn't protocol content.
const ask_798: Rung = {
  path: "asks/798",
  kind: "ask",
  summary:
    "smolinari ASKs about a bug: filed 2022-10-23 with no visibility into the already-three-weeks-old superagent#1743, hitting the same symptom from the supertest side.",
  sources: [
    { kind: "issue", ref: "#798", title: "pin superagent to 8.0.0", author: "smolinari", at: "2022-10-23" },
    { kind: "commit", ref: "25122e6", title: "fix: bump superagent (closes #798)", author: "titanism", at: "2022-10-24" },
  ],
  touches: ["package.json"],
  children: [
    {
      path: "asks/798/1",
      kind: "answer",
      summary: "titanism ANSWERs (grant): \"v6.3.1 released which bumps to superagent v8.0.3 which was released a bit ago today\" (links the release).",
      sources: [{ kind: "issue", ref: "#798", title: "pin superagent to 8.0.0", author: "titanism", at: "2022-10-24T20:31:15Z" }],
      children: [],
    },
  ],
};

// Real 5-year-old thread: filed 2020, fixed-then-reverted in between,
// finally closed 2025, with a real follow-up regression surfacing as a new
// ASK in the same thread rather than just another reply.
const ask_651: Rung = {
  path: "asks/651",
  kind: "ask",
  summary:
    "An ASK about a bug: \"end() not called when app is started manually,\" filed 2020-05-15. Open for over 5 years: a 2025 fix attempt broke manually-started-server usage and was reverted (b6fd281), before the real underlying lifecycle work (end()'s pending-request tracking) finally closed it in 2025-07-07.",
  sources: [
    { kind: "issue", ref: "#651", title: "Fix end() not called when app is started manually", author: "(reporter)", at: "2020-05-15" },
    { kind: "commit", ref: "b6fd281", title: "fix: revert automatic server closing (per #651)", author: "titanism", at: "2025-07-07" },
  ],
  touches: ["lib/test.js/end"],
  children: [
    {
      path: "asks/651/1",
      kind: "answer",
      summary: "titanism ANSWERs (grant): announces the fix, pointing at supertest v7.1.2 and the matching superagent release.",
      sources: [{ kind: "issue", ref: "#651", title: "Fix end() not called when app is started manually", author: "titanism", at: "2025-07-07T18:54:30Z" }],
      children: [],
    },
    {
      path: "asks/651/2",
      kind: "ask",
      summary: "jonathansamines ASKs again, a new problem in the same thread: the v7.1.2 release itself introduced a real backward-incompatible regression, caught within hours.",
      sources: [{ kind: "issue", ref: "#651", title: "Fix end() not called when app is started manually", author: "jonathansamines", at: "2025-07-07T22:57:31Z" }],
      children: [],
    },
    {
      path: "asks/651/3",
      kind: "answer",
      summary: "titanism ANSWERs (inform, not yet resolved): \"You are correct, let me fix.\"",
      sources: [{ kind: "issue", ref: "#651", title: "Fix end() not called when app is started manually", author: "titanism", at: "2025-07-07T23:23:56Z" }],
      children: [],
    },
    {
      path: "asks/651/4",
      kind: "answer",
      summary: "titanism ANSWERs (grant): ships v7.1.3 the same evening and deprecates v7.1.2 on npm for the regression.",
      sources: [{ kind: "issue", ref: "#651", title: "Fix end() not called when app is started manually", author: "titanism", at: "2025-07-07T23:29:04Z" }],
      children: [],
    },
  ],
};

const packageJson: Rung = {
  path: "package.json",
  kind: "file",
  summary: "Package manifest. Pins its superagent dependency tightly rather than a wide range (see the #798 ask rung).",
  sources: [{ kind: "commit", ref: "25122e6", title: "fix: bump superagent (closes #798)", author: "titanism", at: "2022-10-24" }],
  children: [],
};

const libCookiesDir: Rung = {
  path: "lib/cookies",
  kind: "directory",
  summary: "Cookie assertion support, ported wholesale from the real, separate expect-cookies npm package in 2025.",
  sources: [],
  children: [cookiesIndexJs, cookiesAssertionJs],
};

const libDir: Rung = {
  path: "lib",
  kind: "directory",
  summary: "The library's actual logic: Test (the chainable per-request object), TestAgent (a persistent agent across requests), and cookie assertions.",
  sources: [],
  children: [testJs, agentJs, libCookiesDir],
};

const repo: Rung = {
  path: REPO_RUNG_PATH,
  kind: "repo",
  summary: "forwardemail/supertest (formerly visionmedia/supertest): a fluent assertion library for testing Node.js HTTP servers, built on superagent. 539 commits, 2012-06-26 to 2026-10-02, 1202 lines of real source across 5 files.",
  sources: [],
  children: [indexJs, libDir, packageJson, release_v6_3_1, ask_798, ask_651],
};

// Write one git note per anchor (file/directory/repo/ask/release) into
// the real clone's own notes ref; function/line/comment rungs ride along
// embedded in their nearest anchor's note.
await writeLadder(repoDir, stateDir, repo);

// Render by reading back from git notes: one note read per anchor, zero
// extra reads for anything embedded in it.
const { text, stats } = await renderLadder(repoDir, stateDir);
console.log(text);
console.log(`\n${stats.rungs} total rungs, from ${stats.notes} git notes (refs/notes/zz/ladder/{code,asks/*,release}) in the real supertest clone.`);
