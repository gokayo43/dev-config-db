import { closeSync, openSync, readFileSync } from "node:fs";

import { plainly, type Verdict } from "../_lib/annotations.ts";

import { killGroup, shellGroup } from "./group.ts";

/**
 * The half that migrations succeeding does not prove: **the app runs against
 * the schema they built.**
 *
 * A migration set can apply cleanly and still leave a database the app cannot
 * start against — a column the ORM's model says is not null and the migration
 * left nullable, an enum the code selects on and the lineage never created, an
 * index a startup query needs. Every one of those is a green replay and a dead
 * deploy. The health route answers only once the process is up and a query has
 * round-tripped, so polling it is what turns that into a red build.
 *
 * Ported from the boot step of dev-config's `db-gate` at the pinned SHA, which
 * is bash inside its `action.yml`. Two deltas, both about what a program can do
 * that a `run:` block cannot:
 *
 *   * the app's own output is **relayed** rather than `cat`-ed into the log. It
 *     is text the graded repo wrote, on the stdout the runner reads its own
 *     commands off — `annotations.ts`'s `MARGIN` docblock is the whole
 *     argument, and dev-config#71 is the hole upstream;
 *   * a `health-url` that is not a URL is refused by name. Handed to `curl` it
 *     is a connection that never succeeds, so upstream reports it as an app
 *     that did not answer in sixty seconds — a diagnostic that sends its reader
 *     to the app rather than to the input.
 *
 * And one addition: the app is killed when it fails to come up. Nothing after
 * this can use it, and a wedged process holding a port until the job's timeout
 * is a runner this suite also has to run on.
 */

/**
 * How long the app gets to answer. dev-config's number, and the argument is
 * theirs: a boot that has wedged is otherwise indistinguishable from a slow one
 * and would spend the job's whole budget saying so, taking the probe, the ramp
 * and every piece of evidence after it down with it.
 */
export const BOOT_SECONDS = 60;

/** How long between attempts. The app is a local process, so this is a poll rather than a backoff. */
const BETWEEN_MS = 500;

/**
 * The most one attempt gets, bounded for the reason the whole poll is: a
 * process that accepts the connection and never answers is otherwise
 * indistinguishable from a slow boot, and the fetch would sit on it with
 * nothing logged. Never longer than what is left of the bound above — an
 * attempt that could outlive the deadline it is inside of is not a bound.
 */
const ATTEMPT_MS = 5_000;

export interface Boot {
  /** The project the calling job declared: where the start command runs. */
  readonly root: string;
  /** How to start the app, as shell. */
  readonly command: string;
  /** What is polled until it answers 200. */
  readonly url: string;
  /** Where the app's own output is written, for the diagnostics here and for the evidence artifact. */
  readonly log: string;
  /** How long the app gets. */
  readonly seconds: number;
}

/**
 * The command, refused rather than run when there is none. A composite action
 * maps a missing input to the empty string, so `required: true` in an
 * action.yml is a promise nothing enforces at runtime, and `bash -c ""` is a
 * shell that exits 0 having started no app at all — which this step would then
 * report as an app that died before answering.
 */
export function startCommandFrom(value: string): string {
  if (value.trim() === "") {
    throw new Error(
      "start-command is empty — this step boots the app the migrations have to be able to run, and there is nothing here to start",
    );
  }
  return value;
}

/**
 * The URL, refused rather than polled when it is not one. Every step after this
 * takes the app from here — the probe under `HEALTH_URL`, the ramp and the
 * route log from its origin — so a value nothing can parse is refused once,
 * here, rather than three times in three vocabularies.
 */
export function healthUrlFrom(value: string): string {
  if (value.trim() === "") {
    throw new Error(
      "health-url is empty — it is what says the app came up, and every step after this one is aimed at it",
    );
  }
  // The scheme is half the check and it is the half a parse alone misses:
  // `localhost:3000/health` is a URL to `new URL` — with `localhost:` read as
  // its scheme — and a fetch of it fails on the protocol rather than on the
  // app. Polled, either shape is an app that never answers, and the diagnostic
  // would send its reader to the app.
  const parsed = URL.parse(value);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(
      `health-url is '${value}', which is not an http(s) URL — polled as one it would never answer, and this step would report a healthy app as one that failed to start`,
    );
  }
  return parsed.href;
}

/**
 * Whether the process this step started is running, asked of the kernel rather
 * than of the runtime.
 *
 * `Subprocess.exitCode` is set when Bun delivers the child's exit, which is an
 * event — and a request to something already listening on the health URL comes
 * back in about a millisecond, long before that event arrives. Measured against
 * this file's own suite: a start-command of `exit 1` with a stranger on the URL
 * published `boot: the app answered … after 0.0s`, green, with the exit code
 * still unread. So the aliveness of the app is read from `/proc` at the moment
 * its answer is, where it is a fact rather than a notification, and a child Bun
 * has not reaped yet is a zombie there — `Z`, which is not running.
 *
 * Linux only, like `killGroup` beside it: what this gate targets is a
 * `[self-hosted, linux]` runner.
 *
 * The state is read from after the LAST `)`, because the field before it is the
 * executable's name and a name may hold spaces and parentheses of its own.
 * `ENOENT` is the process already reaped, which is the same answer as `Z`.
 */
function running(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  return (
    stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .charAt(0) !== "Z"
  );
}

/** Whether the app answered, which is the whole of what 200 here means. */
async function answers(url: string, within: number): Promise<boolean> {
  try {
    const answered = await fetch(url, { signal: AbortSignal.timeout(within) });
    await answered.text();
    return answered.ok;
  } catch {
    // Nothing listening yet, a connection refused, an attempt that ran out of
    // time: every one of them is "not up yet", and the loop's own bound is what
    // decides when that stops being worth waiting for.
    return false;
  }
}

export async function bootGate({ root, command, url, log, seconds }: Boot): Promise<Verdict> {
  // Asked before anything is started, and it is the half of "did the app boot"
  // that no poll can answer afterwards: a URL already answering is a URL whose
  // 200 belongs to something this step did not start, and the poll below cannot
  // tell that from the app coming up. On a fresh cloud VM there was nothing
  // else on the box; on a shared, persistent runner there is — and the cost of
  // missing it is not one wrong verdict but a green boot, a probe and twenty
  // ramp VUs all run against a stranger while the app under grade never ran.
  //
  // Refused rather than waited out, because nothing about it improves with
  // time. The database job allocates the port it polls, so a consumer that
  // meets this is one whose health-url names a port of its own.
  if (await answers(url, ATTEMPT_MS)) {
    return {
      problems: [
        `${url} already answers, and this step has started nothing yet — so something else on this machine is serving it, and a 200 from it would be this step reporting a boot that never happened. Leave health-url unset and the job allocates a port for the app, or name one nothing else on the runner holds.`,
      ],
    };
  }

  // Opened rather than piped: the app outlives this process — the probe and the
  // ramp run against it in later steps — so nothing here can be holding the
  // read end of its output.
  const output = openSync(log, "w");
  const app = Bun.spawn(shellGroup(command), {
    cwd: root,
    env: plainly(process.env),
    stdout: output,
    stderr: output,
  });

  // The two things this process must let go of, and they are the whole of why a
  // healthy boot ends at all.
  //
  // A subprocess keeps Bun's event loop alive for as long as it runs, and the
  // app here is meant to outlive this step by design — so a gate that published
  // a perfect verdict would then sit on a process that never exits, the step
  // would hang until the job's timeout, and the probe and the ramp would never
  // run. Only a FAILING boot ended, because killing the app is what happened to
  // drop that reference. Unref'd, the loop is held by this gate's own poll and
  // nothing else, and the app is left running exactly as the contract above
  // says.
  //
  // The descriptor is the child's from the moment it is spawned — it holds a
  // dup — so this one is ours to close, and closing it is what stops one
  // descriptor per call accumulating in a suite that makes many.
  app.unref();
  closeSync(output);

  const started = Date.now();
  const deadline = started + seconds * 1000;
  const failed = async (problem: string): Promise<Verdict> => {
    killGroup(app.pid);
    return { log: await Bun.file(log).text(), problems: [problem] };
  };

  for (;;) {
    // The answer and the process that owes it, read together: a 200 is this
    // step's verdict only when the app this step started is alive to have
    // served it. The health URL is a port on a machine other things also listen
    // on, so on a shared, persistent runner a stranger already on it turns a
    // start-command that died into a green boot — and the probe and twenty ramp
    // VUs are then aimed at the stranger while the app under grade never ran.
    //
    // What this narrows: an app that answers and dies in the microseconds
    // before the line below is read is reported as having exited rather than as
    // having booted. It is not serving either way, and every step after this
    // one would have found nothing.
    const attempt = Math.min(ATTEMPT_MS, Math.max(deadline - Date.now(), 1));
    const answered = await answers(url, attempt);
    if (running(app.pid)) {
      if (answered) {
        return {
          note: `boot: the app answered ${url} after ${((Date.now() - started) / 1000).toFixed(1)}s`,
          problems: [],
        };
      }
    } else {
      // Gone, so `exited` is a wait on an event already owed rather than on the
      // app — and it is what fills in the code the diagnostic quotes.
      //
      // Both halves of that, because a child that died on a signal has NO exit
      // code: `exitCode` stays null and `signalCode` carries the name. That is
      // not an exotic case on a runner — it is what the OOM killer does to an
      // app booting against a schema it cannot hold in memory — and reading
      // only the code would name an exit nobody chose.
      await app.exited;
      const how =
        app.signalCode === null
          ? `exited ${app.exitCode}`
          : `was killed by ${app.signalCode}, so it never chose an exit code`;
      return await failed(
        answered
          ? `the app ${how} and ${url} answered anyway — so something other than the app this step started is serving that URL, and every step after this one would have run against it. Its own output is above.`
          : `the app ${how} before ${url} answered — its own output is above. A migration set that applies and leaves the app unable to start against the schema it built is what this step is here to catch; a start-command that is wrong is the other reading, and the output says which.`,
      );
    }
    if (Date.now() >= deadline) {
      return await failed(
        `${url} did not answer within ${seconds}s and the app is still running — its own output is above. Either it is still starting, or it is up and this URL is not the one it serves.`,
      );
    }
    await Bun.sleep(BETWEEN_MS);
  }
}
