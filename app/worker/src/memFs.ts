// A minimal in-memory filesystem implementing exactly the subset of
// node:fs's promise API isomorphic-git needs (readFile/writeFile/
// unlink/readdir/mkdir/rmdir/stat/lstat/readlink/symlink) -- Workers
// have no real filesystem at all, so this exists purely so
// isomorphic-git has *something* to write its git objects into before
// pushing them. Nothing here persists between requests; each call
// site creates a fresh one, writes only the handful of objects a
// single commit needs (the git_minimal_push approach -- see
// site/content/remote-backend/index.md), and pushes immediately.
interface Node {
  isDir: boolean;
  content?: Uint8Array;
  mtimeMs: number;
}

function normalize(path: string): string {
  const parts = path.split("/").filter((p) => p && p !== ".");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function dirname(path: string): string {
  const n = normalize(path);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}

export function createMemFs() {
  const nodes = new Map<string, Node>();
  nodes.set("/", { isDir: true, mtimeMs: Date.now() });

  function ensureParentDirs(path: string): void {
    let dir = dirname(path);
    const toCreate: string[] = [];
    while (dir !== "/" && !nodes.has(dir)) {
      toCreate.push(dir);
      dir = dirname(dir);
    }
    for (const d of toCreate.reverse()) nodes.set(d, { isDir: true, mtimeMs: Date.now() });
  }

  const promises = {
    async readFile(path: string, opts?: { encoding?: string } | string): Promise<Uint8Array | string> {
      const n = nodes.get(normalize(path));
      if (!n || n.isDir || !n.content) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      if (encoding === "utf8" || encoding === "utf-8") return new TextDecoder().decode(n.content);
      return n.content;
    },
    async writeFile(path: string, data: Uint8Array | string): Promise<void> {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      ensureParentDirs(path);
      nodes.set(normalize(path), { isDir: false, content: bytes, mtimeMs: Date.now() });
    },
    async unlink(path: string): Promise<void> {
      nodes.delete(normalize(path));
    },
    async readdir(path: string): Promise<string[]> {
      const p = normalize(path);
      const prefix = p === "/" ? "/" : p + "/";
      const names = new Set<string>();
      for (const key of nodes.keys()) {
        if (key === p || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        names.add(rest.split("/")[0]);
      }
      return [...names];
    },
    async mkdir(path: string): Promise<void> {
      ensureParentDirs(path);
      nodes.set(normalize(path), { isDir: true, mtimeMs: Date.now() });
    },
    async rmdir(path: string): Promise<void> {
      nodes.delete(normalize(path));
    },
    async stat(path: string) {
      const n = nodes.get(normalize(path));
      if (!n) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return statFrom(n);
    },
    async lstat(path: string) {
      return promises.stat(path);
    },
    async readlink(): Promise<string> {
      throw new Error("symlinks not supported in memFs");
    },
    async symlink(): Promise<void> {
      throw new Error("symlinks not supported in memFs");
    },
    async chmod(): Promise<void> {
      // no-op -- isomorphic-git calls this but this fs has no real permission bits
    },
  };

  function statFrom(n: Node) {
    return {
      isFile: () => !n.isDir,
      isDirectory: () => n.isDir,
      isSymbolicLink: () => false,
      size: n.content?.byteLength ?? 0,
      mtimeMs: n.mtimeMs,
      mode: n.isDir ? 0o040000 : 0o100644,
    };
  }

  return { promises };
}
