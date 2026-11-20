# Vocabulary

The words this repo's workflows, tests and issues use, and what each one means
here. dev-config's own `CONTEXT.md` holds the vocabulary of the gates
themselves — a gate, a problem, an exemption, an allowlist entry — and this file
never restates it.

**dev-config** — `gokayo43/dev-config`, the fleet's tooling policy: the configs
every Bun repo inherits and the `check.yml` every repo calls. Referred to as
"upstream" nowhere in the tree; it is a repo with a name.

**The wrapper** — `.github/workflows/check.yml` here. What a consuming repo
calls in place of dev-config's `check.yml`.

**The static gate** — everything dev-config's `check.yml` runs when its
database job is not theirs to run. The wrapper hands the consumer's own
`database` on unchanged, which is the whole of what "unchanged" means in this
repo: the same workflow, at a pinned commit, over the consumer's own tree.

**A database job** — a job of this repo's own that grades a database the
consuming repo's migrations built on the server it pinned, and the app that has
to run against it.
dev-config's job of that name is Postgres, and the two never run in one call.
There is one, and the steps of `#3`–`#6` land in it rather than beside it: the
server is a container that job starts and holds, so a second job would be
grading an empty one.

**Pass-through** — an input the wrapper declares only in order to hand it to
dev-config's `check.yml` under the same name. A pass-through has no behaviour
here; an input that did would not be one. The wrapper's other kind is an input
of this repo's own: it drives a database job and reaches dev-config under no
name at all, though it is spelled the way dev-config spells the same idea.

**A replay** — one run of the consuming repo's own `db:migrate` against one
database. The gate `#2` ships makes two of them, from empty, and its verdict is
that the schema either side is the same.

**The upgrade path** — what a database that already exists reaches when this
branch's migrations run on top of it, as opposed to what a database built from
empty gets. The two are the same schema or the branch has edited history:
`docs/gates/db-upgrade.md`. A duty dev-config leaves to this workflow, because
this workflow is what replaced their database job.

**A server product** — MariaDB or MySQL 8, the two this repo's gates are
certified against. A consumer names theirs by pinning `database-image`; nothing
here infers one from an image's name, and no gate asks which product it is
looking at — where the two genuinely differ, the difference is asked of the
image or of the server itself.

**The schema** — what the image's own dump client renders of a database's
catalogue with no rows in it: tables, views and sequences, routines, events and
triggers. Not the rows, and not the three lines that record how many values an
object has handed out or when it was last created — a table's `AUTO_INCREMENT`
counter, a sequence's `SETVAL` position, an event's `STARTS` stamp — and not the
three lines naming the database the dump came from, which is where it was read
rather than anything it can hold. Those say what has happened to a database, or
where it was; `docs/gates/db-replay.md` names each one and what it costs to drop
it.

**The journal** — the table a journalled migrator keeps its own record in. For
drizzle's MySQL migrator it is `__drizzle_migrations`, in the database being
migrated and unqualified; its Postgres migrator puts the same table in a schema
of its own, so the two spellings are not interchangeable. It is a migrator's
bookkeeping rather than schema, and no gate here counts it as one.

**An instant** — a point on the timeline: the same moment to everyone, wherever
they read it from. Both products record one in a `TIMESTAMP`, which they convert
to UTC on the way in and back to the reader's session zone on the way out.

**A wall-clock reading** — the digits a clock showed, without the clock. A
`DATETIME` holds exactly that and nothing about which zone produced it, so the
same row is two different instants either side of a DST boundary or a server
move. A shop that opens at 09:00 wherever it is has a wall-clock reading and not
an instant, and that is the only thing `datetime-allowlist` waives.

**The app** — the one program `start-command` starts and `health-url` answers
on. Every step after the replay means this program and no other: the boot polls
it and the probe talks to it. A repo with a second program in it — a web app
beside an API — has routes this gate never sees, because only the booted one is
started.

**A consumer** — a repo whose `ci.yml` calls the wrapper. There are two, both
named in `README.md`, both older than the fleet's Postgres decision, and one per
server product.

**The pin** — the 40-character commit SHA of dev-config that this repo calls,
gates itself with and installs, written with the release tag as a trailing
comment where a workflow carries it. The pin is the contract; the tag is the
label. Nothing here is reached by a tag or a branch.
