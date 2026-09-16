# The server the database job grades

`database: external` adds the `database` job, and this is its first step: the
server every gate after it uses, started from the image the consuming repo
pinned and left running for them. It decides nothing about the repo under grade
— what it refuses is a call that could not have worked.

## Which server a consumer gets

Whichever they pin:

```yaml
with:
  database: external
  database-image: mysql:8.0.42@sha256:… # or a mariadb one, or nothing at all
```

The input defaults to the MariaDB build this repo certifies, so a consumer on
MariaDB writes nothing. A consumer on MySQL 8 writes one line, and it is their
own pin: this repo does not maintain a list of blessed images, and nothing here
infers a product from what the reference is called. Both products are certified
by this repo's own suite, which runs every server-touching case against a real
MariaDB **and** a real MySQL 8 in one `bun test`.

The digest is the consumer's discipline, and it is the whole contract: an image
pinned by tag can be repointed by its publisher, and a gate whose server changed
under it is a gate that grades a different thing every week. `check.yml`'s own
default is held to the digest rule by `tests/wrapper-inputs.test.ts`.

## Why it is a step and not a service container

A service container would be the obvious home for it, and it was one until the
server became the consumer's to choose. `services.<id>.image` is a literal:
dev-config's pin gate reads it and refuses anything that is not a `@sha256:`
digest, so an expression there — an input — is reported as a mutable tag.
[dev-config#68](https://github.com/gokayo43/dev-config/issues/68) is that hole;
until it moves, a workflow that wants a caller-declared server cannot declare it
as a service.

What that costs, stated plainly: the runner health-checks a service container
and refuses to start the job's steps until it passes, and it starts one in
parallel with the job's checkout. A step does neither. So this step polls the
server itself and blocks until it answers — the same wait, spent in series
rather than in parallel. Measured from `docker run` to the first query answered,
image already local: 10s on the MariaDB pin, 25s on the MySQL 8 one, plus
whatever the image pull costs a cold runner. The step's own bound is two
minutes.

What it buys back is that the wait is this repo's code rather than a health
command in YAML: it is graded by `tests/server.test.ts` against both products,
including the ways it can go wrong.

**The container is the job's to remove, and `check.yml`'s last step is where.**
A composite action has no `post:` — that belongs to JavaScript and Docker
actions — so nothing in this step can take its own container down afterwards. A
runner that is thrown away made that invisible; a persistent one turns it into a
database server per consumer workspace, resident between runs with the last
run's replayed schemas in it, on a published loopback port. The removal runs
under `always()`, because the runs whose server is most worth removing are the
ones that failed or hit the job's own timeout. The reclaim at the top of this
step stays: it is what a run that was killed outright leaves behind.

## What it does

1. Reclaims the container name — `db-gate-server-<digest of the job's
workspace>` — so a run killed outright does not leave one for the next run to
   collide with. Derived rather than constant because the reclaim is a `docker
rm --force`: on a self-hosted runner two jobs share one docker daemon, and
   under one constant name each would kill the other's server mid-gate. A runner
   agent runs one job at a time and each has its own `_work` root, so the
   workspace separates concurrent jobs while staying the same across re-runs.
2. Starts the image with `--publish 127.0.0.1::3306` — loopback, and a host port
   the docker daemon assigns — then reads that assignment back out of
   `docker port`. The root password and the database name come out of
   `database-url`, through `MYSQL_ROOT_PASSWORD` and `MYSQL_DATABASE`: the two
   names **both** images read, since the MariaDB image keeps them for
   compatibility and no MySQL image has ever had the `MARIADB_` spellings.
3. Polls until a query answers, reports the server's own `version()` and the
   port it came up on in the note it leaves behind, and answers with that URL as
   its `database-url` output — which is what every later step of the job
   connects to, and what the app is given through the environment.

The poll is a query rather than a ping through the image's client, and that is
what makes this one step rather than two shapes of one: the products have no
client binary name in common. It is also the stronger question — both images run
a temporary server with networking off while they initialise, so a port that
answers is a server past that, and a query proves the account and the database
the later gates were handed are the ones this container came up with.

## Why the port is the daemon's

A fixed host port is single-occupancy, and on a shared, persistent runner two
jobs overlapping on one docker daemon is the ordinary case — the second to start
would die with docker's own "port is already allocated", which a consumer reads
as their own call being wrong. Publishing on `127.0.0.1` matters for a second
reason: a bare `3306:3306` binds `0.0.0.0`, and the DNAT rule docker installs
carries no destination match, so the container answers on the box's public
address whatever the host firewall says. README's "Where it runs" is where both
are argued for the workflow as a whole.

An image serving on a port other than 3306 is not one of the ways this goes
wrong here: docker creates the mapping when the container starts, whatever the
image goes on to listen on — probed, `alpine sleep 30` answers
`127.0.0.1:33621` while running — so such an image is a mapping that answers
nothing, and the poll below reports it as a server that never answered. The only
way to have no mapping at all is a container that is gone.

So nothing names a port: the step publishes for the daemon to assign, reads the
assignment back, and answers with the URL it is on. That answer is a step
**output** rather than a `$GITHUB_ENV` write, because the runner folds one of
those into every later step and the graded repo's own steps run in between — an
output cannot be rewritten once set, so the database the gates grade stays the
database this step started.

## What it refuses

- **An empty `database-image`.** A composite action maps a missing input to the
  empty string, so `required: true` is a promise nothing enforces at runtime.
- **A `database-url` naming a port.** The port belongs to the daemon, and a URL
  carrying one names a server this step is not the one publishing.
- **A `database-url` naming a host this step does not publish on**, or an
  account the image never creates. Neither is something the step could satisfy
  by trying harder: it publishes on 127.0.0.1, and the image initialises exactly
  one account from the password it is given. `check.yml` passes none of the
  three; a caller running the action directly is who they are for.
- **A container that came up and stopped**, with the server's own output relayed
  under it. This is the failure a service container could not have: the runner
  would have refused to start the job. Reported as what it is rather than as a
  timeout, because the reason is in the image's first lines.
- **A server that never answers within the bound** — two minutes — with its
  output relayed the same way.

## What a consumer on MySQL 8 has to know about clients

MySQL 8's default authentication plugin is `caching_sha2_password`, and over an
unencrypted socket it completes only by having the client fetch the server's RSA
public key. **Bun's own SQL client refuses that** — probed on Bun 1.4.0, both on
a cold connection and after a successful TLS session, so the server's password
cache does not rescue it:

```
MySQLError: The server requested RSA public key retrieval to complete
authentication, which is not allowed over an insecure connection.
```

The gates here connect over TLS for that reason, against the container's own
self-signed certificate, and nothing a consumer writes is involved. But a
consumer's **own** code runs against the same server in the same job — the
migrator this gate's replay invokes, and the app the serving gate boots — so:

- a migrator or app on `mysql2` is unaffected. Probed: it completes the same
  handshake over plaintext, which is why `wmstcs` needs nothing here.
- a migrator or app on **Bun's `SQL`** has to say so, or the database job goes
  red on a server-side fact rather than on anything about the repo:
  `new SQL({ url, tls: { rejectUnauthorized: false } })` is what this repo's own
  gates do, and `tests/replaying-migrator.ts` is a worked example.

A MariaDB consumer meets none of this: `mysql_native_password` never needed
either half.

## What it cannot catch

- **That the pinned image is the product the consumer runs in production.** It
  starts what it is given and says what that turned out to be; a consumer who
  pins MySQL 8.4 while running 8.0 has certified 8.4.
- **Anything about the server's configuration.** A stock image is not a
  production server: `sql_mode`, character sets and buffer sizes are all the
  image's defaults, and a schema that applies here can fail on a server
  configured differently.
- **A server that answers and then dies.** The check is at the start; a gate
  that later meets a dead server reports a refused connection, and the evidence
  artifact is where the run's own output is.
