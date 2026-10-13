import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type OfficeEquipmentConsumableDto,
  type ServiceFileKind,
  type ServiceRequestDto,
  type ServiceRequestHistoryEntryDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values of these modules come through `await import` once the environment is set,
// because the config validates it on import.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { officeEquipmentModelId } from './office-equipment-model';

/**
 * A consumables request assigned to a service company: the contractor's side does not see the
 * nomenclature (workflow-fixes plan Р7) and the warehouse does not move (Р8).
 *
 * WHY A DATABASE. The hole this file guards is not one door but six channels that carry the same
 * rows — the card and the list, the history, the file list, the direct link to a file, the two
 * doors that write the composition and the documents, and the document letter — and each is a
 * different query. The direct link is an SQL predicate over `service_request_files`; the history is
 * assembled from three tables; the closing writes the warehouse chain whose triggers exist only in
 * the live schema. A mock would answer «hidden» for all of them and prove the mock.
 *
 * EVERY REFUSAL HAS A CONTROL. Each case reads the same thing as someone the rule does not cut off
 * (the administrator, «Ведение», the requester, the in-house executor) or in a request the rule
 * does not apply to (a repair of the same contractor). A hidden list that is hidden from everybody
 * is not the rule, it is a broken list. The pairs were checked against the code with the guarded
 * line removed: each refusal below goes red without its line.
 *
 * The document letter (the sixth channel) is checked in `service-request-mail.db.test.ts`, where the
 * mail harness lives.
 *
 * Run (the base is fresh, the migrations are applied by the test itself):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_blank_test \
 *     pnpm check:db service-request-contractor-consumables
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like the other `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Own suffix per run: the base outlives the run, and the cleanup finds its own rows by it. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
const KEY_PREFIX = `srcc/${RUN}/`;
const REQUESTS = '/api/v1/service-requests';

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
  /** Administrator: creates the fleet and the nomenclature, assigns and marks issues. */
  admin: TestUser;
  /** The requester of the site: reads the composition and the documents as before. */
  customer: TestUser;
  /** «Ведение»: `status` and `assign` through the add-on set, no `execute`. */
  operator: TestUser;
  /** An in-house executor: named on requests, holds `execute`. */
  inHouse: TestUser;
  /** The operator of the assigned service company. */
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
  // The download link is signed locally and storage is never called: the subject is the access
  // decision, not S3.
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
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method, url, headers: auth, remoteAddress: nextAddress() };
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
  const users = sql`SELECT id FROM users WHERE email LIKE 'db-srcc-%'`;
  const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE 'SRCC-%'`;
  await db.execute(sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE 'srcc/%'`);
  // The stock journal is immutable and holds the requests by a foreign key: its rows of the
  // positions of this file go first, the way `service-request-consumables.db.test.ts` does it.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`
      ALTER TABLE office_equipment_consumable_stock_entries
        DISABLE TRIGGER office_equipment_consumable_stock_immutable`);
    await tx.execute(sql`
      DELETE FROM office_equipment_consumable_stock_entries
       WHERE consumable_id IN (SELECT id FROM office_equipment_consumables WHERE code LIKE 'SRCC%')`);
    await tx.execute(sql`
      ALTER TABLE office_equipment_consumable_stock_entries
        ENABLE ALWAYS TRIGGER office_equipment_consumable_stock_immutable`);
  });
  await db.execute(sql`
    DELETE FROM service_requests
     WHERE office_equipment_id IN (${equipment}) OR created_by IN (${users})`);
  await db.execute(sql`DELETE FROM office_equipment WHERE inventory_number LIKE 'SRCC-%'`);
  await db.execute(sql`
    DELETE FROM office_equipment_models m
     WHERE m.name LIKE '%SRCC-%'
       AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE 'srcc/%'`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
  await db.execute(sql`DELETE FROM office_equipment_consumables WHERE code LIKE 'SRCC%'`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'db-srcc-%'`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE 'srcc-%'`);
  await db.execute(sql`DELETE FROM counterparties WHERE name LIKE 'Сервис-SRCC %'`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE 'SRCC-%'`);
}

// ── Fixtures ──

let unitNo = 0;
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    modelId: await officeEquipmentModelId(ctx.db, ctx.typeId, `Ricoh MP C305 SRCC-${RUN}`),
    inventoryNumber: `SRCC-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

let codeNo = 0;
/** A nomenclature position with a starting stock; its code and name are the secret of the case. */
async function makeConsumable(quantity: number): Promise<{ id: string; name: string }> {
  codeNo += 1;
  const name = `Тонер Ricoh SECRET-${RUN}-${codeNo}`;
  const res = await inject('POST', '/api/v1/office-equipment-consumables', ctx.admin.auth, {
    code: `SRCC${RUN.toUpperCase()}${String(codeNo).padStart(3, '0')}`,
    name,
    quantity,
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: (res.json() as OfficeEquipmentConsumableDto).id, name };
}

async function card(id: string, user: TestUser = ctx.admin): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, user.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function historyOf(id: string, user: TestUser): Promise<ServiceRequestHistoryEntryDto[]> {
  const res = await inject('GET', `${REQUESTS}/${id}/history`, user.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestHistoryEntryDto[];
}

function changeFields(history: ServiceRequestHistoryEntryDto[]): string[] {
  return history.flatMap((entry) => entry.changes.map((change) => change.field));
}

/** An uploaded file as a `files` row: the transport is not the subject, the access decision is. */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`${KEY_PREFIX}${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'active', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

async function attach(
  id: string,
  kind: ServiceFileKind,
  user: TestUser,
  filename: string,
): Promise<string> {
  const fileId = await uploadedFile(user.id, filename);
  const res = await inject('POST', `${REQUESTS}/${id}/files`, user.auth, {
    fileIds: [fileId],
    kind,
  });
  expect(res.statusCode, `attach: ${res.body}`).toBe(200);
  return fileId;
}

async function assign(
  id: string,
  input: { userIds: string[]; serviceCounterpartyId: string | null },
): Promise<void> {
  const res = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.admin.auth, {
    ...input,
    version: (await card(id)).version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function start(id: string, user: TestUser): Promise<void> {
  const res = await inject('PATCH', `${REQUESTS}/${id}/start`, user.auth, {
    version: (await card(id)).version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

type Assignment = 'ours' | 'contractor' | 'mixed';

interface Fixture {
  id: string;
  consumableId: string;
  consumableName: string;
  lineId: string;
  documentName: string;
  documentId: string;
}

/**
 * A consumables request in «В работе» with one composition row and one attached document, handed
 * to whom the case needs: `ours` — the in-house executor alone (the warehouse is ours),
 * `contractor` — the service company alone, `mixed` — both.
 */
async function consumablesRequest(
  assignment: Assignment,
  stock = 10,
  options: { started?: boolean } = {},
): Promise<Fixture> {
  const started = options.started ?? true;
  const consumable = await makeConsumable(stock);
  const created = await inject('POST', REQUESTS, ctx.admin.auth, {
    officeEquipmentId: await makeEquipment(),
    kind: 'consumable',
    consumables: [{ consumableId: consumable.id, requestedQuantity: 2 }],
    description: 'Нужны картриджи',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as { request: ServiceRequestDto }).request.id;
  const documentName = `Счёт на ${consumable.name}.pdf`;
  const documentId = await attach(id, 'attachment', ctx.admin, documentName);

  if (assignment === 'ours') {
    await assign(id, { userIds: [ctx.inHouse.id], serviceCounterpartyId: null });
    if (started) await start(id, ctx.inHouse);
  } else if (assignment === 'contractor') {
    await assign(id, { userIds: [], serviceCounterpartyId: ctx.counterpartyId });
    if (started) await start(id, ctx.service);
  } else {
    await assign(id, { userIds: [ctx.inHouse.id], serviceCounterpartyId: ctx.counterpartyId });
    if (started) await start(id, ctx.inHouse);
  }
  const request = await card(id);
  return {
    id,
    consumableId: consumable.id,
    consumableName: consumable.name,
    lineId: request.consumables[0]!.id,
    documentName,
    documentId,
  };
}

describe.skipIf(!DB_URL)('заявка на расходники у подрядчика: номенклатура (Р7)', () => {
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
      const email = `db-srcc-${input.tag}-${RUN}@example.invalid`;
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
      VALUES ('service'::counterparty_type, ${`Сервис-SRCC ${RUN}`}, ${innOf(`78${digits}1`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`SRCC-${RUN}`}, ${`Тестовая площадка SRCC ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const admin = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const inHouse = await makeUser({ tag: 'exec', role: 'shtab' });
    const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId}),
             (${inHouse.id}, ${objectId})`);

    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin.id);
    });

    // The in-house executor's own set (not a system one, which would widen the scope to the whole
    // company): `execute` makes his named assignment a move, `read` shows him the request.
    const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${`srcc-exec-${RUN}`}, ${`Оргтехника: исполнитель ${RUN}`}, 'Набор прогона Р7/Р8',
              false, ${admin.id})
      RETURNING id`);
    const grantId = grantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${grantId}, 'serviceRequests.read'), (${grantId}, 'serviceRequests.execute'),
             (${grantId}, 'serviceRequests.files')`);
    await db.execute(
      sql`INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab'::role)`,
    );
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${inHouse.id}, ${grantId}, ${admin.id})`);

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
      customer: await withAuth(customer),
      operator: await withAuth(operator),
      inHouse: await withAuth(inHouse),
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
  // Р7. What the contractor reads
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('Р7: чтение — карточка, список, история, файлы', () => {
    it('карточка и список подрядчика: ни строк состава, ни документов; остальным — как было', async () => {
      const fixture = await consumablesRequest('contractor');

      const cut = await card(fixture.id, ctx.service);
      expect(cut.kind).toBe('consumable');
      expect(cut.consumables).toEqual([]);
      expect(cut.files).toEqual([]);
      expect(JSON.stringify(cut)).not.toContain(fixture.consumableName);
      expect(JSON.stringify(cut)).not.toContain(fixture.documentName);

      // The list row is built by the same assembler, and a list that forgot the cut would leak
      // the composition of fifty requests at once.
      const list = await inject(
        'GET',
        `${REQUESTS}?equipmentId=${(await card(fixture.id)).equipment!.id}`,
        ctx.service.auth,
      );
      expect(list.statusCode, list.body).toBe(200);
      const row = (list.json() as { items: ServiceRequestDto[] }).items.find(
        (item) => item.id === fixture.id,
      );
      expect(row, 'подрядчик видит свою заявку в списке').toBeDefined();
      expect(row!.consumables).toEqual([]);
      expect(row!.files).toEqual([]);

      // The controls: everyone the rule does not cut off reads the rows and the document.
      for (const user of [ctx.admin, ctx.operator, ctx.inHouse]) {
        const full = await card(fixture.id, user);
        expect(
          full.consumables.map((line) => line.name),
          user.email,
        ).toEqual([fixture.consumableName]);
        expect(
          full.files.map((file) => file.filename),
          user.email,
        ).toContain(fixture.documentName);
      }
      // The requester reads the composition too: «что мне привезут» is his question.
      const customerCard = await card(fixture.id, ctx.customer);
      expect(customerCard.consumables).toHaveLength(1);
    });

    it('ответ действия тоже урезан: «принять в работу» не возвращает подрядчику состав', async () => {
      // Every response that carries the card goes through the same cut, not only the read doors.
      const fixture = await consumablesRequest('contractor', 10, { started: false });
      const res = await inject('PATCH', `${REQUESTS}/${fixture.id}/start`, ctx.service.auth, {
        version: (await card(fixture.id)).version,
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as ServiceRequestDto;
      expect(body.status).toBe('in_work');
      expect(body.consumables).toEqual([]);
      expect(body.files).toEqual([]);
    });

    it('ремонт того же подрядчика не урезан: документы на месте', async () => {
      // The control for the whole group: the cut is for consumables requests only.
      const created = await inject('POST', REQUESTS, ctx.admin.auth, {
        officeEquipmentId: await makeEquipment(),
        description: 'Не печатает',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = (created.json() as { request: ServiceRequestDto }).request.id;
      const photoId = await attach(id, 'attachment', ctx.admin, `Фото ${RUN}.pdf`);
      await assign(id, { userIds: [], serviceCounterpartyId: ctx.counterpartyId });

      const repair = await card(id, ctx.service);
      expect(repair.kind).toBe('repair');
      expect(repair.files.map((file) => file.filename)).toContain(`Фото ${RUN}.pdf`);
      const link = await inject('GET', `/api/v1/files/${photoId}/download`, ctx.service.auth);
      expect(link.statusCode, link.body).toBe(200);
    });

    it('история: состав, выдача и имена документов подрядчику не отдаются, службе — да', async () => {
      const fixture = await consumablesRequest('ours');
      // The composition is rewritten (a `consumables` entry), the issue is marked (a
      // `consumablesIssued` entry), then the request goes to the contractor.
      const request = await card(fixture.id);
      const second = await makeConsumable(5);
      const rewritten = await inject(
        'PUT',
        `${REQUESTS}/${fixture.id}/consumables`,
        ctx.admin.auth,
        {
          items: [
            { consumableId: fixture.consumableId, requestedQuantity: 2 },
            { consumableId: second.id, requestedQuantity: 1 },
          ],
          version: request.version,
        },
      );
      expect(rewritten.statusCode, rewritten.body).toBe(200);
      // The composition was rewritten, so the row to mark is the new one, not `fixture.lineId`.
      const rows = (await card(fixture.id)).consumables;
      const marked = await inject(
        'PATCH',
        `${REQUESTS}/${fixture.id}/consumables/issued`,
        ctx.inHouse.auth,
        {
          items: [
            {
              id: rows.find((r) => r.consumableId === fixture.consumableId)!.id,
              issuedQuantity: 2,
            },
          ],
          version: (await card(fixture.id)).version,
        },
      );
      expect(marked.statusCode, marked.body).toBe(200);
      await assign(fixture.id, { userIds: [], serviceCounterpartyId: ctx.counterpartyId });

      // The edit entries of the request are written by the edit door from the DTO diff; one is
      // seeded here exactly as it lies in the journal, so that the document-name keys have a row to
      // be cut from (the attach door itself writes no names into the history).
      await ctx.db.execute(sql`
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES (${ctx.admin.id}::uuid, 'serviceRequest.update', 'serviceRequest', ${fixture.id},
                ${JSON.stringify({
                  changes: [
                    { field: 'description', from: 'Нужны картриджи', to: 'Нужны картриджи срочно' },
                    { field: 'filesAdded', from: null, to: `Счёт: ${fixture.documentName}` },
                  ],
                })}::jsonb)`);

      const full = await historyOf(fixture.id, ctx.admin);
      const fullFields = changeFields(full);
      // The control: «Ведение» and the administrator read all three kinds of entry.
      expect(fullFields).toContain('consumables');
      expect(fullFields).toContain('consumablesIssued');
      expect(fullFields).toContain('filesAdded');
      expect(changeFields(await historyOf(fixture.id, ctx.operator))).toContain('consumables');

      const cut = await historyOf(fixture.id, ctx.service);
      const cutFields = changeFields(cut);
      for (const field of [
        'consumables',
        'consumablesIssued',
        'consumablesReturned',
        'filesAdded',
        'filesRemoved',
      ]) {
        expect(cutFields, field).not.toContain(field);
      }
      // The names themselves, wherever else in the entries they could sit.
      expect(JSON.stringify(cut)).not.toContain(fixture.consumableName);
      expect(JSON.stringify(cut)).not.toContain(second.name);
      expect(JSON.stringify(cut)).not.toContain(fixture.documentName);
      // The feed itself is not emptied: the status moves and the ordinary edit are still there.
      expect(cut.some((entry) => entry.kind === 'status')).toBe(true);
      expect(cutFields).toContain('description');
    });

    it('прямая ссылка на документ: подрядчик получает 404, служба и заказчик — ссылку', async () => {
      const fixture = await consumablesRequest('contractor');
      const download = (user: TestUser) =>
        inject('GET', `/api/v1/files/${fixture.documentId}/download`, user.auth);

      const hidden = await download(ctx.service);
      expect(hidden.statusCode, hidden.body).toBe(404);
      expect((hidden.json() as { message?: string }).message).toBe('Файл не найден');
      for (const user of [ctx.admin, ctx.operator, ctx.customer]) {
        const open = await download(user);
        expect(open.statusCode, `${user.email}: ${open.body}`).toBe(200);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Р7. What the contractor writes
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('Р7: запись — состав и документы', () => {
    it('PUT /consumables: подрядчику 403 и состав не тронут; администратору и «Ведению» — можно', async () => {
      const fixture = await consumablesRequest('contractor');
      const other = await makeConsumable(5);
      const body = async () => ({
        items: [{ consumableId: other.id, requestedQuantity: 1 }],
        version: (await card(fixture.id)).version,
      });

      const refused = await inject(
        'PUT',
        `${REQUESTS}/${fixture.id}/consumables`,
        ctx.service.auth,
        await body(),
      );
      expect(refused.statusCode, refused.body).toBe(403);
      expect((refused.json() as { message: string }).message).toContain('по заявке на расходники');
      expect((await card(fixture.id)).consumables.map((line) => line.consumableId)).toEqual([
        fixture.consumableId,
      ]);

      // The control on the very same request: the company's own people fill the composition.
      // The request is in «В работе» with the contractor, and an issue was never marked on it.
      const allowed = await inject(
        'PUT',
        `${REQUESTS}/${fixture.id}/consumables`,
        ctx.admin.auth,
        await body(),
      );
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(
        (allowed.json() as ServiceRequestDto).consumables.map((line) => line.consumableId),
      ).toEqual([other.id]);
    });

    it('POST /files: подрядчику 403 и файл не подшит; администратору — можно', async () => {
      const fixture = await consumablesRequest('contractor');
      const fileId = await uploadedFile(ctx.service.id, `Фото ${RUN}.pdf`);
      const refused = await inject('POST', `${REQUESTS}/${fixture.id}/files`, ctx.service.auth, {
        fileIds: [fileId],
        kind: 'attachment',
      });
      expect(refused.statusCode, refused.body).toBe(403);
      const linked = await ctx.db.execute(sql`
        SELECT 1 FROM service_request_files WHERE request_id = ${fixture.id}::uuid
           AND file_id = ${fileId}::uuid`);
      expect(linked.rows).toHaveLength(0);

      // The control: the same call by the administrator.
      const allowed = await inject('POST', `${REQUESTS}/${fixture.id}/files`, ctx.admin.auth, {
        fileIds: [await uploadedFile(ctx.admin.id, `Фото админа ${RUN}.pdf`)],
        kind: 'attachment',
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
    });

    it('DELETE /files/:id: подрядчику 404 как у «связи нет», файл остаётся; администратору — можно', async () => {
      const fixture = await consumablesRequest('contractor');
      const refused = await inject(
        'DELETE',
        `${REQUESTS}/${fixture.id}/files/${fixture.documentId}`,
        ctx.service.auth,
      );
      expect(refused.statusCode, refused.body).toBe(404);
      const still = await ctx.db.execute(sql`
        SELECT 1 FROM service_request_files WHERE request_id = ${fixture.id}::uuid
           AND file_id = ${fixture.documentId}::uuid`);
      expect(still.rows).toHaveLength(1);

      const allowed = await inject(
        'DELETE',
        `${REQUESTS}/${fixture.id}/files/${fixture.documentId}`,
        ctx.admin.auth,
      );
      expect(allowed.statusCode, allowed.body).toBe(200);
    });
  });
});
