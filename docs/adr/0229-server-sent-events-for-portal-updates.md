# ADR 0229. Server-sent events for portal updates

- Статус: Принято (14.10.2026) — owner decision S-28 of the survey of 14.10.2026. Nothing is
  implemented; the stages and the open forks are in the [plan](../realtime-events-plan.md), and the
  outcome of the profile A prototype (stage 1) is to be recorded here
- Домены: каркас-портала, доступ, схема-и-выкат
- Развивает: [ADR 0222](0222-frontend-query-freshness-and-render.md) — its query roots and freshness
  profiles become the targets of server notifications, and the mapping of server tables to query
  roots that it left waiting for this decision is built by the stages of the plan
- Связано: [ADR 0228](0228-frontend-architecture.md) (which layer holds each client part),
  [ADR 0157](0157-maintenance-mode.md) (both gates apply when a stream opens; only the status file
  ends the mode), [ADR 0146](0146-office-equipment-consumables-tab-and-purchase.md) decision 7 and
  [ADR 0226](0226-client-floor-seven-and-deploy-preflight.md) (the rollout raises no client floor),
  [ADR 0141](0141-service-request-chat.md) (delivery never marks a chat message read),
  [ADR 0021](0021-permissions-model.md) (the stream route declares its guard),
  [ADR 0148](0148-print-timeout-ladder.md) (proxy headers stay at server level; a long path gets its
  own location)
- Область: [plan](../realtime-events-plan.md),
  [session.ts](../../apps/web/src/shared/api/session.ts),
  [http.ts](../../apps/web/src/shared/api/http.ts),
  [query.ts](../../apps/web/src/shared/config/query.ts),
  [quality-budget.json](../../apps/web/quality-budget.json) (the `timers` ratchet),
  [plugin.ts](../../apps/api/src/auth/plugin.ts),
  [feature-flags.ts](../../packages/contracts/src/feature-flags.ts),
  [spa.conf](../../deploy/nginx/spa.conf), [technic.conf](../../deploy/nginx/technic.conf)

## Context

The portal learns about other people's changes in two ways only. Seven named browser timers
(`timers` in `apps/web/quality-budget.json`) poll the maintenance status file, the build version,
receipt OCR, the office-equipment chat, bulk runs and two waste-ticket health views. Everything else
is read under the `LIVE` profile of ADR 0222: a colleague's change shows up on the next mount after
ten seconds or after a local invalidation, never by itself. Adding timers to cover more screens
would multiply requests by tabs and still leave every unwatched screen stale.

A draft of 01.10.2026 audited polling, access, deploy and the transports; on 06.10 the owner
suggested a persistent channel with targeted change flags and the maintenance mode on the same
channel; stage 5 of the front end (ADR 0222) prepared the ground — one owner per query root, the
cache check at zero, forms that keep their input across rereads — and deferred the event mapping to
this decision. On 14.10.2026 the owner chose the transport (survey S-28).

## Decision

1. **Commands and reads stay HTTP.** Every command keeps its route, its rights, its optimistic
   versions, its idempotency keys and its tests. Nothing is sent to the server over the new channel.

2. **The server only notifies.** It sends server-sent events over one `text/event-stream` response
   per tab. An event names the topics — server aggregates in the portal's vocabulary — whose data
   became stale; the portal rereads them through the existing GET routes, which apply scope as
   today. No DTO, row, personal data or audit content travels in an event, and a record id only
   where the server has checked that the recipient may see that record — profile A sends none.

3. **The stream is opened with `fetch`, not `EventSource`, and authenticated with
   `Authorization: Bearer`.** `EventSource` cannot set request headers, so it would need the token
   in the URL or an access cookie — a second authentication path next to the one every request uses.
   The `fetch` reader goes through the same session code: single-flight refresh, session
   generations, the client contract headers, the 426 and `maintenance_mode` handling. The reconnect
   and the framing that `EventSource` would give for free are implemented by a small reader in
   `shared/api`.

4. **Delivery profile A first: best-effort notify, then reread.** A lost notification, a lost
   listener or a reconnect leads to a resync of the active data, never to a promise of replay.
   Profile B — a transactional outbox with a publication log and replay — is taken up only if A
   fails the proof listed in the plan (§5.2), and then with its own ADR.

5. **The rollout is additive and switchable.** Old bundles never open the stream; new bundles fall
   back to today's behaviour whenever the stream is absent, refused or unhealthy. No stage raises
   the client floor. Each stage ships separately behind a switch whose off position is today's
   behaviour.

6. **One vocabulary, two homes for the mapping.** Topics, the envelope and the control events live
   in `packages/contracts`. Which server tables feed a topic is decided on the server side; which
   query roots a topic invalidates is one table in the portal's app layer, checked against the
   declared roots by the cache check. Neither side copies the other's keys.

## Alternatives

- **WebSocket (or Socket.IO over it).** Two-way and binary, and it would also carry notifications.
  Rejected for now: the traffic that is missing goes one way, server to browser, while the commands
  already have HTTP contracts with rights, versions and tests that a second command path would have
  to duplicate. The browser WebSocket API cannot send an `Authorization` header either, so it would
  need a ticket exchange or a token in the URL, and both nginx hops would need upgrade handling.
  WebSocket solves neither losses nor replay nor access filtering — the same application protocol is
  needed on top of it. **Revisit** when collaborative editing, presence or frequent two-way messages
  become a requirement.
- **Polling as today.** No new infrastructure and no new failure mode. Rejected as the target: each
  covered screen would need its own timer, the load grows with tabs, and screens without a timer
  stay stale. Kept as the fallback while the stream is unhealthy.
- **`EventSource` with a cookie.** The refresh cookie is scoped to `/api/v1/auth` on purpose; an
  access cookie for the stream would add a cookie-authenticated path with its own CSRF surface.
  Rejected.
- **Long polling.** The same one-way notification with a request per event and more moving parts. No
  gain over a stream.

## Consequences

- Each open tab holds one long request through both nginx hops; the stream path needs its own
  location without buffering in `spa.conf` and `technic.conf`, and the edge vhost must actually be
  synced for the stream to be healthy.
- Each API process holds one database session outside its pool for `LISTEN`; whether the managed
  connection pooler keeps such a session is the first thing stage 1 proves.
- Every reconnect — after sleep, network loss, a restart, a deploy, a maintenance or floor switch —
  rereads the mounted queries. Reconnects are spread by jitter and measured against the per-IP rate
  limit.
- Each module stage starts with an inventory of the tables its GET handlers read; that inventory is
  the server-table mapping ADR 0222 deferred.
- The seven timers stay in the code as the fallback until the last stage, gated by stream health;
  states that change with time alone keep their timers.
- An idle open tab learns about a raised client floor or the start of a maintenance window when its
  stream drops, not at its next action.
