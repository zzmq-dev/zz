// Runs one real increment at a time. Usage: tsx demo/greenfield-run.ts <step-name>
import { submitIncrement, AUTHOR } from "./greenfield.js";
import type { Rung } from "../engine/ladder.js";

const SLUG = "zz-demo/numkit";

const CLAMP_JS = `export function clamp(value, min, max) {
  if (typeof value !== "number" || Number.isNaN(value)) return NaN;
  if (min > max) throw new RangeError("min must be <= max");
  return Math.min(Math.max(value, min), max);
}
`;

const CLAMP_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./clamp.js";

test("clamp keeps in-range values unchanged", () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test("clamp pulls values up to min", () => {
  assert.equal(clamp(-5, 0, 10), 0);
});

test("clamp pulls values down to max", () => {
  assert.equal(clamp(15, 0, 10), 10);
});

test("clamp returns NaN for NaN input", () => {
  assert.ok(Number.isNaN(clamp(NaN, 0, 10)));
});

test("clamp returns NaN for non-number input", () => {
  assert.ok(Number.isNaN(clamp("x", 0, 10)));
});

test("clamp throws when min > max", () => {
  assert.throws(() => clamp(5, 10, 0), RangeError);
});
`;

const INDEX_JS = `export { clamp } from "./clamp.js";
`;

const PACKAGE_JSON = JSON.stringify(
  {
    name: "numkit",
    version: "0.1.0",
    description: "Small, dependency-free numeric utilities.",
    type: "module",
    main: "index.js",
    scripts: { test: "node --test" },
  },
  null,
  2,
) + "\n";

async function step1_clamp() {
  const fileRung = (path: string, summary: string, commitOid: string): Rung => ({
    path,
    kind: "file",
    summary,
    sources: [{ kind: "commit", ref: commitOid, title: "Implement clamp(value, min, max)", author: AUTHOR.name, at: new Date().toISOString() }],
    children: [],
  });

  const { commitOid } = await submitIncrement(SLUG, {
    laneId: "implement-clamp",
    name: "implement clamp",
    objective: "Add a clamp(value, min, max) function: constrains a number to a range, returns NaN for non-numeric input.",
    scope: ["clamp.js", "clamp.test.js", "index.js", "package.json"],
    files: [
      { path: "package.json", content: PACKAGE_JSON },
      { path: "clamp.js", content: CLAMP_JS },
      { path: "clamp.test.js", content: CLAMP_TEST_JS },
      { path: "index.js", content: INDEX_JS },
    ],
    message: "Implement clamp(value, min, max)",
    buildLadderRungs: (commitOid) => [
      fileRung("package.json", "The npm manifest for numkit, a small dependency-free numeric utilities package. Entry point is index.js; tests run via `node --test`.", commitOid),
      fileRung("clamp.js", "Exports clamp(value, min, max), which constrains value to the [min, max] range. Returns NaN if value isn't a finite number (including NaN itself or a non-number); throws RangeError if min > max.", commitOid),
      fileRung("clamp.test.js", "Tests for clamp: in-range values pass through unchanged, out-of-range values are pulled to the nearest bound, non-numeric/NaN input returns NaN, and min > max throws.", commitOid),
      fileRung("index.js", "The package's entry point. Re-exports clamp from clamp.js.", commitOid),
    ],
  });
  console.log("step1_clamp committed:", commitOid);
}

const AVERAGE_JS = `export function average(numbers) {
  const sum = numbers.reduce((a, b) => a + b, 0);
  return sum / numbers.length;
}
`;

const AVERAGE_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { average } from "./average.js";

test("average of a few numbers", () => {
  assert.equal(average([1, 2, 3]), 2);
});

test("average of a single number is itself", () => {
  assert.equal(average([5]), 5);
});

test("average handles negative numbers", () => {
  assert.equal(average([-2, 2]), 0);
});
`;

const INDEX_JS_V2 = `export { clamp } from "./clamp.js";
export { average } from "./average.js";
`;

const PACKAGE_JSON_V2 = JSON.stringify(
  { name: "numkit", version: "0.2.0", description: "Small, dependency-free numeric utilities.", type: "module", main: "index.js", scripts: { test: "node --test" } },
  null,
  2,
) + "\n";

async function step2_average() {
  const fileRung = (path: string, summary: string, commitOid: string): Rung => ({
    path,
    kind: "file",
    summary,
    sources: [{ kind: "commit", ref: commitOid, title: "Add average(numbers)", author: AUTHOR.name, at: new Date().toISOString() }],
    children: [],
  });

  const { commitOid } = await submitIncrement(SLUG, {
    laneId: "implement-average",
    name: "implement average",
    objective: "Add an average(numbers) function: the arithmetic mean of an array of numbers.",
    scope: ["average.js", "average.test.js", "index.js", "package.json"],
    files: [
      { path: "package.json", content: PACKAGE_JSON_V2 },
      { path: "average.js", content: AVERAGE_JS },
      { path: "average.test.js", content: AVERAGE_TEST_JS },
      { path: "index.js", content: INDEX_JS_V2 },
    ],
    message: "Add average(numbers)",
    buildLadderRungs: (commitOid) => [
      fileRung("package.json", "The npm manifest for numkit, a small dependency-free numeric utilities package, now at 0.2.0 with the addition of average(). Entry point is index.js; tests run via `node --test`.", commitOid),
      fileRung(
        "average.js",
        "Exports average(numbers), the arithmetic mean of an array: sums with reduce and divides by length. Not yet guarded against an empty array -- that divides 0 by 0 and silently returns NaN rather than a clear error.",
        commitOid,
      ),
      fileRung("average.test.js", "Tests for average: a few positive numbers, a single-element array, and negative numbers summing to zero. No empty-array case yet.", commitOid),
      fileRung("index.js", "The package's entry point. Re-exports clamp from clamp.js and average from average.js.", commitOid),
    ],
  });
  console.log("step2_average committed:", commitOid);
}

const AVERAGE_JS_V2 = `export function average(numbers) {
  if (numbers.length === 0) throw new RangeError("average: numbers must not be empty");
  const sum = numbers.reduce((a, b) => a + b, 0);
  return sum / numbers.length;
}
`;

const AVERAGE_TEST_JS_V2 = `import { test } from "node:test";
import assert from "node:assert/strict";
import { average } from "./average.js";

test("average of a few numbers", () => {
  assert.equal(average([1, 2, 3]), 2);
});

test("average of a single number is itself", () => {
  assert.equal(average([5]), 5);
});

test("average handles negative numbers", () => {
  assert.equal(average([-2, 2]), 0);
});

test("average throws on an empty array instead of silently returning NaN", () => {
  assert.throws(() => average([]), RangeError);
});
`;

async function step3_averageEmptyFix() {
  const fileRung = (path: string, summary: string, commitOid: string): Rung => ({
    path,
    kind: "file",
    summary,
    sources: [{ kind: "commit", ref: commitOid, title: "Fix average([]) silently returning NaN", author: AUTHOR.name, at: new Date().toISOString() }],
    children: [],
  });

  const { commitOid } = await submitIncrement(SLUG, {
    laneId: "fix-average-empty",
    name: "fix average([])",
    objective: "average([]) currently divides 0 by 0 and silently returns NaN. Throw a clear RangeError instead.",
    scope: ["average.js", "average.test.js"],
    files: [
      { path: "average.js", content: AVERAGE_JS_V2 },
      { path: "average.test.js", content: AVERAGE_TEST_JS_V2 },
    ],
    message: "Fix average([]) silently returning NaN",
    buildLadderRungs: (commitOid) => [
      fileRung("average.js", "Exports average(numbers), the arithmetic mean of an array. Throws RangeError for an empty array instead of silently dividing 0 by 0 into NaN; otherwise sums with reduce and divides by length.", commitOid),
      fileRung("average.test.js", "Tests for average: a few positive numbers, a single-element array, negative numbers summing to zero, and (added in this fix) that an empty array throws RangeError rather than returning NaN.", commitOid),
    ],
  });
  console.log("step3_averageEmptyFix committed:", commitOid);
}

const ISPRIME_JS = `export function isPrime(n) {
  if (!Number.isInteger(n) || n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i * i <= n; i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}
`;

const ISPRIME_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrime } from "./isPrime.js";

test("small primes", () => {
  assert.equal(isPrime(2), true);
  assert.equal(isPrime(3), true);
  assert.equal(isPrime(17), true);
  assert.equal(isPrime(97), true);
});

test("small non-primes", () => {
  assert.equal(isPrime(4), false);
  assert.equal(isPrime(1), false);
  assert.equal(isPrime(100), false);
});

test("non-positive and non-integer input is not prime", () => {
  assert.equal(isPrime(0), false);
  assert.equal(isPrime(-5), false);
  assert.equal(isPrime(2.5), false);
});
`;

const INDEX_JS_V3 = `export { clamp } from "./clamp.js";
export { average } from "./average.js";
export { isPrime } from "./isPrime.js";
`;

const PACKAGE_JSON_V3 = JSON.stringify(
  { name: "numkit", version: "0.3.0", description: "Small, dependency-free numeric utilities.", type: "module", main: "index.js", scripts: { test: "node --test" } },
  null,
  2,
) + "\n";

async function step4_isPrime() {
  const fileRung = (path: string, summary: string, commitOid: string): Rung => ({
    path,
    kind: "file",
    summary,
    sources: [{ kind: "commit", ref: commitOid, title: "Add isPrime(n)", author: AUTHOR.name, at: new Date().toISOString() }],
    children: [],
  });

  const { commitOid } = await submitIncrement(SLUG, {
    laneId: "implement-isprime",
    name: "implement isPrime",
    objective: "Add an isPrime(n) function: true for integers >= 2 with no divisors other than 1 and themselves.",
    scope: ["isPrime.js", "isPrime.test.js", "index.js", "package.json"],
    files: [
      { path: "package.json", content: PACKAGE_JSON_V3 },
      { path: "isPrime.js", content: ISPRIME_JS },
      { path: "isPrime.test.js", content: ISPRIME_TEST_JS },
      { path: "index.js", content: INDEX_JS_V3 },
    ],
    message: "Add isPrime(n)",
    buildLadderRungs: (commitOid) => [
      fileRung("package.json", "The npm manifest for numkit, now at 0.3.0 with clamp, average, and isPrime. Entry point is index.js; tests run via `node --test`.", commitOid),
      fileRung("isPrime.js", "Exports isPrime(n): true for integers >= 2 with no divisors other than 1 and itself, checked by trial division up to sqrt(n), skipping even divisors after 2. False for non-integers, numbers below 2, and negatives.", commitOid),
      fileRung("isPrime.test.js", "Tests for isPrime: small primes, small non-primes, and non-positive/non-integer input (0, negatives, non-integers all false).", commitOid),
      fileRung("index.js", "The package's entry point. Re-exports clamp, average, and isPrime.", commitOid),
    ],
  });
  console.log("step4_isPrime committed:", commitOid);
}

const step = process.argv[2];
const steps: Record<string, () => Promise<void>> = { clamp: step1_clamp, average: step2_average, "fix-average-empty": step3_averageEmptyFix, isprime: step4_isPrime };
if (!step || !steps[step]) {
  console.error("usage: tsx demo/greenfield-run.ts <" + Object.keys(steps).join("|") + ">");
  process.exit(1);
}
await steps[step]();
