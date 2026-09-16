import { expect, test } from "bun:test";
import { join } from "node:path";

import { freePort, pidFileIn, startCommand } from "./app.ts";
import { entryPoints, ranEntryPoint } from "./entrypoint.ts";
import { materialise } from "./tree.ts";

/**
 * The lane that runs what GitHub runs.
 *
 * Every other suite here drives a gate's function and reads the `Verdict` it
 * answered with. That is the right subject for what a gate *decides* — and it
 * is blind to the one thing a step must also do, which is **end**. A gate whose
 * verdict is perfect and whose process never exits is a step that hangs until
 * the job's timeout with every later step skipped, and the suite that graded
 * the verdict is green.
 *
 * So each entry point is spawned as a process, under a wall clock, and the
 * assertion is that it came back. What it exited with is asserted where the
 * case knows; that it exited at all is asserted every time.
 */

const K6 = join(import.meta.dir, "fake-k6.ts");
const SUMMARY = join(import.meta.dir, "k6-summary.json");

/** A case per entry point, and the test below fails when the tree grows one this file has not been told about. */
const CASES = {
  // An account no image creates and an image that is never reached: the step
  // refuses the account before it asks docker anything, which is enough to prove
  // the process ends.
  "db-server/server.main.ts": async () => ({
    INPUT_DATABASE_IMAGE: "mariadb:11.4",
    INPUT_WORKSPACE: await materialise({}),
    DATABASE_URL: "mysql://app:db-gate@127.0.0.1/app",
  }),

  "db-replay/replay.main.ts": async () => ({
    // A project with no package.json, which the gate refuses before it opens a
    // connection — so this case needs no server to prove the process ends.
    INPUT_PROJECT: await materialise({}),
    INPUT_DATABASE_IMAGE: "mariadb:11.4",
    INPUT_FROM_EMPTY: join(await materialise({}), "from-empty.schema"),
    INPUT_REPLAYED: join(await materialise({}), "replayed.schema"),
    DATABASE_URL: "mysql://root:db-gate@127.0.0.1:13306/app",
  }),

  // A project that is no git repository at all, which the gate refuses while
  // establishing whether the checkout has history — enough to prove the process
  // ends without a server or a history to reach for.
  "db-upgrade/upgrade.main.ts": async () => ({
    INPUT_PROJECT: await materialise({}),
    INPUT_DATABASE_IMAGE: "mariadb:11.4",
    INPUT_UPGRADED: join(await materialise({}), "upgraded.schema"),
    INPUT_BASE_REF: "",
    INPUT_BEFORE: "",
    DATABASE_URL: "mysql://root:db-gate@127.0.0.1:13306/app",
  }),

  "db-datetime/datetime.main.ts": async () => ({
    // A database nothing is listening on: the gate opens a connection, fails to,
    // and says so through `entry`. What this case is about is that it comes
    // back — a gate that dies on a refused connection must still end the step.
    DATABASE_URL: "mysql://root:db-gate@127.0.0.1:13306/app",
    INPUT_DATETIME_ALLOWLIST: "",
  }),

  "db-serving/boot.main.ts": async () => {
    const project = await materialise({});
    const port = await freePort();
    return {
      INPUT_PROJECT: project,
      INPUT_START_COMMAND: startCommand(port, pidFileIn(project)),
      INPUT_HEALTH_URL: `http://127.0.0.1:${port}/health`,
      INPUT_APP_LOG: join(project, "server.log"),
    };
  },

  "db-serving/probe.main.ts": async () => {
    const project = await materialise({});
    return {
      INPUT_PROJECT: project,
      // A probe that forks a child which outlives the shell it was started
      // from: the bound fires, the group is killed, and the escapee is what a
      // run that never ends is holding onto.
      INPUT_PROBE_COMMAND: `sleep 45 & wait`,
      INPUT_PROBE_TIMEOUT: "1",
      INPUT_HEALTH_URL: "http://127.0.0.1:65535/health",
    };
  },

  "db-serving/ramp.main.ts": async () => {
    const project = await materialise({});
    const plan = join(project, "plan.json");
    await Bun.write(plan, JSON.stringify({ summary: SUMMARY }));
    return {
      INPUT_PROJECT: project,
      K6,
      INPUT_CAPACITY_SCRIPT: plan,
      INPUT_CAPACITY_PATH: "",
      INPUT_ROUTE_ALLOWLIST: "",
      INPUT_HEALTH_URL: "http://127.0.0.1:65535/health",
      INPUT_ROUTE_LOG_BEFORE: join(project, "before.json"),
      INPUT_ROUTE_LOG_AFTER: join(project, "after.json"),
      INPUT_SUMMARY_FILE: join(project, "capacity.json"),
      GITHUB_STEP_SUMMARY: join(project, "summary.md"),
    };
  },
} satisfies Record<string, () => Promise<Readonly<Record<string, string>>>>;

test("every entry point in the tree is run by this lane", async () => {
  // The list is read off the tree rather than written here, so a gate that
  // ships an entry point nobody ever executed is this test failing rather than
  // a reviewer noticing.
  expect(await entryPoints()).toEqual(Object.keys(CASES).toSorted());
});

for (const [main, setUp] of Object.entries(CASES)) {
  test(`${main} exits`, async () => {
    const ran = await ranEntryPoint(main, await setUp());

    expect(`${main} hung: ${ran.hung}`).toBe(`${main} hung: false`);
    // A step is its exit code, and every one of these has decided something by
    // the time it ends: 0 or 1, never a crash and never a signal.
    expect([0, 1]).toContain(ran.status);
  }, 30_000);
}

/**
 * The healthy boot, which is the run the gate as a whole is for — and the one
 * that hung, because a long-lived app the step deliberately leaves running is
 * exactly what keeps the step's own process alive.
 */
test("boot.main.ts exits 0 on the run that leaves the app serving", async () => {
  const project = await materialise({});
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/health`;
  const ran = await ranEntryPoint("db-serving/boot.main.ts", {
    INPUT_PROJECT: project,
    INPUT_START_COMMAND: startCommand(port, pidFileIn(project)),
    INPUT_HEALTH_URL: url,
    INPUT_APP_LOG: join(project, "server.log"),
  });

  expect(`hung: ${ran.hung}`).toBe("hung: false");
  expect(ran.status).toBe(0);
  expect(ran.output).toContain("::notice::boot: the app answered");
  // And the contract the step's own comment states: the probe and the ramp run
  // against this process in later steps, so it outlives the step that started
  // it.
  const still = await fetch(url, { signal: AbortSignal.timeout(5000) });
  expect(still.ok).toBe(true);
}, 30_000);

/**
 * The probe's bound, from outside: a survivor that made a session of its own
 * escapes the group kill, and the verdict is published — after which the step
 * has nothing left to do and must say so by ending.
 */
test("probe.main.ts exits after the bound, even when something escaped the group", async () => {
  const project = await materialise({});
  const ran = await ranEntryPoint("db-serving/probe.main.ts", {
    INPUT_PROJECT: project,
    INPUT_PROBE_COMMAND: `setsid sleep 45 & wait`,
    INPUT_PROBE_TIMEOUT: "1",
    INPUT_HEALTH_URL: "http://127.0.0.1:65535/health",
  });

  expect(`hung: ${ran.hung}`).toBe("hung: false");
  expect(ran.status).toBe(1);
  expect(ran.output).toContain("was still running after 1s and was killed");
}, 30_000);
