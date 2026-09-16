// oxlint-disable-next-line no-restricted-imports -- what `emptyDatabase` hands a case is a URL rather than a disposable, so `await using` would mean changing every call site to hold an object and read `.url` off it; #23 is that change
import { afterEach } from "bun:test";

import { isList } from "../.github/actions/_lib/foreign.ts";
import { connection } from "../.github/actions/db-replay/database.ts";
import { startServer } from "../.github/actions/db-server/server.ts";

import { defaultServerImage, root } from "./workflow.ts";

/**
 * A real server of each product this repo serves, for every suite that drives a
 * gate against one — because what those gates assert is what a database ends up
 * holding. A second replay that changed the schema is a fact about one server's
 * catalogue, and nothing in-process can report it; a catalogue read that finds
 * no field because the labels came back in another case is a fact about one
 * server's answer, and nothing in-process would ever produce it.
 *
 * Both servers run in one `bun test`, and every case that touches a server runs
 * against each. That is what "the gates serve both products" is worth as a
 * claim: not a leg somebody remembered to turn on, but the same cases, in the
 * same run, against a real MariaDB and a real MySQL 8.
 *
 * They are started through the shipped `startServer` rather than by a
 * `docker run` of this suite's own, so the start every consumer's job depends
 * on is the start this suite proves.
 */

/** What a case has to know about the server under it, beyond how to reach it. */
export interface Product {
  /** What the case names in its output. */
  readonly name: string;
  /** The image it runs, pinned by digest. */
  readonly image: string;
  /**
   * What this product's own `version()` says, as much of it as is the product
   * rather than the build. It is what a case asserts to know the server under it
   * is the one the case's name claims — a suite that quietly ran both legs
   * against one server would otherwise be the failure nothing here could see.
   */
  readonly version: string;
  /**
   * What the server calls the second unnamed CHECK constraint on one table,
   * which is the divergence a schema-comparison case has to name: MariaDB
   * counts constraints per table as `CONSTRAINT_n`, MySQL names them after the
   * table as `<table>_chk_n`. Both are the server's own invention on a
   * migration that ran twice, which is what the case is about.
   */
  readonly secondCheck: string;
}

/**
 * The MySQL 8 build these gates are certified against, and it is deliberately
 * not the newest MySQL.
 *
 * `wmstcs` — the consumer this product exists here for — runs 8.0.32 in
 * production, so the 8.0 series is what certifying against MySQL has to mean;
 * 8.4 is a different LTS with features removed. It is a fixture rather than a
 * shipped default, which is why it is written here rather than in the workflow:
 * nothing a consumer runs comes from this line.
 */
const MYSQL_IMAGE =
  "mysql:8.0.46@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b";

/**
 * The product a case that is not about the server runs against, which is the
 * one a consumer who declares nothing is handed — so a case that needs only "a
 * server" needs no opinion about which.
 */
export const DEFAULT: Product = {
  name: "MariaDB",
  image: await defaultServerImage(),
  version: "-MariaDB",
  secondCheck: "CONSTRAINT_2",
};

const MYSQL: Product = {
  name: "MySQL",
  image: MYSQL_IMAGE,
  version: "8.0.",
  secondCheck: "thing_chk_2",
};

export const PRODUCTS: readonly Product[] = [DEFAULT, MYSQL];

/** What the containers answer to, which is a dummy for servers that live for one suite run. */
const PASSWORD = "db-gate";

/** The database each server comes up with, and the one every case's own database is made beside. */
const FIRST = "app";

/** The same server, pointing at another of its databases. */
function beside(url: string, database: string): string {
  const swapped = new URL(url);
  swapped.pathname = `/${database}`;
  return swapped.href;
}

/**
 * One container per product per worktree, named after both.
 *
 * Named rather than random for the reason the gates in this house derive a
 * scratch database's name: a run killed outright leaves the container behind,
 * and a name the next run derives again is one `startServer` reclaims before it
 * creates. A random name would leave one server per killed run running forever.
 *
 * The worktree is what distinguishes it, so two checkouts under review at once
 * — and any neighbour's containers on the same daemon — are never each other's.
 */
function containerFor({ name }: Product): string {
  const here = new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 16);
  return `dev-config-db-suite-${here}-${name.toLowerCase()}`;
}

/** A server of this product, up and answering, and the URL of the database it came up with. */
async function started(product: Product): Promise<string> {
  // No port in it: the shipped step has docker assign one and answers with the
  // URL on that port, which is how two products run here at once — and how two
  // of a consumer's jobs share one daemon.
  const verdict = await startServer({
    image: product.image,
    url: `mysql://root:${PASSWORD}@127.0.0.1/${FIRST}`,
    as: containerFor(product),
    within: 120_000,
  });
  if (verdict.problems.length > 0) {
    throw new Error(`${product.name} never came up: ${verdict.problems.join(" ")}`);
  }
  if (verdict.url === undefined) {
    throw new Error(`${product.name} came up and the step named no port for it`);
  }
  notes.set(product.name, verdict.note ?? "");
  return verdict.url;
}

/** What the shipped step said about the server it started, kept for the one case that grades it. */
const notes = new Map<string, string>();

/** The note the shipped step published for this product's server, once it is up. */
export async function noteOf(product: Product): Promise<string> {
  await server(product);
  return notes.get(product.name) ?? "";
}

const up = new Map<string, Promise<string>>();

/**
 * The server of one product, started once per run and shared by every file that
 * asks for one.
 *
 * Lazy, and that is the whole of why it is a function rather than a top-level
 * `await`. Two things depend on it:
 *
 * **The teardown has to be registered outside any file.** `bun test` runs every
 * file in one process, and a hook registered at the top level of an imported
 * module attaches to whichever file imported it FIRST — so an `afterAll` here
 * would tear the servers down after that file's cases and leave every later
 * file connecting to nothing, under a `Connection closed` naming neither this
 * module nor the cause. `tests/preload.ts` registers it at the root scope
 * instead, where it runs after all of them; for that, importing this module
 * must not start anything.
 *
 * **A run that needs no database should start none** — and a run that needs one
 * product should start one server rather than two.
 */
export async function server(product: Product): Promise<string> {
  const running = up.get(product.name) ?? started(product);
  up.set(product.name, running);
  return await running;
}

/**
 * The end of the run, called from the root scope. Nothing to do for a product
 * no case ever asked for — and `startServer` reclaims a name before it creates,
 * so a run killed hard enough to skip this leaves nothing the next one trips on.
 */
export async function stop(): Promise<void> {
  const asked = [...up.keys()];
  up.clear();
  for (const name of asked) {
    const product = PRODUCTS.find((each) => each.name === name);
    if (product === undefined) continue;
    const proc = Bun.spawn(["docker", "rm", "--force", containerFor(product)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }
}

const made: string[] = [];

afterEach(async () => {
  if (made.length === 0) return;
  for (const url of made.splice(0)) {
    const database = decodeURIComponent(new URL(url).pathname.replace(/^\//u, ""));
    const db = connection(beside(url, FIRST));
    await db.unsafe(`drop database if exists \`${database}\``);
    await db.close();
  }
});

/**
 * How many databases this run has asked for. Counted rather than read off
 * `made`, whose length is only true until the first `await` below: two cases
 * running at once would both see the same length, ask for the same name, and
 * the second would meet a database rather than make one.
 */
let asked = 0;

/** An empty database of this case's own on this product's server, and its URL. */
export async function emptyDatabase(product: Product): Promise<string> {
  const name = `replay_${process.pid}_${asked++}`;
  const db = connection(await server(product));
  await db.unsafe(`drop database if exists \`${name}\``);
  await db.unsafe(`create database \`${name}\``);
  await db.close();
  const url = beside(await server(product), name);
  made.push(url);
  return url;
}

/** What a case has to be able to ask the server directly, where the gate's own answer is what is under test. */
export async function query(url: string, sql: string): Promise<readonly unknown[]> {
  const db = connection(url);
  try {
    const answered: unknown = await db.unsafe(sql);
    return isList(answered) ? answered : [];
  } finally {
    await db.close();
  }
}
