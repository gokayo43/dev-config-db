import { expect, test } from "bun:test";

import { checkout, decoy, ranStep } from "./action-step.ts";

/**
 * What the shipped serving steps do when the repository they are grading has
 * already had a turn.
 *
 * Each of these steps runs inside that repo's job, after its install scripts,
 * its build and its migrator. Two things they used to take from their
 * surroundings were that repo's to rewrite, and both ended the same way — the
 * step green, having graded nothing:
 *
 * - the working directory was the graded checkout, and `bun` runs a top-level
 *   `preload` from the `bunfig.toml` it finds there before the file it was
 *   given. `process.exit(0)` in that preload ends the step at zero. No
 *   hostility is needed: a legitimate preload injects the same way, and this
 *   very repo declares one under `[test]`;
 * - the interpreter came from a PATH the same steps can prepend to through
 *   `$GITHUB_PATH`, which replaces the gate with a program that exits 0.
 *
 * A green step is therefore the failure in every case here, never the
 * expectation: each asserts the gate's own refusal, which is the proof its code
 * ran at all.
 */

const HOSTILE = {
  "bunfig.toml": 'preload = ["./silence.ts"]\n',
  "silence.ts": "process.exit(0);\n",
};

const PINNED = { bun: process.execPath, path: process.env["PATH"] ?? "" };

/** The boot step with no command in it: its own refusal, and the marker that it ran. */
const BOOT = {
  "working-directory": ".",
  "start-command": "",
  "health-url": "http://127.0.0.1:65535/health",
  ...PINNED,
};
const BOOT_REFUSES = "::error::start-command is empty";

/** The probe step with a bound and nothing to bound. */
const PROBE = {
  "working-directory": ".",
  "probe-command": "",
  "probe-timeout": "30",
  "health-url": "http://127.0.0.1:65535/health",
  ...PINNED,
};
const PROBE_REFUSES = "there is no probe here for it to bound";

test("the boot step reaches its verdict in a checkout it was not run from", async () => {
  const ran = await ranStep("db-serving", "Boot", { inputs: BOOT, workspace: await checkout() });

  expect(ran.output).toContain(BOOT_REFUSES);
  expect(ran.status).toBe(1);
});

test("a preload in the graded checkout cannot silence the boot step", async () => {
  const ran = await ranStep("db-serving", "Boot", {
    inputs: BOOT,
    workspace: await checkout(HOSTILE),
  });

  expect(ran.output).toContain(BOOT_REFUSES);
  expect(ran.status).toBe(1);
});

test("a bun the graded repo put on PATH cannot replace the boot step's interpreter", async () => {
  const ran = await ranStep("db-serving", "Boot", {
    inputs: BOOT,
    workspace: await checkout(),
    path: await decoy("bun"),
  });

  expect(ran.output).toContain(BOOT_REFUSES);
  expect(ran.status).toBe(1);
});

test("a preload in the graded checkout cannot silence the probe step", async () => {
  const ran = await ranStep("db-serving", "probe", {
    inputs: PROBE,
    workspace: await checkout(HOSTILE),
  });

  expect(ran.output).toContain(PROBE_REFUSES);
  expect(ran.status).toBe(1);
});

test("a bun the graded repo put on PATH cannot replace the probe step's interpreter", async () => {
  const ran = await ranStep("db-serving", "probe", {
    inputs: PROBE,
    workspace: await checkout(),
    path: await decoy("bun"),
  });

  expect(ran.output).toContain(PROBE_REFUSES);
  expect(ran.status).toBe(1);
});

/**
 * `required: true` on a composite action's input is a promise nothing enforces:
 * a caller who omits one gets the empty string, and an empty interpreter is a
 * `command not found` naming nothing. Both pins are refused by name instead.
 */
test("a step refuses to run without the interpreter its caller pins", async () => {
  const ran = await ranStep("db-serving", "Boot", {
    inputs: { ...BOOT, bun: "" },
    workspace: await checkout(),
  });

  expect(ran.output).toContain("::error::the bun input is empty");
  expect(ran.status).toBe(1);
});

test("a step refuses to run without the search path its caller pins", async () => {
  const ran = await ranStep("db-serving", "Boot", {
    inputs: { ...BOOT, path: "" },
    workspace: await checkout(),
  });

  expect(ran.output).toContain("::error::the path input is empty");
  expect(ran.status).toBe(1);
});
