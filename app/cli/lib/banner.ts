// The ASCII banner and version-reading logic, shared between zz.ts
// (--version/--help) and any command that wants to print the banner
// itself (work.ts's --stdio mode, so a headless log capture still
// opens with something identifying what produced it).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Reads package.json's own version rather than a hardcoded literal --
// `npm version` is the one standard place a release bump happens, so
// this is the one place that reads it back, instead of a second
// string that's easy to forget to update alongside it. Walks upward
// (not a fixed relative offset) because this file sits at a different
// depth relative to the package root in dev (cli/lib/banner.ts) vs.
// built (dist/cli/lib/banner.js) -- a fixed offset would be right for
// only one of the two.
export function readOwnVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "package.json");
    try {
      return (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version ?? "0.0.0";
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return "0.0.0"; // reached filesystem root -- shouldn't happen, fail soft
      dir = parent;
    }
  }
}

export const version = readOwnVersion();

// The "v2.0.0"/"v0.1.0" tokens are the one place a real version gets
// spliced in -- everything else here is verbatim ASCII art, not a
// generated/figlet call, so it always renders pixel-for-pixel the same
// regardless of terminal font. WIDE_BANNER uses String.raw so every
// backslash is taken literally (no escaping needed to match the art
// exactly); NARROW_BANNER can't use String.raw -- its own art uses
// literal backtick characters, which still need escaping to not
// terminate the template literal early regardless of the raw tag, so
// it's a plain template literal with just those two backticks escaped.
export const WIDE_BANNER = String.raw`
__/\\\\\\\\\\\__/\\\\\\\\\\\___________________
 _\///////\\\/__\///////\\\/____________________
  ______/\\\/_________/\\\/___________v2.0.0_____
   ____/\\\/_________/\\\/________________________
    __/\\\\\\\\\\\__/\\\\\\\\\\\__/\\\\\\\\\\\\\\\_
     _\///////////__\///////////__\///////////////__`.replace("v2.0.0", `v${version}`);

// Shown instead of WIDE_BANNER whenever the terminal is narrower than
// 55 columns -- the wide art simply doesn't fit at common small
// terminal sizes.
export const NARROW_BANNER = `
[_  ,[__  ,
 / /   / /
/ /__ / /__ __v0.1.0__
\`----'\`----'----------'`.replace("v0.1.0", `v${version}`);

// No column-width signal at all (piped output, not a real TTY) keeps
// the wide banner as the default -- same as the current behavior
// before this existed, and --simple already exists for automation that
// wants neither.
export const BANNER = (process.stdout.columns ?? 9999) < 55 ? NARROW_BANNER : WIDE_BANNER;
