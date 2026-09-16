# The serving gate

`database: external` runs three more steps after the replay, in the same job and
against the database it just built: the app is **booted**, the repo's own
**probe** is run against it where there is one, and it is **ramped** with the
route-coverage floor underneath.

Each of them answers a question the one before it cannot. Migrations applying
says nothing about whether an app can start against what they built. An app that
answers its health route says nothing about whether any answer was correct. A
route table answering every request says nothing about what the surface does
under load. A migration set that applies, boots, serves every route and quietly
reinterprets what a column means passes two of the three — which is why the
middle one exists and why what it asserts is the repo's rather than this gate's.

The steps are ordered and the order is the whole of the design: nothing can
probe or ramp before the app answers, and nothing can count routes before the
ramp. A step that fails ends the run there, with that step's diagnostic and
every later step skipped — and the evidence written so far still leaves the run,
because the run that failed on the way to a number is exactly the run whose
partial evidence somebody wants.

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
`bun run start`, and `http://localhost:${PORT}/api/health` on the port that job
allocated for the app. `PORT` is the platform convention, so an app that honours
it needs neither input; an app that ignores it writes both. The port is
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
boot, a probe and twenty ramp VUs, all run against a stranger while the app
under grade never ran. A consumer meets this only by naming a `health-url` of
its own; the job allocates a port for the app otherwise.

A `health-url` that is not an http(s) URL is refused by name rather than polled.
`localhost:3000/health` parses as a URL — with `localhost:` read as its scheme —
and polling it is an app that never answers, so the diagnostic would send its
reader to the app.

The environment the app gets is the job's, plus the house server contract with
dummy secrets — a real secret in a workflow is a leaked secret — and `ROUTE_LOG`,
which is the instrument the floor below reads. A repo whose contract needs more
than that extends this workflow rather than its own call.

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
reference would hang until the job's timeout — with the probe, the ramp, the
floor and the evidence all skipped, on exactly the runs where everything
worked. The gate releases the app deliberately and leaves it serving.

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
  run in the action's own checkout, and the app, the probe and the ramp are
  pointed at the project by a path instead;
- **the interpreter.** A step of the graded repo's own writes `$GITHUB_PATH`,
  the runner folds it into every later step, and a `bun` resolved by name is
  then that repo's to replace with a program that exits 0;
- **everything else resolved by name** — `setsid` and `bash` for the processes
  these steps start, and `curl`, `sha256sum` and `tar` for the k6 fetch below. A
  checksum is a contract only while the program checking it is the one this job
  started.

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
after it answers its health route and before the ramp: a real process, a real
HTTP client, a real migrated database, nothing stubbed. Its contract is
dev-config's, unchanged, because a MySQL-family repo graded more leniently than
a Postgres one is this repo breaking the rule it exists to keep:

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
the boot step and the ramp use for it. Its environment is the job's, less the two
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
`probe-command` under it is refused twice — once by the wrapper's own guard,
before any job runs, and once here. A bound on nothing is an input somebody
wrote that nothing would have read.

## The ramp

k6 against the app, with the app's own route counters read either side of it.
There is no knob: an app the database job can boot is an app that serves
something, and a serving surface nothing has ever put under load is the case
this exists to catch. What a repo still chooses is _what_ the ramp hits —
`capacity-path`, a `capacity-script` of its own, and the reasoned
`route-allowlist` for whatever neither can reach.

**The number is a trend line, not a capacity claim.** GitHub's runners vary by
machine, by neighbour and by hour, and the app is sharing one with a database
server, a Redis and whatever else the job started. What it is good for is
noticing that a change moved the number by an order of magnitude. The number
that answers "how much load does this hold" is a ramp against the deployed
shape, which testing.md asks for before a surface takes real users and again
after a hot-path change; this gate does not replace that and is not evidence for
it.

There is no latency threshold for the same reason: a latency bound on a shared
runner fails on a bad neighbour rather than on a bad commit, and a gate that
fails for reasons nobody caused is a gate somebody switches off. That reasoning
covers latency and throughput. It does not reach a failure rate — a request the
app refused is refused on every machine — so more than a tenth of the requests
failing is the one number this refuses, and it is applied to the summary rather
than declared as a threshold in the shipped script, because `capacity-script`
replaces that file entirely and a rule a caller can drop by accident is not a
rule.

So the step fails when: k6 died, or ran past its bound and was killed with
everything it started — `capacity-script` is a program of the repo's own, and a
script that wedges would otherwise spend the job's whole budget and take the
floor and the evidence with it; it exited cleanly and exported no summary at
all; more than a tenth of its requests failed; it ran and made no requests, so
there is no number to record; the summary it wrote is not the shape this reads;
or a route the app serves was never exercised. Latency, throughput and a failure
rate under a tenth are published for a human to read, as a table on the run
summary.

**One step decides all of that, the floor included.** The floor is the
difference between two reads of the app's counters that this same step takes, so
it is decidable the moment the second one lands — including on the run the
failure bound is about to refuse. Behind a step of its own it would sit under
`success()`, and a ramp that breached the bound would skip it: every route
nothing reached would then cost a CI round-trip that the measurement had already
paid for, which is the failure the whole annotate-everything-once contract
exists to prevent. The one case the floor is skipped is the one where it cannot
be computed — the second snapshot was never taken, and the step is already
failing over saying so.

### The route-coverage floor

**A floor, in the sense the coverage threshold is one.** It catches the route
that no load has ever touched — an endpoint shipped without the ramp being
extended to reach it — and claims nothing at all about whether the load that did
touch a route resembles production traffic. Shipping an endpoint the ramp does
not reach is red for the same reason shipping code with no test is.

The protocol is dev-config's, published as
[`@gokayo43/dev-config/route-log.ts`](https://github.com/gokayo43/dev-config/blob/main/docs/exports/route-log.md)
and imported by the app end: under `ROUTE_LOG` an app serves `GET /__route-log`,
answering with every route it has and how many requests each has taken. The ramp
reads that once before k6 runs and once after, and **coverage is the
difference** — a route whose count rose is a route the ramp reached, and one
whose count stood still is uncovered however often the boot poll had already
touched it. That is what keeps this job's own traffic out of the floor.

A route registered for every method is covered by whichever method reached it,
and is credited only with the methods no route of its own path claims: a router
hands a `GET /events` to the `GET /events` registered beside `ALL /events`, so
crediting the catch-all with it would mark a handler covered that the ramp never
ran.

A route the ramp cannot cover goes in `route-allowlist` as a `METHOD /path --
why` entry, the same price a lint directive pays. An entry is refused in its turn
when it is not a route, when it names a route the app does not serve, and when it
waives a route the ramp **did** exercise — an escape hatch nobody can see rotting
is how a gate quietly stops covering what it names. An entry with no reason is
asked none of those three questions: it fails the step for the missing reason,
still waives its route, and one mistake earns one diagnostic.

An app whose route table comes back empty fails, and so does an app that serves
no `/__route-log` at all — a floor that cannot see the routes is not a floor, and
"the app named nothing" is exactly the never-load-tested case this exists to
catch. So does one that answers 200 with something that is not a route log,
which is what a single-page app's catch-all does to every unmatched path: it is
refused as a problem this step reports, naming which of the two reads it was,
rather than as an exception thrown past the verdict — and the first read is
taken before k6 runs, so an app that cannot answer it is refused before the ramp
is paid for.

## Where k6 comes from

Nothing on a GitHub runner ships k6, and it is a Go binary rather than a package,
so it is in no lockfile and no install policy reaches it. It is fetched by
version and verified against the SHA-256 of the release archive — the version is
a label, the checksum is the contract, and Renovate's pinned-binary manager moves
the two together. The same pair dev-config pins, deliberately: a ramp is only
comparable with another ramp of the same k6.

The fetch lives beside the one step that sources it rather than in `_lib/`,
which is what every action here shares. It moves there when a second gate needs
a pinned binary.

## What the wrapper refuses before any of this runs

Every input above is aimed at a job the caller may not have asked for, so passing
one with `database: none` fails the call rather than being ignored — a repo that
has written out the routes it wants ramped, or the reasons a route cannot be, has
said plainly that it expects a ramp.

A `workflow_call` input cannot be asked whether the caller passed it —
`github.event.inputs` is not populated for one — so "the caller passed this" is
spelled "the value is non-empty". That works for every input defaulting to `""`
and cannot work for one carrying a value, which is why `start-command` and
`health-url` carry none: their real defaults live in the job, where the port in
`health-url`'s could live anyway.

Two inputs still carry a value, for reasons of their own — `database-image`, so
that a consumer running the certified server writes nothing, and `upgrade-gate`,
which is a boolean and has no empty spelling. Those are compared with their
declared defaults instead, and the suite holds the guard's copy of each to what
this workflow declares. What that leaves uncovered is one caller, named below.

## Evidence

Everything these steps leave in the runner is uploaded as the artifact
`db-gate-evidence` names, with the two schema dumps the replay compared:

| File                    | What it answers                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `server.log`            | what the app said while all of this happened — copied while the process still holds it open, so the tail may be torn |
| `capacity.json`         | the raw k6 summary, which the table is read from and another run's can be diffed against                             |
| `route-log-before.json` | what the app declared it serves, and what the boot poll had already reached                                          |
| `route-log-after.json`  | the same, after the ramp — the floor's verdict is the difference between the two                                     |

It runs under `always()` rather than `!cancelled()`, and the difference is the
whole point of having it: the runner marks a job cancelled when it hits its own
`timeout-minutes`, so `!cancelled()` skipped the upload on exactly the runs that
had spent fifteen minutes producing the evidence.

The upload belongs to the job rather than to either action — one database, one
app, one artifact, and a name that may be claimed only once per run;
`check.yml`'s upload step is where that is argued and where the name is read. It
runs whatever the steps before it did, so a floor that failed, a ramp that died
on the way to a number and an app that never answered all leave the same
evidence behind.

## What this cannot catch

Named rather than papered over, because a gate whose limits are undocumented
gets trusted for things it never checked.

- **Whether any answer was right, beyond what the probe asserts.** The boot
  proves the app starts, the floor proves every route was reached; between them
  sits exactly one command, and what it does not assert is not checked. A probe
  that exits 0 without asserting anything passes every build, exactly as a test
  that asserts nothing does.
- **Anything about the deployed shape.** One process on a CI runner, against a
  database built ten seconds ago, sharing a machine with the servers this job
  started. Latency and throughput here are the runner's; only the failure rate
  says something about the app.
- **Whether the load resembles production.** The floor says a route has been
  under load once. It says nothing about the shape of that load, the size of the
  payloads, or the concurrency a real user meets.
- **A handler that answers before the router.** A CORS plugin that answers every
  `OPTIONS` before the request reaches a route is invisible to the floor whatever
  the ramp sends it — which is why the reason on an allowlist entry matters: it
  is what says whether the route is unreachable by the ramp or unseeable by the
  floor.
- **What "covered" means, exactly.** It means _took traffic between the two
  reads_ rather than _k6 sent it a request_. Anything else talking to the app
  during the ramp counts too — a healthcheck, a sidecar — so a repo whose
  `capacity-script` does not ramp the health route can still see it covered by
  something else polling it.
- **A second program in the repo.** The floor covers the program
  `start-command` boots and only that one: another app in the same repo serves
  its own routes, has no instrument, and appears in no route table.
- **A caller who passes `database-image` or `upgrade-gate` as exactly their
  declared defaults with `database: none`.** That value is indistinguishable
  from the value a caller who wrote nothing gets, so it is ignored in silence.
  Everything else aimed at this job is refused.
- **Anything about racing writers.** The ramp puts twenty virtual users on the
  app at once, and nothing here asserts anything about what happens when two of
  them meet in one row. That is a repo's own probe or its own suite, not this.
- **A tool the gate resolves by name that the machine itself is lying about.**
  The pins above put the graded repo out of reach; they say nothing about a
  compromised runner image, which is a different threat with a different answer.
- **An app the migrations broke in a way it survives.** A schema the app boots
  against, serves every route against, and is wrong about is what the probe is
  for, and the probe is optional.
