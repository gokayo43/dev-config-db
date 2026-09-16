/**
 * An app for the boot, probe and ramp suites to run against: a real process,
 * started the way a consuming repo's `start-command` starts one, serving a
 * health route, a couple of ordinary routes and the counter endpoint the
 * coverage floor reads.
 *
 * It imports the protocol from **dev-config's own `route-log.ts`**, which is
 * what a consuming app imports — the export exists so that neither end of the
 * contract reproduces it from memory. So what these suites drive the gate
 * against is a payload built from the published protocol rather than one this
 * repo wrote to match its own reader.
 *
 * `APP_MODE` is how a case asks for the app that is not fine. Each is a real
 * failure a consuming repo has: a process that dies on the way up because the
 * schema is not what it expected, one the kernel takes with no exit code of its
 * own, one that accepts connections and never answers, and one that serves
 * everything except the instrument.
 */
import { ENDPOINT, EVERY_METHOD, type Served } from "@gokayo43/dev-config/route-log";

const port = Number(process.argv[2]);
const mode = Bun.env["APP_MODE"] ?? "serving";

// Written before anything else a case waits on, so that a case can take the
// process down by its group however the run went.
const pidFile = Bun.env["APP_PID_FILE"];
if (pidFile !== undefined) await Bun.write(pidFile, String(process.pid));

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

/** Every route this app serves, as its router registered them. */
const ROUTE_TABLE = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/api/things" },
  { method: "POST", path: "/api/things" },
  { method: EVERY_METHOD, path: "/api/events" },
];

const counts = new Map<string, number>();

function took(method: string, path: string): void {
  const key = `${method} ${path}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function tally(): Served[] {
  return [...counts].map(([key, count]) => {
    const [method = "", ...rest] = key.split(" ");
    return { method, path: rest.join(" "), count };
  });
}

/** The path a request landed on, as the route table spells it rather than as the URL does. */
function routed(pathname: string): string | undefined {
  return ROUTE_TABLE.some((route) => route.path === pathname) ? pathname : undefined;
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    // The instrument leaves itself out of both lists, and out of the counting:
    // the gate's own two fetches are not the scenario's traffic.
    if (pathname === ENDPOINT) {
      if (mode === "no-instrument") return new Response("not found", { status: 404 });
      // The shape a single-page app's catch-all gives every unmatched path: 200,
      // and a page. Worse than a 404 for a floor, because it looks like an
      // answer.
      if (mode === "html-catch-all") {
        return new Response("<!doctype html><title>app</title>", {
          headers: { "content-type": "text/html" },
        });
      }
      return Response.json({ routeTable: ROUTE_TABLE, counts: tally() });
    }
    const path = routed(pathname);
    if (path === undefined) return new Response("no such route", { status: 404 });
    took(request.method, path);
    // Accepted and never answered: what a wedged app looks like from outside,
    // which is otherwise indistinguishable from one that is still starting.
    if (mode === "hangs") await new Promise(() => {});
    return Response.json({ ok: true });
  },
});
