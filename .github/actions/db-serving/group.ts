/**
 * A command this job starts and later has to be able to end, and the two halves
 * of that are one fact: **bash only `exec`s a command that is one simple
 * command.** A pipeline, a subshell, a background job or a command that forks a
 * worker of its own leaves children behind when the shell alone is killed, and
 * those children still hold the write end of whatever pipe the shell was
 * writing down — so a reader waiting for the end of that output never sees it.
 *
 * Under `setsid` the shell is a process-group leader, so a kill addressed to the
 * negated pid takes the whole group. Two gates here need exactly that and for
 * two different reasons — a probe that has to be killable inside its bound, and
 * an app that has to be taken down when it never came up — which is why the
 * argument lives here rather than at either of them.
 *
 * `setsid` is util-linux, on every runner this gate targets. A command meaning
 * to leave something running behind it will not: that is the trade a bound is.
 *
 * Killing the group is not the whole of letting go, which is what `capturing`
 * below is for.
 */

/** The shell, as its own process group. The command is shell because a pipe or an `&&` means what it says. */
export function shellGroup(command: string): string[] {
  return ["setsid", "bash", "-c", command];
}

/**
 * Everything that command started, by the process group `setsid` gave it.
 *
 * The refusal is named rather than guarded away: the group is already gone
 * whenever the command exited between the decision to kill it and this line,
 * and ESRCH is that and nothing else. Whatever is left to say about the run is
 * the annotation the caller is on the way to writing.
 */
export function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group finished on its own between the decision and here.
  }
}

/** A child's output, and the way to stop waiting for it. */
export interface Captured {
  /** Everything that arrived, whether the stream ended or the read was abandoned. */
  readonly text: Promise<string>;
  /** Stop reading and release the pipe. What the child writes after this is gone. */
  abandon: () => void;
}

/**
 * A pipe read this process can put down.
 *
 * `new Response(stream).text()` is the shorter way to spell this and it cannot
 * be undone: the Response locks the stream, so a later `cancel()` throws
 * `ERR_INVALID_STATE` and the read stays pending forever. That matters here
 * because a pending read on a child's pipe **keeps Bun's event loop alive**,
 * and the one case this module exists for is the case where the child is gone
 * and something it started is still holding the write end. Measured on the
 * pinned Bun, killing the group and then racing a grace: with the streams owned
 * by a `Response` the process never exits — `unref()` on the subprocess does
 * not change that, and neither does cancelling a `Response`-locked stream —
 * while cancelling the reader below ends it at once.
 *
 * So a gate that bounds a child holds the reader itself. The text promise still
 * resolves after `abandon`, with whatever had arrived.
 */
export function capturing(stream: ReadableStream<Uint8Array>): Captured {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  const text = (async (): Promise<string> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    return Buffer.concat(parts).toString();
  })();
  return {
    text,
    abandon: () => {
      void reader.cancel();
    },
  };
}
