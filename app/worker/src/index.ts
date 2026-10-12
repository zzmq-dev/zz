// Proof-of-mechanism Worker for the Cloudflare backend
// (site/content/remote-backend/index.md). /full-protocol-test is the
// real target: the actual agent/tools.ts tool surface, through a real
// MaintainerDO, doing the real protocol end to end (propose -> work ->
// changeset_review -> submit_changeset -> commit -> Ladder write ->
// read back) against a real Artifacts repo. The other routes are the
// smaller, lower-level proofs built incrementally to get there, kept
// as regression checks for the mechanisms underneath (native reads,
// isomorphic-git writes, the Ladder's scoped notes checkout).
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createMemFs } from "./memFs.js";
import { MaintainerDO } from "./MaintainerDO.js";
import { commitChangesetOnArtifacts, readFileAtCommit } from "./cloudflareGitBackend.js";
import { writeRung, readRung, appendRepoChildren } from "./cloudflareLadderBackend.js";
import { ensureMeta, readRepoMeta, readRepoRoles, writeRepoRoles } from "./repoMeta.js";
import { handleWebRequest } from "./webApp.js";
import { decryptSecret, type OAuthEnv } from "./auth.js";

export { MaintainerDO };

// Artifacts/ArtifactsRepo/ArtifactsCreateRepoResult are ambient globals
// from @cloudflare/workers-types (tsconfig's "types" pulls them in) --
// no hand-rolled copy needed, and no import either; a hand-rolled copy
// used to live here (and drifted from the real shape -- see
// cloudflareGitBackend.ts's header for the same fix made there).
interface Env extends OAuthEnv {
  ARTIFACTS: Artifacts;
  MAINTAINER_DO: DurableObjectNamespace<MaintainerDO>;
  DB: D1Database;
}

function tokenString(token: { plaintext: string } | string): string {
  return typeof token === "string" ? token.split("?")[0] : token.plaintext;
}

async function seedRepo(env: Env, repoName: string, files: { path: string; content: string }[]): Promise<{ remote: string; commitOid: string }> {
  const created = await env.ARTIFACTS.create(repoName, { setDefaultBranch: "main" });
  const fs = createMemFs();
  const dir = "/seed";
  await git.init({ fs, dir, defaultBranch: "main" });
  const entries = [];
  for (const f of files) {
    const oid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(f.content) });
    entries.push({ mode: "100644", path: f.path, oid, type: "blob" as const });
  }
  const tree = await git.writeTree({ fs, dir, tree: entries });
  const person = { name: "seed", email: "seed@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  const commitOid = await git.writeCommit({ fs, dir, commit: { message: "seed", tree, parent: [], author: person, committer: person } });
  await git.writeRef({ fs, dir, ref: "refs/heads/main", value: commitOid, force: true });
  await git.push({ fs, http, dir, url: created.remote, onAuth: () => ({ username: "x-token-auth", password: tokenString(created.token) }), ref: "main", remoteRef: "main" });
  return { remote: created.remote, commitOid };
}

// The real tool surface, through a real DO, doing the real protocol
// end to end -- the thing all the other routes were building toward.
// Skips run_in_sandbox (can't run on a Worker, by design) and composes
// file content directly instead, same as the rest of this test's
// seeding does; everything else is the actual zz protocol, unmodified.
async function testFullProtocol(env: Env): Promise<Response> {
  const repoName = "full-protocol-" + Date.now();
  const steps: Record<string, unknown> = {};
  const actor = "zz-worker-test";
  try {
    const { commitOid: seedCommitOid } = await seedRepo(env, repoName, [{ path: "clamp.js", content: "export function clamp(v,min,max){return Math.min(Math.max(v,min),max);}\n" }]);
    steps.seeded = seedCommitOid;

    const id = env.MAINTAINER_DO.idFromName(repoName);
    const stub = env.MAINTAINER_DO.get(id);
    await stub.configure(repoName);
    const call = (name: string, args: Record<string, unknown>) => stub.callTool(name, args);

    const lane = (await call("lane_propose", { repo: repoName, name: "full-protocol-test", objective: "prove the real tool surface end to end", scope: ["**"], actor })) as { id: string };
    steps.lane = lane;

    const workAsk = (await call("ask_post", { repo: repoName, lane_id: lane.id, kind: "work", from: "human", payload: { description: "add isOdd to index.js" } })) as { id: string };
    await call("ask_claim", { repo: repoName, lane_id: lane.id, ask_id: workAsk.id, actor });

    const proposedFiles = [
      { path: "clamp.js", content: "export function clamp(v,min,max){return Math.min(Math.max(v,min),max);}\n" },
      { path: "index.js", content: "export { clamp } from \"./clamp.js\";\n\nexport function isOdd(n) { return n % 2 !== 0; }\n" },
    ];

    // The Maintainer-role gate from earlier this session: a review has
    // to exist and be granted before submit_changeset is even
    // claimable (enforced in engine/lane.ts's answer(), not just
    // hoped for) -- so post and grant it first, same order
    // agent/scriptedWork.ts's real flow uses.
    const review = (await call("ask_post", { repo: repoName, lane_id: lane.id, kind: "changeset_review", from: actor, payload: { taskDescription: "add isOdd", files: proposedFiles, message: "add isOdd", summary: "Add isOdd(n)" } })) as { id: string };
    await call("ask_claim", { repo: repoName, lane_id: lane.id, ask_id: review.id, actor });
    await call("ask_answer", { repo: repoName, lane_id: lane.id, ask_id: review.id, actor, action: "grant" });
    steps.reviewGranted = true;

    const submit = (await call("ask_post", {
      repo: repoName,
      lane_id: lane.id,
      kind: "submit_changeset",
      from: actor,
      payload: { files: proposedFiles, message: "add isOdd", summary: "Add isOdd(n)" },
      depends_on: [workAsk.id, review.id],
    })) as { id: string };
    await call("ask_answer", { repo: repoName, lane_id: lane.id, ask_id: workAsk.id, actor, action: "complete", payload: { summary: "proposed" } });

    await call("ask_claim", { repo: repoName, lane_id: lane.id, ask_id: submit.id, actor });
    const commitResult = (await call("commit_changeset", { repo: repoName, files: proposedFiles, message: "add isOdd", author_name: actor, author_email: `${actor}@local` })) as { commitOid: string };
    steps.commitOid = commitResult.commitOid;

    const now = new Date().toISOString();
    const source = [{ kind: "commit", ref: commitResult.commitOid, title: "add isOdd", author: actor, at: now }];
    // appendRepoChildren (called by mergeLaneLadder after every
    // non-root rung write) requires the "_repo" root note to already
    // exist -- demo/greenfield.ts's own bootstrap writes this once,
    // first, before anything else; this test has to do the same.
    await call("ladder_write_rung", { repo: repoName, rung: { path: "_repo", kind: "repo", summary: "A test repo for the full protocol.", sources: source, children: [] } });
    steps.rootRungWritten = true;
    await call("ladder_write_rung", { repo: repoName, rung: { path: "index.js", kind: "file", summary: "Re-exports clamp and adds isOdd.", sources: source, children: [] } });
    steps.fileRungWritten = true;
    await call("ladder_write_rung", {
      repo: repoName,
      rung: { path: `changesets/${commitResult.commitOid}`, kind: "changeset", summary: "Add isOdd.", sources: source, children: [{ path: `changesets/${commitResult.commitOid}/index.js`, kind: "filechange", summary: "Added isOdd.", sources: source, children: [] }] },
    });
    steps.changesetRungWritten = true;
    await call("ask_answer", { repo: repoName, lane_id: lane.id, ask_id: submit.id, actor, action: "complete", payload: { commitOid: commitResult.commitOid } });
    steps.answered = true;

    steps.readIndexRung = await call("ladder_read", { repo: repoName, path: "index.js" });
    steps.readLane = await call("lane_get", { repo: repoName, lane_id: lane.id });
    steps.readFileAtCommit = await call("git_show_file", { repo: repoName, sha: commitResult.commitOid, path: "index.js" });

    await env.ARTIFACTS.delete(repoName);
    steps.cleanedUp = true;
    return Response.json({ ok: true, steps });
  } catch (err) {
    await env.ARTIFACTS.delete(repoName).catch(() => {});
    return Response.json({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err), steps }, { status: 500 });
  }
}

async function testChangesetCommit(env: Env): Promise<Response> {
  const repoName = "changeset-proof-" + Date.now();
  const steps: Record<string, unknown> = {};
  try {
    const { remote, commitOid: seedCommitOid } = await seedRepo(env, repoName, [
      { path: "index.js", content: "export { clamp } from \"./clamp.js\";\n" },
      { path: "clamp.js", content: "export function clamp(v,min,max){return Math.min(Math.max(v,min),max);}\n" },
    ]);
    steps.seeded = seedCommitOid;

    using repo = await env.ARTIFACTS.get(repoName);
    const newToken = await repo.createToken("write", 3600);
    const commitOid = await commitChangesetOnArtifacts(
      repoName,
      remote,
      newToken,
      repo,
      { files: [{ path: "index.js", content: "export { clamp } from \"./clamp.js\";\n\nexport function isOdd(n) { return n % 2 !== 0; }\n" }], message: "add isOdd", author: { name: "zz-worker", email: "zz-worker@local" } },
    );
    steps.changesetCommit = commitOid;
    steps.indexJsAfter = await readFileAtCommit(repo, commitOid, "index.js");
    steps.clampJsStillThere = await readFileAtCommit(repo, commitOid, "clamp.js");

    await env.ARTIFACTS.delete(repoName);
    steps.cleanedUp = true;
    return Response.json({ ok: true, steps });
  } catch (err) {
    await env.ARTIFACTS.delete(repoName).catch(() => {});
    return Response.json({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err), steps }, { status: 500 });
  }
}

async function testLadder(env: Env): Promise<Response> {
  const repoName = "ladder-proof-" + Date.now();
  const steps: Record<string, unknown> = {};
  try {
    const { remote, commitOid: seedCommitOid } = await seedRepo(env, repoName, [{ path: "clamp.js", content: "export function clamp(v,min,max){return Math.min(Math.max(v,min),max);}\n" }]);
    steps.seeded = seedCommitOid;

    using repo = await env.ARTIFACTS.get(repoName);
    const writeToken = await repo.createToken("write", 3600);
    await writeRung(remote, writeToken, repo, {
      path: "clamp.js",
      kind: "file",
      summary: "Exports clamp(value, min, max).",
      sources: [{ kind: "commit", ref: seedCommitOid, title: "seed", author: "seed", at: new Date().toISOString() }],
      children: [],
    });
    steps.wroteFileRung = true;

    using repo2 = await env.ARTIFACTS.get(repoName);
    const readToken = await repo2.createToken("read", 3600);
    steps.readFileRung = await readRung(remote, readToken, repo2, "file", "clamp.js");

    await env.ARTIFACTS.delete(repoName);
    steps.cleanedUp = true;
    return Response.json({ ok: true, steps });
  } catch (err) {
    await env.ARTIFACTS.delete(repoName).catch(() => {});
    return Response.json({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err), steps }, { status: 500 });
  }
}

// Diagnostic only: what does git.fetch() actually return for a ref
// that genuinely doesn't exist on the remote yet? scopedNotesCheckout
// (cloudflareLadderBackend.ts) assumes it throws or returns a falsy
// fetchHead -- this checks that assumption directly against a real
// Artifacts repo instead of guessing from a confusing downstream error.
// Diagnostic only: the "repo"-kind rung (anchored to rootCommitOid
// rather than a file blob) and appendRepoChildren were both added
// speculatively in this final phase and never exercised live --
// testLadder only covers a "file" rung. Isolates each step so a
// failure here points at exactly one of: writing the root note,
// reading it back, or appending a child to it.
async function testRepoRungAndAppend(env: Env): Promise<Response> {
  const repoName = "repo-rung-proof-" + Date.now();
  const steps: Record<string, unknown> = {};
  try {
    const { remote, commitOid: seedCommitOid } = await seedRepo(env, repoName, [{ path: "a.txt", content: "a\n" }]);
    steps.seeded = seedCommitOid;
    const source = [{ kind: "commit" as const, ref: seedCommitOid, title: "seed", author: "seed", at: new Date().toISOString() }];

    using repo1 = await env.ARTIFACTS.get(repoName);
    const writeToken1 = await repo1.createToken("write", 3600);
    await writeRung(remote, writeToken1, repo1, { path: "_repo", kind: "repo", summary: "root", sources: source, children: [] });
    steps.wroteRootRung = true;

    using repo2 = await env.ARTIFACTS.get(repoName);
    const readToken1 = await repo2.createToken("read", 3600);
    steps.readRootAfterWrite = await readRung(remote, readToken1, repo2, "repo", "_repo");

    using repo3 = await env.ARTIFACTS.get(repoName);
    const writeToken2 = await repo3.createToken("write", 3600);
    await appendRepoChildren(remote, writeToken2, repo3, [{ path: "a.txt", kind: "file" }]);
    steps.appended = true;

    using repo4 = await env.ARTIFACTS.get(repoName);
    const readToken2 = await repo4.createToken("read", 3600);
    steps.readRootAfterAppend = await readRung(remote, readToken2, repo4, "repo", "_repo");

    await env.ARTIFACTS.delete(repoName);
    return Response.json({ ok: true, steps });
  } catch (err) {
    await env.ARTIFACTS.delete(repoName).catch(() => {});
    return Response.json({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err), steps }, { status: 500 });
  }
}

// Diagnostic only: the zz-meta orphan branch is brand new this phase
// -- verify ensureMeta's bootstrap, a role-grant write, and reads of
// both files against a real Artifacts repo before anything else is
// built on top of it (D1, the web app).
async function testRepoMeta(env: Env): Promise<Response> {
  const repoName = "repo-meta-proof-" + Date.now();
  const steps: Record<string, unknown> = {};
  try {
    const { remote } = await seedRepo(env, repoName, [{ path: "a.txt", content: "a\n" }]);
    using repo = await env.ARTIFACTS.get(repoName);
    const token = await repo.createToken("write", 3600);

    await ensureMeta(remote, token, { description: "a test repo", owner: { type: "account", id: "acct-test" } });
    steps.ensuredOnce = await readRepoMeta(remote, token);

    // Idempotency: calling ensureMeta again must not clobber the existing meta.json.
    await ensureMeta(remote, token, { description: "SHOULD NOT APPEAR", owner: { type: "account", id: "acct-other" } });
    steps.ensuredTwice = await readRepoMeta(remote, token);

    const rolesBefore = await readRepoRoles(remote, token);
    steps.rolesBefore = rolesBefore;
    await writeRepoRoles(remote, token, { grants: [...(rolesBefore?.grants ?? []), { principal: "agent:agent-test", role: "contributor", granted_by: "acct-test", at: new Date().toISOString() }] });
    steps.rolesAfter = await readRepoRoles(remote, token);

    // meta.json must survive the roles.json-only write untouched.
    steps.metaAfterRolesWrite = await readRepoMeta(remote, token);

    await env.ARTIFACTS.delete(repoName);
    return Response.json({ ok: true, steps });
  } catch (err) {
    await env.ARTIFACTS.delete(repoName).catch(() => {});
    return Response.json({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err), steps }, { status: 500 });
  }
}

async function testFetchMissingRef(env: Env): Promise<Response> {
  const repoName = "fetch-missing-ref-" + Date.now();
  const steps: Record<string, unknown> = {};
  try {
    const { remote } = await seedRepo(env, repoName, [{ path: "a.txt", content: "a\n" }]);
    using repo = await env.ARTIFACTS.get(repoName);
    const token = await repo.createToken("write", 3600);
    const fs = createMemFs();
    const dir = "/notes";
    await git.init({ fs, dir, defaultBranch: "main" });
    await git.addRemote({ fs, dir, remote: "origin", url: remote });
    const onAuth = () => ({ username: "x-token-auth", password: tokenString(token) });
    const ref = "refs/notes/zz/ladder/code";
    try {
      const result = await git.fetch({ fs, http, dir, remote: "origin", onAuth, ref, remoteRef: ref, singleBranch: true, tags: false });
      steps.fetchResolved = true;
      steps.fetchResult = { fetchHead: result.fetchHead, headers: result.headers ? Object.fromEntries(Object.entries(result.headers)) : null, pruned: result.pruned ?? null };
    } catch (fetchErr) {
      steps.fetchThrew = true;
      steps.fetchError = fetchErr instanceof Error ? (fetchErr.stack ?? fetchErr.message) : String(fetchErr);
    }
    await env.ARTIFACTS.delete(repoName);
    return Response.json({ ok: true, steps });
  } catch (err) {
    await env.ARTIFACTS.delete(repoName).catch(() => {});
    return Response.json({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err), steps }, { status: 500 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/full-protocol-test") return testFullProtocol(env);
    if (path === "/ladder-test") return testLadder(env);
    if (path === "/changeset-test") return testChangesetCommit(env);
    if (path === "/fetch-missing-ref-test") return testFetchMissingRef(env);
    if (path === "/repo-rung-test") return testRepoRungAndAppend(env);
    if (path === "/repo-meta-test") return testRepoMeta(env);
    if (path === "/dev-seed-content") {
      const artifactsName = new URL(req.url).searchParams.get("repo");
      if (!artifactsName) return new Response("missing ?repo=", { status: 400 });
      const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(artifactsName));
      await stub.configure(artifactsName);
      const commitResult = await stub.callTool("commit_changeset", {
        repo: artifactsName,
        files: [
          { path: "README.md", content: "# Demo widget\n\nA tiny demo repo for testing the web app.\n" },
          { path: "index.js", content: "export function widget() { return 42; }\n" },
        ],
        message: "seed content",
        author_name: "dev-seed",
        author_email: "dev-seed@local",
      });
      return Response.json(commitResult);
    }

    if (path === "/dev-cf-userinfo-raw") {
      // One-off diagnostic, extended: does GET /client/v4/user with the
      // OAuth access token as a bearer actually return email/name,
      // the way a REST API token's Bearer auth would? (user-details.read
      // is an API-token-permission-shaped scope, not an OIDC one, so
      // it's plausible the access token doubles as a regular API
      // token for that one permission -- or it may not, API tokens and
      // OAuth access tokens aren't always interchangeable. Checking
      // directly rather than assuming either way.)
      const row = await env.DB.prepare("SELECT access_token_enc FROM account_identities WHERE provider = 'cloudflare' ORDER BY created_at DESC LIMIT 1").first<{ access_token_enc: string }>();
      if (!row) return new Response("no cloudflare identity stored yet", { status: 404 });
      const accessToken = await decryptSecret(env, row.access_token_enc);
      const [userinfoResp, apiUserResp] = await Promise.all([
        fetch("https://dash.cloudflare.com/oauth2/userinfo", { headers: { authorization: `Bearer ${accessToken}` } }),
        fetch("https://api.cloudflare.com/client/v4/user", { headers: { authorization: `Bearer ${accessToken}` } }),
      ]);
      const [userinfoText, apiUserText] = await Promise.all([userinfoResp.text(), apiUserResp.text()]);
      return new Response(
        `GET /oauth2/userinfo -> ${userinfoResp.status}\n${userinfoText}\n\nGET /client/v4/user -> ${apiUserResp.status}\n${apiUserText}`,
        { headers: { "content-type": "text/plain" } },
      );
    }

    const webResponse = await handleWebRequest(req, env);
    if (webResponse) return webResponse;

    const repoName = "proof-" + Date.now();
    const steps: Record<string, unknown> = {};
    try {
      const created = await env.ARTIFACTS.create(repoName, { setDefaultBranch: "main" });
      steps.created = { name: created.name, remote: created.remote };
      const token = tokenString(created.token);

      const fs = createMemFs();
      const dir = "/repo";
      await git.init({ fs, dir, defaultBranch: "main" });
      const blobOid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode("hello from a real Worker\n") });
      const treeOid = await git.writeTree({ fs, dir, tree: [{ mode: "100644", path: "README.md", oid: blobOid, type: "blob" }] });
      const person = { name: "zz-worker", email: "zz-worker@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
      const commitOid = await git.writeCommit({ fs, dir, commit: { message: "seed from Worker", tree: treeOid, parent: [], author: person, committer: person } });
      await git.writeRef({ fs, dir, ref: "refs/heads/main", value: commitOid, force: true });
      const onAuth = () => ({ username: "x-token-auth", password: token });
      const pushResult = await git.push({ fs, http, dir, url: created.remote, onAuth, ref: "main", remoteRef: "main" });
      steps.push = pushResult;

      const repo = await env.ARTIFACTS.get(repoName);
      const log = await repo.log({ ref: "main", limit: 5 });
      steps.log = log;
      const nativeCommit = await repo.readCommit(commitOid);
      const nativeTree = nativeCommit ? await repo.readTree(nativeCommit.treeHash) : null;
      const nativeBlob = nativeTree ? await repo.readBlob(nativeTree[0].hash) : null;
      steps.nativeRead = { blobText: nativeBlob ? await nativeBlob.text() : null };

      await env.ARTIFACTS.delete(repoName);
      steps.cleanedUp = true;
      return Response.json({ ok: true, steps });
    } catch (err) {
      await env.ARTIFACTS.delete(repoName).catch(() => {});
      return Response.json({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err), steps }, { status: 500 });
    }
  },
};
