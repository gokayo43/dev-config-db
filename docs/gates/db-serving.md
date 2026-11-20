# The serving gate

`database: external` runs two more steps after the replay, in the same job and
against the database it just built: the app is **booted**, and the repo's own
**probe** is run against it where there is one.

Each answers a question the one before it cannot. Migrations applying says
nothing about whether an app can start against what they built. An app that
answers its health route says nothing about whether any answer was correct. A
migration set that applies, boots and quietly reinterprets what a column means
passes the boot — which is why the probe exists and why what it asserts is the
repo's rather than this gate's.

The steps are ordered: nothing can probe before the app answers. A step that
fails ends the run there, with that step's diagnostic and every later step
skipped — and the evidence written so far still leaves the run, because the run
that failed on the way is exactly the run whose partial evidence somebody
wants.

They run as steps of the same job the replay runs in, rather than as a job of
their own, because the migrated database is a container that job started and
holds — the `database` job is the only one there is, and CONTEXT.md's entry for
the term says why.

## Boot

`start-command` is how a repo starts its app and `health-url` is what this polls
until it answers 200 — the two inputs a repo writes when its app is not started
and reached the way the defaults assume, since everything else here is the same
for every repo.

Both default to empty in the call and take their real value in the database job:
`bun run start`, and `http://localhost:${PORT}/api/health`. The job replaces every
`${PORT}` in `health-url` with the port it allocated for the app, the default's
and a caller's alike, and hands the app that port as `PORT`. `PORT` is the
platform convention, so an app that honours it and answers at `/api/health`
needs neither input; one that answers elsewhere writes only `health-url`, with
the placeholder where the port goes; an app that ignores `PORT` writes both, and
its `health-url` names the port its `start-command` gives it. The port is
allocated rather than fixed because the runner is a shared, persistent machine —
README's "Where it runs" is the argument, and it is also why neither default
could be declared as the input's own.

A health route answers only once the process is up and a query has
round-tripped, so a migration that applies and leaves the app unable to run
fails here: a column the model says is not null and the lineage left nullable,
an enum the code selects on that no migration created, an index a startup query
needs. Every one of those is a green replay and a dead deploy.

The poll watches the process as well as the URL, and the two are read together:
a 200 counts as this app's answer only while the process this step started is
alive to have served it, read out of `/proc` at the moment the answer arrives
rather than out of the runtime, which learns of an exit as an event and learns
it late. An app that answers and dies in the same breath is reported as having
exited — it is not serving either way. A start command that dies on
its first line otherwise looks exactly like a slow boot, and the run spends its
whole bound before saying so — the diagnostic then names the app rather than the
bound, and carries what the app itself wrote. Each attempt is bounded too, and
never by longer than what is left of the whole bound: a process that accepts the
connection and never answers is otherwise indistinguishable from a slow boot.

**A `health-url` that already answers is refused before anything is started.**
The step polls a URL to decide whether the app came up, and a 200 off a port
something else on the machine already holds says nothing about the app — it says
the runner is shared. Left alone, that is not one wrong verdict: it is a green
boot and a probe, both run against a stranger while the app under grade never
ran. A consumer meets this by naming a port of its own in
`health-url`. One writing `${PORT}` gets a port nothing held when the job
allocated it, but the job lets go of that port so the app can bind it, and the
kernel can hand it out again in between
([dev-config#123](https://github.com/gokayo43/dev-config/issues/123), item 2);
that collision is rare and fails here, loudly, rather than grading a stranger.

A `health-url` that is not an http(s) URL is refused by name rather than polled.
`localhost:3000/health` parses as a URL — with `localhost:` read as its scheme —
and polling it is an app that never answers, so the diagnostic would send its
reader to the app.

The environment the app gets is the job's, plus the house server contract with
dummy secrets — a real secret in a workflow is a leaked secret. A repo whose
contract needs more than that extends this workflow rather than its own call.

Everything the app writes is captured, relayed to the log under a diagnostic
that needs it, and uploaded whatever happened to the run. Relayed rather than
printed: it is text the graded repo wrote, on the stdout the runner reads its
own commands off — `_lib/annotations.ts` carries that argument at length, and
dev-config#71 is the same hole upstream.

The poll reads the process two ways, because a child that died on a signal has
no exit code at all: the code is never chosen, and only the signal name is
there. That is the canonical runner failure rather than an exotic one — it is
what the OOM killer does to an app booting against a schema it cannot hold — and
a gate reading the code alone would spend the whole bound and then report a live
process.

An app that failed to come up is killed before the step ends. Nothing after it
can use the app, and a wedged process holding a port until the job's timeout is
a runner this suite also has to run on.

**The step ends; the app does not.** That is a stranger pair than it looks: a
process that spawned a long-lived child stays alive as long as the child does,
so a boot step that published a green verdict and let the runtime hold that
reference would hang until the job's timeout — with the probe skipped, on
exactly the runs where everything worked. The gate releases the app
deliberately and leaves it serving.

## What the graded repo does not get to choose

These steps run inside the job of the repository they grade, after its install
scripts, its build and its migrator have each had a turn. Three things they
would otherwise take from their surroundings are that repo's to rewrite, and
every one of them ends the same way — the step green, having graded nothing:

- **the working directory.** `bun` runs a top-level `preload` from the
  `bunfig.toml` in its working directory before the file it was given, so a gate
  running in the graded checkout runs whatever that repo's bunfig names. A
  `process.exit(0)` there ends the step at zero. No hostility is required: a
  legitimate `preload` injects exactly the same way. The gate steps therefore
  run in the action's own checkout, and the app and the probe are pointed at the
  project by a path instead;
- **the interpreter.** A step of the graded repo's own writes `$GITHUB_PATH`,
  the runner folds it into every later step, and a `bun` resolved by name is
  then that repo's to replace with a program that exits 0;
- **everything else resolved by name** — `setsid` and `bash` for the processes
  these steps start.

So the calling job reads the interpreter and the search path once, in a step
placed after `setup-bun` and before the install — the last moment at which no
line of the graded repo's code has run — and hands both to the action. A step
output cannot be rewritten once it is set, and a step's own `env:` beats
anything an earlier step exported, which is what makes those two immutable
rather than merely early.

One consequence a consumer should know: the app and the probe run under that
same search path, so a directory a repo prepends through `$GITHUB_PATH` does not
reach its own app here either. Its `PATH` is the job's, as it stood after
`setup-bun`.

## The repo's own probe

`probe-command` is one command of the repo's own, run against the booted app
after it answers its health route: a real process, a real HTTP client, a real
migrated database, nothing stubbed. Its contract is dev-config's, unchanged,
because a MySQL-family repo graded more leniently than a Postgres one is this
repo breaking the rule it exists to keep:

- **stdout is the verdict** — every line the command writes there is one
  problem, whatever it exits with;
- **a command that exits non-zero having written nothing** is a failure the gate
  words for itself, because a red step with an empty explanation is the one
  thing no gate here may produce.

Stdout rather than the exit status, because the status is the half a probe gets
wrong. A runner that collects failures and reports them at the end, a shell
function whose last command happened to succeed, a `set +e` somebody added while
debugging: each of those prints exactly what is broken and then exits 0. Reading
the status first would make this gate's answer depend on the one thing about a
repo's own program it cannot see, and the failure mode is silence over an app
that said out loud what was wrong with it.

The command runs as shell — a pipe or an `&&` means what it says — in the
project the caller declared, with the app's URL in `HEALTH_URL`, the same name
the boot step uses for it. Its environment is the job's, less the two
ways of asking for colour and the terminal type they are read off: stdout is the
protocol here, and a problem arriving wrapped in escape codes is a problem
nobody can match to a route. Escape sequences are stripped from a line before it
becomes an annotation anyway, for the probe that colours unconditionally.

Its output is capped at fifty annotations, with a line saying how many there
were: a probe is one or two contract-level assertions per invariant, and four
thousand annotations render as neither a list nor a page. The whole output is on
the log either way.

`probe-timeout` bounds it, in seconds, and empty takes the bound `probe.ts`
declares — two minutes today — which is where that number and the argument for it
live. An hour is the most it takes, and that ceiling is arithmetic rather than
policy: a bound at or above 2147484 seconds overflows the timer it is stored in
and kills the probe the instant it starts, under a diagnostic saying it ran too
long.

**The bound takes everything the probe started.** The command runs under
`setsid`, so its shell is a process-group leader and the kill addresses the
group. That is not a detail: bash only _execs_ a command that is one simple
command, so a pipeline, a subshell, a background job or a command that forks a
worker leaves children behind when the shell alone is killed — and those
children still hold the write end of the stdout pipe, so the step reading it
never sees the end of the output. A bound that hangs is worse than no bound,
because the job's whole timeout goes with nothing said. A probe meaning to leave
something running behind it will not: that is the trade a bound is.

The step runs when **either** input is set, and a `probe-timeout` with no
`probe-command` under it is refused here, as this action's own check of its
inputs. The wrapper refuses the same call earlier: its `refusals` job when the
database job is off, and the database job's first step when it is on, before
anything is checked out. A bound on nothing is an input somebody wrote that
nothing would have read.

## What the wrapper refuses before any of this runs

Every input above is aimed at a job the caller may not have asked for, so passing
one with `database: none` fails the call rather than being ignored — a repo that
has written out how its app starts or what its probe asserts has said plainly
that it expects them to run.

A `workflow_call` input cannot be asked whether the caller passed it —
`github.event.inputs` is not populated for one — so "the caller passed this" is
spelled "the value is non-empty". That works for every input defaulting to `""`
and cannot work for one carrying a value, which is why `start-command` and
`health-url` carry none: their real defaults live in the job, where the port in
`health-url`'s is allocated anyway.

Two inputs still carry a value, for reasons of their own — `database-image`, so
that a consumer running the certified server writes nothing, and `upgrade-gate`,
which is a boolean and has no empty spelling. Those are compared with their
declared defaults instead, and the suite holds the guard's copy of each to what
this workflow declares. What that leaves uncovered is one caller, named below.

## Evidence

Everything the database job leaves in the runner is uploaded as the artifact
`db-gate-evidence` names:

| File                        | What it answers                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `replay-from-empty.schema`  | the schema the lineage built on an empty database, one of the two the replay compared                                |
| `replay-again.schema`       | the second replay's, the other of the two                                                                            |
| `upgraded-from-base.schema` | the schema the upgrade path reached, where the caller asked for it — [db-upgrade.md](db-upgrade.md)                  |
| `server.log`                | what the app said while all of this happened — copied while the process still holds it open, so the tail may be torn |
| `database-server.log`       | what the database server said, read just before the job removes it — [db-server.md](db-server.md)                    |

It runs under `always()` rather than `!cancelled()`, and the difference is the
whole point of having it: the runner marks a job cancelled when it hits its own
`timeout-minutes`, so `!cancelled()` skipped the upload on exactly the runs that
had spent fifteen minutes producing the evidence.

The upload belongs to the job rather than to either action — one database, one
app, one artifact, and a name that may be claimed only once per run;
`check.yml`'s upload step is where that is argued and where the name is read. It
runs whatever the steps before it did, so a probe that failed and an app that
never answered leave the same evidence behind.

## What this cannot catch

Named rather than papered over, because a gate whose limits are undocumented
gets trusted for things it never checked.

- **Whether any answer was right, beyond what the probe asserts.** The boot
  proves the app starts; after it sits exactly one command, and what it does not
  assert is not checked. A probe that exits 0 without asserting anything passes
  every build, exactly as a test that asserts nothing does.
- **Anything about the deployed shape.** One process on a CI runner, against a
  database built ten seconds ago, sharing a machine with the servers this job
  started.
- **What the app holds under load.** Nothing here sends it more than the boot
  poll and the probe's own requests. Load is measured by dev-config's
  `capacity-ramp` command, against a target named when it runs.
- **A second program in the repo.** The boot covers the program `start-command`
  starts and only that one: another app in the same repo is never started.
- **A caller who passes `database-image` or `upgrade-gate` as exactly their
  declared defaults with `database: none`.** That value is indistinguishable
  from the value a caller who wrote nothing gets, so it is ignored in silence.
  Everything else aimed at this job is refused.
- **Anything about racing writers.** Nothing here asserts what happens when two
  requests meet in one row. That is a repo's own probe or its own suite, not
  this.
- **A tool the gate resolves by name that the machine itself is lying about.**
  The pins above put the graded repo out of reach; they say nothing about a
  compromised runner image, which is a different threat with a different answer.
- **An app the migrations broke in a way it survives.** A schema the app boots
  against and is wrong about is what the probe is for, and the probe is
  optional.
