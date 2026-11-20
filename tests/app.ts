import { join } from "node:path";

import { killGroup } from "../.github/actions/db-serving/group.ts";

/**
 * The app the boot and probe suites run against, as a real process on a real
 * port. Nothing here stands in for the app: what those gates assert is what a
 * process does — that it came up, that it answered — and a stand-in for the
 * process would be grading the stand-in.
 *
 * `served-app.ts` beside this file is the program; this is how a case starts
 * one and how the run takes it down again.
 */

/** The program a case starts, by the path a `start-command` would name it under. */
const PROGRAM = join(import.meta.dir, "served-app.ts");

/** What a case asks the app to be. `served-app.ts` says what each one does. */
export type Mode = "serving" | "dies" | "killed" | "hangs";

const running: string[] = [];

/**
 * Every app any case started, taken down after it — by the process group, so
 * that a shell between this suite and the app goes with it. Called from
 * `tests/preload.ts` rather than registered here, for the reason `tree.ts` says
 * at `removeRoots`: a hook at the top level of an imported module attaches to
 * the file that imported it first, and an app left running holds a port and a
 * database connection for the rest of the run and after it.
 */
export async function stopApps(): Promise<void> {
  for (const file of running.splice(0)) await stop(file);
}

/** The app whose pid is in this file, and everything it started. */
export async function stop(pidFile: string): Promise<void> {
  const file = Bun.file(pidFile);
  if (!(await file.exists())) return;
  const pid = Number((await file.text()).trim());
  if (!Number.isInteger(pid)) return;
  killGroup(pid);
  try {
    // The group kill reaches everything under `setsid`; this reaches an app a
    // case started without one. Both are refused when the process is already
    // gone, which is the ordinary case.
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * A port nothing is on. Taken by binding one and letting go, which is what
 * every "find a free port" is: two suites racing for the same number is
 * possible and one run per checkout is what this repo's suite already assumes.
 */
export async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const { port } = held;
  await held.stop(true);
  if (port === undefined) throw new Error("a server bound to port 0 reported no port");
  return port;
}

/** Where a case's app is asked to leave its pid, so the run can end it. */
export function pidFileIn(root: string): string {
  const file = join(root, "app.pid");
  running.push(file);
  return file;
}

/**
 * A `start-command` as a consuming repo writes one: shell, with the app's own
 * settings in front of it. What the gate does with it is the point of the
 * suites that call this.
 */
export function startCommand(port: number, pidFile: string, mode: Mode = "serving"): string {
  return `APP_MODE=${mode} APP_PID_FILE=${pidFile} bun ${PROGRAM} ${port}`;
}

/**
 * Whether a process this run started is gone, waited for rather than asked
 * once: a signal is delivered rather than awaited, so a case asserting that
 * something was killed is asserting about a moment that has not arrived yet.
 * The wait is bounded, and a `false` here is a real answer — the process
 * outlived the kill that was supposed to take it.
 */
export async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      // Signal 0 asks the question without sending anything: it throws when
      // there is no such process, and the app here is orphaned rather than a
      // child of this one, so nothing can be answering as a zombie.
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await Bun.sleep(50);
  }
}

/** The pid a case's app wrote down, for a case whose subject is whether it is still there. */
export async function pidIn(pidFile: string): Promise<number> {
  const written = Number((await Bun.file(pidFile).text()).trim());
  if (!Number.isInteger(written)) throw new Error(`${pidFile} holds no pid`);
  return written;
}
