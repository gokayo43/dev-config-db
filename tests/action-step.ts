import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type Foreign, isForeign, isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { root } from "./workflow.ts";

/**
 * A shipped action step, run the way the runner runs it — the step's own `run:`
 * block, in the working directory it declares, under the environment the runner
 * would have built.
 *
 * What this exists for is the class of failure no in-process test can see: a
 * gate runs inside the job of the repository it grades, after that repo's
 * install scripts, build and migrator have each had a turn, and each of those
 * can write `$GITHUB_ENV`/`$GITHUB_PATH` — folded into every later step — or
 * leave a file in the checkout that the gate's own interpreter reads on the way
 * up. All of them end the same way: the step green, having graded nothing.
 *
 * The step is extracted from the shipped `action.yml` and run, never
 * transcribed — the reason `refusals.test.ts` gives for the wrapper's own
 * block. A transcription would grade a copy that cannot go stale, which is the
 * opposite of the property wanted.
 *
 * Both suites that drive shipped steps come through here: `action-steps.test.ts`
 * for the replay and DATETIME gates, `serving-steps.test.ts` for the two the
 * serving gate ships.
 */

/** The contexts the runner resolves in a step before it runs, as far as these steps use them. */
export interface Context {
  readonly actionPath: string;
  readonly workspace: string;
  readonly temp: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/**
 * One `${{ … }}` as the runner resolves it. Only the handful of references
 * these steps actually carry: an expander that answered everything would be a
 * second implementation of the expression language, and a step reaching for a
 * context this does not know should fail loudly rather than silently expand to
 * nothing.
 */
function resolved(reference: string, context: Context): string {
  const input = /^inputs(?:\.([\w-]+)|\[(['"])([^'"]+)\2\])$/u.exec(reference);
  if (input !== null) {
    const name = input[1] ?? input[3] ?? "";
    const value = context.inputs[name];
    if (value === undefined) throw new Error(`the case passed no ${name} input`);
    return value;
  }
  if (reference === "github.action_path") return context.actionPath;
  if (reference === "github.workspace") return context.workspace;
  if (reference === "runner.temp") return context.temp;
  throw new Error(`this harness does not resolve \${{ ${reference} }}`);
}

function expand(value: string, context: Context): string {
  return value.replaceAll(/\$\{\{\s*(.+?)\s*\}\}/gu, (_, reference: string) =>
    resolved(reference, context),
  );
}

/** The step of that name, since an action may ship several that run something. */
function stepNamed(action: Foreign, name: string): Foreign {
  const steps = mapAt(action, "runs")["steps"];
  const found = (isList(steps) ? steps : [])
    .filter((step) => isForeign(step))
    .find((step) => (textAt(step, "name") ?? "").includes(name));
  if (found === undefined || textAt(found, "run") === undefined) {
    throw new Error(`no step matching '${name}' with a run: block`);
  }
  return found;
}

export interface Ran {
  readonly status: number;
  readonly output: string;
}

export interface Run {
  readonly inputs: Readonly<Record<string, string>>;
  readonly workspace: string;
  /** What an earlier step of the graded repo's own exported, which the runner hands to this one. */
  readonly inherited?: Readonly<Record<string, string>>;
  /** A directory the graded repo prepended to PATH through `$GITHUB_PATH`. */
  readonly path?: string;
}

/**
 * The step, under the runner's own order: the environment it inherited first,
 * then the step's own `env:` over the top. That order is the whole of what
 * makes a step's declared variable beat one an earlier step exported, so a
 * harness that applied it the other way round would pass against the bug.
 */
export async function ranStep(action: string, step: string, run: Run): Promise<Ran> {
  const actionPath = `${root}/.github/actions/${action}`;
  const parsed: unknown = Bun.YAML.parse(await Bun.file(`${actionPath}/action.yml`).text());
  if (!isForeign(parsed)) throw new Error(`${action}/action.yml did not parse as a mapping`);
  const found = stepNamed(parsed, step);
  const context: Context = {
    actionPath,
    workspace: run.workspace,
    temp: run.workspace,
    inputs: run.inputs,
  };

  const env = mapAt(found, "env");
  const declared = Object.fromEntries(
    Object.keys(env).map((name) => {
      const value = textAt(env, name);
      if (value === undefined) throw new Error(`${action}'s ${step} maps ${name} to something odd`);
      return [name, expand(value, context)];
    }),
  );
  const where = textAt(found, "working-directory");
  const script = textAt(found, "run");
  if (script === undefined) throw new Error(`${action}'s ${step} declares no run block`);

  const proc = Bun.spawn(["bash", "-c", script], {
    // Resolved against the checkout, which is what the runner does with a
    // relative one and the whole of what a step declaring none inherits — a
    // harness that read it any other way would report a step running somewhere
    // it never runs.
    cwd: where === undefined ? run.workspace : resolve(run.workspace, expand(where, context)),
    env: {
      ...process.env,
      ...(run.path === undefined ? {} : { PATH: `${run.path}:${process.env["PATH"] ?? ""}` }),
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_WORKSPACE: run.workspace,
      ...run.inherited,
      ...declared,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: await proc.exited, output: out + err };
}

const made: string[] = [];

/** A checkout of the repository under grade, holding whatever this case says it holds. */
export async function checkout(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const where = await mkdtemp(join(tmpdir(), "graded-"));
  made.push(where);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(`${where}/${name}`, content);
  }
  return where;
}

/**
 * A directory holding a program of that name which does nothing and reports
 * success, which is the whole of what a hijacked PATH buys: every case that
 * uses one is asking whether the step reached the real program instead.
 */
export async function decoy(name: string): Promise<string> {
  const where = await checkout({ [name]: "#!/bin/sh\nexit 0\n" });
  await Bun.spawn(["chmod", "+x", `${where}/${name}`]).exited;
  return where;
}

/** Called from `tests/preload.ts`, for the reason `tree.ts` gives at `removeRoots`. */
export async function removeCheckouts(): Promise<void> {
  for (const where of made.splice(0)) await rm(where, { recursive: true, force: true });
}
