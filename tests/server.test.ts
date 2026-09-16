import { describe, expect, test } from "bun:test";

import { startServer } from "../.github/actions/db-server/server.ts";

import { DEFAULT, PRODUCTS, emptyDatabase, noteOf, query, server } from "./servers.ts";
import { serviceImages } from "./workflow.ts";

/**
 * The step that stands where a service container used to, and the reason it has
 * a suite of its own: everything after it in the job assumes a server that is up
 * and answering, and the runner is no longer the thing that decided that.
 *
 * A service container is health-checked by the runner, which refuses to start
 * the job's steps until it passes. A step is not: it says the server is up, and
 * every gate after it believes that. So the cases below are the ways it could
 * say so wrongly — a server that never answers, a container that came up and
 * died, a name a previous run left behind — and each asserts the failure
 * surfaces rather than the job carrying on into a gate that will report a
 * refused connection as if it were a fact about the graded repo.
 */

/** An image that is not a database server at all: it starts, stays up, and never answers a query. */
const [NOT_A_SERVER] = await serviceImages();
if (NOT_A_SERVER === undefined) {
  throw new Error(
    "the wrapper declares no service image, and these cases need one that is not a database",
  );
}

/** A bound short enough to be a test and long enough that a slow box does not decide the verdict. */
const BRIEF = 10_000;

/** What a caller declares: the account, the password and the database, and no port — docker assigns that. */
const SERVER = "mysql://root:db-gate@127.0.0.1/app";

/** A container name of this file's own, so a case never reclaims the suite's shared servers. */
function named(what: string): string {
  return `dev-config-db-case-${process.pid}-${what}`;
}

/** Whatever this case started, gone — asserted nowhere, because a leaked container is not this file's verdict. */
async function removed(name: string): Promise<void> {
  const proc = Bun.spawn(["docker", "rm", "--force", name], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

for (const product of PRODUCTS) {
  describe(product.name, () => {
    /**
     * The shared server every other suite here runs against, which this file is
     * the one place asserting anything about: it came up through the shipped
     * step, it answers, and the step said which server it got.
     *
     * The version is the assertion worth having. A step that started a container
     * and reported success without connecting would pass everything else in this
     * file's neighbourhood; what it cannot do is quote the server back.
     */
    test("the server the caller pinned comes up, answers, and says which server it is", async () => {
      const note = await noteOf(product);
      const { port } = new URL(await server(product));

      expect(note).toContain("came up on port");
      expect(note).toContain("and answered as");
      // And it is this product's server rather than the other one. A suite that
      // ran both legs against one server would pass every case in this repo
      // while certifying half of what it claims.
      expect(note).toContain(product.version);
      // The port every other suite here connects on is the one docker assigned,
      // named in the line the step leaves behind — a step that answered with the
      // declaration it was handed would carry no port at all.
      expect(port).not.toBe("");
      expect(note).toContain(`came up on port ${port}`);
    }, 180_000);

    test("a database made on it is the database the gates then read", async () => {
      const url = await emptyDatabase(product);

      expect(await query(url, "select database() as here")).toHaveLength(1);
    }, 180_000);

    /**
     * The container's own death, which is the failure mode a step has and a
     * service container does not: the runner would have refused to start the job.
     * Here the step is what has to notice, and the most plausible wrong
     * implementation polls until the deadline and reports a timeout — which sends
     * a reader looking for a slow server rather than at the image's own first
     * line, where the reason is.
     *
     * An empty password is how both images are made to die: their entrypoints
     * refuse to initialise a fresh data directory without one.
     */
    test("a server that comes up and dies is named as that, with its own output", async () => {
      const as = named(`dies-${product.name.toLowerCase()}`);
      try {
        const verdict = await startServer({
          image: product.image,
          url: "mysql://root:@127.0.0.1/app",
          as,
          within: BRIEF,
        });

        expect(verdict.problems).toHaveLength(1);
        expect(verdict.problems[0]).toContain("started and then stopped");
        expect(verdict.note).toBeUndefined();
        // Never a refusal with nothing to show for itself: what the server said
        // on its way down is the whole of why it went down.
        expect(verdict.log ?? "").not.toBe("");
      } finally {
        await removed(as);
      }
    }, 120_000);
  });
}

/**
 * A container that is up and is not a server: it never answers, and the step has
 * to end on its own bound rather than on the job's. The wrong implementation is
 * a poll with no deadline at all, which is a step that hangs for fifteen minutes
 * and takes every later step down with it.
 */
test("a server that never answers is refused at the bound, not at the job's timeout", async () => {
  const as = named("silent");
  try {
    const started = Date.now();
    const verdict = await startServer({
      image: NOT_A_SERVER,
      url: SERVER,
      as,
      within: BRIEF,
    });

    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain("never answered a query");
    // The bound is the bound: a step that gave up early would report the same
    // sentence over a server that was still initialising.
    expect(Date.now() - started).toBeGreaterThanOrEqual(BRIEF);
  } finally {
    await removed(as);
  }
}, 120_000);

/**
 * The name is reclaimed rather than assumed free. A run killed outright leaves
 * its container behind, and the next run derives the same name — so without this
 * the second run of a suite, or a re-run of a job on a self-hosted runner, dies
 * on a name conflict that has nothing to do with the repo under grade.
 */
test("a container left behind by a previous run is reclaimed rather than collided with", async () => {
  const as = named("reclaimed");
  const url = SERVER;
  try {
    // Twice over the image that never answers, because what is under test is the
    // reclaim rather than the server: the second start meets a container of that
    // name already running, and has to replace it. A step that did not would
    // report docker's own "name is already in use" — a fault of this repo's,
    // reported to a consumer as if their call were wrong.
    await startServer({ image: NOT_A_SERVER, url, as, within: BRIEF });
    const again = await startServer({ image: NOT_A_SERVER, url, as, within: BRIEF });

    expect(again.problems).toHaveLength(1);
    expect(again.problems[0]).toContain("never answered a query");
    expect(again.problems[0]).not.toContain("already in use");
  } finally {
    await removed(as);
  }
}, 120_000);

/**
 * Two servers from one declaration, which is what a shared docker daemon asks
 * of this step: two consumers' jobs, or two legs of one matrix, each starting
 * the server their call declares — and neither may be the other's.
 *
 * The wrong implementation is the one this replaces, publishing the port the
 * URL names, and it dies here on docker's own "port is already allocated" for
 * the second container: a consumer reads that as their own call being wrong.
 * Started in sequence, because the first is still running when the second
 * starts — nothing removes either until the `finally` below — so the collision
 * is the same collision, with one less moving part than racing them.
 */
test("two servers from one declaration are two ports, so neither job is the other's", async () => {
  const names = [named("beside-a"), named("beside-b")];
  try {
    const urls: string[] = [];
    for (const as of names) {
      const started = await startServer({ image: DEFAULT.image, url: SERVER, as, within: 120_000 });
      expect(started.problems).toEqual([]);
      if (started.url === undefined) throw new Error(`${as} came up and named no port`);
      urls.push(started.url);
    }

    // Assigned, and assigned apart: a step answering with the declaration it was
    // handed would have been refused above for naming no port, and one
    // answering with a constant would show one port twice.
    expect(new Set(urls.map((url) => new URL(url).port)).size).toBe(2);
    // And each URL reaches a server rather than merely reading well: the port
    // is the one thing every later step of a consumer's job depends on.
    for (const url of urls) {
      expect(await query(url, "select 1 as one")).toHaveLength(1);
    }
  } finally {
    for (const as of names) await removed(as);
  }
}, 300_000);

/**
 * The four wiring faults, which are refused before docker is asked anything: a
 * composite action maps an input nobody passed to the empty string, and the
 * other three name a server this step is not the one starting. Each costs
 * nothing to ask and saves the whole bound to answer.
 */
test("an empty image is refused as the wiring fault it is", async () => {
  const verdict = await startServer({
    image: "",
    url: SERVER,
    as: named("unused"),
    within: BRIEF,
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("database-image input is empty");
});

test("a URL naming a port is refused, because the port is not the caller's to name", async () => {
  const verdict = await startServer({
    image: "mariadb:11.4",
    url: "mysql://root:db-gate@127.0.0.1:3306/app",
    as: named("unused"),
    within: BRIEF,
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("does not choose one");
  // And nothing was started to be reached on it.
  expect(verdict.url).toBeUndefined();
});

test("a URL naming a host this step does not publish on is refused", async () => {
  const verdict = await startServer({
    image: "mariadb:11.4",
    url: "mysql://root:db-gate@db.internal/app",
    as: named("unused"),
    within: BRIEF,
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("publishes the server it starts on 127.0.0.1");
});

test("a URL naming an account the image never creates is refused", async () => {
  const verdict = await startServer({
    image: "mariadb:11.4",
    url: "mysql://app:db-gate@127.0.0.1/app",
    as: named("unused"),
    within: BRIEF,
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("initialises the server's root account");
});
