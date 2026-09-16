import { SQL } from "bun";

import { relay } from "../_lib/annotations.ts";
import { type Foreign, isForeign, isList, kindOf, textAt } from "../_lib/foreign.ts";

/**
 * Not a gate. What a gate here needs a server for: what it says it holds, how
 * the repo's own migrator is run against it, and how a schema is read back as
 * text. Comparing two of them is `schema.ts`, which is pure and kept out of
 * here for that reason.
 *
 * Every function below serves both server products, and only three of them had
 * anything to decide about the difference: the connection, whose TLS is what
 * MySQL 8's default authentication needs; the catalogue reads, which alias what
 * they select because the two products answer with the labels in different
 * case; and the dump, whose client has no name both images use.
 *
 * **Four functions below are checked-in copies of dev-config's
 * `.github/actions/db-gate/database.ts` at the pinned SHA**, not independent
 * work: `databaseIn`, `migrate`, `rowsIn` (theirs is `rows`) and `textIn`. An action runs
 * from a checkout with no `node_modules` above it and `.github/` is outside
 * dev-config's `files` allowlist, so there is no import that reaches them —
 * dev-config#69 is where publishing them in a reachable form is argued, and
 * CLAUDE.md's "It only adds" rule carries the carve-out. Each names its own
 * delta below; anything not named is theirs verbatim, and a bug fixed there is
 * a bug still here until somebody carries it over.
 */

/**
 * The database a URL names, for the tool that takes one and for the
 * diagnostics.
 *
 * dev-config's, plus `decodeURIComponent`: a MySQL-family database name may
 * hold characters a URL has to percent-encode, and the dump client is handed
 * this as an argument rather than as part of a URL. Postgres names reach their tool
 * inside the URL, so upstream never has to undo the encoding.
 *
 * The decode is load-bearing and it is also the sharp edge: whatever it returns
 * becomes an argv entry, and a dump client reads options after positionals —
 * so a URL whose path spelled `%2D%2Dtab%3D/tmp/x` would arrive as `--tab=…`
 * and write files. Nothing crosses a boundary as shipped, because the URL a
 * gate step is handed is a literal in check.yml, read into a step output before
 * the graded repo runs — the action.yml comment on `database-url` is why it is
 * handed in rather than inherited. It is written down because the next reader's
 * instinct will be to widen where the URL comes from, and that is the change
 * that would make this reachable.
 */
export function databaseIn(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//u, ""));
}

/**
 * The rows a query answered, as objects a reader can say something true about.
 *
 * `Bun.SQL` answers `any`: a driver cannot know what a string of SQL returns.
 * So a call site that goes straight to a field is asserting the shape, and the
 * assertion is the only thing between a renamed column and a `TypeError` three
 * frames from the query. The answer is refused here instead, where the SQL that
 * produced it is still in hand to name.
 *
 * dev-config's `rows`, with one delta: it takes the answer rather than running
 * the query, because the one caller here needs parameters bound and theirs does
 * not. The diagnostics are theirs word for word.
 */
function rowsIn(answered: unknown, query: string): readonly Foreign[] {
  if (!isList(answered)) {
    throw new Error(`the query answered ${kindOf(answered)} rather than rows — ${query}`);
  }
  return answered.map((row, at) => {
    if (!isForeign(row))
      throw new Error(`row ${at} is ${kindOf(row)} rather than a row — ${query}`);
    return row;
  });
}

/**
 * A field a reader needs, or the diagnostic naming what was there instead. The
 * one narrowing every catalogue read here ends in: a row a driver answered
 * `any` for is refused field by field, where the query that produced it is
 * still in hand to name.
 *
 * dev-config's, verbatim but for the diagnostic taking `where` as the whole of
 * its subject rather than composing it from a source and an index — the two
 * callers here already hold the sentence they want to say.
 */
export function textIn(row: Foreign, key: string, where: string): string {
  const value = textAt(row, key);
  if (value === undefined) {
    throw new Error(`${where} has ${key} as ${kindOf(row[key])} rather than text`);
  }
  return value;
}

/**
 * A connection to either server product, and the one place anything here
 * decides how one is opened — this repo's own, not dev-config's.
 *
 * The TLS is not about secrecy: the server is a container this job started,
 * published on its own loopback and thrown away with the runner. It is what
 * MySQL 8's default authentication plugin needs. `caching_sha2_password`
 * completes over an unencrypted socket only by having the client fetch the
 * server's RSA public key, which Bun refuses outright (probed on 1.4.0:
 * "requested RSA public key retrieval … not allowed over an insecure
 * connection"), while over TLS it completes with no key exchange at all.
 * MariaDB's `mysql_native_password` never needed either, so one statement
 * serves both products.
 *
 * Unverified because the certificate is the container's own self-signed one:
 * both images generate a certificate at first start and there is no authority
 * anywhere in a job that could vouch for it, so verifying would refuse exactly
 * the server this job just started.
 */
export function connection(url: string): SQL {
  return new SQL({ url, tls: { rejectUnauthorized: false } });
}

/**
 * One query, one connection, and the rows it answered — this repo's own, over
 * `rowsIn` above.
 *
 * A gate here reads a catalogue exactly once and decides on the whole of the
 * answer: there is no cursor, no page and no second read, so a query that came
 * up short is not a state any verdict can be built from. Either this returns
 * every row the server had, or it throws and the step ends without a verdict at
 * all. The connection is closed on both paths, because a gate whose runtime
 * stays alive holding a socket costs the job its whole timeout to say what it
 * already knew.
 *
 * Every query that reaches this gives each column it selects an explicit alias,
 * and that is a requirement rather than a style: MySQL 8 answers a catalogue
 * read with the labels in upper case (`TABLE_NAME`) and MariaDB with them in
 * lower case, so a field read by name finds nothing on one of the two servers
 * unless the query said what to call it. Probed on both pins this repo
 * certifies; an alias is spelled the same way by both.
 */
export async function rowsFrom(
  url: string,
  query: string,
  binds: readonly string[],
): Promise<readonly Foreign[]> {
  const db = connection(url);
  try {
    return rowsIn(await db.unsafe(query, [...binds]), query);
  } finally {
    await db.close();
  }
}

/**
 * The name drizzle's MySQL migrator keeps its journal under, and where it keeps
 * it: a table of that name **in the database being migrated**, with no schema
 * qualifier. Its Postgres migrator puts the same table in a schema of its own,
 * so the two spellings are not interchangeable and a reader who knows the
 * Postgres one would look in the wrong place.
 *
 * It is exported because a gate has to be able to tell the migrator's own
 * bookkeeping from the schema a migration built: a `db:migrate` that records
 * having applied nothing leaves exactly this table and nothing else, and
 * counting it as schema is how a repo with no migrations at all passes a gate
 * that replays them.
 */
export const JOURNAL = "__drizzle_migrations";

/**
 * Everything the database holds that a schema dump would carry: its tables,
 * views and sequences, its stored routines and its events. Asked of the server
 * rather than read out of the dump, because the catalogue is the fact and a
 * dump is a rendering of it — and a reader that had to find the boundaries of a
 * `CREATE` statement in text would be a parser for a dialect nothing here owns.
 *
 * Routines and events are in the answer for one reason: without them a
 * migration set that builds only a stored procedure reads as one that built
 * nothing, and the gate refuses a repo that is fine. The dump asks for these
 * and for triggers as well, which are not counted here and need not be: a
 * trigger cannot exist without the table it is on, so a database holding one
 * has already been counted.
 */
export async function objectsIn(url: string): Promise<string[]> {
  const database = databaseIn(url);
  const query =
    "select table_name as name from information_schema.tables where table_schema = ?" +
    " union all select routine_name from information_schema.routines where routine_schema = ?" +
    " union all select event_name from information_schema.events where event_schema = ?";
  const answered = await rowsFrom(url, query, [database, database, database]);
  return answered.map((row, at) => textIn(row, "name", `row ${at} of ${database}'s catalogue`));
}

/**
 * The script a repo declares its migrator as, named once: the pre-flight check
 * that a repo HAS one and the command that runs it are one name, and two
 * spellings of it would let a gate refuse a repo over a script it never ran.
 */
export const SCRIPT = "db:migrate";

/**
 * The repo's own migrator, which is the only one there is: nothing here writes
 * SQL. Its output is the developer's — the statement that would not apply, and
 * the line it was on — so it goes to the log rather than into a diagnostic that
 * would quote a fragment of it.
 *
 * `failed` is the whole diagnostic rather than a database name, because this
 * runs more than once per gate and "the second one failed" names something the
 * author has never heard of.
 *
 * dev-config's, with two deltas. Their `against` is folded in: they route two
 * commands through it — the migrator and a repo's own shell — and this gate
 * runs only the first, so the indirection had one caller.
 *
 * And the output is **relayed rather than inherited**, which is the important
 * one. Inherited, a consuming repo's migrator writes straight onto the stdout
 * the runner reads its own commands off, so `echo '::stop-commands::x'` in a
 * `db:migrate` script silences every annotation the gate is about to make —
 * with no gate code in between to prevent it. Captured and relayed, the same
 * line arrives as text. The cost is that the output lands when the migrator
 * ends rather than streaming, which for a migration is no cost at all.
 * dev-config#71 is the same shape upstream.
 */
export async function migrate(root: string, url: string, failed: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", SCRIPT], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  relay(out + err);
  if (status !== 0) throw new Error(failed);
}

/**
 * The two names a MySQL-family image has for its dump client, in the order they
 * are looked for.
 *
 * There is no third and there is no name both use. Probed on the images this
 * repo certifies: MariaDB 11.4 ships `/usr/bin/mariadb-dump` and no `mysqldump`
 * symlink at all, and MySQL 8.0 ships `/usr/bin/mysqldump` and no
 * `mariadb-dump`. So the client is asked of the image rather than derived from
 * the reference naming it — a consumer's digest may come from any registry
 * path, and the image is the only thing that knows what it ships.
 */
const DUMP_CLIENTS = ["mariadb-dump", "mysqldump"] as const;

/**
 * The dump client the pinned image ships, as a path in that image, or
 * `undefined` when it ships neither.
 *
 * Asked once and before anything is migrated, because an image with no dump
 * client is a wiring fault whose diagnostic is worth more than the two replays
 * it would otherwise be found after.
 */
export async function dumpClientIn(image: string): Promise<string | undefined> {
  // The trailing `exit 0` is what makes the answer readable: `command -v` says
  // "not found" with a status that is 1 in one shell and 127 in another, so
  // without it an image shipping neither client and an image that will not run
  // at all are one outcome. With it the container's status is about the
  // container, and an empty stdout is the answer.
  const lookUp = `${DUMP_CLIENTS.map((client) => `command -v ${client}`).join(" || ")} || exit 0`;
  const proc = Bun.spawn(["docker", "run", "--rm", "--entrypoint", "sh", image, "-c", lookUp], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) {
    throw new Error(
      `the dump client could not be read out of ${image} — \`docker run ${image} sh -c '${lookUp}'\` exited ${status}: ${stderr.trim()}`,
    );
  }
  const found = stdout.trim();
  return found === "" ? undefined : found;
}

/**
 * The schema as the server's own client writes it.
 *
 * The client comes out of the image the calling job runs the server from, which
 * is what makes them the same build rather than two versions that agree today:
 * the client renders the catalogue, and a client of another product or another
 * major renders a schema it half understands. Running it from the image is also
 * the only way to have it at all without a second thing to pin — nothing on a
 * GitHub runner ships a client for either product, and an apt install would be
 * an unpinned package inside a gate whose whole point is that what it runs is
 * pinned.
 *
 * `docker` itself is the one name here still resolved through a search path,
 * which is why action.yml declares that path from the calling job's own reading
 * rather than letting the step inherit it: a digest pins which image runs, and
 * nothing in it pins which program is asked to run that image.
 *
 * `--network host` because the server is a container of the calling job,
 * published on the runner's loopback: the dump's container has to be in the
 * namespace those ports are in.
 *
 * The password goes through the environment rather than the argument list.
 * `MYSQL_PWD` is the name both products' clients read — `MARIADB_PWD` is not
 * one, in either — and `--env MYSQL_PWD` with no value hands over the one this
 * process holds, so it never reaches the command line the runner logs or
 * another process on the box can read.
 */
export async function dumpOf(
  url: string,
  image: string,
  client: string,
  args: readonly string[],
): Promise<string> {
  const server = new URL(url);
  const database = databaseIn(url);
  // Named rather than defaulted to 3306: the server step publishes on the port
  // the docker daemon assigned and answers with the URL it is on, so every URL
  // that reaches this carries one. A default here would dump from whatever else
  // on the runner holds the default port — which on a shared box is a real
  // server — and call the result this job's schema.
  if (server.port === "") {
    throw new Error(
      `the database URL names no port, so this dump would be taken from whatever holds 3306 on this machine — the calling job passes the URL the server step answered with, which carries the port docker assigned`,
    );
  }
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "host",
      "--env",
      "MYSQL_PWD",
      image,
      client,
      `--host=${server.hostname}`,
      `--port=${server.port}`,
      `--user=${decodeURIComponent(server.username)}`,
      ...args,
      database,
    ],
    {
      env: { ...process.env, MYSQL_PWD: decodeURIComponent(server.password) },
      stdout: "pipe",
      // Captured rather than inherited, and surfaced only where it explains
      // something: the client warns on every run that it is not verifying the
      // server's certificate, which is true, is the caller's decision and is
      // not news twice a job. A dump that failed carries the whole of it into
      // the diagnostic instead, where the reader is already looking.
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) {
    throw new Error(
      `${client} could not read ${database} — \`docker run ${image} ${client}\` exited ${status}: ${stderr.trim()}`,
    );
  }
  return stdout;
}
