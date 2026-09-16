import { expect, test } from "bun:test";

import { isForeign, isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { root, serviceImages, SERVER_IMAGE, WRAPPER } from "./workflow.ts";

const CHECK_CALL = /^gokayo43\/dev-config\/\.github\/workflows\/check\.yml@([0-9a-f]{40})$/;

/** This repo's own action, which the wrapper reaches the only way a called workflow can. */
const OWN_ACTION = /^gokayo43\/dev-config-db\/\.github\/actions\/[\w-]+@([0-9a-f]{40})$/;

/** `${{ inputs.build }}` and `${{ inputs['test-network'] }}` are one reference written two ways. */
const FORWARD = /^\$\{\{\s*inputs(?:\.([\w-]+)|\[(['"])([^'"]+)\2\])\s*\}\}$/;

/** The spec that installs dev-config, which has to name the commit the workflows call. */
const INSTALLS = /"@gokayo43\/dev-config": "github:gokayo43\/dev-config#([0-9a-f]{40})"/;

/** What bun.lock records that spec as having resolved to — an abbreviated commit. */
const LOCKED = /"@gokayo43\/dev-config@github:gokayo43\/dev-config#([0-9a-f]+)"/;

/** The sentence README.md's list of refused inputs opens with, which is what makes that list checkable. */
const REFUSED = "refused here rather than forwarded";

const INSTALLED = "node_modules/@gokayo43/dev-config/.github/workflows/check.yml";

/** Everything a consumer fetches when it resolves an action pin of this repo. */
const ACTIONS = ".github/actions";

/**
 * The inputs this wrapper declares that dev-config has no name for at all, each
 * with the shape its kind is declared in.
 *
 * Every other input here is dev-config's, either handed on or spelled the way
 * they spell the same idea — and the tests below hold each of those to their
 * type and default, so that a consumer moving between the two workflows writes
 * one call either way. This map is the exception, and it is small on purpose:
 * an input earns a place in it only when the fact it names is this family's own
 * and borrowing dev-config's spelling would name the wrong thing.
 * `datetime-allowlist` is one, and docs/gates/db-datetime.md is why;
 * `database-image` is the other, and it is the server a consumer runs, which
 * dev-config's Postgres job has no question to ask.
 *
 * Written out rather than derived, so that adding one is a decision somebody
 * made rather than a name that stopped matching — and the shape is written with
 * it, because the two kinds are held to different rules below.
 */
const OURS = new Map<string, "an allowlist" | "a pinned image">([
  ["datetime-allowlist", "an allowlist"],
  [SERVER_IMAGE, "a pinned image"],
]);

/** The rule dev-config's pin gate holds an image to, which this repo's own default is held to here. */
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** What a caller may write beside a called workflow's input name. */
type Argument = string | boolean;

/**
 * A workflow as the questions below read one: the keys they name and no others,
 * each optional because a file that has stopped carrying one is exactly what
 * they are here to catch.
 *
 * It is a view of the parse rather than the parse itself — see `read` below.
 * Two questions here need the document as it actually came out of the YAML: an
 * input can be mentioned anywhere in a job, and an image sits under keys this
 * type does not name.
 */
interface Workflow {
  readonly on?: {
    readonly workflow_call?: {
      readonly inputs?: Readonly<
        Record<string, { readonly type?: string; readonly default?: Argument }>
      >;
    };
  };
  readonly jobs?: Readonly<
    Record<string, { readonly uses?: string; readonly with?: Readonly<Record<string, Argument>> }>
  >;
}

/** One file, parsed once, read two ways: as the shape below, and as whatever it is. */
interface Read {
  readonly typed: Workflow;
  readonly document: unknown;
}

function readAs(document: unknown): Read {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the interface above is this suite's schema for the workflows it reads; what the assertion claims is what every test below asserts
  return { typed: document as Workflow, document };
}

async function workflow(path: string): Promise<Read> {
  return readAs(Bun.YAML.parse(await Bun.file(`${root}/${path}`).text()));
}

/**
 * dev-config's `check.yml` as this repo has it installed, which is that pin's
 * own copy of the input surface every test below grades the wrapper against.
 *
 * It is on disk because a `github:` dependency installs a checkout of the whole
 * repository — `.github/` is outside dev-config's `files` allowlist, so a packed
 * install would not carry it. That is the invariant the diagnostic states: if it
 * fires, dev-config is being installed packed and this suite needs another way
 * to read what it declares.
 */
async function installed(): Promise<Read> {
  const file = Bun.file(`${root}/${INSTALLED}`);
  if (!(await file.exists())) {
    throw new Error(
      `${INSTALLED} is not there — this suite reads dev-config's input surface out of the install, which carries its workflows only because a github: dependency is a full checkout rather than a packed tarball. Run bun install; if the file is still missing, dev-config is packed now and this suite has to read that surface from somewhere else.`,
    );
  }
  return readAs(Bun.YAML.parse(await file.text()));
}

/** A group the pattern that matched has to have captured, since every branch of it captures one. */
function captured(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} matched and captured nothing`);
  return value;
}

function inputsOf({
  typed,
}: Read): Readonly<Record<string, { readonly type?: string; readonly default?: Argument }>> {
  return typed.on?.workflow_call?.inputs ?? {};
}

/**
 * The job that calls dev-config's gate. Exactly one, and the count is the check
 * rather than a detail of finding it: a second job calling the same workflow is
 * how the Postgres database job gets turned on beside a wrapper that reads as
 * leaving it off, and reading only the first is how nobody would notice.
 */
function call(
  { typed }: Read,
  path: string,
): { readonly uses: string; readonly with: Readonly<Record<string, Argument>> } {
  const jobs = Object.values(typed.jobs ?? {}).filter(
    ({ uses }) => uses !== undefined && CHECK_CALL.test(uses),
  );
  const [job] = jobs;
  if (jobs.length !== 1 || job?.uses === undefined) {
    throw new Error(
      `${path} must have exactly one job calling dev-config's check.yml at a pinned commit, and has ${jobs.length}`,
    );
  }
  return { uses: job.uses, with: job.with ?? {} };
}

/** Whether the value written beside an input name hands a caller's input on rather than deciding it here. */
function forwards(value: Argument): value is string {
  return typeof value === "string" && FORWARD.test(value);
}

/** The inputs the call hands on, each with the name it was read under. */
function forwarded(read: Read, path: string): (readonly [string, string])[] {
  return Object.entries(call(read, path).with).flatMap(([key, value]) => {
    if (!forwards(value)) return [];
    const forward = FORWARD.exec(value);
    return [[key, captured(forward?.[1] ?? forward?.[3], "FORWARD")] as const];
  });
}

/**
 * Every string in a document, which is where an expression can be.
 *
 * A reference to an input is not confined to a `with:` value: `if: inputs.x`
 * carries one bare, an `env:` maps one into a step's shell, and a job's
 * `services` could hold one too. Reading the strings rather than a fixed set of
 * keys is what makes "is this input read by anything" a question about the
 * file instead of about a list somebody remembered to update.
 */
function stringsIn(document: unknown): string[] {
  if (typeof document === "string") return [document];
  if (isList(document)) return document.flatMap((node) => stringsIn(node));
  if (!isForeign(document)) return [];
  return Object.values(document).flatMap((node: unknown) => stringsIn(node));
}

/** Whether anything in `document` reads the named input, in either spelling an expression has. */
function reads(document: unknown, name: string): boolean {
  const reference = new RegExp(`inputs(?:\\.${name}(?![\\w-])|\\[(['"])${name}\\1\\])`, "u");
  return stringsIn(document).some((text) => reference.test(text));
}

/** Every job whose work is this repo's own, which is every job that is not the call into dev-config. */
function ownJobs({ document }: Read): unknown[] {
  return Object.values(mapAt(document, "jobs")).filter((job) => {
    const uses = textAt(job, "uses");
    return uses === undefined || !CHECK_CALL.test(uses);
  });
}

/** Every value the wrapper's own jobs write beside `key` in a step's `with:`. */
function jobStepsWith(key: string): string[] {
  return ownJobs(wrapper).flatMap((job) => {
    const steps = isForeign(job) ? job["steps"] : undefined;
    return (isList(steps) ? steps : []).flatMap((step) => {
      const given = textAt(mapAt(step, "with"), key);
      return given === undefined ? [] : [given];
    });
  });
}

const alphabetically = (a: string, b: string): number => a.localeCompare(b);

const wrapper = await workflow(WRAPPER);
const ci = await workflow(".github/workflows/ci.yml");
const upstream = await installed();

test("every input the wrapper hands dev-config reaches its check.yml under its own name", () => {
  const passes = Object.entries(call(wrapper, "check.yml").with);
  const passed = forwarded(wrapper, "check.yml");
  // Two failures, and a run shows neither of them: an input handed on under a
  // neighbour's name is a setting the consumer wrote with a wrong answer beside
  // it, and a key dev-config does not declare is a whole argument it ignores.
  expect(passed.filter(([key, from]) => key !== from)).toEqual([]);
  expect(passes.map(([key]) => key).filter((key) => !(key in inputsOf(upstream)))).toEqual([]);
});

/**
 * The third failure the check above used to catch, now asked of every input
 * rather than only of the ones handed on.
 *
 * The wrapper declares two kinds: a pass-through, which exists in order to
 * reach dev-config, and an input of this repo's own, which drives a job here
 * and must never reach dev-config at all. An equality between "declared" and
 * "forwarded" cannot express the second kind — and the failure it was there to
 * catch is the same for both, so it is asked the way that covers both: a
 * declared input nothing reads is a setting a consumer wrote that nothing acts
 * on, which is silence with a plausible-looking workflow around it.
 */
test("every input the wrapper declares is read by something", () => {
  const handed = new Set(forwarded(wrapper, "check.yml").map(([key]) => key));
  const own = ownJobs(wrapper);
  const unread = Object.keys(inputsOf(wrapper)).filter(
    (name) => !handed.has(name) && !own.some((job) => reads(job, name)),
  );
  expect(unread).toEqual([]);
});

test("every input the wrapper shares with dev-config is declared exactly as dev-config declares it", () => {
  const differs = Object.entries(inputsOf(wrapper)).filter(
    ([name, { type, default: fallback }]) => {
      if (OURS.has(name)) return false;
      const theirs = inputsOf(upstream)[name];
      return theirs === undefined || type !== theirs.type || fallback !== theirs.default;
    },
  );
  // A type or a default of this repo's own is a wrapper that answers for
  // dev-config: a caller who omits the input gets this file's idea of what it
  // means, and the workflow that reads it never sees the difference. It holds
  // for an input of this repo's own too, and for a stronger reason — the four so
  // far are `database`, `upgrade-gate`, `db-gate-evidence` and `start-command`,
  // which this repo implements for the MySQL family and dev-config implements
  // for Postgres. A consumer switching
  // between the two workflows writes one call either way, and a name that meant
  // something different here is the trap that shape is worth avoiding.
  expect(differs).toEqual([]);
});

/**
 * The other half of that rule, for the inputs dev-config has no name for. Two
 * things can go wrong with one and neither is visible in the check above: the
 * name could be one dev-config has since taken — in which case this workflow
 * and that one now mean different things by one spelling, which is the trap the
 * check above exists to prevent — or it could be declared in some shape other
 * than the one every allowlist in the fleet has.
 */
test("an input of this repo's own is a name dev-config does not have, in the shape its kind has", () => {
  for (const [name, shape] of OURS) {
    expect(`dev-config declares ${name}: ${name in inputsOf(upstream)}`).toBe(
      `dev-config declares ${name}: false`,
    );
    const declared = inputsOf(wrapper)[name];
    expect(declared?.type).toBe("string");
    if (shape === "an allowlist") {
      expect(`${name} defaults to: ${String(declared?.default)}`).toBe(`${name} defaults to: `);
      continue;
    }
    // The image default is the one thing in this repo that dev-config's own pin
    // gate cannot see any more: it reads `services.<id>.image`, and the server
    // stopped being a service so that a consumer could declare it (dev-config#68
    // is why an expression cannot go there). So the rule it would have applied is
    // applied here instead — a default that drifted to a mutable tag would
    // otherwise ship to every consumer who writes nothing.
    expect(`${name} defaults to a digest: ${DIGEST.test(String(declared?.default))}`).toBe(
      `${name} defaults to a digest: true`,
    );
  }
});

test("README.md's account of the input surface is dev-config's own", async () => {
  const readme = await Bun.file(`${root}/README.md`).text();
  const byName = (a: readonly [string, string], b: readonly [string, string]): number =>
    alphabetically(a[0], b[0]);
  const tabled = [...readme.matchAll(/^\| `([\w-]+)` +\| `(\w+)` +\|$/gm)].map(
    ([, name, type]) =>
      [captured(name, "the input table"), captured(type, "the input table")] as const,
  );
  expect(tabled.toSorted(byName)).toEqual(
    Object.entries(inputsOf(wrapper))
      .map(([name, { type }]) => [name, type ?? ""] as const)
      .toSorted(byName),
  );

  // Collapsed first: markdown wraps a paragraph wherever the width runs out,
  // so the sentence this looks for is a line break away from being unfindable.
  const paragraph = readme
    .split("\n\n")
    .map((block) => block.replaceAll("\n", " "))
    .find((block) => block.includes(REFUSED));
  if (paragraph === undefined) {
    throw new Error(`README.md has no paragraph saying what is "${REFUSED}"`);
  }
  const refused = [...paragraph.matchAll(/`([\w-]+)`/g)].map(([, name]) =>
    captured(name, "the refused list"),
  );
  // Both halves are prose about a file in another repo, which is the statement
  // here most able to go quietly out of date: an input dev-config adds and this
  // page names in neither place is one nobody decided about. Nothing is
  // subtracted from dev-config's surface any more — `database` was, while this
  // wrapper had no job of its own to turn on, and it is now on the table. What
  // is subtracted from THIS page's table is `OURS`: a name dev-config has never
  // had cannot be accounted for against their surface, and the test above is
  // what holds each of those to being exactly that.
  expect(
    [...tabled.map(([name]) => name).filter((name) => !OURS.has(name)), ...refused].toSorted(
      alphabetically,
    ),
  ).toEqual(Object.keys(inputsOf(upstream)).toSorted(alphabetically));
});

test("nothing in the call is this workflow answering for its consumer", () => {
  // A literal here would be this workflow deciding a value nothing in it
  // declares, and dev-config cannot tell that from the consumer's own answer.
  //
  // There used to be exactly one, and what happened to it is worth keeping: while
  // their `database` was a boolean meaning "run our Postgres job", this workflow
  // answered it `false` and kept an input of the same name meaning "run mine" —
  // one spelling, two questions, and a literal to hold them apart. Their enum has
  // `external` for a workflow that runs the database gates in that job's place,
  // so the two questions became one input and the literal went with them.
  expect(
    Object.entries(call(wrapper, "check.yml").with).filter(([, value]) => !forwards(value)),
  ).toEqual([]);

  // And the value that decides both jobs really is handed on rather than
  // dropped: a call that stopped naming it would leave dev-config on its own
  // default while the job here still ran off the consumer's answer.
  expect(forwarded(wrapper, "check.yml").map(([key]) => key)).toContain("database");
});

test("this repo is gated by, and installs, the dev-config it hands its consumers", async () => {
  const pinned = captured(CHECK_CALL.exec(call(wrapper, "check.yml").uses)?.[1], "CHECK_CALL");
  expect(captured(CHECK_CALL.exec(call(ci, "ci.yml").uses)?.[1], "CHECK_CALL")).toBe(pinned);
  // The other two carriers of the same commit: the manifest decides which
  // dev-config the lanes above read, and the lockfile is what `bun install
  // --frozen-lockfile` actually resolves — a manifest and a lock that disagree
  // put a third version on disk with nothing saying so.
  expect(INSTALLS.exec(await Bun.file(`${root}/package.json`).text())?.[1]).toBe(pinned);
  expect(pinned).toStartWith(
    captured(LOCKED.exec(await Bun.file(`${root}/bun.lock`).text())?.[1], "LOCKED"),
  );
});

/**
 * The actions this repo ships, each reached by full path and SHA because a
 * relative `uses:` inside a called workflow resolves against the CALLER's
 * checkout. So a pin names a commit of this repo, and a commit it does not
 * carry is an action GitHub cannot fetch — a database job that fails for every
 * consumer at once, over a value no consumer wrote.
 *
 * Reachability rather than freshness. Whether a pinned commit is the newest one
 * carrying that action is a release decision; whether it exists at all is
 * arithmetic, and it is the half that is silently wrong after a squash.
 */
test("every action the wrapper pins is a commit this repo carries", async () => {
  const pins = [...stringsIn(wrapper.document)].filter((text) => OWN_ACTION.test(text));
  expect(pins).not.toEqual([]);
  for (const pin of pins) {
    const sha = captured(OWN_ACTION.exec(pin)?.[1], "OWN_ACTION");
    const proc = Bun.spawn(["git", "cat-file", "-e", `${sha}^{commit}`], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(`${pin} resolves: ${(await proc.exited) === 0}`).toBe(`${pin} resolves: true`);
  }
});

/** What git calls the tree of `.github/actions` at a commit, which is every byte a consumer fetches. */
async function actionsTree(commit: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", `${commit}:${ACTIONS}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [id, why] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0)
    throw new Error(`${commit}:${ACTIONS} is not a tree — ${why.trim()}`);
  return id.trim();
}

/**
 * And it is the CURRENT one, which reachability alone never asked.
 *
 * A pin that resolves can still name a commit whose actions have been changed
 * since — and then a consumer fetches an action this repo reviewed, merged and
 * moved on from, while every gate here grades the tree at HEAD. Shipped
 * behaviour and reviewed behaviour part company with nothing red anywhere, and
 * the older the pin the longer nobody notices: exactly the state this repo was
 * in when `db-replay` was pinned two changes back.
 *
 * The whole directory rather than each action's own, because that is what a
 * consumer's checkout of a pinned commit contains and what these actions import
 * across: `db-datetime` reads its catalogue through `db-replay/database.ts` and
 * both read `_lib/`, so an action's shipped behaviour is not bounded by its own
 * directory. One tree per pin also means one rule rather than a map of which
 * directory each pin owns.
 *
 * A commit cannot name itself, so the pin is one commit behind by design —
 * CLAUDE.md, "Releasing an action". Trees are what that costs nothing: the
 * re-pinning commit touches the workflow and leaves this tree alone.
 */
test("every action the wrapper pins ships the actions this repo has now", async () => {
  const here = await actionsTree("HEAD");
  for (const pin of [...stringsIn(wrapper.document)].filter((text) => OWN_ACTION.test(text))) {
    const sha = captured(OWN_ACTION.exec(pin)?.[1], "OWN_ACTION");
    expect(`${pin} ships ${await actionsTree(sha)}`).toBe(`${pin} ships ${here}`);
  }
});

/** The step of a workflow's database job that runs a gate of the named action. */
function gateStep(read: Read, action: string): Readonly<Record<string, string>> {
  const steps = mapAt(mapAt(read.document, "jobs"), "database")["steps"];
  const found = (isList(steps) ? steps : []).find((step) =>
    (textAt(step, "uses") ?? "").includes(action),
  );
  if (found === undefined) throw new Error(`no step of the database job uses ${action}`);
  const given = mapAt(found, "with");
  return Object.fromEntries(
    Object.entries(given).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value] as const] : [],
    ),
  );
}

/**
 * What a caller who wrote nothing gets, read off the `||` in the value a job
 * hands its gate.
 *
 * The port is allocated while the job runs, so the only thing the two workflows
 * can legitimately differ on is where that value is read from — dev-config's
 * job spells it `env.PORT` and this one spells it as the allocating step's
 * output, which the graded repo cannot rewrite. The placeholder is what makes
 * the rest of the sentence comparable.
 */
function fallbackIn(value: string): string {
  const fallback = /\|\|\s*(.*?)\s*\}\}\s*$/su.exec(value)?.[1];
  if (fallback === undefined) {
    throw new Error(`${value} names no value for a caller who passed nothing`);
  }
  return fallback.replace(/env\.PORT|steps\.[\w-]+\.outputs\.port/u, "<the allocated port>");
}

/**
 * The two defaults that moved out of the input declarations and into the job.
 *
 * README and docs/gates/db-serving.md state them as this workflow's contract,
 * and a default written in a job body is held to nothing — dev-config declares
 * neither any more either, and applies both in its own database job. So the
 * oracle is that job: a consumer moving between the two workflows writes one
 * call either way, which is the same rule the input declarations above are held
 * to, asked of the place the values actually live now.
 */
test("the serving gate's two defaults are the ones dev-config's own job applies", () => {
  const ours = gateStep(wrapper, "actions/db-serving");
  const theirs = gateStep(upstream, "actions/db-gate");

  for (const name of ["start-command", "health-url"] as const) {
    const mine = ours[name];
    const upstreams = theirs[name];
    if (mine === undefined || upstreams === undefined) {
      throw new Error(`${name} is not handed to the gate by both jobs`);
    }
    expect(`${name}: ${fallbackIn(mine)}`).toBe(`${name}: ${fallbackIn(upstreams)}`);
  }
});

/**
 * The server the job starts and the server the gate dumps from are one image,
 * and now they are one statement of it: both steps are handed the caller's
 * input. A drift between two literals used to be the worst kind of quiet — the
 * gate would render one product's catalogue with another product's client,
 * compare the two renderings to each other, and pass — and this is what keeps
 * the shape that made that unsayable.
 */
test("every step that takes a server image is handed the one the caller declared", () => {
  const handed = [...jobStepsWith(SERVER_IMAGE)];

  // The server and the dump client: two steps, one value, and a third that took
  // an image would have to be one too.
  expect(handed.length).toBeGreaterThanOrEqual(2);
  expect(handed.filter((value) => value !== `\${{ inputs['${SERVER_IMAGE}'] }}`)).toEqual([]);
});

/**
 * And the reason the server is a step rather than a service, stated where a
 * change would undo it: dev-config's pin gate reads `services.<id>.image` as a
 * literal and refuses anything that is not a digest, so an input cannot go there
 * (dev-config#68). A future edit that moves the server back into `services`
 * fails here, with the reason, rather than in dev-config's gate with a message
 * about a mutable tag.
 */
test("no service image is an expression, which is why the server is not one", async () => {
  const images = await serviceImages();

  expect(images).not.toEqual([]);
  expect(images.filter((image) => image.includes("${{"))).toEqual([]);
  expect(images.filter((image) => !DIGEST.test(image))).toEqual([]);
});
