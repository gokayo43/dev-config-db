/**
 * An app for the boot and probe suites to run against: a real process, started
 * the way a consuming repo's `start-command` starts one, serving a health route.
 *
 * `APP_MODE` is how a case asks for the app that is not fine. Each is a real
 * failure a consuming repo has: a process that dies on the way up because the
 * schema is not what it expected, one the kernel takes with no exit code of its
 * own, and one that accepts connections and never answers.
 */
import { writeFileSync } from "node:fs";

const port = Number(process.argv[2]);
const mode = Bun.env["APP_MODE"] ?? "serving";

// Written before anything else a case waits on, so that a case can take the
// process down by its group however the run went.
const pidFile = Bun.env["APP_PID_FILE"];
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

if (mode === "killed") {
  // What the OOM killer does to an app booting against a schema it cannot hold:
  // no exit code at all, only a signal. The canonical runner failure, and the
  // one a gate reading `exitCode` alone cannot see.
  process.kill(process.pid, "SIGKILL");
}

if (mode === "dies") {
  // On stdout, the way a runtime reports what it could not do. The boot step
  // has to carry this into the log, or a red build says only that something
  // exited.
  process.stdout.write("FATAL: relation `thing` does not exist\n");
  process.exit(3);
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    if (new URL(request.url).pathname !== "/health") {
      return new Response("no such route", { status: 404 });
    }
    // Accepted and never answered: what a wedged app looks like from outside,
    // which is otherwise indistinguishable from one that is still starting.
    if (mode === "hangs") await new Promise(() => {});
    return Response.json({ ok: true });
  },
});
