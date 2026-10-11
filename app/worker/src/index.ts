// Minimal proof-of-mechanism Worker -- step 2 of
// site/content/remote-backend/index.md's build sequencing: "just
// enough of the interface implemented to clone a real repo into a
// real Artifacts repo and read it back." Not the real MaintainerDO
// yet, just confirming the two previously-unverified things actually
// work *inside workerd*, not just in plain Node: the native
// ARTIFACTS binding's read methods, and an isomorphic-git write+push
// using an in-memory fs (no node:fs exists here).
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createMemFs } from "./memFs.js";
import { MaintainerDO } from "./MaintainerDO.js";
import { commitChangesetOnArtifacts, readFileAtCommit } from "./cloudflareGitBackend.js";
import { writeRung, readRung } from "./cloudflareLadderBackend.js";

export { MaintainerDO };

interface Env {
  ARTIFACTS: {
    create(name: string, opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string }): Promise<{ name: string; remote: string; defaultBranch: string; token: { plaintext: string; expiresAt?: string } | string }>;
    get(name: string): Promise<ArtifactsRepo>;
    delete(name: string): Promise<boolean>;
  };
  MAINTAINER_DO: DurableObjectNamespace<MaintainerDO>;
}

interface ArtifactsCommit {
  hash: string;
  treeHash: string;
  message: string;
  parents: string[];
}

interface ArtifactsRepo extends Disposable {
  info(): Promise<unknown>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt?: string }>;
  readCommit(hash: string): Promise<ArtifactsCommit | null>;
  readTree(hash: string): Promise<{ name: string; hash: string; type: string; mode: string }[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number }): Promise<ArtifactsCommit[]>;
}

function tokenString(token: { plaintext: string } | string): string {
  return typeof token === "string" ? token.split("?")[0] : token.plaintext;
}

async function testMaintainerDo(env: Env): Promise<Response> {
  const steps: Record<string, unknown> = {};
  try {
    const id = env.MAINTAINER_DO.idFromName("zz-demo/do-test");
    const stub = env.MAINTAINER_DO.get(id);

    const lane = await stub.proposeLane({ id: "_repo", repo: "zz-demo/do-test", name: "do-test", objective: "prove Lane storage on a real DO", scope: ["**"], proposedBy: "zz-worker-test" });
    steps.proposedLane = lane;

    const workAsk = await stub.ask(lane.id, { kind: "work", from: "human", payload: { description: "prove the round trip" } });
    steps.postedAsk = workAsk;

    const claim = await stub.ask(lane.id, { kind: "claim_request", from: "zz-worker-test", payload: { target: workAsk.id } });
    await stub.answer(lane.id, claim, { from: "zz-worker-test", action: "grant" });
    steps.claimed = true;

    const finalAnswer = await stub.answer(lane.id, workAsk, { from: "zz-worker-test", action: "complete", payload: { result: "done, for real, on a Durable Object" } });
    steps.answered = finalAnswer;

    const readBack = await stub.readLane(lane.id);
    steps.readBack = readBack;

    return Response.json({ ok: true, steps });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err), steps }, { status: 500 });
  }
}

async function testChangesetCommit(env: Env): Promise<Response> {
  const repoName = "changeset-proof-" + Date.now();
  const steps: Record<string, unknown> = {};
  try {
    // Seed with two files via a plain push, same as step 2.
    const created = await env.ARTIFACTS.create(repoName, { setDefaultBranch: "main" });
    const fs = createMemFs();
    const dir = "/seed";
    await git.init({ fs, dir, defaultBranch: "main" });
    const aOid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode("export { clamp } from \"./clamp.js\";\n") });
    const bOid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode("export function clamp(v,min,max){return Math.min(Math.max(v,min),max);}\n") });
    const seedTree = await git.writeTree({ fs, dir, tree: [{ mode: "100644", path: "index.js", oid: aOid, type: "blob" }, { mode: "100644", path: "clamp.js", oid: bOid, type: "blob" }] });
    const person = { name: "seed", email: "seed@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
    const seedCommitOid = await git.writeCommit({ fs, dir, commit: { message: "seed", tree: seedTree, parent: [], author: person, committer: person } });
    await git.writeRef({ fs, dir, ref: "refs/heads/main", value: seedCommitOid, force: true });
    const seedToken = tokenString(created.token);
    await git.push({ fs, http, dir, url: created.remote, onAuth: () => ({ username: "x-token-auth", password: seedToken }), ref: "main", remoteRef: "main" });
    steps.seeded = seedCommitOid;

    using repo = await env.ARTIFACTS.get(repoName);

    // Now commit a changeset via the no-clone path -- only touches
    // index.js; clamp.js must survive untouched via native re-fetch.
    const newToken = await repo.createToken("write", 3600);
    const commitOid = await commitChangesetOnArtifacts(
      repoName,
      created.remote,
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
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err), steps }, { status: 500 });
  }
}

async function testDoChangeset(env: Env): Promise<Response> {
  const repoName = "do-changeset-proof-" + Date.now();
  const steps: Record<string, unknown> = {};
  try {
    const created = await env.ARTIFACTS.create(repoName, { setDefaultBranch: "main" });
    const fs = createMemFs();
    const dir = "/seed";
    await git.init({ fs, dir, defaultBranch: "main" });
    const blobOid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode("one\n") });
    const treeOid = await git.writeTree({ fs, dir, tree: [{ mode: "100644", path: "a.txt", oid: blobOid, type: "blob" }] });
    const person = { name: "seed", email: "seed@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
    const seedCommitOid = await git.writeCommit({ fs, dir, commit: { message: "seed", tree: treeOid, parent: [], author: person, committer: person } });
    await git.writeRef({ fs, dir, ref: "refs/heads/main", value: seedCommitOid, force: true });
    await git.push({ fs, http, dir, url: created.remote, onAuth: () => ({ username: "x-token-auth", password: tokenString(created.token) }), ref: "main", remoteRef: "main" });

    const id = env.MAINTAINER_DO.idFromName("zz-demo/" + repoName);
    const stub = env.MAINTAINER_DO.get(id);
    const commitOid = await stub.commitChangeset(repoName, created.remote, { files: [{ path: "b.txt", content: "two\n" }], message: "add b.txt via the DO", author: { name: "zz-do", email: "zz-do@local" } });
    steps.commitOid = commitOid;
    steps.aTxt = await stub.readFileAtCommit(repoName, commitOid, "a.txt");
    steps.bTxt = await stub.readFileAtCommit(repoName, commitOid, "b.txt");

    await env.ARTIFACTS.delete(repoName);
    steps.cleanedUp = true;
    return Response.json({ ok: true, steps });
  } catch (err) {
    await env.ARTIFACTS.delete(repoName).catch(() => {});
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err), steps }, { status: 500 });
  }
}

async function testLadder(env: Env): Promise<Response> {
  const repoName = "ladder-proof-" + Date.now();
  const steps: Record<string, unknown> = {};
  try {
    const created = await env.ARTIFACTS.create(repoName, { setDefaultBranch: "main" });
    const fs = createMemFs();
    const dir = "/seed";
    await git.init({ fs, dir, defaultBranch: "main" });
    const blobOid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode("export function clamp(v,min,max){return Math.min(Math.max(v,min),max);}\n") });
    const treeOid = await git.writeTree({ fs, dir, tree: [{ mode: "100644", path: "clamp.js", oid: blobOid, type: "blob" }] });
    const person = { name: "seed", email: "seed@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
    const seedCommitOid = await git.writeCommit({ fs, dir, commit: { message: "seed", tree: treeOid, parent: [], author: person, committer: person } });
    await git.writeRef({ fs, dir, ref: "refs/heads/main", value: seedCommitOid, force: true });
    const seedToken = tokenString(created.token);
    await git.push({ fs, http, dir, url: created.remote, onAuth: () => ({ username: "x-token-auth", password: seedToken }), ref: "main", remoteRef: "main" });
    steps.seeded = seedCommitOid;

    using repo = await env.ARTIFACTS.get(repoName);
    const writeToken = await repo.createToken("write", 3600);

    // Write a "file" rung (anchored to clamp.js's blob at HEAD).
    await writeRung(created.remote, writeToken, repo, {
      path: "clamp.js",
      kind: "file",
      summary: "Exports clamp(value, min, max).",
      sources: [{ kind: "commit", ref: seedCommitOid, title: "seed", author: "seed", at: new Date().toISOString() }],
      children: [],
    });
    steps.wroteFileRung = true;

    // Write a "changeset" rung (anchored to the commit itself) with an embedded filechange child.
    await writeRung(created.remote, writeToken, repo, {
      path: `changesets/${seedCommitOid}`,
      kind: "changeset",
      summary: "Initial seed commit.",
      sources: [{ kind: "commit", ref: seedCommitOid, title: "seed", author: "seed", at: new Date().toISOString() }],
      children: [
        {
          path: `changesets/${seedCommitOid}/clamp.js`,
          kind: "filechange",
          summary: "Added clamp.js.",
          sources: [{ kind: "commit", ref: seedCommitOid, title: "seed", author: "seed", at: new Date().toISOString() }],
          children: [],
        },
      ],
    });
    steps.wroteChangesetRung = true;

    // A SECOND file rung on the SAME notes ref ("code") as clamp.js's,
    // via a completely separate repo handle/token -- the real test of
    // whether the scoped-fetch-before-write actually prevents data
    // loss, not just that a single write works (which force:true
    // could satisfy even while silently clobbering).
    using repoForSecondWrite = await env.ARTIFACTS.get(repoName);
    const secondToken = await repoForSecondWrite.createToken("write", 3600);
    // Seed a second file on main so it has a real blob to anchor to.
    const fs2 = createMemFs();
    const dir2 = "/second";
    await git.init({ fs: fs2, dir: dir2, defaultBranch: "main" });
    await git.addRemote({ fs: fs2, dir: dir2, remote: "origin", url: created.remote });
    const fetchMain = await git.fetch({ fs: fs2, http, dir: dir2, remote: "origin", onAuth: () => ({ username: "x-token-auth", password: tokenString(secondToken) }), ref: "main", singleBranch: true, depth: 1 });
    await git.writeRef({ fs: fs2, dir: dir2, ref: "refs/heads/main", value: fetchMain.fetchHead!, force: true });
    const clampBlob = (await git.readTree({ fs: fs2, dir: dir2, oid: fetchMain.fetchHead!, filepath: "" })).tree.find((e) => e.path === "clamp.js")!.oid;
    const otherBlob = await git.writeBlob({ fs: fs2, dir: dir2, blob: new TextEncoder().encode("export function other(){}\n") });
    const newTree = await git.writeTree({ fs: fs2, dir: dir2, tree: [{ mode: "100644", path: "clamp.js", oid: clampBlob, type: "blob" }, { mode: "100644", path: "other.js", oid: otherBlob, type: "blob" }] });
    const personSecond = { name: "second", email: "second@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
    const secondCommitOid = await git.writeCommit({ fs: fs2, dir: dir2, commit: { message: "add other.js", tree: newTree, parent: [fetchMain.fetchHead!], author: personSecond, committer: personSecond } });
    await git.writeRef({ fs: fs2, dir: dir2, ref: "refs/heads/main", value: secondCommitOid, force: true });
    await git.push({ fs: fs2, http, dir: dir2, url: created.remote, onAuth: () => ({ username: "x-token-auth", password: tokenString(secondToken) }), ref: "main", remoteRef: "main" });

    using repoForSecondRung = await env.ARTIFACTS.get(repoName);
    const thirdToken = await repoForSecondRung.createToken("write", 3600);
    await writeRung(created.remote, thirdToken, repoForSecondRung, {
      path: "other.js",
      kind: "file",
      summary: "Exports other().",
      sources: [{ kind: "commit", ref: secondCommitOid, title: "add other.js", author: "second", at: new Date().toISOString() }],
      children: [],
    });
    steps.wroteSecondFileRung = true;

    // Read both back -- fresh repo handle, fresh scoped checkout, no shared state with the writes above.
    using repo2 = await env.ARTIFACTS.get(repoName);
    const readToken = await repo2.createToken("read", 3600);
    steps.readFileRung = await readRung(created.remote, readToken, repo2, "file", "clamp.js");
    steps.readSecondFileRung = await readRung(created.remote, readToken, repo2, "file", "other.js");
    steps.readChangesetRung = await readRung(created.remote, readToken, repo2, "changeset", `changesets/${seedCommitOid}`, seedCommitOid);

    await env.ARTIFACTS.delete(repoName);
    steps.cleanedUp = true;
    return Response.json({ ok: true, steps });
  } catch (err) {
    await env.ARTIFACTS.delete(repoName).catch(() => {});
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err), steps }, { status: 500 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname === "/do-test") return testMaintainerDo(env);
    if (new URL(req.url).pathname === "/ladder-test") return testLadder(env);
    if (new URL(req.url).pathname === "/changeset-test") return testChangesetCommit(env);
    if (new URL(req.url).pathname === "/do-changeset-test") return testDoChangeset(env);
    if (new URL(req.url).pathname === "/notes-native-test") {
      try {
        using repo = await env.ARTIFACTS.get("notes-test2");
        const info = await repo.info();
        const logMain = await repo.log({ ref: "main", limit: 5 });
        const logNotes1 = await repo.log({ ref: "notes/zz/ladder/code", limit: 5 });
        const logNotes2 = await repo.log({ ref: "refs/notes/zz/ladder/code", limit: 5 });
        return Response.json({ ok: true, info, logMain, logNotes1, logNotes2 });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }
    if (new URL(req.url).pathname === "/do-read") {
      const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName("zz-demo/do-test"));
      return Response.json({ lane: await stub.readLane("_repo") });
    }
    const repoName = "proof-" + Date.now();
    const steps: Record<string, unknown> = {};
    try {
      const created = await env.ARTIFACTS.create(repoName, { setDefaultBranch: "main" });
      steps.created = { name: created.name, remote: created.remote };
      const token = tokenString(created.token);

      // Seed one commit via push (nothing to read natively yet on a brand-new repo).
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

      // Now read it back via the NATIVE binding -- no isomorphic-git, no clone.
      steps.gettingRepo = "about to call env.ARTIFACTS.get";
      const repo = await env.ARTIFACTS.get(repoName);
      steps.gotRepo = true;
      const log = await repo.log({ ref: "main", limit: 5 });
      steps.log = log;
      const nativeCommit = await repo.readCommit(commitOid);
      steps.nativeCommitRaw = nativeCommit;
      const nativeTree = nativeCommit ? await repo.readTree(nativeCommit.treeHash) : null;
      steps.nativeTreeRaw = nativeTree;
      const nativeBlob = nativeTree ? await repo.readBlob(nativeTree[0].hash) : null;
      steps.nativeRead = {
        blobText: nativeBlob ? await nativeBlob.text() : null,
      };

      await env.ARTIFACTS.delete(repoName);
      steps.cleanedUp = true;

      return Response.json({ ok: true, steps });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err), steps }, { status: 500 });
    }
  },
};
