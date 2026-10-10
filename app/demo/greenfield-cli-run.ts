// numkit-cli: a real consumer of numkit, exercising the cross-repo side
// of the greenfield test. Usage: tsx demo/greenfield-cli-run.ts <step>
import { submitIncrement, AUTHOR } from "./greenfield.js";
import type { Rung } from "../engine/ladder.js";

const SLUG = "zz-demo/numkit-cli";

const PACKAGE_JSON_V1 = JSON.stringify(
  {
    name: "numkit-cli",
    version: "0.1.0",
    description: "A command-line wrapper over numkit.",
    type: "module",
    bin: { "numkit-cli": "./cli.js" },
    dependencies: { numkit: "file:../numkit" },
    scripts: { test: "node --test" },
  },
  null,
  2,
) + "\n";

const CLI_JS_V1 = `#!/usr/bin/env node
import { clamp } from "numkit";

export function run(argv) {
  const [command, ...args] = argv;
  if (command === "clamp") {
    const [value, min, max] = args.map(Number);
    return String(clamp(value, min, max));
  }
  throw new Error(\`Unknown command: \${command}\`);
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  console.log(run(process.argv.slice(2)));
}
`;

const CLI_TEST_JS_V1 = `import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./cli.js";

test("clamp command clamps into range", () => {
  assert.equal(run(["clamp", "15", "0", "10"]), "10");
});

test("clamp command passes through in-range values", () => {
  assert.equal(run(["clamp", "5", "0", "10"]), "5");
});

test("unknown command throws", () => {
  assert.throws(() => run(["nope"]), /Unknown command/);
});
`;

async function step1_clampCommand() {
  const fileRung = (path: string, summary: string, commitOid: string): Rung => ({
    path,
    kind: "file",
    summary,
    sources: [{ kind: "commit", ref: commitOid, title: "Implement the clamp command", author: AUTHOR.name, at: new Date().toISOString() }],
    children: [],
  });

  const { commitOid } = await submitIncrement(SLUG, {
    laneId: "implement-clamp-command",
    name: "implement clamp command",
    objective: "A CLI wrapper over numkit's clamp(): `numkit-cli clamp <value> <min> <max>`.",
    scope: ["cli.js", "cli.test.js", "package.json"],
    files: [
      { path: "package.json", content: PACKAGE_JSON_V1 },
      { path: "cli.js", content: CLI_JS_V1 },
      { path: "cli.test.js", content: CLI_TEST_JS_V1 },
    ],
    message: "Implement the clamp command",
    buildLadderRungs: (commitOid) => [
      fileRung("package.json", "The npm manifest for numkit-cli, a command-line wrapper over numkit. Depends on numkit via a local file: path (not yet published). Exposes a `numkit-cli` bin pointing at cli.js.", commitOid),
      fileRung("cli.js", "The CLI entry point. Exports run(argv) for testing, and invokes it against process.argv when run directly. Currently supports one command: `clamp <value> <min> <max>`, delegating to numkit's clamp().", commitOid),
      fileRung("cli.test.js", "Tests for the CLI's clamp command: an out-of-range value gets clamped, an in-range value passes through, and an unrecognized command throws.", commitOid),
    ],
  });
  console.log("step1_clampCommand committed:", commitOid);
}

const PACKAGE_JSON_V2 = JSON.stringify(
  {
    name: "numkit-cli",
    version: "0.2.0",
    description: "A command-line wrapper over numkit.",
    type: "module",
    bin: { "numkit-cli": "./cli.js" },
    dependencies: { numkit: "file:../numkit" },
    scripts: { test: "node --test" },
  },
  null,
  2,
) + "\n";

const CLI_JS_V2 = `#!/usr/bin/env node
import { clamp, average } from "numkit";

export function run(argv) {
  const [command, ...args] = argv;
  if (command === "clamp") {
    const [value, min, max] = args.map(Number);
    return String(clamp(value, min, max));
  }
  if (command === "average") {
    return String(average(args.map(Number)));
  }
  throw new Error(\`Unknown command: \${command}\`);
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  console.log(run(process.argv.slice(2)));
}
`;

const CLI_TEST_JS_V2 = `import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./cli.js";

test("clamp command clamps into range", () => {
  assert.equal(run(["clamp", "15", "0", "10"]), "10");
});

test("clamp command passes through in-range values", () => {
  assert.equal(run(["clamp", "5", "0", "10"]), "5");
});

test("average command averages its arguments", () => {
  assert.equal(run(["average", "1", "2", "3"]), "2");
});

test("unknown command throws", () => {
  assert.throws(() => run(["nope"]), /Unknown command/);
});
`;

async function step2_averageCommand() {
  const fileRung = (path: string, summary: string, commitOid: string): Rung => ({
    path,
    kind: "file",
    summary,
    sources: [{ kind: "commit", ref: commitOid, title: "Add the average command", author: AUTHOR.name, at: new Date().toISOString() }],
    children: [],
  });

  const { commitOid } = await submitIncrement(SLUG, {
    laneId: "implement-average-command",
    name: "implement average command",
    objective: "Add `numkit-cli average <n1> <n2> ...`, delegating to numkit's average().",
    scope: ["cli.js", "cli.test.js", "package.json"],
    files: [
      { path: "package.json", content: PACKAGE_JSON_V2 },
      { path: "cli.js", content: CLI_JS_V2 },
      { path: "cli.test.js", content: CLI_TEST_JS_V2 },
    ],
    message: "Add the average command",
    buildLadderRungs: (commitOid) => [
      fileRung("package.json", "The npm manifest for numkit-cli, now at 0.2.0 with the average command added. Depends on numkit via a local file: path.", commitOid),
      fileRung("cli.js", "The CLI entry point. Supports two commands: `clamp <value> <min> <max>` and `average <n1> <n2> ...`, both delegating directly to numkit. average's empty-input behavior is whatever numkit's average() does -- not yet specifically handled or tested at the CLI level.", commitOid),
      fileRung("cli.test.js", "Tests for both CLI commands: clamp in and out of range, average over a few numbers, and an unrecognized command throwing. No empty-input case for average yet.", commitOid),
    ],
  });
  console.log("step2_averageCommand committed:", commitOid);
}

const CLI_JS_V3 = `#!/usr/bin/env node
import { clamp, average } from "numkit";

export function run(argv) {
  const [command, ...args] = argv;
  if (command === "clamp") {
    const [value, min, max] = args.map(Number);
    return String(clamp(value, min, max));
  }
  if (command === "average") {
    return String(average(args.map(Number)));
  }
  throw new Error(\`Unknown command: \${command}\`);
}

// numkit's average() now throws RangeError on empty input (it used to
// silently return NaN) -- without this, that surfaced as a raw,
// unfriendly stack trace instead of a clean CLI error.
export function main(argv) {
  try {
    return { ok: true, output: run(argv) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const result = main(process.argv.slice(2));
  if (result.ok) {
    console.log(result.output);
  } else {
    console.error(\`error: \${result.message}\`);
    process.exit(1);
  }
}
`;

const CLI_TEST_JS_V3 = `import { test } from "node:test";
import assert from "node:assert/strict";
import { run, main } from "./cli.js";

test("clamp command clamps into range", () => {
  assert.equal(run(["clamp", "15", "0", "10"]), "10");
});

test("average command averages its arguments", () => {
  assert.equal(run(["average", "1", "2", "3"]), "2");
});

test("unknown command throws", () => {
  assert.throws(() => run(["nope"]), /Unknown command/);
});

// Regression test for numkit's fix-average-empty: average([]) used to
// return NaN silently; now it throws, and the CLI must surface that as
// a clean error instead of an unhandled exception.
test("average with no numbers reports a clean error, not a crash", () => {
  const result = main(["average"]);
  assert.equal(result.ok, false);
  assert.match(result.message, /must not be empty/);
});
`;

async function step3_cleanErrorHandling() {
  const fileRung = (path: string, summary: string, commitOid: string): Rung => ({
    path,
    kind: "file",
    summary,
    sources: [{ kind: "commit", ref: commitOid, title: "Handle numkit's average() empty-input error cleanly", author: AUTHOR.name, at: new Date().toISOString() }],
    children: [],
  });

  const { commitOid } = await submitIncrement(SLUG, {
    laneId: "cli-clean-error-handling",
    name: "handle average's empty-input error cleanly",
    objective: "numkit's average() now throws RangeError for empty input instead of silently returning NaN. Running `numkit-cli average` with no numbers surfaced that as a raw stack trace. Catch it and print a clean CLI error instead.",
    scope: ["cli.js", "cli.test.js"],
    // This Lane exists because of numkit's own fix -- a real cross-repo
    // dependency, not just this repo's own history. origin points
    // directly at that upstream Lane rather than numkit-cli's own
    // _repo, the same cross-repo mechanism the project's cascade design
    // has described from the start.
    origin: { repo: "zz-demo/numkit", lane: "fix-average-empty" },
    files: [
      { path: "cli.js", content: CLI_JS_V3 },
      { path: "cli.test.js", content: CLI_TEST_JS_V3 },
    ],
    message: "Handle numkit's average() empty-input error cleanly",
    buildLadderRungs: (commitOid) => [
      fileRung(
        "cli.js",
        "The CLI entry point. Adds main(argv), which wraps run() in a try/catch and returns {ok, output} or {ok: false, message} instead of letting an error escape as a raw stack trace -- specifically needed once numkit's average() started throwing RangeError on empty input instead of silently returning NaN.",
        commitOid,
      ),
      fileRung("cli.test.js", "Tests for both commands plus a regression test (tied to numkit's fix-average-empty) confirming `numkit-cli average` with no numbers reports a clean error instead of crashing with a stack trace.", commitOid),
    ],
  });
  console.log("step3_cleanErrorHandling committed:", commitOid);
}

const PACKAGE_JSON_V4 = JSON.stringify(
  {
    name: "numkit-cli",
    version: "0.4.0",
    description: "A command-line wrapper over numkit.",
    type: "module",
    bin: { "numkit-cli": "./cli.js" },
    dependencies: { numkit: "^0.3.0" },
    scripts: { test: "node --test" },
  },
  null,
  2,
) + "\n";

const CLI_JS_V4 = `#!/usr/bin/env node
import { clamp, average, isPrime } from "numkit";

export function run(argv) {
  const [command, ...args] = argv;
  if (command === "clamp") {
    const [value, min, max] = args.map(Number);
    return String(clamp(value, min, max));
  }
  if (command === "average") {
    return String(average(args.map(Number)));
  }
  if (command === "isprime") {
    return String(isPrime(Number(args[0])));
  }
  throw new Error(\`Unknown command: \${command}\`);
}

export function main(argv) {
  try {
    return { ok: true, output: run(argv) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const result = main(process.argv.slice(2));
  if (result.ok) {
    console.log(result.output);
  } else {
    console.error(\`error: \${result.message}\`);
    process.exit(1);
  }
}
`;

const CLI_TEST_JS_V4 = `import { test } from "node:test";
import assert from "node:assert/strict";
import { run, main } from "./cli.js";

test("clamp command clamps into range", () => {
  assert.equal(run(["clamp", "15", "0", "10"]), "10");
});

test("average command averages its arguments", () => {
  assert.equal(run(["average", "1", "2", "3"]), "2");
});

test("isprime command reports primality", () => {
  assert.equal(run(["isprime", "17"]), "true");
  assert.equal(run(["isprime", "18"]), "false");
});

test("unknown command throws", () => {
  assert.throws(() => run(["nope"]), /Unknown command/);
});

test("average with no numbers reports a clean error, not a crash", () => {
  const result = main(["average"]);
  assert.equal(result.ok, false);
  assert.match(result.message, /must not be empty/);
});
`;

async function step4_isPrimeCommand() {
  const fileRung = (path: string, summary: string, commitOid: string): Rung => ({
    path,
    kind: "file",
    summary,
    sources: [{ kind: "commit", ref: commitOid, title: "Add the isprime command", author: AUTHOR.name, at: new Date().toISOString() }],
    children: [],
  });

  const { commitOid } = await submitIncrement(SLUG, {
    laneId: "implement-isprime-command",
    name: "implement isprime command",
    objective: "Add `numkit-cli isprime <n>`, delegating to numkit's isPrime(). Bumps the numkit dependency from a local file: path to a real version range (^0.3.0), now that numkit has a real version with everything this CLI uses.",
    scope: ["cli.js", "cli.test.js", "package.json"],
    files: [
      { path: "package.json", content: PACKAGE_JSON_V4 },
      { path: "cli.js", content: CLI_JS_V4 },
      { path: "cli.test.js", content: CLI_TEST_JS_V4 },
    ],
    message: "Add the isprime command",
    buildLadderRungs: (commitOid) => [
      fileRung("package.json", "The npm manifest for numkit-cli, now at 0.4.0. Depends on numkit ^0.3.0 -- switched from a local file: path now that numkit has a real published-style version covering everything this CLI uses (clamp, average, isPrime).", commitOid),
      fileRung("cli.js", "The CLI entry point. Supports clamp, average, and isprime, all delegating to numkit, with main(argv) wrapping run() to report errors cleanly rather than crashing.", commitOid),
      fileRung("cli.test.js", "Tests for all three commands plus the average-empty-input regression test.", commitOid),
    ],
  });
  console.log("step4_isPrimeCommand committed:", commitOid);
}

const step = process.argv[2];
const steps: Record<string, () => Promise<void>> = {
  "clamp-command": step1_clampCommand,
  "average-command": step2_averageCommand,
  "clean-error-handling": step3_cleanErrorHandling,
  "isprime-command": step4_isPrimeCommand,
};
if (!step || !steps[step]) {
  console.error("usage: tsx demo/greenfield-cli-run.ts <" + Object.keys(steps).join("|") + ">");
  process.exit(1);
}
await steps[step]();
