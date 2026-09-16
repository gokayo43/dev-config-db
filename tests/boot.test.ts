import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  BOOT_SECONDS,
  bootGate,
  healthUrlFrom,
  startCommandFrom,
} from "../.github/actions/db-serving/boot.ts";

import { freePort, gone, pidFileIn, pidIn, startCommand } from "./app.ts";
import { materialise } from "./tree.ts";

/**
 * A real app, started the way a consuming repo's `start-command` starts one and
 * polled the way the shipped step polls it. What this gate claims is that a
 * process came up against the schema the replay built, and nothing short of a
 * process can be the subject of that claim.
 *
 * `app.ts` is how a case starts one and how the run takes it down again.
 */

interface Ran {
  readonly verdict: Awaited<ReturnType<typeof bootGate>>;
  readonly took: number;
  readonly pidFile: string;
  readonly url: string;
}

async function boot(mode: Parameters<typeof startCommand>[2], seconds: number): Promise<Ran> {
  const root = await materialise({});
  const port = await freePort();
  const pidFile = pidFileIn(root);
  const url = `http://127.0.0.1:${port}/health`;
  const started = Date.now();
  const verdict = await bootGate({
    root,
    command: startCommand(port, pidFile, mode),
    url,
    log: join(root, "server.log"),
    seconds,
  });
  return { verdict, took: Date.now() - started, pidFile, url };
}

test("an app that answers its health route boots, and is left running for the steps after it", async () => {
  const { verdict, url } = await boot("serving", BOOT_SECONDS);

  expect(verdict.problems).toEqual([]);
  expect(verdict.note).toContain(url);

  // The probe and the ramp run against this process in later steps. A boot step
  // that took the app down with it would leave both of them with nothing, and
  // the failure would surface two steps away from its cause.
  const still = await fetch(url, { signal: AbortSignal.timeout(5000) });
  expect(still.ok).toBe(true);
});

test("an app that dies on the way up is refused by its exit, not by the bound", async () => {
  // The whole point of the step: migrations that apply, and an app that cannot
  // run against what they built. The bound is generous on purpose — a gate that
  // reported this as a slow boot would have spent sixty seconds to send its
  // reader to the wrong place.
  const { verdict, took } = await boot("dies", BOOT_SECONDS);

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("the app exited 3 before");
  expect(verdict.problems[0]).toContain("unable to start against the schema it built");
  // What the app itself said, which is the only thing that names the cause.
  expect(verdict.log).toContain("FATAL: relation `thing` does not exist");
  // Polling the URL alone is the plausible wrong implementation, and it is
  // indistinguishable from this one until the bound runs out.
  expect(took).toBeLessThan(BOOT_SECONDS * 1000);
  expect(took).toBeLessThan(20_000);
});

/**
 * The failure a shared, persistent runner has and a fresh VM does not: the
 * health URL is a port on a machine other things also listen on, and a 200 off
 * it says nothing about the process this step started. Here the stranger is
 * this case's own server and the start-command dies at once — so a gate that
 * polls the URL alone reports a boot, and the probe and twenty ramp VUs after
 * it are aimed at the stranger while the app that was supposed to be under
 * grade never ran.
 */
test("a 200 from something else on the box is not this app's boot", async () => {
  const root = await materialise({});
  const port = await freePort();
  const stranger = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const verdict = await bootGate({
      root,
      command: "exit 1",
      url,
      log: join(root, "server.log"),
      seconds: BOOT_SECONDS,
    });

    expect(verdict.problems).toHaveLength(1);
    // And the diagnostic names the reading that matters here, rather than
    // sending its reader to look for a slow boot.
    expect(verdict.problems[0]).toContain("already answers");
    expect(verdict.problems[0]).toContain("started nothing yet");
    expect(verdict.note).toBeUndefined();
  } finally {
    await stranger.stop(true);
  }
});

test("an app that accepts and never answers is refused at the bound, and taken down", async () => {
  const { verdict, pidFile, took } = await boot("hangs", 2);

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("did not answer within 2s");
  expect(verdict.problems[0]).toContain("still running");
  // An attempt that could outlive the bound it sits inside is not a bound: the
  // per-attempt ceiling is five seconds and this one is two.
  expect(took).toBeLessThan(10_000);
  // Nothing after this step can use the app, and a wedged process holding a
  // port until the job's timeout is a runner this suite also runs on.
  expect(await gone(await pidIn(pidFile))).toBe(true);
});

test("a start-command that is not a command is refused before anything is started", () => {
  expect(() => startCommandFrom("")).toThrow("start-command is empty");
  expect(() => startCommandFrom("   ")).toThrow("start-command is empty");
  expect(startCommandFrom("bun run start")).toBe("bun run start");
});

test("a health-url that is not a URL is refused by name rather than polled to the bound", () => {
  expect(() => healthUrlFrom("")).toThrow("health-url is empty");
  // The whole reason this refusal exists: handed to a poll, each of these is an
  // app that never answers, and the diagnostic would send its reader to the
  // app. The first is a URL as far as `new URL` is concerned — `localhost:` is
  // read as its scheme — which is why the scheme is checked and not just the
  // parse.
  expect(() => healthUrlFrom("localhost:3000/health")).toThrow("not an http(s) URL");
  expect(() => healthUrlFrom("/health")).toThrow("not an http(s) URL");
  expect(healthUrlFrom("http://127.0.0.1:3000/health")).toBe("http://127.0.0.1:3000/health");
});

test("an app the kernel killed is named by its signal rather than waited out", async () => {
  // `exitCode` is null for a signal-killed child — the code is never chosen —
  // so a gate reading it alone spends the whole bound and then reports a live
  // process. That is the canonical runner failure: the OOM killer taking an app
  // booting against a schema it cannot hold in memory.
  const { verdict, took } = await boot("killed", 30);

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("was killed by SIGKILL, so it never chose an exit code");
  expect(took).toBeLessThan(20_000);
});

test("the log descriptor is the child's, not this process's, once the app is started", async () => {
  // The app writes into a file this gate opens, and the child holds a dup of
  // it from the moment it is spawned — so the parent's copy is one descriptor
  // per boot that nothing ever closes. One per run of the shipped step is
  // bounded; in a suite that boots many, it is a leak with a fixed cost per
  // case and no ceiling.
  const open = (): number => readdirSync("/proc/self/fd").length;

  const before = open();
  for (let each = 0; each < 3; each++) await boot("dies", BOOT_SECONDS);

  // Not "equal": a test runner has its own reasons to open a file. What this
  // refuses is growth in proportion to the number of boots.
  expect(open() - before).toBeLessThan(3);
});
