# ADR 0233. Database pool deadlines, dropping dead clients and restarting a stuck process

- Статус: Принято (26.10.2026)
- Домены: схема-и-выкат, доступ
- Связано: [ADR 0148](0148-print-timeout-ladder.md) (the timeout ladder: the layer closest to the
  work gives up first), [ADR 0157](0157-maintenance-mode.md) (the maintenance gate's 503, which the
  portal must not confuse with this one)
- Область: [bounded pool](../../apps/api/src/db/bounded-pool.ts), [pool and ping](../../apps/api/src/db/client.ts),
  [error classes](../../apps/api/src/lib/pg-error.ts), [error handler](../../apps/api/src/lib/error-handler.ts),
  [readiness streak](../../apps/api/src/lib/readiness-watch.ts), [server](../../apps/api/src/server.ts),
  [refresh route](../../apps/api/src/routes/auth.ts), [config](../../apps/api/src/config.ts),
  [worker pool](../../apps/worker/src/db-pool.ts), [worker](../../apps/worker/src/index.ts),
  [worker loop watchdog](../../apps/worker/src/loop-watch.ts)

## Context

On 26.10.2026 a short drop of the Yandex Managed PostgreSQL cluster left `technic-api` unable to
serve anything for about twenty minutes, until a person restarted the container at 12:34 MSK. The
cluster had recovered long before: a fresh connection opened in 200 ms. What did not recover was
the process.

The pool had a size and TLS, and nothing else. node-postgres without limits waits forever for a new
connection, for a free client and for a query's reply. The ten clients sat on half-open sockets to
the old master, each holding a query whose reply would never come. Login, refresh and readiness
queued behind them; nginx answered 504 and the browser gave up, but neither frees a pool client.
Docker marked the container unhealthy after five failed checks and stopped there: the restart
policy `unless-stopped` acts only on an exit.

Two more defects surfaced while fixing it:

- pg rejects an expired `query_timeout` but keeps the query active on the connection. The client
  still counts as queryable, so a plain `release()`, which is what drizzle's transactions and the
  worker's hand-held clients do, returns it to the pool, and the next borrower queues behind it.
- drizzle-orm 0.45 sends BEGIN before its `try` block, so a transaction whose BEGIN fails never
  releases its client. Behind a dead socket that is the usual way BEGIN fails.

And one in the session: `POST /auth/refresh` dropped the refresh cookie on any error of the
rotation, a failed database call included. A fast 503 would have turned every page reload during a
failover into a logout.

## Decision

1. **Every wait has an end.** Both pools (API and worker) get a connect deadline of 5 s (it bounds
   opening a connection and waiting for a free client), an idle lifetime of 30 s and a client-side
   query deadline of 15 s: `DB_CONNECT_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS`, one
   set of names for both containers, which read one `prod.env`. A server-side `statement_timeout`
   cannot replace the query deadline: on a half-open socket the query never reached the server.
   The pool size stays as it was.
2. **A dead client leaves the pool.** A client whose query hit the deadline is ended at once, which
   pg-pool checks on every release, so it is dropped whether or not the holder passes the error,
   and the ROLLBACK after it fails at once instead of waiting out a second deadline. A checked-out
   client whose connection closed is released by the pool itself, and its holder's own `release()`
   becomes a no-op; that returns the slot drizzle keeps after a failed BEGIN. Connection errors of
   idle clients are logged; those of checked-out clients reach their queries. Neither ends the
   process any more.
3. **Readiness asks the same pool**, through `pool.query`, so the query deadline applies and a
   failed ping releases its client with the error. `/health/ready` answers 503 on failure, as before.
4. **A process that does not recover exits, and Docker starts a fresh one.** Two triggers:
   - the pool stalls: callers wait for a client and the pool has neither handed one out nor taken
     one back for twice the query deadline (30 s). Both processes watch for it. Waiting alone is
     normal under load, and silence alone is an idle pool; together they are the incident;
   - in the API only, readiness fails at least three times in a row over at least a minute. With
     Docker's 30-second interval that is the third check; a failover takes seconds, and
     `deploy-auto`'s five checks in fifteen seconds cannot reach it.

   The worker has a third, broader trigger with the same exit, added with the mailbox fix of
   22.10.2026: no step of its sequential loop (one job, one tick, one cleanup pass) starts for
   `WORKER_LOOP_STALL_MS`, 30 minutes by default and never below 10 (runbook, «Worker loop
   watchdog»). It catches any hang, not only the database's; the pool stall stays the fast path for
   the database, 30 seconds instead of half an hour.
5. **Connection failures answer 503.** Every route, not only login and refresh, answers a request
   that failed on an unreachable or silent database with 503, code `db_unavailable` and
   `Retry-After: 5`, from the one error handler. The code differs from the gate's
   `maintenance_mode`, so the portal never closes itself over a failover. A socket code alone
   (`ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`…) names no peer, and S3, SMTP and the recognition
   proxy raise the same ones; so the pool marks every error it hands out, and a socket code counts
   only with that mark. SQLSTATEs and pg's own deadline wording count as they are.
6. **Only the verdict on the token drops the refresh cookie.** `POST /auth/refresh` clears the
   cookie when the rotation refuses the token (an `AppError`), and keeps it on any other failure:
   the rotation rolled back, and the token is as valid as it was.

The deadlines form a ladder in the sense of ADR 0148: connect 5 s, query 15 s, pool stall 30 s,
readiness exit after a minute, the nginx timeout for `/api/` 60 s. The bulk actions' own
`SET LOCAL statement_timeout` (30 s by default) sits above the client deadline on purpose: the
client gives up at 15 s, the server still ends the statement by its own limit, and that server
limit is what keeps a row inside its lease.

## Consequences

- After a failover or a short DNS drop the portal answers a burst of 503 for up to the query
  deadline, then serves from fresh connections without a manual restart.
- A query that legitimately runs longer than 15 s now fails with 503. The deadline is raised in
  `prod.env`, not by a release. Maintenance scripts that import the API's pool get the same
  deadline and take a larger one per run (`docs/runbook.md`).
- During a long cluster outage the API exits every minute or so and Docker restarts it with a
  growing delay of up to a minute; between restarts nginx answers 502 instead of 503. Accepted: a
  restart costs nothing while the cluster is down and is the only cure when the process is stuck.
- The exits work only if the process's exit ends the container. The exit passes the whole launch
  chain (`pnpm --filter … start` → `sh -c` → `tsx` → `node`) locally, and in `node:24-bookworm-slim`
  with `pnpm` as PID 1 the container stopped with code 1 on an unhandled error. Yet on 22.10.2026 the
  prod worker's queue stood for four days with the container `Up` (card «Оргтехника: обрыв почтового
  ящика больше не роняет worker»), for a reason not yet known. Until the prod check (`RestartCount`,
  `docker top`, log timestamps) explains it, a restart after these exits is expected, not proven;
  a fix of the launch chain, if one is needed, is one decision for all three triggers.
- A COMMIT that hits the deadline is ambiguous: the rotation may have landed. The kept old token
  then reads as reuse on the next refresh and ends the session, the same outcome as before, only
  rarer.
- The portal still reads any refused refresh as the end of the session, so a reload during the
  burst shows the login form. The cookie survives, and the next reload after recovery restores the
  session. A portal-side retry is a separate decision and is not taken here.
- The worker carries a copy of the pool code: the two apps share no server package.
- The API's test runner raises the query deadline to 120 s (`apps/api/vitest.config.ts`): db tests
  seed and sweep thousands of rows in one statement on a shared host, and 15 s cut the seeding of
  the chat counter test, whose unfinished cleanup then broke the next file's list counts.

## Alternatives considered

- **A larger pool.** It only takes longer to fill with dead clients.
- **`Promise.race` around the readiness `SELECT 1`.** The ping would report failure while the query
  under it kept holding the client.
- **A sidecar that restarts unhealthy containers.** Another moving part on the VPS for what the
  process can tell about itself, and it would still restart on a slow cluster as eagerly as on a
  stuck process.
- **A stall trigger of 15 s,** equal to the query deadline. It would race the deadline that frees
  stuck clients by itself and restart a process that was about to recover.

## Verification

`apps/api/test/bounded-pool.test.ts` runs the pool against a fake server that opens a session and
then stays silent, which is what a half-open socket looks like from the client: a timed-out client
is dropped after a plain release, a drizzle transaction fails after one deadline, a failed BEGIN
returns its slot, both connect deadlines fire, and dropped connections of checked-out and idle
clients do not end the process, and pool errors carry the database's mark. Removing any of these
mechanisms fails at least one of the tests. `db-unavailable-auth.test.ts` checks the 503 of login and refresh on the assembled
application and that the cookie survives a database failure but not a refused token;
`pg-error.test.ts` and `readiness-watch.test.ts` cover the error classes and the streak;
`apps/worker/test/db-pool.test.ts` covers the worker's copy.
