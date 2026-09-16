# dev-config-db

The MySQL-family extension of `gokayo43/dev-config`, for the two legacy repos
whose database is not Postgres — one on MariaDB, one on MySQL 8. `CONTEXT.md` is
the vocabulary; `README.md` is the reference for how a consumer calls this
workflow and what each job does.

## Canon

The house rules live outside this repo and win over anything here:
`~/claude-shared/STACK.md`, `architecture.md`, `testing.md`, `principles.md`.
dev-config is where most of them are already executable — this repo adds the one
thing that could not live there.

## The rule this repo exists to keep

**It only adds.** No gate here loosens one of theirs, and the static half is a
call rather than a fork. A change that would be better made in dev-config is
made in dev-config: this repo is for what is MySQL-family-shaped and nothing
else.
Anything that reads as "the base should have this too" is an issue there, not a
second implementation here.

**The one carve-out: the gate library.** A composite action runs from a checkout
of its own repo with no `node_modules` above it, and `.github/` is outside
dev-config's `files` allowlist — so nothing under `.github/actions/` here can
import from the dev-config this repo installs, by any route. Several files
therefore carry checked-in copies of theirs at the pinned SHA, and each says so
in its own header with its deltas named: `_lib/annotations.ts` (the writing half
of their `_lib/gate.ts`), `_lib/foreign.ts` (its narrowing half),
`_lib/allowlist.ts` (its `-- why` half), the four functions
`db-replay/database.ts` names (`databaseIn`, `migrate`, `rowsIn`, `textIn`), and what the
serving gate ports — `db-serving/probe.ts`, `route-coverage.ts`, `capacity.ts`,
`route-log.ts` and the k6 script `ramp.js` — and the upgrade gate's
`db-upgrade/base-lineage.ts` and `db-upgrade/repo.ts`, which are theirs entire
but for a problem being a string here rather than their `Problem`.
[dev-config#69](https://github.com/gokayo43/dev-config/issues/69) is where
ending that is argued.

One of those copies is not blind, and it is the shape the rest could take.
`route-log.ts` is a protocol both ends of a contract need, so dev-config
publishes it — it is in their `files` allowlist, and a consuming app imports it.
A **test** resolves `node_modules` normally even though an action cannot, so
`tests/route-log.test.ts` holds this repo's copy to dev-config's own module and
fails when either end drifts. The other copies have no published original to be
held to; `.github/` reaches this repo's install only because a `github:`
dependency is a full checkout.

The carve-out is for what the runtime makes unreachable, and nothing else. It is
not licence to fork a gate: an assertion, a diagnostic or a rule that could live
in dev-config still belongs there. And it cuts both ways — a bug fixed there is
a bug still here until somebody carries it over, and two fixes have so far gone
the other way ([dev-config#70](https://github.com/gokayo43/dev-config/issues/70),
[#71](https://github.com/gokayo43/dev-config/issues/71)), which is why a copy
that has been improved says so at the line that improved it.

## Layout

- `.github/workflows/check.yml` — the wrapper consumers call. Three jobs: the
  call into dev-config's `check.yml` with the consumer's own `database` handed
  on — their enum's `external` is the value for a workflow that runs the
  database gates in that job's place, so one input decides both and this file
  answers for nobody — the always-running
  `refusals` job that fails a call asking for a database-job input without the
  job, and `database`, which is every database gate this repo has — one job, and
  CONTEXT.md's entry for the term says why there will stay one. Its server is a
  **step** rather than a service container, because the image is the consumer's
  `database-image` input and dev-config's pin gate refuses an expression in
  `services` (dev-config#68); `docs/gates/db-server.md` carries the argument and
  what it costs. Every gate step
  in it is handed the interpreter by a step that reads it at the top of that
  job, before a line of the graded repo's own code has run, the search path too
  wherever the step resolves a program by name, and the database as the server
  step's own output — docker assigns the port, so that value is one step later
  and still earlier than anything the graded repo runs. Every one of the three
  is an expression a later step cannot rewrite, and the job's last step removes
  the container the server step named — a composite action has no `post:`, so a
  server nobody takes down outlives the job on a runner that is not thrown
  away. It installs the graded repo's dependencies through **dev-config's own
  `install` action** rather than a `bun install` of its own, which is what lets
  one key serve both jobs: the `git-ssh-key` secret this workflow declares is
  handed to that action here and to their check.yml in the call above, and to
  nothing else — writing, using and removing it is theirs. `#2`, `#3`,
  `#5` and the upgrade path are shipped; `#4`'s backfill half and `#6` land as
  further steps of it, each with the composite action that runs it, its own
  suite, and its page under `docs/gates/` — the shape dev-config's "Adding a
  gate" describes.
- `.github/workflows/ci.yml` — this repo's own gate, which is dev-config's
  `check.yml` called directly. It cannot be the wrapper: a commit cannot pin its
  own SHA, so the wrapper's pin is always one commit behind whatever is under
  review.
- `.github/actions/` — the gates themselves, each a `<name>.ts` the suite drives
  and a `<name>.main.ts` the action runs. Five directories, all steps of the one
  database job: `db-server` (the server the rest of them grade), `db-replay`
  (`#2`), `db-upgrade` (the upgrade path, which dev-config leaves to a wrapper
  passing `database: external`), `db-datetime` (`#5`) and `db-serving` (`#3`,
  the boot, probe and ramp). Each splits what talks to something from
  what is pure, so that a verdict can be driven without the thing under it —
  `db-replay/database.ts` and `db-replay/schema.ts`, `db-serving/ramp.ts` and
  `db-serving/capacity.ts`; `db-datetime` reads its catalogue through the first
  of those and opens no connection of its own, and `db-upgrade` splits the same
  way — `base-lineage.ts` and `repo.ts` are git and files, `upgrade.ts` is the
  verdict. `_lib/` is what every action
  shares: `annotations.ts` (the log protocol and the run summary), `foreign.ts`
  (the one place a document nobody here wrote is narrowed), `allowlist.ts` (how
  an allowlist input is read, what a reason costs, and what a dead entry costs)
  and `gate.sh` (how every gate step starts its own program).
- **A gate step takes nothing from the repository it grades.** It runs in the
  action's own checkout — `bun` reads a `bunfig.toml` `preload` from its working
  directory, and a graded repo's is not the gate's to run — under an interpreter
  and, where it resolves a program by name, a search path that the calling job
  read before that repo's install scripts, build or migrator could rewrite
  either. `check.yml`'s `pinned` step is where they are read, `_lib/gate.sh` is
  where they are refused when empty and where the rule about which steps need
  which is written, and the project reaches the gate as a path rather than as
  the place it was run. Anything a new gate resolves by name — a binary, a
  config, a database URL — belongs on that list.
- The evidence artifact belongs to the **job**, not to either action — the
  upload step in `check.yml` says why, and is where `db-gate-evidence` is read.
  What that costs a new gate: a file it leaves in the runner goes on that step's
  `path`, and `tests/serving-job.test.ts` fails when one does not.
- `tests/` — what CI cannot see from outside. `wrapper-inputs.test.ts` grades
  the wrapper and the README against the dev-config in `node_modules`, which is
  the commit the workflows call: every input the wrapper hands on reaches the
  call under its own name, every input it declares is read by something and is
  declared with dev-config's own type and default, nothing is forwarded that
  dev-config does not declare, the call carries no literal at all — every value
  in it is a consumer's input handed on — only one job calls that workflow at
  all, what the README
  tables and what it says is refused cover dev-config's input surface exactly,
  the four carriers of the dev-config pin agree, every action pin names a commit
  this repo carries AND one whose `.github/actions` is the tree here now, every
  step taking a server image is handed the caller's one input, and no service
  image is an expression — which is the rule that decided the server is a step.
  `refusals.test.ts` runs the wrapper's own `run:` block — extracted from the
  shipped YAML rather than transcribed, with the environment derived from its
  own `env:` block — over the whole truth table of the rule this workflow adds.
  `serving-job.test.ts` grades the wiring no gate can see from inside: which
  steps the job runs, what the app is given, whether every file a step leaves in
  the runner is actually uploaded, and that every step declares the pins above.
  `action-steps.test.ts` and `serving-steps.test.ts` run the shipped `run:`
  blocks against a checkout that fights back — a `bunfig.toml` preloading its
  own code, a `DATABASE_URL` naming a database of its own, a `bun` or a `docker`
  of its own first on PATH — both through the one harness in `action-step.ts`.
  `upgrade.test.ts` drives the upgrade path against a real git history — the
  fixture in `repo.ts` commits twice, because what that gate grades is the
  relationship between two commits rather than a tree.
  `server.test.ts` grades the step that replaced the service container, which is
  the one piece of wiring the runner used to guarantee: a server that never
  answers, one that came up and died, a container a killed run left behind, and
  two started at once from one declaration — which is what a fixed host port
  cost and what the daemon-assigned one buys.
  `entrypoints.test.ts` is the lane that runs what GitHub runs: every
  `*.main.ts` as a process, under a wall clock, asserting it **ends** — the
  property no in-process test can see, and the one a gate that starts a
  long-lived app gets wrong. The rest of the suite drives the gates against the
  real thing — a container per server product, started through the shipped
  `db-server` and removed by `tests/servers.ts`, and a real app process on a
  real port — which is why `ci.yml` sets `test-network`. Every case that touches
  a server runs against both products; the two that cannot are marked where they
  stand, and each is the dialect rather than the gate.

  The one thing the suite cannot run has a job of its own in `ci.yml`: nothing
  in `bun test` may fetch a binary, so the shipped k6 ramp is executed by
  `tests/ramp-script.ts` under the pinned k6 that `k6.sh` fetches. "It runs
  inside k6" is why the linter and knip skip that script, and it is not a reason
  for nothing to have run it.

## The servers this repo serves

Two products, because the two consumers run two: `nfp-elysia` is MariaDB 11.4
(probed: `11.4.12-MariaDB`) and `wmstcs` is **MySQL 8.0.32** — the owner's
decision on `#9` was that wmstcs stays there, so serving both is a requirement
rather than a question.

A consumer declares which by pinning `database-image`; nothing here infers a
product from a reference, and the default is the MariaDB build this repo
certifies. Only three things in the tree had anything to decide about the
difference, and each says so where it stands:

- **the dump client has no shared name** — MariaDB 11.4 ships `mariadb-dump`
  with no `mysqldump`, a MySQL 8 image ships only `mysqldump` — so `database.ts`
  asks the image which it has, once, before anything is migrated;
- **a catalogue read comes back in different case** — MySQL 8 labels
  `information_schema` columns upper case, MariaDB lower — so every query here
  aliases what it selects, and `rowsFrom` is where that is written down;
- **MySQL 8's default authentication needs an encrypted socket** — Bun refuses
  the RSA public-key retrieval that `caching_sha2_password` otherwise wants — so
  `connection` opens every connection with TLS the server's own certificate
  cannot be verified against, which MariaDB is indifferent to.

Everything else — the types the DATETIME gate grades, the dump's normalisation,
the serving gate — is the same on both, and the suite proves it by running every
server-touching case against a real one of each in one `bun test`. The MySQL pin
the suite certifies against lives in `tests/servers.ts` and is deliberately 8.0:
it tracks what `wmstcs` runs rather than what MySQL ships.

## Moving the dev-config pin

Four files carry it — both workflows, `package.json` and `bun.lock` — and the
suite requires all four to name one commit: a repo gated by one dev-config,
shipping another and grading its own wrapper against a third has no answer about
any of them. Renovate raises the bump as a PR (`renovate.json` extends
dev-config's preset, which keeps that pin off automerge); the tag in the trailing
comment moves with the SHA, and `bun install` is part of adopting it.

Renovate reaches the manifest through a different oracle than the workflows —
digest against dev-config's default branch, tag for the two `uses:` — so a bump
raised while dev-config's `main` sits ahead of its latest tag arrives with the
carriers disagreeing, and the suite fails on that PR. Point all four at the
tagged commit by hand when it happens.
[#8](https://github.com/gokayo43/dev-config-db/issues/8) is the decision
about ending that, including why the obvious fix — a tag in the manifest — is
refused by dev-config's own contract.

## Releasing an action

A commit cannot reference its own SHA, and inside a called workflow a relative
`uses:` resolves against the **caller's** checkout — so the wrapper reaches this
repo's actions by full path and SHA, and an action and the workflow pinning it
are two commits. dev-config carries the same shape; `check.yml` there is v0.50.1
pinning actions at v0.50.0.

Two consequences, both live from the first action this repo shipped:

- **A change to an action is two commits**, the second re-pinning the first.
  `tests/wrapper-inputs.test.ts` fails when a pin names a commit this repo does
  not carry, and when it names one whose actions are no longer the actions here
  — a pin that resolves but ships something else is the half nobody notices.
- **The pinned commit has to survive.** A squash merge orphans it, and an
  orphaned pin is an action GitHub cannot fetch — a database job that fails for
  every consumer at once. Tagging the release is what keeps it reachable, and
  until this repo has a release, merging without squashing is what stands in.

## Commands

```sh
bun run check   # format:check + lint + typecheck + knip
bun test
```

## Adoption

`wmstcs` calls this workflow; `nfp-elysia` has no CI workflow at all yet and
needs the fleet scaffold before the wrapper is worth pointing at. A consumer
also needs a runner carrying `self-hosted` and `linux`: without one its jobs
queue and are cancelled 24 hours later, which reads as a run that never started
— `README.md`'s "Where it runs" is what such a runner has to provide. Two things in dev-config's repo contract
refuse a consumer of this workflow on facts that are about dev-config's own
Postgres job rather than about the repo —
[dev-config#65](https://github.com/gokayo43/dev-config/issues/65) carries both,
and `README.md`'s call example carries the `ci-call` exemption that is the
answer until it lands.
