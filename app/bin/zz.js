#!/usr/bin/env node
// Thin bin entry so `zz` works the same whether run via `npm link`/global
// install or `npm run zz --`. Delegates straight to tsx against the real
// TypeScript source rather than requiring a separate build step.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, "..", "cli", "zz.ts");
const tsx = join(here, "..", "node_modules", ".bin", "tsx");

const result = spawnSync(tsx, [cliEntry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
