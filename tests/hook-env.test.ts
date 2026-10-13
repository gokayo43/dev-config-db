import { expect, test } from "bun:test";

import { mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { checkout } from "./action-step.ts";
import { headOf } from "./repo.ts";
import { root } from "./workflow.ts";

/**
 * The suite run the way lefthook's pre-push runs it from a linked worktree:
 * through the shipped command, with GIT_DIR naming the repository being pushed.
 * That repository has to come out of the run exactly as it went in, and the
 * fixtures' git has to act on the fixtures — without the unset, a push from a
 * worktree committed every fixture onto the branch being pushed and read that
 * branch's history as the fixtures'.
 *
 * Narrowed to base-lineage, the file that drives git fixtures without a server,
 * so the case costs seconds rather than containers.
 */
test("the pre-push suite leaves the repository being pushed alone", async () => {
  const hook: unknown = Bun.YAML.parse(await Bun.file(`${root}/lefthook.yml`).text());
  const command = textAt(mapAt(mapAt(mapAt(hook, "pre-push"), "commands"), "test"), "run");
  if (command === undefined || !command.endsWith("bun test")) {
    throw new Error(
      `lefthook.yml's pre-push test command is ${command}, not one ending in bun test`,
    );
  }

  const pushed = await checkout();
  const env = { ...process.env, GIT_DIR: `${pushed}/.git` };
  const identity = ["-c", "user.name=suite", "-c", "user.email=suite@example.invalid"];
  expect(Bun.spawnSync(["git", "init", "--quiet", pushed]).exitCode).toBe(0);
  const commit = ["commit", "--quiet", "--allow-empty", "-m", "pushed"];
  expect(Bun.spawnSync(["git", ...identity, ...commit], { cwd: pushed, env }).exitCode).toBe(0);
  const before = await headOf(pushed, "HEAD");

  const run = Bun.spawn(["sh", "-c", `${command} tests/base-lineage.test.ts`], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);

  expect(`${await run.exited}\n${out}${err}`).toStartWith("0\n");
  expect(await headOf(pushed, "HEAD")).toBe(before);
}, 120_000);
