import { expect, test } from "bun:test";
import { dirname } from "node:path";

import { isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { checkout } from "./action-step.ts";
import { WRAPPER, wrapperDocument } from "./workflow.ts";

/**
 * The step that allocates the app's port and writes it into the health URL,
 * run as the runner runs it: its own `run:` block, extracted from the shipped
 * workflow rather than transcribed, for the reason `refusals.test.ts` gives.
 *
 * What it owes is one port with two readers. The app is handed it as `PORT`,
 * and every gate step takes the app from the `health-url` output — so the two
 * naming different ports is a boot step polling something other than the app,
 * which on a shared runner is the collision this step exists to prevent.
 */
const STEP = await (async (): Promise<{ readonly script: string; readonly url: string }> => {
  const steps = mapAt(mapAt(await wrapperDocument(), "jobs"), "database")["steps"];
  const found = (isList(steps) ? steps : []).find((step) => textAt(step, "id") === "app");
  const script = textAt(found, "run");
  const url = textAt(mapAt(found, "env"), "HEALTH_URL");
  if (script === undefined || url === undefined) {
    throw new Error(
      `${WRAPPER}'s database job has no step 'app' with a run: block and a HEALTH_URL — that step is where the app's port is allocated and written into the URL every gate polls`,
    );
  }
  return { script, url };
})();

/** The step's `HEALTH_URL`: the caller's input, or the default a caller who wrote nothing gets. */
const DEFAULTED = /^\$\{\{\s*inputs\['health-url'\]\s*\|\|\s*'([^']*)'\s*\}\}$/u;

/** That expression as the runner resolves it for a caller who passed `passed`. */
function healthUrlFor(passed: string): string {
  const fallback = DEFAULTED.exec(STEP.url)?.[1];
  if (fallback === undefined) {
    throw new Error(`HEALTH_URL is ${STEP.url}, which this suite does not know how to resolve`);
  }
  return passed === "" ? fallback : passed;
}

interface Allocated {
  /** What the app is handed, through `$GITHUB_ENV`. */
  readonly port: number;
  /** What every gate step is handed, through `$GITHUB_OUTPUT`. */
  readonly healthUrl: string;
}

/** `name=value` lines, the format both runner files take from this step. */
function linesOf(text: string): Map<string, string> {
  return new Map(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

async function allocated(passed: string): Promise<Allocated> {
  const where = await checkout({ output: "", env: "" });
  const proc = Bun.spawn(["bash", "-c", STEP.script], {
    cwd: where,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
      HEALTH_URL: healthUrlFor(passed),
      GITHUB_OUTPUT: `${where}/output`,
      GITHUB_ENV: `${where}/env`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  if (status !== 0) throw new Error(`the step exited ${status}: ${out}${err}`);

  const port = linesOf(await Bun.file(`${where}/env`).text()).get("PORT");
  const healthUrl = linesOf(await Bun.file(`${where}/output`).text()).get("health-url");
  if (port === undefined || healthUrl === undefined) {
    throw new Error("the step wrote no PORT to $GITHUB_ENV or no health-url to $GITHUB_OUTPUT");
  }
  return { port: Number(port), healthUrl };
}

/** A port held the way a running app holds it, for as long as the case keeps the value. */
function holding(port: number): Disposable & { readonly port: number } {
  const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  return { port: listener.port, [Symbol.dispose]: () => listener.stop(true) };
}

test("a caller who names no health-url is polled on the port the app is handed", async () => {
  const { port, healthUrl } = await allocated("");

  expect(Number.isInteger(port) && port > 0 && port < 65_536).toBe(true);
  expect(healthUrl).toBe(`http://localhost:${port}/api/health`);
  // Let go, so the app can take it: a step that held its own port would hand
  // the app one it cannot bind.
  using held = holding(port);
  expect(held.port).toBe(port);
});

/**
 * The case #802 of nfp-elysia is: a health route that is not the default's,
 * which used to mean naming a whole URL, and so a port.
 */
test("every ${PORT} in a caller's health-url becomes the port the app is handed", async () => {
  const { port, healthUrl } = await allocated(
    "http://127.0.0.1:${PORT}/api/v1/health?from=${PORT}",
  );

  // Every occurrence, which is what `${var/…}` against `${var//…}` decides.
  expect(healthUrl).toBe(`http://127.0.0.1:${port}/api/v1/health?from=${port}`);
});

/**
 * Backwards compatibility, and the rule that it is a placeholder rather than an
 * expansion. The plausible wrong implementation is `envsubst` or an `eval`,
 * which would turn `$PORT` and `${HOME}` into values and run `$(…)`: the URL
 * is the caller's text, and the one thing replaced in it is the placeholder.
 */
test("a health-url without the placeholder is polled exactly as written", async () => {
  const written = "http://127.0.0.1:3100/api/v1/health?a=$PORT&b=${HOME}&c=$(echo ran)";

  expect((await allocated(written)).healthUrl).toBe(written);
});

/**
 * Two jobs on one runner, the second allocating while the first one's app is
 * up — the overlap that turned a fixed port into one job grading the other's
 * app. Holding the first port is what makes this deterministic: the kernel
 * cannot hand out a port something is bound to, so a step that allocates gets
 * another one, and a step that names one does not.
 */
test("a job allocating while another job's app holds its port gets a port of its own", async () => {
  const first = await allocated("http://localhost:${PORT}/api/v1/health");
  using firstApp = holding(first.port);
  expect(firstApp.port).toBe(first.port);

  const second = await allocated("http://localhost:${PORT}/api/v1/health");

  expect(second.port).not.toBe(first.port);
  expect(second.healthUrl).toBe(`http://localhost:${second.port}/api/v1/health`);
});
