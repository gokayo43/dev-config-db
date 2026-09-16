import { expect, test } from "bun:test";

import { type Foreign, isForeign, isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { root, stringsIn, WRAPPER, wrapperDocument } from "./workflow.ts";

/**
 * The wiring the gates themselves cannot see: which steps the shipped job runs,
 * what the app is given, and whether the evidence every one of them leaves
 * behind is actually uploaded.
 *
 * Each of these is a way for a green run to mean nothing. An app booted without
 * `ROUTE_LOG` serves no instrument, so the floor grades a payload that never
 * comes; a file written into the runner and left out of the upload is evidence
 * deleted with the runner; a ramp step that stopped sourcing the pinned fetch
 * runs whatever k6 the machine happens to have.
 */

/**
 * Where a step leaves a file for the job to upload afterwards, in either
 * spelling a step has for the runner's temp directory: the expression a YAML
 * value carries, and the variable a `run:` block reads.
 */
const IN_RUNNER_TEMP = /(?:\$\{\{\s*runner\.temp\s*\}\}|\$\{?RUNNER_TEMP\}?)\/([\w.-]+)/gu;

async function action(name: string): Promise<Foreign> {
  const parsed: unknown = Bun.YAML.parse(
    await Bun.file(`${root}/.github/actions/${name}/action.yml`).text(),
  );
  if (!isForeign(parsed)) throw new Error(`${name}/action.yml did not parse as an action`);
  return parsed;
}

function stepsOf(document: Foreign): Foreign[] {
  const steps = mapAt(document, "runs")["steps"];
  return (isList(steps) ? steps : []).filter((step) => isForeign(step));
}

/**
 * Every file under the runner's temp directory the action names, by name and
 * once each: two steps naming one file are one file to upload.
 *
 * Read off every string in the action rather than off `env:` alone. An `env:`
 * block is where these paths are written today, and a guard that only knew that
 * would go quiet the first time a step wrote one into its own `run:` — which is
 * exactly the claim CLAUDE.md makes for this test.
 */
function runnerFiles(document: Foreign): string[] {
  return [
    ...new Set(
      stringsIn(document).flatMap((value) =>
        [...value.matchAll(IN_RUNNER_TEMP)].flatMap((found) =>
          found[1] === undefined ? [] : [found[1]],
        ),
      ),
    ),
  ];
}

const wrapper = await wrapperDocument();
const serving = await action("db-serving");
const replay = await action("db-replay");
const upgrade = await action("db-upgrade");

/** The steps of the one job that builds a database and runs an app against it. */
function jobSteps(): Foreign[] {
  const steps = mapAt(mapAt(wrapper, "jobs"), "database")["steps"];
  return (isList(steps) ? steps : []).filter((step) => isForeign(step));
}

/** The step that ramps, which is also the step that grades the floor — see below. */
function rampStep(): Foreign {
  const found = stepsOf(serving).find((step) => (textAt(step, "name") ?? "").includes("ramp"));
  if (found === undefined) throw new Error("db-serving has no ramp step");
  return found;
}

function stepUsing(what: string): Foreign {
  const found = jobSteps().find((step) => (textAt(step, "uses") ?? "").includes(what));
  if (found === undefined) throw new Error(`${WRAPPER}'s database job has no step using ${what}`);
  return found;
}

test("every file the gates leave in the runner is in the artifact the job uploads", async () => {
  const upload = stepUsing("actions/upload-artifact");
  const path = textAt(mapAt(upload, "with"), "path") ?? "";

  const written = [...runnerFiles(serving), ...runnerFiles(replay), ...runnerFiles(upgrade)];
  // The two schemas the replay compared, the schema the upgrade path reached,
  // the app's own output, the k6 summary and both route-log snapshots: seven
  // files, and the whole reason the upload belongs to the job rather than to any
  // one action.
  expect(written).toHaveLength(7);
  expect(written.filter((file) => !path.includes(file))).toEqual([]);

  // The run that failed on the way to a number is exactly the run whose partial
  // evidence is worth having — and `!cancelled()` is not that condition: the
  // runner marks the job cancelled when it hits its own `timeout-minutes`, so
  // the step was skipped on exactly the runs that had spent fifteen minutes
  // producing the evidence. This assertion used to hold the hole in place.
  expect(textAt(upload, "if")).toBe("${{ always() }}");
  expect(textAt(mapAt(upload, "with"), "if-no-files-found")).toBe("ignore");
});

test("the app is booted with the instrument the coverage floor reads", () => {
  const boot = stepsOf(serving)[0];
  expect(textAt(boot, "name")).toBe("Boot against that database");
  // Set only here: an instrument rather than a surface, and no deployment sets
  // it. Without it the app serves no route log and the floor grades nothing.
  expect(textAt(mapAt(boot, "env"), "ROUTE_LOG")).toBe("true");
});

test("the probe step runs when either of its two inputs is set", () => {
  const probe = stepsOf(serving).find((step) => textAt(step, "name")?.includes("probe"));
  const when = textAt(probe, "if") ?? "";

  // A caller who set only the bound is told so rather than ignored — the step
  // has to be selected for the gate to be able to say it.
  expect(when).toContain("probe-command");
  expect(when).toContain("probe-timeout");
});

test("the ramp's k6 is fetched by version and archive checksum", async () => {
  // What this holds is the wiring and the pin, not the identity of the binary
  // that arrives: `sha256sum` is itself found on PATH, so the checksum is a
  // contract only while the search path is the one the calling job read. The
  // case below is where that half is held.
  const ramp = rampStep();
  expect(textAt(ramp, "run")).toContain("k6.sh");

  const fetcher = await Bun.file(`${root}/.github/actions/db-serving/k6.sh`).text();
  // Version and archive checksum, the pair Renovate moves together: the version
  // is a label and the SHA-256 is the contract.
  expect(fetcher).toMatch(/^K6_VERSION=v\d+\.\d+\.\d+$/mu);
  expect(fetcher).toMatch(/^K6_SHA256=[\da-f]{64}$/mu);
  expect(fetcher).toContain("sha256sum -c -");
  // The pin is only a pin while Renovate can find it.
  expect(fetcher).toContain("renovate: datasource=github-release-attachments depName=grafana/k6");
});

test("the job hands the serving gate every input it declares, each under its own name", () => {
  const passed = mapAt(stepUsing("actions/db-serving"), "with");
  const declared = Object.keys(mapAt(serving, "inputs"));

  // working-directory is the one input the wrapper leaves at its default: this
  // workflow's consumers are single-package repos, and a monorepo's path is a
  // decision rather than a pass-through.
  expect(declared.filter((name) => name !== "working-directory").toSorted()).toEqual(
    Object.keys(passed).toSorted(),
  );
  // An input handed on under a neighbour's name is a setting the consumer wrote
  // with a wrong answer beside it, and no run shows it. The two pins are the
  // exception and the only one: they are not the caller's to write at all — the
  // job reads them for itself before the graded repo runs, which is what makes
  // them worth having.
  const PINNED = new Map([
    ["bun", "${{ steps.pinned.outputs.bun }}"],
    ["path", "${{ steps.pinned.outputs.path }}"],
  ]);
  expect(Object.keys(passed)).not.toContain("database-url");
  const crossed = Object.entries(passed).filter(([name, value]) => {
    const pinned = PINNED.get(name);
    if (pinned !== undefined) return value !== pinned;
    const reference = new RegExp(`inputs(?:\\.${name}(?![\\w-])|\\[(['"])${name}\\1\\])`, "u");
    return typeof value !== "string" || !reference.test(value);
  });
  expect(crossed).toEqual([]);
});

test("the floor is decided by the step that ramps, not by one behind it", () => {
  // A step of its own runs under `success()`, so a ramp the failure bound
  // refuses would skip it — and every route nothing reached would cost a CI
  // round-trip that the measurement had already paid for. One step, one
  // verdict: the two snapshots and the allowlist reach the same program.
  const ramp = mapAt(rampStep(), "env");
  expect(Object.keys(ramp)).toContain("INPUT_ROUTE_ALLOWLIST");
  expect(Object.keys(ramp)).toContain("INPUT_ROUTE_LOG_BEFORE");
  expect(Object.keys(ramp)).toContain("INPUT_ROUTE_LOG_AFTER");

  // And nothing after it: the ramp is the last thing the action does.
  expect(stepsOf(serving).at(-1)).toEqual(rampStep());
});

test("every step runs in the action's own checkout, under the interpreter and path its caller pinned", () => {
  // The three things a graded repo could otherwise choose about a gate that
  // runs inside its job: which `bunfig.toml` the interpreter reads on the way
  // up, which `bun` that is, and which `curl`, `tar`, `sha256sum`, `setsid` and
  // `bash` everything else resolves to. `serving-steps.test.ts` drives the
  // shipped blocks against a checkout that fights back; this holds the
  // declaration every one of them depends on, including for a step no case
  // there can reach without spending a network fetch.
  for (const step of stepsOf(serving)) {
    const name = textAt(step, "name") ?? "(unnamed)";
    const env = mapAt(step, "env");
    expect(`${name}: ${textAt(step, "working-directory")}`).toBe(
      `${name}: \${{ github.action_path }}`,
    );
    expect(`${name}: ${textAt(env, "INPUT_BUN")}`).toBe(`${name}: \${{ inputs.bun }}`);
    expect(`${name}: ${textAt(env, "PATH")}`).toBe(`${name}: \${{ inputs.path }}`);
    // The project reaches the gate as a value rather than as the place it was
    // run, and `github.workspace` is an expression context no step can write.
    expect(`${name}: ${textAt(env, "INPUT_PROJECT")}`).toContain("github.workspace");
    expect(`${name}: ${textAt(step, "run")}`).toContain("gate.sh");
  }
});

test("the caller reads the interpreter and the path before the graded repo runs", () => {
  const steps = jobSteps();
  const at = (matches: (step: Foreign) => boolean): number => steps.findIndex((s) => matches(s));

  const pinned = at((step) => textAt(step, "id") === "pinned");
  const install = at((step) => (textAt(step, "run") ?? "").includes("bun install"));
  const gate = at((step) => (textAt(step, "uses") ?? "").includes("db-serving"));

  // Order is the whole of the argument: a value read after the graded repo's
  // own install scripts have run is a value that repo could have rewritten.
  expect(pinned).toBeGreaterThan(-1);
  expect(pinned).toBeLessThan(install);
  expect(install).toBeLessThan(gate);
});

/**
 * The server is a step now rather than a service container, which moves one
 * thing the runner used to guarantee into this file's order: a service was up
 * before any step ran, and a step is up only before the steps after it.
 *
 * So every step of this job that touches the database has to be after the one
 * that starts it — and the failure this catches is not a hang: the replay gate
 * would report a refused connection, which reads as a fact about the repo under
 * grade rather than as a job that was assembled wrong.
 */
/**
 * Every gate is handed the database as the server step's own output, and the
 * map below is where a second source would show up: the value is also in the
 * environment, for the graded repo's own processes, and a gate reading it from
 * there would be reading something that repo's later steps can rewrite.
 */
test("every gate takes the database from the step that started it, not from the environment", () => {
  const handed = jobSteps().flatMap((step) => {
    const given = textAt(mapAt(step, "with"), "database-url");
    if (given === undefined) return [];
    return [{ starts: (textAt(step, "uses") ?? "").includes("actions/db-server"), given }];
  });
  const gates = handed.filter(({ starts }) => !starts).map(({ given }) => given);

  // The replay, the upgrade path and the DATETIME catalogue. The serving gate
  // takes none at all — its app reads the environment, which is the one place a
  // process the graded repo wrote can read it from.
  expect(gates).toHaveLength(3);
  expect(gates.filter((value) => value !== "${{ steps.server.outputs['database-url'] }}")).toEqual(
    [],
  );
  // And the one step that takes something else is the one that starts the
  // server: what it is handed is the declaration the port is not in yet.
  expect(handed.filter(({ starts }) => starts).map(({ given }) => given)).toEqual([
    "mysql://root:db-gate@127.0.0.1/app",
  ]);
});

/**
 * The container the server step created, removed by the job that asked for it.
 *
 * A composite action has no `post:` — that belongs to JavaScript and Docker
 * actions — so nothing in the action can take its own container down, and on a
 * persistent runner what that leaves behind is a database server per consumer
 * workspace, resident between runs with the last run's schemas in it. The
 * removal is the job's, it is last, and it runs whatever happened to the run:
 * the failed and the timed-out ones are exactly the runs whose server would
 * otherwise stay.
 */
test("the job takes its server down, whatever happened to the run", () => {
  const steps = jobSteps();
  const last = steps.at(-1);

  expect(textAt(last, "if")).toBe("${{ always() }}");
  expect(textAt(last, "run")).toContain("docker rm --force");
  // The container it removes is the one the server step named, rather than a
  // name this file derives a second time.
  expect(textAt(mapAt(last, "env"), "CONTAINER")).toBe("${{ steps.server.outputs.container }}");
});

test("every step that uses the database comes after the step that starts it", () => {
  const steps = jobSteps();
  const using = (named: string): number =>
    steps.findIndex((step) => (textAt(step, "uses") ?? "").includes(named));

  const server = using("actions/db-server");
  expect(server).toBeGreaterThan(-1);
  // Every step of this job that opens a connection, and the list is the point:
  // a gate added without its name here is a gate this rule stopped covering on
  // the day it shipped, which is how db-upgrade first arrived.
  for (const gate of [
    "actions/db-replay",
    "actions/db-upgrade",
    "actions/db-datetime",
    "actions/db-serving",
  ]) {
    expect(`${gate} runs after the server: ${using(gate) > server}`).toBe(
      `${gate} runs after the server: true`,
    );
  }
});
