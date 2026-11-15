import { expect, test } from "bun:test";

import { only } from "@gokayo43/dev-config/narrowing";

import { type Foreign, isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { root, WRAPPER, wrapperDocument } from "./workflow.ts";

/**
 * The refusals the wrapper itself adds, rather than delegating. The main one: a
 * call that asks for an input aimed at the database job without asking for the
 * job is refused instead of ignored. Being quietly ignored is how a gate
 * somebody asked for turns out never to have run, and this is the only place
 * that rule exists. Beside it, `database: postgres` and the probe pair.
 *
 * The suite runs the shipped `run:` block rather than a transcription of it,
 * the way dev-config's test-suite suite runs its action's. A copy could not
 * grade the thing worth grading — whether the block the workflow actually ships
 * refuses what it claims to — and would go green against a workflow that had
 * stopped carrying it at all.
 */
interface Step {
  readonly script: string;
  readonly env: Foreign;
}

const JOBS = mapAt(await wrapperDocument(), "jobs");

function stepsOf(job: string): readonly unknown[] {
  const steps = mapAt(JOBS, job)["steps"];
  return isList(steps) ? steps : [];
}

const STEP = ((): Step => {
  const found = stepsOf("refusals").filter((step) => textAt(step, "run") !== undefined);
  const [step, ...rest] = found;
  const script = textAt(step, "run");
  if (script === undefined || rest.length > 0) {
    throw new Error(
      `${WRAPPER} must have a 'refusals' job with exactly one run step, and has ${found.length} — that job is the only thing refusing a database-job input passed without the job`,
    );
  }
  return { script, env: mapAt(step, "env") };
})();

/**
 * The database job's first step, which refuses the probe pair for the calls the
 * refusals job skips. Read as the first step and nothing else, because "before
 * anything is checked out, installed or booted" is the whole of its worth.
 */
const PAIR_STEP = ((): Step => {
  const [step] = stepsOf("database");
  const script = textAt(step, "run");
  if (script === undefined) {
    throw new Error(
      `${WRAPPER}'s database job must open with a run step refusing a probe-timeout with no probe-command, and opens with ${textAt(step, "uses") ?? "nothing"}`,
    );
  }
  return { script, env: mapAt(step, "env") };
})();

interface Ran {
  readonly status: number;
  readonly output: string;
}

/** `${{ inputs.build }}` and `${{ inputs['health-url'] }}` are one reference written two ways. */
const REFERENCE = /^\$\{\{\s*inputs(?:\.([\w-]+)|\[(['"])([^'"]+)\2\])\s*\}\}$/u;

const DECLARED = mapAt(mapAt(await wrapperDocument(), "on"), "workflow_call")["inputs"];

/** What a caller who wrote nothing gets, which is what the runner puts in the variable. */
function declaredDefault(name: string): string {
  const held = mapAt(DECLARED, name)["default"];
  if (held === undefined) return "";
  if (typeof held === "string") return held;
  if (typeof held === "boolean" || typeof held === "number") return String(held);
  throw new Error(
    `the declared default of ${name} is not a value a runner could put in a variable`,
  );
}

/**
 * The step under bash, with the environment the runner would give it: every
 * name its own `env:` block declares, an expression standing for the input's
 * declared default and a literal standing for itself.
 *
 * Derived from the shipped block rather than listed here, and that is the
 * point twice over. The body runs under `set -u`, so an input added to the
 * guard and forgotten here would fail every case over an unbound variable
 * rather than one case over the rule — and an input whose default is not empty
 * is only refused correctly if the case starts from the value a caller who
 * wrote nothing would have.
 */
async function ran(over: Readonly<Record<string, string>>, step: Step = STEP): Promise<Ran> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(step.env)) {
    const written = typeof value === "string" ? value : "";
    const reference = REFERENCE.exec(written);
    const input = reference?.[1] ?? reference?.[3];
    env[name] = input === undefined ? written : declaredDefault(input);
  }
  const proc = Bun.spawn(["bash", "-c", step.script], {
    cwd: root,
    env: { ...process.env, ...env, ...over },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: await proc.exited, output: out + err };
}

/**
 * Every input this workflow declares for its own job, by the variable the guard
 * reads it under, each refused without the job. Not being refused with it is
 * the refusals job not running then, which the job-selection case at the end
 * of this file asks.
 */
const AIMED_AT_THE_JOB = [
  [
    "DB_GATE_EVIDENCE",
    "db-gate-evidence",
    "db-evidence",
    "names the artifact the database job uploads",
  ],
  [
    "PROBE_COMMAND",
    "probe-command",
    "bun run scripts/probe.ts",
    "the probe runs against the app the database job boots",
  ],
  [
    "CAPACITY_SCRIPT",
    "capacity-script",
    "scripts/ramp.js",
    "the ramp runs against the app the database job boots",
  ],
  [
    "CAPACITY_PATH",
    "capacity-path",
    "/api/things",
    "the ramp runs against the app the database job boots",
  ],
  [
    "ROUTE_ALLOWLIST",
    "route-allowlist",
    "OPTIONS /* -- the cors plugin answers before a route does",
    "the route floor is measured across the database job's ramp",
  ],
  [
    "UPGRADE_GATE",
    "upgrade-gate",
    "true",
    "it adds a step to the database job, which replays the base ref's migrations",
  ],
  [
    "DATETIME_ALLOWLIST",
    "datetime-allowlist",
    "shop.opens_at -- the shop's clock",
    "waives columns the database job's DATETIME step grades",
  ],
  [
    "DATABASE_IMAGE",
    "database-image",
    "mysql:8.0.46@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b",
    "it is the server the database job starts, and this call starts none",
  ],
  [
    "START_COMMAND",
    "start-command",
    "bun run serve",
    "it is how the database job's boot step starts the app",
  ],
  [
    "HEALTH_URL",
    "health-url",
    "http://localhost:8080/health",
    "what the database job's boot step polls",
  ],
] as const;

/**
 * The inputs that carry a value rather than an empty default, and the whole of
 * the reason they are compared rather than tested for emptiness.
 *
 * `database-image` carries one so that a consumer running the server this repo
 * certifies writes nothing; `upgrade-gate` is a boolean, and `-n` is true of
 * `false`. Every other input aimed at the job defaults to `""` — including
 * `start-command` and `health-url`, whose real defaults live in the database
 * job, which is the only place `health-url`'s could live at all since it names
 * a port that job allocates while it runs.
 */
const COMPARED = ["database-image", "upgrade-gate"] as const;

for (const [variable, input, value, because] of AIMED_AT_THE_JOB) {
  test(`${input} without the job it drives is refused rather than ignored`, async () => {
    const refused = await ran({ DATABASE: "none", [variable]: value });

    expect(refused.status).toBe(1);
    expect(refused.output).toContain(`::error::${input} needs database: external`);
    // The name alone is half a rule: what a caller needs is why the input is
    // aimed at a job they left off.
    expect(refused.output).toContain(because);
  });
}

/**
 * Every wrong input in one call earns every diagnostic. The most plausible
 * wrong implementation of a guard that has grown a second rule is a chain that
 * stops at the first — which costs the caller a CI round-trip per input, and
 * hides how many of them were aimed at a job that is off.
 */
test("a call carrying every misplaced input is told about every one of them", async () => {
  const refused = await ran({
    DATABASE: "false",
    ...Object.fromEntries(AIMED_AT_THE_JOB.map(([variable, , value]) => [variable, value])),
  });

  expect(refused.status).toBe(1);
  for (const [, input] of AIMED_AT_THE_JOB) {
    expect(refused.output).toContain(`::error::${input} needs database: external`);
  }
});

/**
 * Also the one caller this guard cannot see, and it is the same call: a
 * `workflow_call` input cannot be asked whether the caller passed it —
 * `github.event.inputs` is not populated for one — so a caller who passes
 * exactly the declared default sends what a caller who wrote nothing sends, and
 * `ran` seeds every input with its declared default. A second case spelling
 * those defaults out would die to the same wrong implementation as this one.
 * docs/gates/db-serving.md names the hole.
 */
test("a call that asks for neither passes, which is every consumer that has not adopted", async () => {
  const quiet = await ran({ DATABASE: "none" });

  expect(quiet.status).toBe(0);
  expect(quiet.output).not.toContain("::error::");
});

/**
 * The guard's copy of the two defaults in `COMPARED`, held to what the workflow
 * declares — and the other half of that rule: an input the guard compares is an
 * input that carries a value, and one that carries none is read as passed the
 * moment it is non-empty. A default that grew on an input read the second way
 * would make every caller who wrote nothing a caller who passed it.
 */
test("the defaults the guard compares against are the defaults this workflow declares", () => {
  // Written twice on purpose — a workflow_call input's default is not readable
  // from a step — so the two statements are held together here instead. A drift
  // between them refuses every caller or none, and for the image it would refuse
  // the consumer who wrote nothing at all.
  for (const input of COMPARED) {
    const variable = `${input.toUpperCase().replaceAll("-", "_")}_DEFAULT`;
    expect(`${variable}: ${String(STEP.env[variable])}`).toBe(
      `${variable}: ${declaredDefault(input)}`,
    );
  }
  const compared: readonly string[] = COMPARED;
  const emptily = AIMED_AT_THE_JOB.map(([, input]) => input).filter(
    (input) => !compared.includes(input),
  );
  expect(emptily.filter((input) => declaredDefault(input) !== "")).toEqual([]);
});

/**
 * Refused by whichever job the call runs: the refusals job beside its other
 * reason when the database job is off, and the database job's first step when
 * it is on. The two say one sentence, held here by the line each prints, so a
 * caller reads the same refusal whichever job carried it.
 */
test("a bound with no probe under it is refused whether or not the job runs", async () => {
  const withJob = await ran({ PROBE_TIMEOUT: "30" }, PAIR_STEP);
  const withoutJob = await ran({ DATABASE: "none", PROBE_TIMEOUT: "30" });

  expect(withJob.status).toBe(1);
  const sentence = only(withJob.output.split("\n").filter((line) => line.startsWith("::error::")));
  expect(sentence).toStartWith("::error::probe-timeout needs probe-command");
  expect(withoutJob.status).toBe(1);
  expect(withoutJob.output.split("\n")).toContain(sentence);
});

test("a bound with a probe under it, or neither, passes the database job's first step", async () => {
  for (const over of [{ PROBE_COMMAND: "bun run probe", PROBE_TIMEOUT: "30" }, {}]) {
    const allowed = await ran(over, PAIR_STEP);

    expect(allowed.status).toBe(0);
    expect(allowed.output).not.toContain("::error::");
  }
});

/**
 * The one value of dev-config's enum this workflow does not serve, and the only
 * place that rule is stated: handing their `database` on is what makes their
 * vocabulary this workflow's, and `postgres` is where that stops being true. The
 * static call still hands it on and starts their Postgres job, so this refusal
 * is what fails the run.
 *
 * The most plausible wrong implementation is the guard simply not being there:
 * every other case in this file stays green, since none of them passes a value
 * this workflow does not serve.
 */
test("database: postgres is refused, which is what fails the run", async () => {
  const refused = await ran({ DATABASE: "postgres" });

  expect(refused.status).toBe(1);
  expect(refused.output).toContain(
    "::error::database: postgres is not a value this workflow serves",
  );
  // The refusal has somewhere to send the caller, which is the half a bare "no"
  // would leave them without.
  expect(refused.output).toContain("calls gokayo43/dev-config's check.yml directly");
});

/**
 * A job's `if:` evaluated for one call rather than compared as text, in the
 * one form this workflow writes: `inputs.<name> == '<value>'` or `!=`,
 * bare or inside `${{ }}`, compared without case as GitHub compares. Anything
 * else throws, naming the expression, rather than being read as something it
 * is not.
 */
const CONDITION = /^\s*(?:\$\{\{\s*)?inputs\.([\w-]+)\s*(==|!=)\s*'([^']*)'\s*(?:\}\}\s*)?$/u;

function evaluated(expression: string, inputs: Readonly<Record<string, string>>): boolean {
  const [, name, operator, literal] = CONDITION.exec(expression) ?? [];
  if (name === undefined || literal === undefined) {
    throw new Error(
      `cannot evaluate \`${expression}\`: it is not inputs.<name> == or != a quoted value`,
    );
  }
  const same = (inputs[name] ?? declaredDefault(name)).toLowerCase() === literal.toLowerCase();
  return operator === "==" ? same : !same;
}

/**
 * Which jobs a call starts, read by evaluating each job's own `if:` for that
 * call. A call asking for the database job gets it and the static job and
 * nothing else, since every job waits about a minute for one of a consumer's
 * few runners; every other call gets the refusals job and no database job.
 *
 * The likeliest wrong implementations: the refusals job's `if:` left off, so
 * it runs beside the database job again, or written so it also skips the call
 * this workflow refuses `postgres` on.
 */
test("a call starts the refusals job exactly when it leaves the database job off", () => {
  const started = (database: string): string[] =>
    Object.entries(JOBS)
      .filter(([, job]) => {
        const condition = textAt(job, "if");
        return condition === undefined || evaluated(condition, { database });
      })
      .map(([name]) => name)
      .toSorted();

  // A `needs` would put the job behind another's handover, or skip it with it.
  expect(Object.keys(mapAt(JOBS, "refusals"))).not.toContain("needs");
  expect(started("external")).toEqual(["database", "static"]);
  expect(started("none")).toEqual(["refusals", "static"]);
  expect(started("postgres")).toEqual(["refusals", "static"]);
});
