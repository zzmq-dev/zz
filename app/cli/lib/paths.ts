// Normalizes a user-supplied path (an env var value -- ZZ_CONFIG,
// ZZ_CREDENTIALS, ZZ_ID_FILE -- or a future path-taking flag) to an
// absolute path. Node's fs functions resolve a relative path against
// process.cwd() silently and don't expand "~" at all, so without this a
// value like "~/my-config.json" would be read literally as a directory
// named "~" next to wherever the command happened to be run from,
// rather than the user's home directory. Internal paths this CLI
// computes itself (e.g. cli/lib/repo.ts's `~/.zz/repos/...`) are
// already absolute by construction (join() against homedir()) and
// don't need this -- it's specifically for normalizing input a user
// typed on the command line or in their environment.
import { homedir } from "node:os";
import { resolve } from "node:path";

export function resolveUserPath(input: string): string {
  const expanded = input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input;
  return resolve(expanded);
}
