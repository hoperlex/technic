# Construction company portal

A corporate portal: vehicle orders and waybills, waste removal, mechanization rental, office
equipment service, garage and readings, directories, driver cabinet, administration. Built to the
corporate standard v3.1 (single-VPS).

Where to go next: **[AGENTS.md](AGENTS.md)** — how work is done here;
**[docs/code-map.md](docs/code-map.md)** — which area is responsible for what and which layers it
passes through; **[docs/adr/README.md](docs/adr/README.md)** — the index of accepted decisions.

## Stack

- **Backend**: Node.js 24 · TypeScript · Fastify 5 · Drizzle ORM · pg · jose · @node-rs/argon2 · zod · pino
- **Frontend**: React 19 · Ant Design 6 · Vite 8 · TanStack Query · react-router 7
- **DB**: Yandex Managed PostgreSQL (TLS verify-full)
- **Files**: cloud.ru Evolution Object Storage (S3, presigned URLs)

## Layout

```text
apps/web            React SPA (Vite + antd 6): pages, entities/features/shared layers
apps/api            Fastify REST API, services, migrations and the teardown suite, seed
apps/worker         Background jobs (PostgreSQL jobs, mail, waste ticket recognition, S3 cleanup)
packages/contracts  Shared language of server and portal: zod schemas, permissions, predicates, status corridors
scripts             Quality gates and documentation checks
deploy              Dockerfiles, docker-compose, nginx
docs                decisions (adr/), code map, runbook, DB schema, work plans
```

## Quick start (dev)

Requires Node ≥ 22.12 and pnpm 9. A local PostgreSQL and S3-compatible storage (MinIO) — see `deploy/docker-compose.dev.yml`.

```bash
pnpm install
docker compose -f deploy/docker-compose.dev.yml -p technic-dev up -d   # postgres :5433 + minio :9000
cp .env.example .env.dev        # fill in local values
pnpm db:migrate                 # apply SQL migrations
ADMIN_EMAIL=admin@dev.local ADMIN_PASSWORD=... pnpm seed:admin
pnpm dev                        # api + worker + web in parallel
```

Local variables live in `.env.dev`, and the dev scripts read it themselves
(`tsx --env-file-if-exists=../../.env.dev`): neither api nor worker pulls in dotenv, and `pnpm dev`
has no environment of its own — without this file both would start with an empty `DATABASE_URL` and
crash before the first log line. The `-if-exists` flag and the real environment taking precedence
over the file leave prod and CI untouched: there the variables come from the host env file, and
`.env.dev` simply does not exist. Mail is off in it, S3 points at MinIO, ticket recognition is a
stub: the local setup never reaches outside.

On start the server compares the schema with the code and refuses to come up if migrations are not
applied: otherwise an unapplied migration fails the first human action with a 500 from the middle of
a transaction, and that reads as a broken form rather than an unmigrated database.

## Checks

```bash
pnpm check        # types, lint and all tests except the db suite
pnpm check:db     # db tests on their own fresh database
pnpm check:docs   # links, decision numbers, code map completeness
```

API tests need no database — except one file, which is skipped without it. It checks what rules
cannot: that the code and the schema agree. Run it on a separate database (an empty one is fine —
it applies migrations itself):

```bash
TEST_DATABASE_URL=postgres://technic:technic@localhost:5432/technic_test \
  pnpm --filter @technic/api test
```

## Roles and permissions

Access is granted by permissions, not by listing roles in code: the matrix is in
`packages/contracts/src/permissions.ts`; the API checks it, and the portal hides what is unavailable
by the same matrix ([ADR 0021](docs/adr/0021-permissions-model.md)).

**The source of truth for role permissions is [docs/access-model.md](docs/access-model.md)**: the
full matrix, visibility scopes, status corridors and the map of code where all of it is checked.
The table below is a short digest.

Permissions are granted not to a role but to the pair "role + the account's counterparty type"
([ADR 0038](docs/adr/0038-executor-permissions-by-counterparty-type.md)). Only an external executor
has a counterparty, and its type decides which module the executor works in: a waste operator
handles waste removal, a vehicle lessor handles the vehicle requests its machines are assigned to.
These are the last two columns below.

The Russian names the business uses (role labels live in `roleLabels`, `packages/contracts`):
Admin — «Администратор», Manager — «Менеджер», Dispatcher — «Диспетчер», Site HQ — «Штаб»,
Construction manager — «Руководитель строительства» («Рукстрой»), Observer — «Наблюдатель»; the
two external executors share the role «Оператор» and differ by counterparty type — Waste operator
(«Оператор вывоза») and Vehicle lessor («Арендодатель ТС»).

| Permission                          | Admin | Manager | Dispatcher | Site HQ | Constr. mgr | Waste operator | Vehicle lessor | Observer |
| ----------------------------------- | :---: | :-----: | :--------: | :-----: | :---------: | :------------: | :------------: | :------: |
| Directories — read                  |   ✓   |    ✓    |     ✓      |    ✓    |      ✓      |       ✓        |       ✓        |    ✓     |
| Directories — maintain              |   ✓   |    ✓    |     ✓      |    —    |      —      |       —        |       —        |    —     |
| Office equipment — directory        |   ✓   |    ✓    |     ✓      |    ✓    |      ✓      |       —        |       —        |    ✓     |
| Office equipment — maintain         |   ✓   |    ✓    |     ✓      |    —    |      —      |       —        |       —        |    —     |
| Waste removal — read                |   ✓   |    ✓    |     ✓      |    ✓    |      ✓      |       ✓        |       —        |    ✓     |
| Waste — create/edit                 |   ✓   |    ✓    |     ✓      |    ✓    |      ✓      |       —        |       —        |    —     |
| Waste — statuses                    |   ✓   |    ✓    |     ✓      |    —    |      —      |       ✓        |       —        |    —     |
| Waste — assign operator             |   ✓   |    ✓    |     ✓      |    —    |      —      |       —        |       —        |    —     |
| Vehicle orders — read               |   ✓   |    ✓    |     ✓      |    ✓    |      ✓      |       —        |       ✓        |    ✓     |
| Vehicle orders — create/edit        |   ✓   |    ✓    |     ✓      |    ✓    |      ✓      |       —        |       —        |    —     |
| Vehicle orders — statuses           |   ✓   |    ✓    |     ✓      |    —    |      —      |       —        |       ✓        |    —     |
| Vehicle orders — approval           |   ✓   |    —    |     —      |    —    |      ✓      |       —        |       —        |    —     |
| Garage — day snapshot               |   ✓   |    ✓    |     ✓      |    —    |      —      |       —        |       —        |    —     |
| Archive, rollbacks, accounts, audit |   ✓   |    —    |     —      |    —    |      —      |       —        |       —        |    —     |

On top of the role an account can get an **add-on** — a set of actions in one module that stays part
of its regular work ([ADR 0086](docs/adr/0086-role-addons.md)). There is one add-on now: "Operator
(office equipment)" («Оператор (оргтехника)») for Site HQ and Department («Отдел»). It adds
maintaining the office equipment directory and **does not change the visibility scope**: the person
stays the HQ of their own site.

A permission says what an account may do; the **visibility scope** says over which rows:

- **Site HQ** — only its own site; edits and deletes a request while it is in the «Новая» (New)
  status.
- **Construction manager** («Рукстрой») — also only its own site: handles requests of both modules on
  a par with HQ ([ADR 0031](docs/adr/0031-rukstroy-waste-requests.md)), and in addition approves
  vehicle requests ([ADR 0025](docs/adr/0025-vehicle-request-approval.md)) — without the approval the
  dispatcher does not take the request into work. Their own request is approved at once: the
  auto-approval follows from responsibility for the site, not from the approval permission, which is
  why the admin does not get it ([ADR 0032](docs/adr/0032-approval-not-automatic-for-admin.md)).
- **Waste operator** — only requests assigned to its counterparty (ADR 0010); closes the ones taken
  into work.
- **Vehicle lessor** — only requests its vehicles are assigned to (ADR 0038); closes them with the
  fact of completion. It does not see a «Новая» request: before a vehicle is assigned it belongs to
  no one.
- **Observer** — requests of all sites, with no action on them
  ([ADR 0033](docs/adr/0033-observer-role.md)); the archive is closed to it.

Registration is self-service; an account stays inactive until an administrator activates it, and the
API does not allow activating an account without a role: without a role there are no permissions at
all. Site roles (Site HQ, Construction manager) require a construction site at activation, an
external executor requires a counterparty (a waste operator or a vehicle lessor: its type sets the
working module); an Observer requires nothing — its visibility is not narrowed by anything.

The full name is asked in parts — surname, first name, patronymic (if any) — and the database joins
them into `users.full_name`; the form is protected by Yandex SmartCaptcha
([ADR 0130](docs/adr/0130-smart-captcha.md); before that, a custom raster captcha,
[ADR 0034](docs/adr/0034-registration-name-parts-and-captcha.md)). Pending applications are visible
to the administrator through the «Ожидают активации» (Awaiting activation) toggle and a badge in the
menu; a rejection requires a reason and goes to the audit.

## Maintenance mode

The portal closes entirely for a migration window: the browser API answers 503, all issued access
tokens expire, and tabs show an announcement instead of network errors
([ADR 0157](docs/adr/0157-maintenance-mode.md), [plan](docs/maintenance-mode-plan.md)).

```bash
deploy-auto --maintenance                      # three states separately: prod.env, container, file
deploy-auto --maintenance=on --reason='перенос данных' --until='2026-09-04 03:00'
deploy-auto --maintenance=off
```

The switch is variables in `prod.env` (`MAINTENANCE_MODE`, `AUTH_EPOCH_SINCE` and the announcement
text), not a row in the database: during the window the database is what gets migrated, and the
portal's state must not live in what is being closed. Nobody passes through the mode, the
administrator included — data after a migration is checked through `DATABASE_MAINTENANCE_URL`.

**People are not logged out.** Only access tokens expire (an epoch by `iat`); refresh sessions live
on, and `/auth/refresh` and `/auth/logout` are outside the gate — once the mode is lifted, a tab
continues working without a password or a captcha after dropping its query cache.

**There are two announcement channels.** A 503 from the gate is the immediate signal to a live tab;
`/maintenance.json`, served by the web container, is the only one that survives stopping
`technic-api` in a `--cutover` window, and the web container also uses it to serve a static stub on
page reload.

**Before the first window** the client version floor must be raised
(`deploy-auto --client-floor=<build contract>`): only a build that knows about the announcement draws
it. While the floor is lower, `--maintenance=on` refuses by itself. The mode's place in a deploy —
[the protocol](docs/schema-cutover-protocol.md) §11, operator commands — [runbook](docs/runbook.md).

## Security

- Secrets live in a host env file outside the docker image and outside git (`.env`, `.env.*` are in
  `.gitignore`).
- Own authentication: access JWT (Ed25519) + opaque refresh with rotation and reuse detection.
- Files go through presigned URLs straight to cloud.ru; the backend generates the object key.

Deployment and operations details are in `docs/`. So are the working guides (in Russian, for portal
users and operators): [filling the staff directory](docs/guide-staff-import.md) from an HR export,
[setting up office equipment mail notifications](docs/guide-office-equipment-mail.md),
[a guide for department staff](docs/guide-department.md),
[a guide for construction managers](docs/guide-rukstroy.md).
