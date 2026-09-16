# dev-config-db

The MySQL-family extension of
[`@gokayo43/dev-config`](https://github.com/gokayo43/dev-config). One reusable
workflow: a consuming repo calls it instead of dev-config's `check.yml` and gets
that gate unchanged, plus the database job a MariaDB or MySQL 8 repo needs.

Nothing here is a copy of dev-config. The static half is a call into it, pinned
by commit SHA, so a gate lands here when the pin moves and never because a fork
drifted.

## Scope

Two repos, both older than the fleet's Postgres decision: `nfp-elysia` and
`wmstcs`. dev-config's database job replays migrations onto Postgres, and it
stays Postgres — a base that grew a second dialect would carry the choice into
every repo that has none. This workflow is where the second dialect lives
instead, and `database: external` is dev-config's own value for saying so. A new
project consumes dev-config directly; nothing else is a reason to call this one.

The database job serves **both** products of that dialect, because the two
consumers run two: `nfp-elysia` is MariaDB 11.4 and `wmstcs` is MySQL 8.0.32. A
consumer says which by pinning `database-image`; nothing here infers a product
from a reference, and every gate that meets a difference asks the image or the
server rather than guessing. Both are certified by this repo's own suite, which
runs every server-touching case against a real MariaDB and a real MySQL 8 in one
run.

## Where it runs

Every job in `.github/workflows/check.yml` and in this repo's own `ci.yml`
declares `runs-on: [self-hosted, linux]`, which is dev-config's own spelling of
the same thing. **A consumer needs a runner carrying both labels.** Without one
its jobs queue and GitHub cancels them 24 hours later, so what a consumer sees
is a run that never started rather than one that failed naming the reason.

What such a runner has to provide, beyond those two labels:

- **A docker daemon it can reach.** The server the database job grades is a
  container this workflow starts, and Redis is a service container beside it.
- **Passwordless `sudo`**, for dev-config's test-suite gate inside the `static`
  job — their
  [docs/gates/test-suite.md](https://github.com/gokayo43/dev-config/blob/main/docs/gates/test-suite.md)
  is what it is for and what a runner without it gets.
- **Room for a workspace that is not discarded when the run ends.** What cleans
  it is `actions/checkout` at the start of the next run.

Three things follow from that machine being shared and persistent rather than a
fresh cloud VM. Two of its jobs overlapping on one docker daemon is the ordinary
case, not the corner one, and nothing in the database job may assume otherwise:

- **Nothing publishes on a fixed host port, and nothing publishes on
  `0.0.0.0`.** Redis is `ports: ["127.0.0.1::6379"]` with the assignment read
  back out of the `job` context; the server is `docker run --publish
127.0.0.1::3306` with the assignment read back and answered as the server
  step's `database-url` output, so `DATABASE_URL` names the port docker assigned
  and never `3306`. Why those two forms and not the obvious ones is
  [docs/gates/db-server.md](docs/gates/db-server.md), "Why the port is the
  daemon's".
- **The app the serving gate boots gets an allocated port too.** `health-url`
  defaults to `http://localhost:${PORT}/api/health`, where `PORT` is a free port
  the job binds immediately before the gate runs and passes to the app; `3000`
  is the framework default and therefore the port something else on a shared box
  already holds. `PORT` is the platform convention, so an app that honours it
  needs no further wiring. **A consumer that sets `health-url` names a port the
  allocation cannot reach, so it owes that port to its app as well** — in
  `start-command`, e.g. `env PORT=8080 bun run start`, since no input can
  reference a value the job allocates while it runs. The boot gate refuses a
  `health-url` something already answers rather than grading whatever that is.
- **The job takes its server container down when it ends**, on every run
  including the failed and the cancelled ones. A composite action has no `post:`
  of its own, so without that step a persistent runner keeps one database server
  per consumer workspace resident between runs.

## Calling it

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    uses: gokayo43/dev-config-db/.github/workflows/check.yml@<commit sha> # <release tag>
    with:
      build: true
      database: external
      contract-exemptions: ci-call
```

`external` is dev-config's own value for this arrangement: their database job is
Postgres, and it says a workflow wrapping theirs runs the database gates in that
job's place. It is handed straight on, so one input decides both — and
`database: postgres` is refused here rather than served, since a repo whose
database is Postgres calls dev-config directly.

A repo whose server is MySQL 8 adds one line, pinned by digest the way it pins
everything else:

```yaml
database-image: mysql:8.0.42@sha256:… # renovate keeps this current
```

`database-image` defaults to the MariaDB build this repo certifies, so a MariaDB
consumer writes nothing. The pin is the consumer's own discipline and the whole
contract: an image pinned by tag can be repointed by its publisher, and a gate
whose server changed under it grades a different thing every week. This repo
holds its own default to a digest in `tests/wrapper-inputs.test.ts`, since
dev-config's pin gate cannot see it —
[docs/gates/db-server.md](docs/gates/db-server.md) is why the server is a step
rather than a service container.

`ci-call` is part of the call rather than a shortcut: dev-config's repo contract
asks a repo to call **dev-config's** `check.yml` at a pinned SHA, and a repo
pointing at this workflow has that call one level down where the contract cannot
read it. [dev-config#65](https://github.com/gokayo43/dev-config/issues/65) is
where teaching the contract to see this workflow is argued.

`ci-call` waives two rules of theirs, not one: that the CI workflow calls their
`check.yml`, and that a repo declaring `lifecycle: "live"` asks its call for
`upgrade-gate: true`. The second is a rule this workflow now keeps rather than
skips — **a live consumer that owns migrations should pass `upgrade-gate: true`
here**, where it runs against the server that consumer pinned.
[docs/gates/db-upgrade.md](docs/gates/db-upgrade.md) is what it does.

| Input                 | Type      |
| --------------------- | --------- |
| `build`               | `boolean` |
| `affected`            | `boolean` |
| `nightly`             | `boolean` |
| `compose`             | `boolean` |
| `mutation-lane`       | `boolean` |
| `mutation-floor`      | `string`  |
| `contract-exemptions` | `string`  |
| `stack-allowlist`     | `string`  |
| `data-jobs-external`  | `string`  |
| `test-network`        | `string`  |
| `test-suite-evidence` | `string`  |
| `database`            | `string`  |
| `database-image`      | `string`  |
| `upgrade-gate`        | `boolean` |
| `db-gate-evidence`    | `string`  |
| `start-command`       | `string`  |
| `health-url`          | `string`  |
| `probe-command`       | `string`  |
| `probe-timeout`       | `string`  |
| `capacity-script`     | `string`  |
| `capacity-path`       | `string`  |
| `route-allowlist`     | `string`  |
| `datetime-allowlist`  | `string`  |

The first eleven are handed to dev-config's `check.yml` unchanged, so
[its README](https://github.com/gokayo43/dev-config#ci) is the reference for
what one does and for the conditions under which it refuses one. The inputs
here carry no description of their own for that reason — a second copy of that
prose is a copy that drifts — and the one exception says what dev-config
cannot: that a consumer of this workflow owes `ci-call`.

The other twelve drive this workflow's own job and reach dev-config's
`check.yml` under no name at all — `database` is the exception among them, since
it decides a job here AND is handed on. Ten are spelled the way dev-config
spells the same ten, and mean here what they mean there against another server:
`database` adds the database job below, `upgrade-gate` adds its upgrade step,
`db-gate-evidence` names the artifact it leaves behind, and the seven after them
aim its boot, probe and ramp steps —
[docs/gates/db-serving.md](docs/gates/db-serving.md) is what each one does. A
consumer that moves between the two workflows writes one call either way.

Two are names dev-config has no use for. `datetime-allowlist` is the type this
family gets wrong where Postgres gets it right: their `timestamp-allowlist`
stays refused below rather than standing in for it, and
[docs/gates/db-datetime.md](docs/gates/db-datetime.md) is what it waives.
`database-image` is the server itself, which dev-config's Postgres job has no
question to ask — [docs/gates/db-server.md](docs/gates/db-server.md) is what is
done with it.

`tests/wrapper-inputs.test.ts` is what keeps every list on this page honest: it
reads the dev-config this repo installs — the same commit the workflows call —
and fails on a type or default of this wrapper's own, on an input declared that
nothing reads, and on a name this page has stopped accounting for.

Every other input dev-config's `check.yml` declares is refused here rather than
forwarded: `semantic-fixtures`, `timestamp-allowlist`, `backfill-seed`,
`backfill-command`, `fuzz-seed` and `route-retire`. Each is aimed at a step of
the Postgres database job this workflow leaves off — theirs refuses all six on a
call passing `database: external`, so forwarding one would be this workflow
sending a consumer a refusal from a job they never asked for — and the jobs below
are what will answer them for this family.

`upgrade-gate` was on that list until dev-config stopped demanding its own
upgrade gate of a caller passing `database: external`: the duty came here with
the value, and [docs/gates/db-upgrade.md](docs/gates/db-upgrade.md) is this
workflow's answer to it for both products.

Passing any input aimed at this repo's own database job without asking for that
job is refused rather than ignored, which is what the `refusals` job is for. An
input that defaults to empty is refused when it is non-empty, since a
`workflow_call` input cannot be asked whether the caller passed it. Two here
carry a value instead — `database-image`, so that a consumer running the server
this repo certifies writes nothing, and `upgrade-gate`, which is a boolean —
and those are compared with their declared defaults, which leaves exactly one
caller invisible: the one who passes the default itself.
`docs/gates/db-serving.md` names that hole rather than implying it is closed.
`start-command` and `health-url` are not in it: both default to empty and take
their real default in the database job, which is also the only place
`health-url`'s could live, since it names a port that job allocates while it
runs.

`db-gate-evidence` is asked the same question this workflow's own job can ask:
passing it with `database: none` fails the run rather than being ignored, since
it names an artifact nothing would have uploaded. Its default is a constant, and
an artifact name may be claimed once per run — so a caller running this workflow
as a **matrix** gives each leg its own, and keeps it distinct from
`test-suite-evidence`, exactly as dev-config's README describes for its own two.

## The jobs

| Job                 | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `refusals`          | the one rule this workflow adds rather than delegates: a call asking for an input aimed at a database job, without that job, is refused rather than ignored                                                                                                                                                                                                                                                                                             | shipped                                                            |
| `static`            | dev-config's `check.yml` with the caller's `database` handed on: the secret scan, the repo contract, the stack denylist, the workflow lint, suppression hygiene, shell scripts, `format:check` / `lint` / `typecheck` / `knip`, the test suite, and — each where the caller asks for it — the compose lint and the mutation lane                                                                                                                        | shipped                                                            |
| `database`          | the server the consumer pinned, started and answering — [docs/gates/db-server.md](docs/gates/db-server.md) — then the repo's `db:migrate` onto an empty database on it, twice, compared as normalized schema dumps — [docs/gates/db-replay.md](docs/gates/db-replay.md) — and then, against that database, the app booted, the repo's own probe run, and a k6 ramp with the route-coverage floor — [docs/gates/db-serving.md](docs/gates/db-serving.md) | shipped                                                            |
| upgrade path        | a step of `database` where the caller asks for it: the base ref's migrations replayed into a database of the gate's own, this branch's applied on top, and the schema compared with the fresh replay's — [docs/gates/db-upgrade.md](docs/gates/db-upgrade.md)                                                                                                                                                                                           | shipped                                                            |
| backfill            | a backfill run twice, and the rows a deployed database already has graded against this branch's contract                                                                                                                                                                                                                                                                                                                                                | planned ([#4](https://github.com/gokayo43/dev-config-db/issues/4)) |
| DATETIME wall clock | a step of `database`, after the migrations have built the schema: every `DATETIME` column in the database they built carries a reasoned allowlist entry, this family's half of the ambiguous-instant class — [docs/gates/db-datetime.md](docs/gates/db-datetime.md)                                                                                                                                                                                     | shipped                                                            |
| integration lane    | the repo's DB-touching suite against a real server and Redis, with the junit report read afterwards                                                                                                                                                                                                                                                                                                                                                     | planned ([#6](https://github.com/gokayo43/dev-config-db/issues/6)) |

## Gating this repo

`.github/workflows/ci.yml` calls dev-config's `check.yml` directly rather than
the workflow beside it: a commit cannot pin its own SHA, so the wrapper would
gate every review against the dev-config of one commit ago. Both files name one
dev-config commit, and the suite fails when they stop agreeing.

```sh
bun install
bun run check   # format:check + lint + typecheck + knip
bun test        # needs Docker: the database gates' suites drive real servers
```

The suite starts one container per product per worktree — a MariaDB and a MySQL
8, since every server-touching case runs against both — and takes them down
again, so `bun test` needs a Docker daemon it can reach. It also starts a real
app on a real port, which is what the boot, probe and ramp gates are graded
against. It is not sealed the way every other repo's suite is: dev-config's
test-suite gate runs `bun test` in a network namespace holding nothing but its
own loopback, and a container's published port is on the runner's.
`test-network` in `ci.yml` is the reason for that, written where it is read in
review.

Beside that call, `ci.yml` carries one job of its own: the k6 ramp shipped with
the serving gate, executed under the k6 that gate pins. Nothing in `bun test`
may fetch a binary, and "it runs inside k6" is not a reason for nothing to have
run the file.

## Pins

The call is pinned by commit SHA with the release as a trailing comment, in both
workflows. `renovate.json` extends dev-config's preset, which reads a job-level
`uses:` like any other dependency and holds dev-config's own pins back from
automerge — a bump here is a gate landing in two repos, and it is read before it
is merged.
