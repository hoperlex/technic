# Plan: portal updates through server-sent change notifications

- Status: edition 1 of 14.10.2026. **A plan is intent, not state** (AGENTS.md): nothing below is
  implemented. The transport is decided by the owner (survey S-28, 14.10.2026) and recorded in
  [ADR 0229](adr/0229-server-sent-events-for-portal-updates.md); the forks in
  [§13](#13-questions-to-the-owner) are open and no stage that depends on one starts before it is
  answered.
- Source: the draft of 01.10.2026, `.local/plans/realtime-events-plan.md` (outside history, in
  Russian), re-verified against `origin/main` `805d5902`. What the draft got wrong or what changed
  since is listed in [§2.6](#26-what-changed-since-the-draft). The draft stays as the owner's
  material; this file replaces it as the working plan.
- Numbers: nothing is reserved besides ADR 0229. Stage 1 needs one migration (the switch key and the
  producer side); it gets its number when it is merged, under the release-train rules.
- Client floor: no stage raises it ([§9.3](#93-client-floor)).

## 1. Scope and non-goals

The goal: an open screen shows what other people, the worker and internal jobs changed — without F5
and without timers that ask "has anything changed?" — while every command stays the HTTP request it
is today, with its rights, versions, idempotency keys and tests.

**The server only notifies.** An event says which kind of data became stale; the portal rereads it
through the existing GET routes. No DTO, row or document travels in an event.

In scope:

- change notifications for lists, cards, badges and background operations (receipt and ticket OCR,
  bulk runs, the office-equipment chat);
- recovery after tab sleep, network loss, API restart and deploy: reconnect plus resync;
- the stream's place in the maintenance mode, the client contract gate and the session lifecycle;
- gating, and at the end retiring, the seven named browser timers once their replacement is proven.

Not in scope — each needs its own decision:

- collaborative editing, presence, typing indicators, a WebSocket channel (ADR 0229 names when to
  revisit the transport);
- commands, uploads or drafts over the stream;
- browser push notifications and a user-visible notification history;
- the audit log as an event source, or any change to it;
- the access model, and per-session revocation of an issued access token;
- states that change with time alone — OCR task age, sliding health windows, deadlines, the
  Moscow-midnight warranty cut: no write happens, so no event can say it; they keep their timers or
  get a server-side schedule later ([§12](#12-stages), stage 5);
- the server-side SNMP device poll, which is not a browser timer.

"No polling" does not mean "no traffic": an open stream, heartbeats, reconnects and the rereads
after a real change remain. A request that stays open in the network panel is the normal state.

## 2. What the code has today (`805d5902`)

Everything in this section is confirmed in code at the named commit; everything after it is
proposed.

### 2.1 Browser timers

The quality ratchet already names them: `timers` in
[quality-budget.json](../apps/web/quality-budget.json) holds exactly seven entries, and a new timer
fails `pretest`.

| Timer                                       | Interval                              | Where                                                                                       |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Maintenance status file `/maintenance.json` | 25 s, plus mount, focus, visibility   | [MaintenanceBoundary.tsx](../apps/web/src/app/MaintenanceBoundary.tsx)                      |
| Build version `/version.json`               | 10 min, plus mount, focus, visibility | [useVersionCheck.ts](../apps/web/src/shared/lib/useVersionCheck.ts)                         |
| Receipt OCR state while `pending`           | 2 s                                   | [useReceiptRecognitionBatch.ts](../apps/web/src/pages/garage/useReceiptRecognitionBatch.ts) |
| Office-equipment chat, `afterSeq`           | 20 s while the feed is mounted        | [useServiceChatFeed.ts](../apps/web/src/features/service-chat/model/useServiceChatFeed.ts)  |
| Office-equipment bulk run status            | 1 s while running                     | [ServiceBulkModal.tsx](../apps/web/src/pages/service/ServiceBulkModal.tsx)                  |
| Waste-ticket recognition health             | 60 s while its banner is shown        | [queries.ts](../apps/web/src/entities/waste-ticket/api/queries.ts)                          |
| Ticket-audit operations snapshot            | 60 s                                  | the same file                                                                               |

Outside the ratchet: the static [maintenance.html](../deploy/nginx/maintenance.html) reloads itself
every 60 s (`meta refresh`); shell badges in the `SIGNAL` profile refetch on focus after 60 s; the
driver cabinet refetches on every focus (`refetchOnWindowFocus: 'always'`) and the route window on
focus. Both focus exceptions, like the two ticket timers, carry a `query-freshness:` marker with the
reason.

Everything else is `LIVE` (10 s): a colleague's change appears on the next mount after the term or
after a local invalidation, never by itself (ADR 0222, consequences). That is the larger gap this
plan closes — not only the seven timers.

### 2.2 Cache and forms

- **60 query roots in 40 entity `keys.ts`**, each declared by `createQueryKeys('<root>', …)`; a key
  is `[root, family, …params]`, and invalidating `[root]` covers the whole entity
  ([createQueryKeys.ts](../apps/web/src/shared/api/createQueryKeys.ts)). Keys live only in entities
  (ADR 0228 rule 4; `rawKeyFiles: 0` in the budget).
- **The cache check reached zero** (roadmap Q9, 12.10.2026):
  [check-cache-invalidation.mjs](../apps/web/scripts/check-cache-invalidation.mjs) reads every
  mutation's effect, and the eight multi-root slices name the root a write lands in with
  `cache-home: <root> — reason` markers; the budget
  [cache-budget.json](../apps/web/cache-budget.json) has empty `unresolved` and `home-ambiguous`
  lists. Its header names what it cannot know — what the **server** changes — and ADR 0222 ends with
  "mapping server tables to query roots is still not done; it waits for the realtime-events
  decision". [§4](#4-event-model) is that mapping.
- **Forms already survive rereads.** `useRecordSession` and `useFormRecordSession` with
  `StaleRecordNotice` (stage 5 plan §4.5, ADR 0222 decision 7): a clean form takes a newer record
  silently, a dirty one keeps its fields and the version it was filled with and shows the notice
  with "Reload". Nine forms use it: the receipt form and its deletion mark, the estimate editor, the
  weekly composition and its reversal, the equipment move, candidate review and declaration, and the
  fuel-norm settings. Other edit forms are filled once per opening from a click-time snapshot —
  `ServiceRequestForm` gets the `editing` state of its tab — so a reread does not reset them, but
  they do not learn of a newer record either.
- `listQueryOptions` keeps the previous rows during a parameter change, and selection and bulk
  actions are disabled on placeholder rows (ADR 0222 decision 6).

### 2.3 Session, gates and limits

- The access token lives in tab memory. `refresh()` is single-flight and checked against a session
  generation number, and **any** failure of it, a network error included, ends the session
  ([session.ts](../apps/web/src/shared/api/session.ts)). The refresh answer carries the user with
  the rights recomputed after `authVersion + 1` (`onRefreshedUser`).
- The access JWT carries `sub`, `role`, `av` (the auth version) and `iat`; its TTL is 900 s by
  default (`ACCESS_TOKEN_TTL_SECONDS`); there is no session id in it. The guard checks the epoch
  (`AUTH_EPOCH_SINCE`, ADR 0157 decision 5), loads the principal from the database on every request
  without a cache, and rejects an `av` mismatch ([plugin.ts](../apps/api/src/auth/plugin.ts)).
  `authVersion + 1` is written in the same transaction as grant, scope and account changes
  (`bumpAuthVersions` in `grant-catalog.ts`, `user-scopes.ts`, `users.ts`).
- The root instance runs, in this order: the rate limit, the client contract gate (426), the
  maintenance gate (503 `maintenance_mode`) and then authentication
  ([app.ts](../apps/api/src/app.ts)). `/auth/refresh` and `/auth/logout` are exempt from both gates
  for good.
- The portal transport refuses every request except logout while the maintenance flag is up (ADR
  0157 decision 8); 426 calls `requireClientUpgrade()`; only 503 with `maintenance_mode` enters the
  mode — a plain 503 means unavailability ([http.ts](../apps/web/src/shared/api/http.ts)).
- `@fastify/rate-limit` allows **300 requests per minute per client IP** for the whole API
  (`RATE_LIMIT_MAX`). An office behind one NAT address shares that budget.
- Every route declares its guard (an `authz` mark), or `route-authorization.test.ts` fails.
- Feature switches are a closed registry: `FEATURE_FLAGS` in
  [feature-flags.ts](../packages/contracts/src/feature-flags.ts), matched by a `CHECK` on
  `feature_flags`. A key arrives with its migration, is switched by `UPDATE` without a restart, is
  read without a cache, and a missing row reads as off.

### 2.4 Who writes

- About 220 `writeAudit` calls are best-effort and about 50 `writeAuditTx` calls are transactional:
  the audit log is neither a complete nor a reliable change source.
- The worker writes some tables with its own SQL — receipt and ticket OCR
  (`auto_part_receipt_scans`, `waste_ticket_files`, `waste_tickets`, proposals), orphan files, stale
  driver reports, user retention — and calls internal API routes for others (mail schedules, device
  mail intake, reparse). The directory import writes in bulk
  ([engine.ts](../apps/api/src/services/directory-transfer/engine.ts)). Migrations and repair
  scripts write too.
- `jobs` is a work queue, not a broadcast log. There is no LISTEN/NOTIFY, SSE, WebSocket,
  `EventSource` or `BroadcastChannel` anywhere in `apps`, `packages` or `deploy`.

### 2.5 Deploy and proxies

- **One API process**: `container_name: technic-api` pins a single instance
  ([docker-compose.yml](../deploy/docker-compose.yml)). One pool of 10 connections (`DB_POOL_MAX`)
  and no replica routing: reads and writes go to one `DATABASE_URL`.
- Production PostgreSQL is Yandex Managed PostgreSQL 17, reached on port 6432
  ([.env.example](../.env.example)) — the managed connection pooler's port. LISTEN needs a session
  that stays pinned to one server connection; whether the runtime user's pooling mode keeps it is
  not verified ([§14](#14-risks-and-what-this-plan-does-not-verify)).
- **Two nginx hops.** The edge [technic.conf](../deploy/nginx/technic.conf) is the shared
  infra-nginx: HTTP/2 to the browser, default `proxy_buffering`, the default 60 s read timeout. The
  web container's [spa.conf](../deploy/nginx/spa.conf) sets `proxy_read_timeout 60s` at server
  level. Proxy headers sit at server level on purpose: one `proxy_set_header` inside a location
  drops the inherited set (ADR 0148). `deploy-auto` syncs the edge vhost and **a failed sync only
  warns** — the edge can lag behind the release.
- On SIGTERM the API runs `app.close()`, which waits for open requests; docker's default stop grace
  is 10 s. Deploys and both operator switches (`--maintenance`, `--client-floor`) recreate
  `technic-api`, so every open stream drops at those moments.
- The maintenance status file is mounted into the web container only; the API cannot see it.

### 2.6 What changed since the draft

| Draft of 01.10                                                       | At `805d5902`                                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Audited at `3d437ea0`                                                | Re-verified at `805d5902`                                                                                                                |
| `refetchOnWindowFocus` is off globally in `main.tsx`                 | Five profiles in `shared/config/query.ts`; `SIGNAL` badges refetch on focus; two named focus exceptions                                  |
| Receipt OCR is polled by `ReceiptRecognitionPanel`                   | The poll lives in `useReceiptRecognitionBatch.ts`                                                                                        |
| Timers are listed by hand                                            | The `timers` ratchet names seven, and a new one fails `pretest`                                                                          |
| `cache-invalidation-map.json` is the generated audit                 | Still generated and git-ignored; the gate is `cache-budget.json`, at zero, with `cache-home:` markers                                    |
| The receipt form and the estimate editor reset from the incoming DTO | Both run on the record session with the stale notice; `ServiceRequestForm` is fed by a click-time snapshot                               |
| "Coordinate with the parallel Stage 3"                               | Stages 3 and 7 are done (ADR 0228, Реализовано); layer boundaries are lint errors                                                        |
| Test several API instances                                           | Compose pins one instance; the design must not preclude more                                                                             |
| A separate control service keeps maintenance free of timers          | Not needed for the first stages; open question [Q3](#q3-maintenance-and-version-channel)                                                 |
| Two streams per tab (control and domain)                             | One domain stream per tab; a second only if Q3 chooses it                                                                                |
| Not in the draft                                                     | Per-IP rate limit 300/min; pooler port 6432; soft-failing edge sync; contract 7 (ADR 0226); the feature switch registry; one API process |

The draft's analysis of WebSocket versus SSE, of the two delivery profiles, of the access lifecycle
and of the protected editing still holds and is carried into the sections below.

## 3. The decision in short

Recorded in [ADR 0229](adr/0229-server-sent-events-for-portal-updates.md): commands and reads stay
HTTP. Server-to-browser notifications travel over one `text/event-stream` response per tab, opened
with `fetch` rather than `EventSource`, so that it carries `Authorization: Bearer` and the client
contract headers through the same session code as every other request. Delivery profile A
(best-effort notify, then reread) comes first; profile B (durable replay) only if A fails its proof.

## 4. Event model

### 4.1 Topics: one vocabulary in the contracts

A new contracts module (proposed name `packages/contracts/src/realtime-events.ts`) holds the closed
list of topics, the envelope schema, the control events and the protocol version. Server and portal
both import it; neither keeps a copy (AGENTS.md, "one rule, one place").

A **topic is a server aggregate that a portal screen reads**, named in the portal's language
(`service-requests`, `vehicle-requests`, `waybills`, …), not a table name: the portal must not learn
the schema, and renaming a table must not change the contract. The set grows per stage from the
inventory of [§4.2](#42-producer-side-tables-to-topics); it is not invented ahead.

Each topic declares its **audience** in the same entry: the permissions any one of which admits a
subject, asked through the contracts `can`, and whether counterparty-scoped and person-scoped
subjects receive it ([Q5](#q5-audience-of-external-counterparties-and-drivers)). The audience is the
server's question; the portal never filters events.

### 4.2 Producer side: tables to topics

Proposed ([Q4](#q4-producer-mechanism)): one generic trigger function that takes the topic as its
trigger argument, and an `AFTER` trigger with that argument on each table read by the GET handlers
of a covered module. The function calls `pg_notify` on one channel with a short JSON payload: the
topic and, for a targeted topic, the recipient user id. Never row data.

Why a trigger and not a call in the service code (the case for option (a) of Q4):

- PostgreSQL delivers a notification only when its transaction commits, in commit order; a rolled
  back transaction sends nothing, and identical notifications within one transaction fold into one;
- it covers every writer the same way — API routes, the worker's own SQL, the directory import,
  retention, migrations and repair scripts — with no call to forget;
- the table-to-topic mapping lives in one place, the database catalog (`pg_trigger.tgargs` of the
  triggers on that function). A db test compares that set with the contracts list in both
  directions: every topic has at least one table, every trigger names a known topic. The inventory
  is a query, not a document that drifts.

Statement-level or row-level triggers is a measured choice of stage 1: the largest bulk write of the
pilot module and the directory import, with and without triggers. Queue and log tables that no
covered screen reads (`jobs`, `audit_log`) get no trigger.

The step a module stage starts with is its **inventory**: for each GET handler of the module, the
tables it reads, hence its topic, hence the roots that read it. This is the step the cache check's
header names as not done.

### 4.3 Consumer side: topics to query roots

One table in a new app slice (proposed `apps/web/src/app/realtime/`), typed as a record over the
contracts topic union, so that a new topic fails `tsc` until it is mapped. Its values are the owning
entities' roots. It lives in `app` because an effect spanning several entities can live neither in
one of them (ADR 0228 rule 2) nor in `shared` (rule 4) — ADR 0228 names this as a known cost, and
`app` is the one layer that sees every entity.

Whether the values are imported `keys.root` objects or root strings is settled by measuring the
entry chunk in stage 1: entity entries pulled into the startup bundle cost bytes. Either way the
cache check gets two rules: every root the table names is declared by some `createQueryKeys`, and
every root read by a covered module is reached by a topic or listed `local-only — reason`
(`releases`, `license-categories` and similar).

Local mutations keep their own invalidations where roadmap Q9 put them. The table is the effect of
the **server's** change. A rule that the roots of a topic include the roots invalidated by the
mutations writing its tables needs the inventory and comes with the module stages, not before.

Example: the topic `service-requests` maps to the roots `service-requests` and `office-equipment`,
because the equipment card joins the service history on the fly — the reason is already written in
`entities/service-request/api/keys.ts`.

Applying an event:

- topics are coalesced per root over a short window (start at 300 ms, tune by measurement), then
  `invalidateQueries({ queryKey: root, refetchType: 'active' })`: mounted reads refetch, the rest
  are marked stale and refetch on their next mount whatever their profile's term;
- an event arriving while a read is in flight cancels and restarts it (the TanStack default of
  `cancelRefetch`), because that read may predate the commit;
- `queryClient.clear()` on an event, and patching cached DTOs from an event, are forbidden.

### 4.4 Envelope and control events

| Event          | Meaning                                                                                                   | Client                                              |
| -------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `ready`        | the stream is registered in the fanout; protocol version, server boot id, heartbeat                       | start barrier: reread every mapped active root      |
| `change`       | a set of topics changed (coalesced on the server too)                                                     | invalidate their roots                              |
| `resync`       | the server may have lost notifications (listener restart, overflow)                                       | reread every mapped active root                     |
| `bye`          | the server closes: shutdown, token expiring, re-authentication, switch off, slow client; reason and delay | act by reason ([§6](#6-authentication-and-session)) |
| comment `: hb` | heartbeat every 20 s                                                                                      | liveness                                            |

Profile A sets no `id:` field: nothing is replayable, so a reconnect always resyncs. An unknown
event kind or topic is ignored: a newer server may name a topic an older bundle never mapped, and
that bundle's screens keep today's behaviour for it.

### 4.5 What an event never carries

A DTO or a row; the id of a record (profile A carries no record ids at all — a targeted topic
carries only the recipient's own user id); personal data; audit content; a token.

## 5. Delivery profiles

### 5.1 Profile A: best-effort notify, then reread

- One dedicated `pg.Client` per API process, outside the pool of 10, holds `LISTEN` on the channel
  and fans notifications out in memory to that process's streams. More processes would each hold
  their own listener; nothing in the design assumes one.
- **Listener health is proved end to end, not by the socket.** Besides the client's `error` and
  `end` events, the API sends a self-ping every 10 s — a `NOTIFY` with a nonce through the ordinary
  pool — and expects it on the listener within 5 s. A missed ping means the listener is presumed
  lost: reconnect, `LISTEN` again, then `resync` to every stream. This covers a pooler that silently
  dropped the session, which a socket check would not see.
- **Start barrier.** The stream is registered first, then `ready` is sent, then the client rereads
  its active roots. A commit after registration arrives as an event; one before it is covered by the
  reread.
- **Every reconnect resyncs.** Profile A promises current state, never a replay of events.
- **Bounded per stream.** With coalescing a stream's queue is a set of topics; a stream that does
  not drain within 30 s is closed with `bye(slow)`.
- **Reads see the commit.** A notification is delivered after commit, and a GET that follows it
  reads the same primary. Replica routing would break this; it does not exist today and must not be
  added under the stream without a read-your-writes rule.
- A listening session that stops consuming holds the server's notification queue, and when that
  queue fills, transactions that notify fail at commit. `pg_notification_queue_usage()` goes into
  the metrics with an alert threshold.

### 5.2 The proof profile A must pass

Stage 1 is accepted, and profile A kept, only when on the stand (both nginx hops, see
`deploy/nginx/stand.conf`) and then on production:

1. a change by one account in the pilot module appears in another account's open list and card, with
   p95 under the target of [Q6](#q6-latency-target-and-scale) over 100 changes, without F5;
2. a rolled back write sends nothing; a write by each writer kind — an API route, the worker's SQL
   if the module has one, a bare SQL statement — sends one event (db tests);
3. terminating the listener's backend while idle is detected within two ping intervals, every stream
   gets `resync`, and a change committed in the gap is visible after it;
4. restarting the API with 50 tabs from one address: every tab is back within the jitter window,
   without 429 and without exhausting the pool; the number of GETs is recorded;
5. token expiry under an open stream re-authenticates without a logout; an `auth_version` bump
   closes and re-authenticates that user's streams within 2 s; a revoked read permission stops the
   module's events for that user only;
6. maintenance on and off and a floor raise on the stand bring an idle tab to the stub or the
   upgrade banner through the stream drop; the end of maintenance is still confirmed by the file;
7. with buffering re-enabled at the edge, the client declares the stream unhealthy within 10 s and
   keeps today's behaviour;
8. switching the key off by `UPDATE` closes open streams within one heartbeat and refuses new ones;
   switching it on resumes; no restart either way;
9. with the producer side missing (migration not applied or rolled back), the API refuses the stream
   instead of serving a silent one ([§9.4](#94-the-migration-window));
10. LISTEN holds through the production connection path — the managed pooler on 6432 or a dedicated
    listener connection — before the key is switched on in production.

If item 3 or item 10 cannot be met, profile A has failed its proof.

### 5.3 Profile B: only if A fails

Profile B is taken up when A fails its proof — the listener cannot be held on the managed cluster,
or the resync cost under frequent reconnects (mobile sleep) is unacceptable — or when a product need
for per-event history appears. It is then its own ADR and its own migrations:

- a transactional outbox written with the business change (by the same triggers), so that a failed
  event write rolls the change back;
- a relay that assigns a publication cursor under a short lock. The source rows' `bigserial` is not
  a cursor: transaction A takes 41 and is still open, B takes 42 and commits, a reader remembers 42,
  then A commits and `id > 42` never sees 41;
- a bounded publication log with retention and cleanup; the cursor travels as a string with an
  epoch, never a JS number; gaps after access filtering are normal;
- catch-up then live, with the server closing the race between reading the backlog and switching to
  the live listener; an expired cursor, a new epoch or an incompatible version gives an explicit
  `resync`, never a silent continuation;
- `NOTIFY` only as a wake-up signal: after a lost one, catch-up by the log.

## 6. Authentication and session

- The stream is opened by `fetch` with the token from `getToken()` and the headers from
  `clientRequestHeaders()`. The token never goes into a URL, storage or a log; the refresh cookie's
  path stays `/api/v1/auth` and is not widened for the stream.
- **A stream lives no longer than its token.** Shortly before `exp` the server sends
  `bye(token-expiring)`; the client runs `refresh()` and reconnects. The stream never extends a
  token's life.
- The open response is read like any request: 401 runs the single-flight `refresh()` and reconnects
  only on `refreshed`, an `expired` outcome goes to `expireIfCurrent` exactly as in `http.ts`; 403
  stops the stream for this subject and keeps today's behaviour; 426 calls `requireClientUpgrade()`;
  503 with `maintenance_mode` enters the mode. Other 5xx and network errors back off with jitter and
  **never** call `refresh()` — a network failure inside `refresh()` ends the session
  ([§2.3](#23-session-gates-and-limits)).
- **`auth_version` is the revocation signal.** A trigger on the change of `users.auth_version` sends
  the server-internal topic `access` with the user id; the server closes that user's streams with
  `bye(reauth)`, because their token's `av` no longer matches; the client runs `refresh()`, whose
  answer also brings the recomputed rights to the menus (`onRefreshedUser`), and reconnects. The
  epoch of the maintenance mode needs nothing extra: leaving the mode recreates the API, the streams
  drop, and the old token meets 401 on reconnect.
- **A stream belongs to the session generation it was opened in.** Logout and login close it; late
  events of an older generation are dropped, by the same comparison `session.ts` already makes.
- **Backstop.** Once a minute per process, the principals of all open streams are reloaded in one
  query: an account archived by a path that missed the bump loses its stream within a minute.

## 7. Access filtering on the server

- The route is authenticated, marked `authorizeInHandler` with its reason for the authorization
  test, and sits under both gates like every `/api/v1` route.
- The audience of each topic is computed on the stream's principal when the stream opens and on each
  principal reload — not per event, so an event costs no database round trip per stream.
- A topic-level signal tells a holder of the module's read permission only that something in the
  module changed. Scope (site, department, executor) is not applied to it, because nothing in the
  signal is scoped; the reread applies scope exactly as today.
- Moves between scopes, archiving and deletion need no special case: the audience is the permission,
  not the row's scope, so the old and the new audience both get the signal.
- Signals carrying record ids, for narrower invalidation, are a later optimization that needs each
  module's visibility predicate on the server (`*VisibilityWhere`, `docs/access-model.md` §5). Not
  before a measurement shows that topic-level rereads cost too much.

## 8. Client

### 8.1 Where the parts live (ADR 0228)

- `shared/api`: the fetch-based event-stream reader (framing as the WHATWG event-stream format:
  lines, `data` joining, comments, a leading BOM), the reconnect policy, the health store — a module
  store like the maintenance state in `shared/api/maintenance.ts` — and the same gate helpers
  `http.ts` uses. No contracts import (`shared` does not import `@technic/contracts`) and no domain
  keys.
- `app/realtime` (a new app slice): the lifecycle, mounted under `AuthProvider` and below
  `MaintenanceBoundary` — the boundary unmounts the portal in the mode, which closes the stream;
  payload parsing with the contracts schema; the topic table; coalescing.
- A feature that keeps live state outside the query cache (the chat feed, the bulk run) subscribes
  to the `shared/api` store and parses the payload with the contracts schema itself.
- `MaintenanceBoundary` sits above `AuthProvider` and cannot read a context provided below it;
  whatever it needs from the stream comes from the `shared/api` store.

### 8.2 Health and fallback

A stream is **healthy** when `ready` arrived within 10 s of opening and a heartbeat arrives at least
every two intervals. Anything else — a buffering proxy, an edge not yet synced, a refused or
switched-off stream, repeated failures — is **unhealthy**, and today's behaviour returns: each gated
timer runs as now ([Q2](#q2-behaviour-while-the-stream-is-unhealthy)). A timer is gated, not
deleted, until stage 5; its ratchet entry stays, because the code stays.

### 8.3 Forms, tables, chat

- **Forms.** Rereads caused by events reach a form only through the record session (ADR 0222
  decision 7). A module stage is accepted only when every form editing a record of the module is
  either on the record session or filled from an opening snapshot; a form that copies live props
  into its fields blocks the stage.
- **Tables.** Rows are reread in place under `keepPreviousData`: filter, sort, page, selection and
  scroll stay ([Q8](#q8-tables-whose-rows-move)); a bulk action is validated by the server as today.
- **Chat** ([ADR 0141](adr/0141-service-request-chat.md)): a `service-requests` change makes the
  feed ask `afterSeq` once; merging by `seq` stays; delivery never marks a message read.

## 9. Maintenance mode, client floor and deploy

### 9.1 Gates

At open the stream is gated like any `/api/v1` route, and the transport does not open it while the
maintenance flag is up. During its life a gate changes only when `technic-api` is recreated
(`--maintenance`, `--client-floor`, a deploy): the stream drops and the reconnect meets the new gate
— 503 shows the stub, 426 the upgrade banner. An idle open tab thus learns of a floor raise within
seconds instead of at its next action, which ADR 0146 decision 7 could not promise ("a sleeping tab
sends no requests").

The end of the mode is confirmed only by the status file (ADR 0157 decision 6), which the API cannot
see. How the stream and the file poll divide the work is [Q3](#q3-maintenance-and-version-channel).

### 9.2 Reconnect storms

After a restart every tab reconnects and rereads its active roots. Bounds: `bye(restart)` carries a
delay hint; after a server-initiated close the client waits a random 0–10 s (full jitter), after a
failure it backs off exponentially with jitter up to 60 s; a resync rereads mounted queries only.
Stage 1 measures the storm against the per-IP limit — many tabs behind one NAT address — and against
the pool of 10, and records whether the stream route should count toward the rate limit (it is one
request per connect).

### 9.3 Client floor

The rollout is additive: old bundles never open the stream, and new bundles fall back to timers when
it is absent or switched off. No stage raises the floor. The protocol version travels in `ready`; an
incompatible change is either served side by side by `X-Client-Contract` or rides a floor raise
under [ADR 0226](adr/0226-client-floor-seven-and-deploy-preflight.md).

### 9.4 The migration window

The producer migration runs while the old release still serves (`docs/runbook.md`). Old code's
writes then start notifying with nobody listening — harmless, and its cost is part of the stage 1
measurement. The opposite case is not harmless: new code without the producer side would serve a
healthy-looking stream that never reports a change. So the API checks at startup and with each
principal backstop that the triggers of its topics exist, and refuses the stream otherwise. The
teardown suite (`apps/api/teardown/`) gets both cases.

## 10. Proxies

- One exact location for the stream path in [spa.conf](../deploy/nginx/spa.conf),
  [technic.conf](../deploy/nginx/technic.conf) and `stand.conf`: `proxy_buffering off`,
  `proxy_cache off`, a `proxy_read_timeout` well above the heartbeat, and no `proxy_set_header`
  inside — the headers stay at server level (ADR 0148).
- `X-Accel-Buffering: no` from the API is not enough: nginx acts on `X-Accel-*` response headers and
  does not pass them on, so only the first hop would see it. Each hop needs its own location.
- The response is `text/event-stream` with `Cache-Control: no-cache` and is not compressed.
- `apps/api/test/deploy-config.test.ts` asserts the location in all three files.
- The edge sync can fail softly: the client's health rule handles a buffering edge (no `ready`
  within 10 s means unhealthy, so the timers keep running).
- HTTP/2 at the edge lets the tabs of a browser share one connection. Over HTTP/1.1 — a corporate
  proxy that downgrades — each tab's stream would hold one of about six connections per origin. The
  protocol actually seen from the office network is checked in stage 1; if it is HTTP/1.1, one
  stream per browser through a leader tab becomes a prerequisite of wide enablement.

## 11. Observability

- Prometheus text on `/metrics`: open streams; connects and disconnects by reason; listener up and
  self-ping lag; notifications received by topic; events sent; resyncs by reason; slow-client
  closes; refused opens by status; `pg_notification_queue_usage()`.
- Logs: open and close with user id and reason; never the token or a payload.
- Client, in development and behind a debug switch: GETs per received event, time from event to the
  settled reread.
- The numbers each stage reports: p95 commit-to-settled for an active screen, GETs per change,
  requests of an idle tab over 10 minutes, the size of a reconnect storm.

## 12. Stages

Every stage ships on its own and is reversed by one `UPDATE` of the master switch
([Q7](#q7-switch-granularity)): with the key off the server refuses the stream, every client is
unhealthy, and today's behaviour is back without a deploy. A code rollback works as well, because
everything is additive. A stage that depends on an open question waits for its answer.

**Stage 0 — this plan and ADR 0229.** Docs only. Accepted by review and the docs gates.

**Stage 1 — the prototype of profile A on one pilot topic** ([Q1](#q1-pilot-module)).

- Contracts: topics (the pilot topic and `access`), envelope, control events, protocol version 1.
- Server: the stream route, the listener with self-ping, fanout, heartbeat, `bye` on shutdown and
  token expiry, audience by permission, the principal backstop, the producer check of §9.4, metrics.
  Producer side for the pilot tables and `users.auth_version` ([Q4](#q4-producer-mechanism)).
- Switch: a new key in `FEATURE_FLAGS` with its row, off by default. Migration: protected area,
  numbered at merge.
- Portal: the `shared/api` reader and health store, the `app/realtime` slice with the pilot rows of
  the topic table. **No timer is gated yet**: stage 1 adds rereads on events and proves them.
- Proxies: the stream location in all three nginx files and the config test.
- Acceptance: the proof of [§5.2](#52-the-proof-profile-a-must-pass); trigger cost measured; entry
  chunk measured (`bundle:check`; the integrator re-measures the budget); `pnpm check`,
  `pnpm check:db`, `pnpm check:docs`. The outcome — A kept or failed — is recorded in ADR 0229.

**Stage 2 — the pilot module without timers.**

- The pilot's timers and badge focus refetches are gated by stream health; the pilot's forms are
  audited (§8.3); the inventory of its GET handlers is complete.
- Acceptance: an idle healthy tab makes no periodic GET of the module over 10 minutes; with the
  stream down the gated timers resume within one interval; a new chat message (if the pilot is
  office equipment) appears within the target and stays unread until shown.

**Stage 3 — background operations.**

- Receipt OCR (2 s) and the bulk run (1 s) become topics targeted at the initiator, fed by their own
  tables (`auto_part_receipt_scans`, `service_request_bulk_operations`); their timers are gated.
  Waste-ticket recognition results reach the screens through the waste removal topic in stage 4.
- Acceptance: each state change arrives as an event; F5 in the middle of a run restores it; the two
  60 s ticket health timers stay — they are time-driven (§1).

**Stage 4 — the remaining modules, one stage each.**

- Proposed order: vehicle requests together with their cross-module effects (waybills, garage day,
  driver tasks); waste removal; mechanization; garage, readings and maintenance; directories (the
  import still drops the whole cache — `unfilteredInvalidations` in the budget); access and
  administration.
- Acceptance per module: two accounts see the change and its cross-module effects; the inventory and
  both mapping checks are complete for the module; its forms pass §8.3; heavy reports (analytics,
  exports) are not reread on every event — `local-only` or not mapped.

**Stage 5 — closing the transition.**

- Maintenance and version per [Q3](#q3-maintenance-and-version-channel); a runbook section (how to
  switch off, which metrics to watch, what a reconnect storm looks like); a load test; the replaced
  timers either retired from the ratchet by name or kept there as the documented fallback;
  time-driven states either keep their timers or get server-side transitions.
- Acceptance: maintenance on and off with the API and worker stopped, a static stub in a new tab, an
  old tab coming back — all reach the right state; no covered module makes periodic GETs while
  healthy.

**Stage B — profile B, only if A failed its proof** (§5.3), with its own ADR.

## 13. Questions to the owner

Each question names its options and a recommendation; none is decided here.

### Q1. Pilot module

- (a) **Office-equipment service requests** — the 20 s chat poll, the waiting and unread badges, one
  team of daily users, and the cross-root effect on the equipment card exercises the mapping.
- (b) Vehicle requests — the highest value and traffic, many cross-module effects, the largest blast
  radius for a prototype.
- (c) Garage receipts — the 2 s OCR poll, few users, little to prove about lists.

Recommended: (a).

### Q2. Behaviour while the stream is unhealthy

- (a) **Today's timers and mount rereads resume by themselves, with no banner**: the switch is a
  full rollback, and users see nothing new.
- (b) A banner «Автообновление временно недоступно» with manual refresh; the timers stay off.
- (c) A rarer fallback poll than today.

Recommended: (a).

### Q3. Maintenance and version channel

- (a) As today: the 25 s file poll and the 10 min version poll stay for good.
- (b) **The poll follows stream health**: while the stream is healthy the status file is read on
  every stream drop and reconnect instead of every 25 s; while the stream is unhealthy, or while the
  stub is shown, the 25 s poll runs; the version is read after a reconnect that follows a server
  restart, and on focus. ADR 0157 decision 6 is unchanged — only the file ends the mode. The cost:
  if the operator's command stops after writing the file and before recreating the API, a healthy
  tab keeps working until its next drop, where today it closes within 25 s.
- (c) A separate control stream from a small service next to the web container that watches the file
  (the draft's design): no timer even with the API stopped, at the cost of a new container, a new
  location and a file watcher.

Recommended: (b), in stage 5.

### Q4. Producer mechanism

- (a) **Database triggers on the tables the covered screens read**: they cover the worker's SQL, the
  import, retention, repairs and migrations; a rollback sends nothing; the mapping lives in the
  catalog and a db test checks it. Cost: a migration (protected area) in each module stage.
- (b) Explicit calls in API services and `pg_notify` in the worker's SQL: no trigger migrations, but
  every write path must remember the call, and a forgotten one is silent staleness.
- (c) A mix: triggers for the worker's tables, calls in the API.

Recommended: (a).

### Q5. Audience of external counterparties and drivers

- (a) **Excluded at first**: operators, lessors, service companies and drivers keep today's
  behaviour, because a topic-level signal shows them when other companies' records change.
- (b) Included: they receive their module's topics like staff; the reread still shows only their
  rows.

Recommended: (a); revisit together with id-level signals (§7).

### Q6. Latency target and scale

- (a) **p95 under 2 s from commit to the settled active screen, as stage 1 acceptance on the
  stand**; limits on streams per user and on the pool are sized after counting users and tabs from
  the nginx logs once the VPS is reachable.
- (b) Another target.

Recommended: (a). The number is a working target, not a measured SLA.

### Q7. Switch granularity

- (a) **One master key for the stream**: one migration, and one `UPDATE` returns every module to
  today's behaviour.
- (b) One key per module: finer, but a migration and a registry entry each.

Recommended: (a).

### Q8. Tables whose rows move

- (a) **Reread in place**, keeping filter, sort, page, selection and scroll; a row may move under
  the cursor, as it already does after one's own action.
- (b) A «Есть обновления» notice that applies the reread on click.

Recommended: (a) for stage 2; (b) only if users complain.

### Q9. When stage 1 is built

- (a) **On a branch from the train tip when the integrator has a slot**; it enters `main` after the
  R2 deploy is confirmed, its migration unnumbered in `apps/api/drizzle/pending/` until then.
- (b) After the release train is merged, as D3 (S-29).

Recommended: (a).

## 14. Risks and what this plan does not verify

- **LISTEN through the managed pooler** on 6432 — not verified; production is unreachable since
  08.10 (debt X1). If the pooler mode drops sessions, the listener needs a dedicated connection
  path, or profile A fails item 10 of its proof.
- **Load is unknown**: users, tabs per user, change rate, bulk bursts. Nothing here is a measured
  number; the limits are set after stage 1.
- **The network path from the offices**: HTTP/2 or a downgrading proxy (§10).
- **Commit cost of notifications** under bulk writes — measured in stage 1.
- **A single primary for reads** is assumed (§5.1).
- **Mobile sleep**: a phone tab reconnects and resyncs on every wake; acceptable under profile A
  only if the GET count stays low — measured in stage 2.
