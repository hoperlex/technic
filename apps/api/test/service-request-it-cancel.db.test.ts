import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  type ServiceRequestBulkResultDto,
  type ServiceRequestDto,
  type ServiceRequestHistoryEntryDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values of these modules come through `await import` once the environment is set,
// because the config validates it on import.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { officeEquipmentModelId } from './office-equipment-model';

/**
 * The IT service cancels a request with a right of its own, `serviceRequests.cancel` (workflow-fixes
 * plan Р2, stage Э5; ADR 0174, wave 2): the three cancelling arcs of the operator corridor and
 * nothing beyond them.
 *
 * WHY A DATABASE. The right reaches the IT account from the system set of the catalog (the
 * migration of the wave puts it there), is read by `loadPrincipal` on every request and is asked by
 * four things at once: the guard of `PATCH /:id/status`, the corridor behind the guard, the guard
 * of `POST /bulk` and the second and third gates of the batch. A mock sees none of this: the
 * subject here is the account assembled from the real catalog, the way production assembles it.
 *
 * EVERY REFUSAL HAS A CONTROL, and the controls are the point. «The IT service cannot accept the
 * work» is worthless next to a route that nobody can call; so «Ведение» accepts the same request
 * through the same door in the same file. And «the cancel alone is not the whole corridor» is
 * checked on a holder of NOTHING BUT the cancel, assembled by hand — the IT set also carries
 * `assign` and `hold`, which would blur what the new right opens.
 *
 * Each refusal below was checked against the code with the guarded line removed.
 *
 * Run (the base is fresh, the migrations are applied by the test itself):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55990/technic_test \
 *     pnpm check:db service-request-it-cancel
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Own suffix per run: the base outlives the run, and the cleanup finds its own rows by it. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
const TODAY = moscowDateKeyOf(new Date());
const REQUESTS = '/api/v1/service-requests';
const BULK = `${REQUESTS}/bulk`;
const REASON = 'Заявка потеряла смысл: аппарат списан';

type Auth = { authorization: string };

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Administrator: creates the fleet and moves requests along the cycle. */
  admin: TestUser;
  /**
   * The IT service: the profile «Системный администратор» — the system sets
   * `office_equipment_it_approver` and `office_equipment_executor` from the real catalog.
   */
  it: TestUser;
  /** Holder of NOTHING but the cancel and the reading of the module: the assembled set. */
  cancelOnly: TestUser;
  /** «Ведение»: `serviceRequests.status`, the control of every refusal. */
  operator: TestUser;
  /** The requester of the site: no moves at all. */
  customer: TestUser;
  /**
   * The cancel alone on a role that has no `delete` of its own: the route guard of the batch admits
   * `delete` for the sake of the archive, and next to a requester role (who has it) the line that
   * admits the cancel could be removed unnoticed.
   */
  cancelObserver: TestUser;
  /** The in-house executor's set alone: `read`, `execute`, `files` — no cancel. */
  executorOnly: TestUser;
  /** The operator of the service company. */
  service: TestUser;
  objectId: string;
  counterpartyId: string;
  typeId: string;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED = 'false';
  process.env.RATE_LIMIT_MAX ??= '100000';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Own address per call: login and the shared limiter count requests by address. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function inject(
  method: Method,
  url: string,
  auth: Auth,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { ...auth, ...extraHeaders },
    remoteAddress: nextAddress(),
  };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

/** A ten-digit INN with a real check digit: the counterparty directory export rejects invented ones. */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

async function cleanup(db: typeof AppDb): Promise<void> {
  const users = sql`SELECT id FROM users WHERE email LIKE 'db-srit-%'`;
  const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE 'SRIT-%'`;
  await db.execute(sql`
    DELETE FROM service_requests
     WHERE office_equipment_id IN (${equipment}) OR created_by IN (${users})`);
  await db.execute(sql`DELETE FROM office_equipment WHERE inventory_number LIKE 'SRIT-%'`);
  await db.execute(sql`
    DELETE FROM office_equipment_models m
     WHERE m.name LIKE '%SRIT-%'
       AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'db-srit-%'`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE 'srit-%'`);
  await db.execute(sql`DELETE FROM counterparties WHERE name LIKE 'Сервис-SRIT %'`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE 'SRIT-%'`);
}

// ── Fixtures ──

let unitNo = 0;
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    modelId: await officeEquipmentModelId(ctx.db, ctx.typeId, `Kyocera M3145 SRIT-${RUN}`),
    inventoryNumber: `SRIT-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function card(id: string, user: TestUser = ctx.admin): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, user.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function ok(res: LightMyRequestResponse, what: string): Promise<void> {
  expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
}

/**
 * A request brought to the status by real doors, as an administrator would: «Новая» is the
 * creation, «В работе» is an assignment and a start, «Отложена» a hold, «Решена» a closing,
 * «Принята» an acceptance. An internal repair (no contractor): no closing document is demanded.
 */
async function requestIn(
  status: ServiceRequestStatus,
  options: { kind?: 'repair' | 'consumable'; assignedTo?: 'it' | 'admin' } = {},
) {
  const created = await inject('POST', REQUESTS, ctx.admin.auth, {
    officeEquipmentId: await makeEquipment(),
    kind: options.kind ?? 'repair',
    description: 'Не печатает',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as { request: ServiceRequestDto }).request.id;
  const version = async () => (await card(id)).version;

  // The IT account works inside the executor scope of ADR 0179 (switched on by the migrations):
  // it acts on requests it is named on or has authored. Every request of the file is therefore
  // handed to it, even a «Новая» one — except the one case that is about the scope itself.
  const executor = (options.assignedTo ?? 'it') === 'it' ? ctx.it.id : ctx.admin.id;
  await ok(
    await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.admin.auth, {
      userIds: [executor],
      serviceCounterpartyId: null,
      version: await version(),
    }),
    'assign',
  );
  if (status === 'new') return id;

  await ok(
    await inject('PATCH', `${REQUESTS}/${id}/start`, ctx.admin.auth, { version: await version() }),
    'start',
  );
  if (status === 'in_work') return id;
  if (status === 'on_hold') {
    await ok(
      await inject('PATCH', `${REQUESTS}/${id}/hold`, ctx.admin.auth, {
        reason: 'Ждём запчасть',
        version: await version(),
      }),
      'hold',
    );
    return id;
  }
  await ok(
    await inject('PATCH', `${REQUESTS}/${id}/complete`, ctx.admin.auth, {
      completedOn: TODAY,
      items: [],
      version: await version(),
    }),
    'complete',
  );
  if (status === 'done') return id;
  await ok(
    await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.admin.auth, { version: await version() }),
    'accept',
  );
  return id;
}

function cancel(id: string, user: TestUser, body: Record<string, unknown> = {}) {
  return card(id).then((request) =>
    inject('PATCH', `${REQUESTS}/${id}/status`, user.auth, {
      status: 'cancelled',
      reason: REASON,
      version: request.version,
      ...body,
    }),
  );
}

async function untouched(id: string, version: number, status: ServiceRequestStatus, what: string) {
  const after = await card(id);
  expect(after.status, what).toBe(status);
  expect(after.version, what).toBe(version);
}

describe.skipIf(!DB_URL)(
  'отмена заявки ИТ-службой: своё право, три дуги и ничего сверх (Р2)',
  () => {
    beforeAll(async () => {
      prepareEnv(DB_URL!);
      await migrate(DB_URL!);

      const { db, closeDb } = await import('../src/db/client');
      const { hashPassword } = await import('../src/auth/password');
      const { buildApp } = await import('../src/app');
      await cleanup(db);
      const passwordHash = await hashPassword(PASSWORD);

      async function makeUser(input: {
        tag: string;
        role: string;
        counterpartyId?: string;
      }): Promise<{ id: string; email: string }> {
        const email = `db-srit-${input.tag}-${RUN}@example.invalid`;
        const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
        return { id: res.rows[0]!.id, email };
      }

      const digits = String(Date.now()).slice(-6);
      const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-SRIT ${RUN}`}, ${innOf(`77${digits}1`)})
      RETURNING id`);
      const counterpartyId = counterpartyRow.rows[0]!.id;

      const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`SRIT-${RUN}`}, ${`Тестовая площадка SRIT ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
      const objectId = objectRow.rows[0]!.id;

      const admin = await makeUser({ tag: 'admin', role: 'admin' });
      const it = await makeUser({ tag: 'it', role: 'shtab' });
      const cancelOnly = await makeUser({ tag: 'cancel', role: 'shtab' });
      const cancelObserver = await makeUser({ tag: 'obs', role: 'observer' });
      const operator = await makeUser({ tag: 'oper', role: 'shtab' });
      const customer = await makeUser({ tag: 'cust', role: 'shtab' });
      const executorOnly = await makeUser({ tag: 'exec', role: 'shtab' });
      const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });
      // One object for every account of the file: the scope must be the same for all of them,
      // otherwise a refusal by the right is indistinguishable from a refusal by the scope.
      await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${it.id}, ${objectId}), (${cancelOnly.id}, ${objectId}),
             (${operator.id}, ${objectId}), (${customer.id}, ${objectId}),
             (${executorOnly.id}, ${objectId})`);

      // The system sets are handed BY CODE from the real catalog: that is what production does, and
      // it is the catalog (migrated by this very run) that must carry `serviceRequests.cancel` to the
      // IT account — an assembled copy of the set would prove the test's own fixture.
      async function grantByCode(userId: string, code: string): Promise<void> {
        const res = await db.execute<{ id: string }>(
          sql`SELECT id FROM grants WHERE code = ${code} AND deleted_at IS NULL`,
        );
        const grantId = res.rows[0]?.id;
        if (!grantId) throw new Error(`в базе нет системного набора «${code}»`);
        await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
        VALUES (${userId}, ${grantId}, ${admin.id}, 'manual')`);
      }
      // The profile «Системный администратор» is a pair of codes (ADR 0187 era, profiles plan Р2).
      await grantByCode(it.id, 'office_equipment_it_approver');
      await grantByCode(it.id, 'office_equipment_executor');
      await grantByCode(operator.id, 'office_equipment_operator');
      await grantByCode(executorOnly.id, 'office_equipment_executor');

      // The holder of the cancel alone: an assembled set of the reading and the cancel. The IT set
      // also carries `assign` and `hold`, and next to them the cancel would prove less.
      const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${`srit-cancel-${RUN}`}, ${`Только отмена ${RUN}`}, 'Набор прогона Р2', false,
              ${admin.id})
      RETURNING id`);
      const grantId = grantRow.rows[0]!.id;
      await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${grantId}, 'serviceRequests.read'), (${grantId}, 'serviceRequests.cancel')`);
      await db.execute(sql`
        INSERT INTO grant_roles (grant_id, role)
        VALUES (${grantId}, 'shtab'::role), (${grantId}, 'observer'::role)`);
      await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by)
        VALUES (${cancelOnly.id}, ${grantId}, ${admin.id}),
               (${cancelObserver.id}, ${grantId}, ${admin.id})`);

      const app = await buildApp();
      async function login(email: string): Promise<Auth> {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: PASSWORD },
          remoteAddress: nextAddress(),
        });
        expect(res.statusCode, res.body).toBe(200);
        return { authorization: `Bearer ${res.json().accessToken}` };
      }
      const withAuth = async (u: { id: string; email: string }): Promise<TestUser> => ({
        ...u,
        auth: await login(u.email),
      });

      const typeRow = await db.execute<{ id: string }>(
        sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
      );
      const typeId = typeRow.rows[0]?.id;
      if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

      ctx = {
        app,
        db,
        closeDb,
        admin: await withAuth(admin),
        it: await withAuth(it),
        cancelOnly: await withAuth(cancelOnly),
        cancelObserver: await withAuth(cancelObserver),
        operator: await withAuth(operator),
        customer: await withAuth(customer),
        executorOnly: await withAuth(executorOnly),
        service: await withAuth(service),
        objectId,
        counterpartyId,
        typeId,
      };
    }, 120_000);

    afterAll(async () => {
      await ctx?.app.close();
      if (ctx?.db) await cleanup(ctx.db);
      await ctx?.closeDb();
    });

    // ────────────────────────────────────────────────────────────────────────────────────────────
    // What the right opens: the three cancelling arcs
    // ────────────────────────────────────────────────────────────────────────────────────────────

    describe('дуги отмены', () => {
      it.each(['new', 'in_work', 'on_hold'] as const)(
        'ИТ-служба отменяет заявку в статусе «%s» с причиной',
        async (status) => {
          const id = await requestIn(status);
          const res = await cancel(id, ctx.it);
          expect(res.statusCode, res.body).toBe(200);
          const after = await card(id);
          expect(after.status).toBe('cancelled');
          // The reason is in the history, under the actor's name, as for every cancel.
          const history = (await (
            await inject('GET', `${REQUESTS}/${id}/history`, ctx.admin.auth)
          ).json()) as ServiceRequestHistoryEntryDto[];
          const entry = history.find((e) => e.toStatus === 'cancelled');
          expect(entry?.comment).toBe(REASON);
          expect(entry?.actorId).toBe(ctx.it.id);
        },
      );

      it('причина обязательна и у ИТ-службы: без неё 422 и заявка на месте', async () => {
        const id = await requestIn('in_work');
        const version = (await card(id)).version;
        const res = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.it.auth, {
          status: 'cancelled',
          version,
        });
        expect(res.statusCode, res.body).toBe(422);
        await untouched(id, version, 'in_work', 'без причины');
      });

      it('ремонт: ИТ-служба отмечает замену и пишет решение — тем же окном, что и «Ведение»', async () => {
        const id = await requestIn('in_work');
        const res = await cancel(id, ctx.it, {
          resolution: 'Аппарат под замену, закупка в октябре',
          replacementRecommended: true,
        });
        expect(res.statusCode, res.body).toBe(200);
        const after = await card(id);
        expect(after.replacementRecommended).toBe(true);
        expect(after.rejectionResolution).toBe('Аппарат под замену, закупка в октябре');
      });

      it('держатель одной только отмены тоже отменяет — набор ИТ-службы здесь ни при чём', async () => {
        const id = await requestIn('on_hold');
        const res = await cancel(id, ctx.cancelOnly);
        expect(res.statusCode, res.body).toBe(200);
        expect((await card(id)).status).toBe('cancelled');
      });
    });

    // ────────────────────────────────────────────────────────────────────────────────────────────
    // What the right does not open
    // ────────────────────────────────────────────────────────────────────────────────────────────

    describe('чего право не открывает', () => {
      it.each(['done', 'accepted'] as const)(
        'отмены из «%s» нет ни у ИТ-службы, ни у держателя одной отмены: 403 и заявка на месте',
        async (status) => {
          const id = await requestIn(status);
          const version = (await card(id)).version;
          for (const user of [ctx.it, ctx.cancelOnly]) {
            const res = await cancel(id, user);
            expect(res.statusCode, `${user.email}: ${res.body}`).toBe(403);
          }
          await untouched(id, version, status, status);
        },
      );

      it('приёмка и возврат на доработку остаются «Ведению»: ИТ-служба получает 403, «Ведение» — 200', async () => {
        const id = await requestIn('done');
        const version = (await card(id)).version;
        for (const user of [ctx.it, ctx.cancelOnly]) {
          const accept = await inject('PATCH', `${REQUESTS}/${id}/accept`, user.auth, { version });
          expect(accept.statusCode, `${user.email}: ${accept.body}`).toBe(403);
          const rework = await inject('PATCH', `${REQUESTS}/${id}/rework`, user.auth, {
            reason: 'Не работает',
            version,
          });
          expect(rework.statusCode, `${user.email}: ${rework.body}`).toBe(403);
        }
        await untouched(id, version, 'done', 'после отказов');
        // The control: the same request, the same door, a different holder.
        const accepted = await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.operator.auth, {
          version,
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
      });

      it('«Вернуть в «Новую»» у ИТ-службы закрыто и через API: это дуга права распределения, а не отмены', async () => {
        // The corridor gives the IT service the arc `in_work → new` from `assign`, and the door has
        // always been closed to it by the guard. The cancel right let the account through the guard,
        // so the door now asks the status right itself, per target.
        const id = await requestIn('in_work');
        const version = (await card(id)).version;
        for (const user of [ctx.it, ctx.cancelOnly]) {
          const res = await inject('PATCH', `${REQUESTS}/${id}/status`, user.auth, {
            status: 'new',
            version,
          });
          expect(res.statusCode, `${user.email}: ${res.body}`).toBe(403);
        }
        await untouched(id, version, 'in_work', 'после отказов');
        // The control: «Ведение» rolls the start back through the same door.
        const rolled = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.operator.auth, {
          status: 'new',
          version,
        });
        expect(rolled.statusCode, rolled.body).toBe(200);
      });

      it('административные откаты тоже закрыты: «Решена» → «В работе», «Принята» → «Решена»', async () => {
        const done = await requestIn('done');
        const accepted = await requestIn('accepted');
        for (const [id, to] of [
          [done, 'in_work'],
          [accepted, 'done'],
        ] as const) {
          const version = (await card(id)).version;
          for (const user of [ctx.it, ctx.cancelOnly]) {
            const res = await inject('PATCH', `${REQUESTS}/${id}/status`, user.auth, {
              status: to,
              reason: 'Откат',
              version,
            });
            expect(res.statusCode, `${user.email} → ${to}: ${res.body}`).toBe(403);
          }
        }
      });

      it('право отмены не даёт заморозки и назначения: держатель одной отмены получает 403', async () => {
        const id = await requestIn('in_work');
        const version = (await card(id)).version;
        const hold = await inject('PATCH', `${REQUESTS}/${id}/hold`, ctx.cancelOnly.auth, {
          reason: 'Ждём',
          version,
        });
        expect(hold.statusCode, hold.body).toBe(403);
        const assign = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.cancelOnly.auth, {
          userIds: [ctx.admin.id],
          serviceCounterpartyId: null,
          version,
        });
        expect(assign.statusCode, assign.body).toBe(403);
        await untouched(id, version, 'in_work', 'после отказов');
      });

      it('право не обходит область действий исполнителя (ADR 0179): чужую заявку ИТ-служба не отменяет', async () => {
        // The right opens the door; WHICH requests the IT account may touch is decided by the scope
        // of the executor profile — assigned or authored. A request of someone else's is out of reach
        // for every mutating door, the cancel included, and the sentence says why.
        const id = await requestIn('in_work', { assignedTo: 'admin' });
        const version = (await card(id)).version;
        const res = await cancel(id, ctx.it);
        expect(res.statusCode, res.body).toBe(403);
        expect((res.json() as { message: string }).message).toContain(
          'Исполнитель работает со своими заявками',
        );
        await untouched(id, version, 'in_work', 'чужая заявка');
        // The control: the person who is not narrowed by the scope cancels the same request.
        const allowed = await cancel(id, ctx.operator);
        expect(allowed.statusCode, allowed.body).toBe(200);
      });

      it('без права отмены дверь закрыта: заказчик и набор одного исполнителя получают 403', async () => {
        const id = await requestIn('new');
        const version = (await card(id)).version;
        for (const user of [ctx.customer, ctx.executorOnly]) {
          const res = await cancel(id, user);
          expect(res.statusCode, `${user.email}: ${res.body}`).toBe(403);
        }
        await untouched(id, version, 'new', 'без права');
      });

      it('подрядчик отменить не может: его сторона отвечает вместо остальных', async () => {
        const id = await requestIn('new');
        await ok(
          await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.admin.auth, {
            userIds: [],
            serviceCounterpartyId: ctx.counterpartyId,
            version: (await card(id)).version,
          }),
          'assign',
        );
        const version = (await card(id)).version;
        const res = await cancel(id, ctx.service);
        expect(res.statusCode, res.body).toBe(403);
        await untouched(id, version, 'new', 'подрядчик');
      });
    });

    // ────────────────────────────────────────────────────────────────────────────────────────────
    // Batch: three gates and the step
    // ────────────────────────────────────────────────────────────────────────────────────────────

    describe('пачка', () => {
      function bulk(body: unknown, user: TestUser) {
        return inject('POST', BULK, user.auth, body, { 'idempotency-key': randomUUID() });
      }

      async function rowsOf(ids: string[]) {
        const rows: { id: string; version: number }[] = [];
        for (const id of ids) rows.push({ id, version: (await card(id)).version });
        return rows;
      }

      it('ИТ-служба отменяет пачкой; держатель одной отмены — тоже, и на роли без права удаления тоже', async () => {
        for (const user of [ctx.it, ctx.cancelOnly, ctx.cancelObserver]) {
          const ids = [await requestIn('new'), await requestIn('in_work')];
          const res = await bulk(
            { operation: 'cancel', rows: await rowsOf(ids), reason: 'Площадку закрыли' },
            user,
          );
          expect(res.statusCode, `${user.email}: ${res.body}`).toBe(200);
          const result = res.json() as ServiceRequestBulkResultDto;
          expect([result.done, result.failed], `${user.email}: ${res.body}`).toEqual([2, 0]);
          for (const id of ids) expect((await card(id)).status, id).toBe('cancelled');
        }
      });

      it('пачка отменяет «В работе» со своим исполнителем и у «Ведения»: дефект был не в праве, а в порядке шагов', async () => {
        // The cancel removes the named executors before it writes the status, and the batch used to
        // check the executor invariant immediately from the first statement of a row: the row failed
        // with «Не удалось выполнить» for every holder. The IT cases above and this control stand
        // on the same fix (the check moved after the row's step).
        const id = await requestIn('in_work');
        const res = await bulk(
          { operation: 'cancel', rows: await rowsOf([id]), reason: 'Площадку закрыли' },
          ctx.operator,
        );
        expect(res.statusCode, res.body).toBe(200);
        expect((res.json() as ServiceRequestBulkResultDto).done, res.body).toBe(1);
        expect((await card(id)).status).toBe('cancelled');
      });

      it('в пачке отмена не тянет за собой приёмку и остальное: 403 на весь запрос, строки не тронуты', async () => {
        const id = await requestIn('done');
        const rows = await rowsOf([id]);
        for (const user of [ctx.it, ctx.cancelOnly]) {
          const res = await bulk({ operation: 'accept', rows }, user);
          expect(res.statusCode, `${user.email} accept: ${res.body}`).toBe(403);
        }
        const hold = await bulk(
          { operation: 'hold', rows: await rowsOf([await requestIn('in_work')]), reason: 'Ждём' },
          ctx.cancelOnly,
        );
        expect(hold.statusCode, hold.body).toBe(403);
        await untouched(id, rows[0]!.version, 'done', 'после отказов пачки');
      });

      it('контроль: «Ведение» принимает ту же заявку той же пачкой — отказы выше не от сломанной ручки', async () => {
        const id = await requestIn('done');
        const res = await bulk({ operation: 'accept', rows: await rowsOf([id]) }, ctx.operator);
        expect(res.statusCode, res.body).toBe(200);
        expect((res.json() as ServiceRequestBulkResultDto).done).toBe(1);
      });

      it('заказчику пачка не открыта вовсе — отмена в том числе', async () => {
        const id = await requestIn('new');
        const rows = await rowsOf([id]);
        const res = await bulk({ operation: 'cancel', rows, reason: 'Передумал' }, ctx.customer);
        expect(res.statusCode, res.body).toBe(403);
        await untouched(id, rows[0]!.version, 'new', 'заказчик');
      });
    });
  },
);
