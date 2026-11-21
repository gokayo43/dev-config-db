import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Foreign, isForeign, isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { root, stringsIn, WRAPPER, wrapperDocument } from "./workflow.ts";

/**
 * The wiring the gates themselves cannot see: which steps the shipped job runs,
 * and whether the evidence every one of them leaves behind is actually
 * uploaded.
 *
 * Each of these is a way for a green run to mean nothing: a file written into
 * the runner and left out of the upload is evidence deleted with the runner,
 * and a step that resolves a program through a path the graded repo wrote runs
 * that repo's program instead of the gate.
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
function runnerFiles(document: Foreign | readonly Foreign[]): string[] {
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

function stepUsing(what: string): Foreign {
  const found = jobSteps().find((step) => (textAt(step, "uses") ?? "").includes(what));
  if (found === undefined) throw new Error(`${WRAPPER}'s database job has no step using ${what}`);
  return found;
}

test("every file the gates leave in the runner is in the artifact the job uploads", async () => {
  const upload = stepUsing("actions/upload-artifact");
  const path = textAt(mapAt(upload, "with"), "path") ?? "";

  // The job's own steps write files too, and the upload's `path` is left out
  // because it names every file it carries and would grade itself.
  const job = jobSteps().filter((step) => step !== upload);
  const written = [
    ...runnerFiles(serving),
    ...runnerFiles(replay),
    ...runnerFiles(upgrade),
    ...runnerFiles(job),
  ];
  // The two schemas the replay compared, the schema the upgrade path reached,
  // the app's own output and the database server's own output: five files, and
  // the whole reason the upload belongs to the job rather than to any one
  // action.
  expect(written).toHaveLength(5);
  expect(written.filter((file) => !path.includes(file))).toEqual([]);

  // The run that failed partway is exactly the run whose partial evidence is
  // worth having — and `!cancelled()` is not that condition: the runner marks
  // the job cancelled when it hits its own `timeout-minutes`, so the step was
  // skipped on exactly the runs that had spent fifteen minutes producing the
  // evidence. This assertion used to hold the hole in place.
  expect(textAt(upload, "if")).toBe("${{ always() }}");
  expect(textAt(mapAt(upload, "with"), "if-no-files-found")).toBe("ignore");
});

/**
 * No step of CI runs a load test. Every file under the workflows and the
 * actions is read, whatever its extension, because a load test can enter as a
 * step of a workflow or as a script or loader beside an action it calls, and a
 * file there that names either word has no reason to.
 */
test("no workflow and no action of this repo runs a load test", async () => {
  const files = await Array.fromAsync(
    new Bun.Glob("{workflows,actions}/**/*").scan({ cwd: join(root, ".github"), dot: true }),
    (file) => `.github/${file}`,
  );
  expect(files).toContain(WRAPPER);
  expect(files).toContain(".github/actions/db-serving/action.yml");

  const mentioning: string[] = [];
  for (const file of files) {
    if (/\b(?:k6|capacity-ramp)\b/iu.test(await Bun.file(join(root, file)).text())) {
      mentioning.push(file);
    }
  }
  expect(mentioning).toEqual([]);
});

test("the probe step runs when either of its two inputs is set", () => {
  const probe = stepsOf(serving).find((step) => textAt(step, "name")?.includes("probe"));
  const when = textAt(probe, "if") ?? "";

  // A caller who set only the bound is told so rather than ignored — the step
  // has to be selected for the gate to be able to say it.
  expect(when).toContain("probe-command");
  expect(when).toContain("probe-timeout");
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
  // health-url is the caller's, and still reaches the gate as one value: the
  // step that allocates the app's port writes that port into it, so the gate
  // takes that step's output — app-port.test.ts runs it.
  const COMPOSED = new Map([["health-url", "${{ steps.app.outputs['health-url'] }}"]]);
  expect(Object.keys(passed)).not.toContain("database-url");
  const crossed = Object.entries(passed).filter(([name, value]) => {
    const fixed = PINNED.get(name) ?? COMPOSED.get(name);
    if (fixed !== undefined) return value !== fixed;
    const reference = new RegExp(`inputs(?:\\.${name}(?![\\w-])|\\[(['"])${name}\\1\\])`, "u");
    return typeof value !== "string" || !reference.test(value);
  });
  expect(crossed).toEqual([]);
});

test("every step runs in the action's own checkout, under the interpreter and path its caller pinned", () => {
  // The three things a graded repo could otherwise choose about a gate that
  // runs inside its job: which `bunfig.toml` the interpreter reads on the way
  // up, which `bun` that is, and which `setsid` and `bash` everything else
  // resolves to. `serving-steps.test.ts` drives the shipped blocks against a
  // checkout that fights back; this holds the declaration every one of them
  // depends on.
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

/** Where in the job the graded repo's dependencies are installed, by the action that installs them. */
const INSTALL = "dev-config/.github/actions/install";

test("the caller reads the interpreter and the path before the graded repo runs", () => {
  const steps = jobSteps();
  const at = (matches: (step: Foreign) => boolean): number => steps.findIndex((s) => matches(s));

  const pinned = at((step) => textAt(step, "id") === "pinned");
  // Found by the action rather than by a `bun install` in a `run:` block: the
  // install is dev-config's step now, because it is the one that can be handed a
  // key. What this rule is about did not change with it.
  const install = at((step) => (textAt(step, "uses") ?? "").includes(INSTALL));
  const gate = at((step) => (textAt(step, "uses") ?? "").includes("db-serving"));

  // Order is the whole of the argument: a value read after the graded repo's
  // own install scripts have run is a value that repo could have rewritten.
  expect(pinned).toBeGreaterThan(-1);
  expect(install).toBeGreaterThan(-1);
  expect(pinned).toBeLessThan(install);
  expect(install).toBeLessThan(gate);
});

/**
 * The install is the second half of one door: dev-config's static gate takes
 * the consumer's key through the call, and this job's install has to take the
 * same key from the same secret, or a consumer with a private git dependency
 * passes one job and dies in the next at `bun install` — on a step that never
 * asked for a credential, over a dependency its manifest names.
 *
 * Pinned by full path and SHA like every other action here, and handed the
 * secret and nothing else: the key's whole safety is that it is written, used
 * and removed inside that action's own shell, so this job's part is to pass it
 * there and nowhere else.
 */
test("the database job installs through dev-config's install, carrying the key", () => {
  // `stepUsing` rather than a find of this test's own: a job that has stopped
  // installing through that action fails by name here, rather than as a
  // malformed pin belonging to a step that is not there.
  const step = stepUsing(INSTALL);

  expect(textAt(step, "uses")).toMatch(
    /^gokayo43\/dev-config\/\.github\/actions\/install@[0-9a-f]{40}$/u,
  );
  // The key and nothing else: what makes it safe is that it is written, used
  // and removed inside that action's own shell, so this job's part is to hand
  // it there and to hold nothing back for itself.
  expect(mapAt(step, "with")).toEqual({ "git-ssh-key": "${{ secrets['git-ssh-key'] }}" });
});

/**
 * And one install, not two. A `bun install` left in a `run:` block beside the
 * action is a second answer to which dependencies this job graded — and it is
 * the answer that takes no key, so a consumer with a private dependency would
 * meet exactly the failure the action is here to end.
 */
test("nothing in the database job installs the other way", () => {
  expect(jobSteps().filter((each) => (textAt(each, "run") ?? "").includes("bun install"))).toEqual(
    [],
  );
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

/** The step that keeps the server's output and removes its container. */
function serverRemoval(): { step: Foreign; at: number } {
  const steps = jobSteps();
  const at = steps.findIndex((step) => (textAt(step, "run") ?? "").includes("docker rm"));
  const step = steps[at];
  if (step === undefined) throw new Error(`${WRAPPER}'s database job never removes its server`);
  return { step, at };
}

/**
 * A composite action has no `post:`, so the job removes the container its
 * server step created, on every run: the failed and the timed-out ones are the
 * runs whose server would otherwise stay resident. The removal takes the
 * server's output with it, so the same step reads the output first, and both
 * happen before the upload that carries the output.
 */
test("the job keeps its server's output and then takes the server down, before the upload, whatever happened to the run", () => {
  const { step, at } = serverRemoval();
  const run = textAt(step, "run") ?? "";
  const upload = jobSteps().findIndex((each) =>
    (textAt(each, "uses") ?? "").includes("upload-artifact"),
  );

  expect(textAt(step, "if")).toBe("${{ always() }}");
  expect(at).toBeLessThan(upload);
  expect(run.indexOf("docker logs")).toBeGreaterThan(-1);
  expect(run.indexOf("docker logs")).toBeLessThan(run.indexOf("docker rm --force"));
  // `--volumes`, or an image that keeps its data outside the in-memory data
  // directory leaves an anonymous volume on the runner's disk every run.
  expect(run).toContain("docker rm --force --volumes");
  // The container the server step named, rather than a name derived twice.
  expect(textAt(mapAt(step, "env"), "CONTAINER")).toBe("${{ steps.server.outputs.container }}");
});

/** A directory holding a `docker` that records each call and fails the ones named. */
async function fakeDocker(failing: string): Promise<AsyncDisposable & { dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fake-docker-"));
  await writeFile(
    join(dir, "docker"),
    `#!/bin/sh\necho "$*" >> "${dir}/calls"\n[ "$1" = "${failing}" ] && exit 1\nexit 0\n`,
    { mode: 0o755 },
  );
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The output is evidence and nothing more, so a read that fails must leave the
 * job's verdict as the gates made it and must not keep the server resident.
 */
test("a server output that cannot be read is a warning, and the server is still removed", async () => {
  await using docker = await fakeDocker("logs");
  const proc = Bun.spawn(["bash", "-c", textAt(serverRemoval().step, "run") ?? ""], {
    env: {
      CONTAINER: "db-gate-server-x",
      RUNNER_TEMP: docker.dir,
      PATH: `${docker.dir}:/usr/bin:/bin`,
    },
    stdout: "pipe",
  });
  const [out, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(status).toBe(0);
  expect(out).toContain("::warning::");
  expect(await Bun.file(join(docker.dir, "calls")).text()).toContain(
    "rm --force --volumes db-gate-server-x",
  );
});

/**
 * The class `pinned` exists for: a step that runs after the graded repo's
 * install resolves programs through the path that repo could have prepended to,
 * unless the step declares the path read before it ran.
 */
test("every run step after the install takes the path read before the graded repo ran", () => {
  const steps = jobSteps();
  const install = steps.findIndex((step) => (textAt(step, "uses") ?? "").includes(INSTALL));
  const unpinned = steps
    .slice(install + 1)
    .filter((step) => textAt(step, "run") !== undefined)
    .filter((step) => textAt(mapAt(step, "env"), "PATH") !== "${{ steps.pinned.outputs.path }}")
    .map((step) => textAt(step, "name") ?? textAt(step, "id") ?? "(unnamed)");

  expect(install).toBeGreaterThan(-1);
  expect(unpinned).toEqual([]);
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
