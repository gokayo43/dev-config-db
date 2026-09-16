// oxlint-disable no-console -- this file's subject IS stdout: it replaces console.log to read what the protocol wrote, and restores it
import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inputs,
  mask,
  publish,
  relay,
  required,
  stepOutput,
} from "../.github/actions/_lib/annotations.ts";

/**
 * The log protocol, which had no suite at all until this file: only `import
 * type` reached it, so the coverage floor graded none of it — including
 * `commanded`, the function this repo deliberately diverges from dev-config on.
 *
 * What every case here is really about is one property: **nothing this repo
 * writes to stdout can be read by the runner as a command unless this repo
 * meant it as one.** The runner matches `::` after trimming a line's leading
 * whitespace, so the test for every path is the same — take what it wrote, trim
 * each line, and see which ones start with `::`.
 */

/** stdout, captured, the way the runner would read it. */
async function written(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log: typeof console.log = console.log.bind(console);
  console.log = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines;
}

const ENTRY = new URL("../.github/actions/_lib/annotations.ts", import.meta.url).pathname;

/** The lines the runner would treat as its own commands. */
function commands(lines: readonly string[]): string[] {
  return lines.filter((line) => line.trimStart().startsWith("::"));
}

test("a newline in a problem cannot end the annotation and start a second command", async () => {
  const lines = await written(async () => {
    await publish({ problems: ["could not read `t`\n::stop-commands::deadbeef"] });
  });

  expect(lines).toEqual(["::error::could not read `t`%0A::stop-commands::deadbeef"]);
  expect(commands(lines)).toHaveLength(1);
});

test("a carriage return and a percent are escaped the way GitHub decodes them", async () => {
  const lines = await written(async () => {
    await publish({ note: "100% done\rand back", problems: [] });
  });

  expect(lines).toEqual(["::notice::100%25 done%0Dand back"]);
});

test("percent is escaped first, so an introduced escape is not escaped again", async () => {
  const lines = await written(async () => {
    await publish({ problems: ["a%0Ab\nc"] });
  });

  // The literal `%0A` the message carried survives as `%250A`; the real newline
  // becomes `%0A`. Escaping the newline first would render both identically and
  // the reader could not tell which had been in the value.
  expect(lines).toEqual(["::error::a%250Ab%0Ac"]);
});

/**
 * The log sink, which is the one this repo had wrong: a schema dump is text the
 * graded repo wrote, and a routine body holding a newline and `::stop-commands::`
 * reaches the log as a line of its own. Indenting it does not help — whitespace
 * is exactly what the runner trims before it matches.
 */
test("a dump line that is a workflow command reaches the log as text", async () => {
  const lines = await written(async () => {
    await publish({
      log: "the schema after a second replay, from line 2:\n  ::stop-commands::deadbeef",
      problems: ["replaying changed the schema"],
    });
  });

  expect(lines).toEqual([
    "| the schema after a second replay, from line 2:",
    "|   ::stop-commands::deadbeef",
    "::error::replaying changed the schema",
  ]);
  // The gate's own annotation, and nothing the dump asked for.
  expect(commands(lines)).toEqual(["::error::replaying changed the schema"]);
});

/**
 * The same class, one character further on. The runner reads stdout with
 * `StreamReader.ReadLine`, which ends a line on a carriage return as well as on
 * a line feed — so a dump line carrying a bare `\r` is one line to a split on
 * `\n` and two to the runner, and the second would have arrived with no margin
 * on it. MariaDB really does produce such a line: a routine body is stored and
 * re-dumped as source text, so `select 'x\r::stop-commands::…'` survives
 * verbatim.
 */
test("a bare carriage return inside a dump line does not smuggle a line past the margin", async () => {
  const lines = await written(() => {
    relay("  select 'x\r::stop-commands::deadbeef' as v");
  });

  expect(lines).toEqual(["|   select 'x", "| ::stop-commands::deadbeef' as v"]);
  expect(commands(lines)).toEqual([]);
});

test("a CRLF ends one line rather than two", async () => {
  expect(await written(() => relay("first\r\nsecond"))).toEqual(["| first", "| second"]);
});

test("a trailing carriage return is a line ending too", async () => {
  expect(await written(() => relay("only\r"))).toEqual(["| only"]);
});

test("relayed output keeps its shape, one line at a time", async () => {
  expect(await written(() => relay("first\nsecond\nthird"))).toEqual([
    "| first",
    "| second",
    "| third",
  ]);
});

test("a trailing newline is a line ending rather than an empty last line", async () => {
  expect(await written(() => relay("only\n"))).toEqual(["| only"]);
});

/**
 * `commanded` is deliberately NOT applied to relayed output: it is plain
 * stdout, GitHub decodes no escapes in it, and a percent run through it would
 * render as `%25` in the log a developer reads.
 */
test("a percent in relayed output is left alone", async () => {
  expect(await written(() => relay("100% applied"))).toEqual(["| 100% applied"]);
});

test("the log goes out before the annotation that summarises it", async () => {
  const lines = await written(async () => {
    await publish({ log: "evidence", note: "a note", problems: ["a problem"] });
  });

  expect(lines).toEqual(["| evidence", "::notice::a note", "::error::a problem"]);
});

test("a verdict with no problems leaves the step green", async () => {
  const before = process.exitCode;
  await written(async () => await publish({ note: "all well", problems: [] }));
  expect(process.exitCode).toBe(before);
});

test("every problem is annotated rather than only the first", async () => {
  const lines = await written(async () => await publish({ problems: ["one", "two", "three"] }));
  expect(commands(lines)).toHaveLength(3);
  process.exitCode = 0;
});

/**
 * The run summary, which is where a measurement goes: an annotation is one line
 * on a step and a table is what a reader compares with the last run's. The two
 * cases are the whole of the contract — it is written for a run about to fail,
 * and a gate that builds one with nowhere to put it is a wiring fault rather
 * than a run.
 */
test("a table is published before the annotations, including on the run that fails", async () => {
  const into = join(tmpdir(), `summary-${Bun.randomUUIDv7()}.md`);
  try {
    const lines = await written(
      async () =>
        await publish({ table: "### Capacity\n", problems: ["half the requests failed"] }, into),
    );

    // A summary that appeared only on green runs would be missing from every
    // run that needed one.
    expect(await Bun.file(into).text()).toBe("### Capacity\n");
    expect(commands(lines)).toEqual(["::error::half the requests failed"]);
  } finally {
    await rm(into, { force: true });
    process.exitCode = 0;
  }
});

test("a table with nowhere to go is a wiring fault, raised after what it found", async () => {
  const lines: string[] = [];
  const log: typeof console.log = console.log.bind(console);
  console.log = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  let refused: unknown;
  try {
    await publish({ table: "### Capacity\n", problems: ["a problem"] });
  } catch (thrown) {
    refused = thrown;
  } finally {
    console.log = log;
    process.exitCode = 0;
  }
  expect(String(refused)).toContain("named no step summary");

  // Raised after the annotations rather than before them: a step that died on
  // the way to writing a table would otherwise lose every problem it had just
  // found, and the failure would reach the log as a stack trace about a file
  // path.
  expect(commands(lines)).toEqual(["::error::a problem"]);
});

/**
 * The mask, which is the one line here that is MEANT to be a command — and is
 * still a command carrying a value the gate did not write: the server step masks
 * the password out of the URL its calling job declared.
 */
test("a masked value is escaped like every other message this file writes", async () => {
  const lines = await written(() => {
    mask("p%ss\n::stop-commands::deadbeef");
  });

  // Written raw, the newline would end the mask and hand the runner the rest as
  // a command of its own — the same class every case above is about, on the one
  // path whose whole purpose is to be obeyed.
  expect(lines).toEqual(["::add-mask::p%25ss%0A::stop-commands::deadbeef"]);
  expect(commands(lines)).toHaveLength(1);
});

/**
 * And the value that cannot be masked. The runner warns on an empty mask and
 * replaces nothing, so asking is a line in every run's log that says the gate
 * tried to hide something it did not have.
 */
test("the empty string is not masked at all", async () => {
  expect(await written(() => mask(""))).toEqual([]);
});

/**
 * The step output, which is how a gate answers its caller with a value the
 * steps after it cannot rewrite — `db-server` names the port docker assigned.
 */
test("a step output is one name=value line, and a second call keeps the first", async () => {
  const file = join(tmpdir(), `outputs-${Bun.randomUUIDv7()}.txt`);
  Bun.env["GITHUB_OUTPUT"] = file;
  try {
    await stepOutput("database-url", "mysql://root:db-gate@127.0.0.1:33640/app");
    await stepOutput("container", "db-gate-server-0123456789abcdef");

    expect(await Bun.file(file).text()).toBe(
      "database-url=mysql://root:db-gate@127.0.0.1:33640/app\ncontainer=db-gate-server-0123456789abcdef\n",
    );
  } finally {
    delete Bun.env["GITHUB_OUTPUT"];
    await rm(file, { force: true });
  }
});

/**
 * The line form ends at the first terminator the runner honours, so a value
 * carrying one would arrive as an output the gate never wrote — the wrong
 * implementation is the obvious one, a write with nothing asked of the value.
 * All three terminators, because the runner reads its outputs the way it reads
 * its log: a bare carriage return ends a line there too.
 */
test("a value carrying any line terminator is refused rather than written", async () => {
  const file = join(tmpdir(), `outputs-${Bun.randomUUIDv7()}.txt`);
  Bun.env["GITHUB_OUTPUT"] = file;
  try {
    for (const value of ["one\ntwo=three", "one\rtwo=three", "one\r\ntwo=three"]) {
      // Caught rather than asserted on the promise, the way the table case
      // above does: what a write that asked nothing of the value returns is a
      // resolved promise, and `refused` staying undefined is what says so.
      let refused: unknown;
      try {
        await stepOutput("database-url", value);
      } catch (thrown) {
        refused = thrown;
      }
      expect(String(refused)).toContain("the database-url output carries a line break");
    }
    // And nothing was written on the way to refusing.
    expect(await Bun.file(file).exists()).toBe(false);
  } finally {
    delete Bun.env["GITHUB_OUTPUT"];
    await rm(file, { force: true });
  }
});

test("a gate answering with a value and no GITHUB_OUTPUT to write it to is refused by name", async () => {
  const held = Bun.env["GITHUB_OUTPUT"];
  delete Bun.env["GITHUB_OUTPUT"];
  try {
    let refused: unknown;
    try {
      await stepOutput("container", "db-gate-server-0123456789abcdef");
    } catch (thrown) {
      refused = thrown;
    }
    expect(String(refused)).toContain("GITHUB_OUTPUT is not set");
  } finally {
    if (held !== undefined) Bun.env["GITHUB_OUTPUT"] = held;
  }
});

test("an input the action forgot to pass is refused by name", async () => {
  expect(() => inputs("database-image")).toThrow("INPUT_DATABASE_IMAGE is not set");
});

test("an input's name is read in the environment's spelling", async () => {
  Bun.env["INPUT_FROM_EMPTY"] = "/tmp/x.schema";
  try {
    expect(inputs("from-empty")["from-empty"]).toBe("/tmp/x.schema");
  } finally {
    delete Bun.env["INPUT_FROM_EMPTY"];
  }
});

test("a variable the calling job owns is refused with the reason it was wanted", async () => {
  expect(() => required("DATABASE_URL", "the calling job must set it")).toThrow(
    "DATABASE_URL is not set — the calling job must set it",
  );
});

test("an empty variable is not a value", async () => {
  Bun.env["EMPTY_ON_PURPOSE"] = "";
  try {
    expect(() => required("EMPTY_ON_PURPOSE", "why")).toThrow("is not set");
  } finally {
    delete Bun.env["EMPTY_ON_PURPOSE"];
  }
});

/**
 * The divergence from dev-config this repo carries deliberately: a thrown
 * message quotes what the gate read off the repo under grade, so it is escaped
 * like every other message. Upstream writes it raw — dev-config#71.
 *
 * Driven as a real process rather than with `process.exit` replaced, because
 * exiting is half of what `entry` promises and a stub of it would grade the
 * stub. What comes back is what a runner would see: the bytes, and the status.
 */
test("a thrown message cannot inject a command either, and the step still fails", async () => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `const { entry } = await import(${JSON.stringify(ENTRY)});
       await entry(async () => { throw new Error("could not read \`t\`\\n::stop-commands::deadbeef"); });`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [out, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(status).toBe(1);
  expect(commands(out.split("\n"))).toEqual([
    "::error::could not read `t`%0A::stop-commands::deadbeef",
  ]);
});
