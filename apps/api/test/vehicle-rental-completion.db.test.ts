import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  VEHICLE_REQUEST_DOCUMENT_LIMIT,
  type VehicleRequestDocumentDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values come by `await import` after the environment is set — the config checks
// it on import and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as Schema from '../src/db/schema';

/**
 * Rental closing facts and request documents on the live schema (plan
 * `docs/vehicle-rental-completion-documents-plan.md`; the shared resolver is unit-tested in
 * `vehicle-rental-completion.test.ts`, the contracts in `vehicle-rental-completion-contracts.test.ts`).
 *
 * WHAT IS PROVEN
 *
 * 1. The completion door stores both counts and the delivery of a rental apart from the cost, the
 *    preview shows them, a delivery changed after the preview is a stale fingerprint, the lessor
 *    branch stores them too, and a non-rental closing with a delivery is refused by name.
 * 2. The journal summary totals the delivery apart from the cost; the history event names it.
 * 3. Documents: added only in the corridor statuses, by whoever runs requests and by the lessor on
 *    its own request only; removed by the uploader or an administrator, never an attachment; the
 *    request DTO keeps attachments only; the limit; the history events.
 *
 * OWN DATABASE: the counts asserted here are exact, and a neighbour's rows in the same tables would
 * make them false. Run (the file creates and drops its base; `TEST_DATABASE_URL` gives the server):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/vehicle-rental-completion.db.test.ts --maxWorkers=1
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_rental_docs';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const PASSWORD = 'db-test-password-123';
const EMAIL = {
  admin: 'db-rental-admin@example.invalid',
  dispatcher: 'db-rental-dispatcher@example.invalid',
  dispatcher2: 'db-rental-dispatcher2@example.invalid',
  lessor: 'db-rental-lessor@example.invalid',
  otherLessor: 'db-rental-lessor2@example.invalid',
} as const;
type Who = keyof typeof EMAIL;

const RUN = Date.now().toString(36);
/** The site contact of a request: invented digits that resemble nobody's number. */
const SITE = { name: 'Арендов Пётр Сергеевич', phone: '9007770931' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: Record<Who, { authorization: string }>;
  userId: Record<Who, string>;
  objectId: string;
  kindId: string;
  ownVehicleId: string;
  lessorCounterpartyId: string;
  driverId: string;
  today: string;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV ??= 'test';
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
  process.env.RATE_LIMIT_MAX ??= '100000';
}

// ── Scene ──

interface RequestDto {
  id: string;
  version: number;
  status: string;
  files: { id: string }[];
  completion: Record<string, unknown> | null;
}

async function login(email: string): Promise<{ authorization: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

let types = 0;
async function createType(): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth.admin,
    payload: {
      kindId: ctx.kindId,
      code: `rent_${++types}_${RUN}`,
      // «Яя» first: half of the db tests pick a type by `ORDER BY … LIMIT 1`.
      name: `Яя тестовый тип аренды (${types} ${RUN})`,
      isLinear: false,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** A rental offer of the scene's lessor; filed in the base, as the rental directory is another door. */
async function createRentalVehicle(typeId: string): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicles (vehicle_type_id, ownership, lessor_id, lessor_type, lessor_is_active,
                          description, price_per_hour, price_per_shift, shift_hours, status)
    VALUES (${typeId}, 'rental', ${ctx.lessorCounterpartyId}, 'vehicle_lessor', true,
            ${`ТЕСТ аренда закрытия (${RUN} ${typeId.slice(0, 4)})`}, 1500, 12000, 8, 'active')
    RETURNING id`);
  return rows.rows[0]!.id;
}

let objects = 0;
/** A file uploaded by `who`, as the presign flow leaves it: pending, linked nowhere. */
async function upload(who: Who, filename: string): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`rental-docs/${RUN}/${++objects}`}, ${filename}, 'application/pdf', 1024,
            'pending', ${ctx.userId[who]})
    RETURNING id`);
  return rows.rows[0]!.id;
}

/** An on-site order taken into work; `vehicleId` given — that (rental) vehicle, else the own one. */
async function inWork(
  options: { vehicleId?: string; fileIds?: string[] } = {},
): Promise<RequestDto> {
  const typeId = await createType();
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth.admin,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: ctx.today,
      dateTo: shiftDateKey(ctx.today, 5),
      responsibleName: SITE.name,
      responsiblePhone: SITE.phone,
      comment: 'ТЕСТ: закрытие аренды и документы',
      fileIds: options.fileIds ?? [],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json() as RequestDto;
  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth.admin,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  const rental = options.vehicleId !== undefined;
  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth.admin,
    payload: {
      version: (approved.json() as RequestDto).version,
      status: 'confirmed',
      comment: '',
      assignment: {
        vehicleId: options.vehicleId ?? ctx.ownVehicleId,
        pricePerHour: rental ? 1500 : null,
        pricePerShift: rental ? 12000 : null,
        shiftHours: rental ? 8 : null,
        driverPersonId: ctx.driverId,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return confirmed.json() as RequestDto;
}

async function reload(id: string, who: Who = 'admin'): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${id}`,
    headers: ctx.auth[who],
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

function door(
  id: string,
  step: 'preview' | 'apply',
  payload: Record<string, unknown>,
  who: Who = 'admin',
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${id}/completion${step === 'preview' ? '/preview' : ''}`,
    headers: ctx.auth[who],
    payload,
  });
}

/** A rental closing: 3 shifts billed, 27 hours, a delivery, closed today. */
function rentalBody(
  request: RequestDto,
  fact: Record<string, unknown> = {},
  endedOn: string | null = ctx.today,
): Record<string, unknown> {
  return {
    version: request.version,
    comment: '',
    completion: {
      workedUnit: 'shifts',
      workedAmount: 3,
      workedShifts: 3,
      workedHours: 27,
      deliveryCost: 12000,
      ...(endedOn === null ? {} : { endedOn }),
      ...fact,
    },
  };
}

async function completionRow(requestId: string) {
  const rows = await ctx.db.execute<{
    worked_amount: string;
    worked_hours: string | null;
    worked_shifts: string | null;
    delivery_cost: string | null;
    total_cost: string | null;
  }>(sql`SELECT worked_amount, worked_hours, worked_shifts, delivery_cost, total_cost
           FROM vehicle_request_completions WHERE request_id = ${requestId}`);
  return rows.rows[0] ?? null;
}

async function auditOf(requestId: string, action: string) {
  const rows = await ctx.db.execute<{
    metadata: { changes?: { field: string; to: string | null }[] };
  }>(
    sql`SELECT metadata FROM audit_log
         WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId} AND action = ${action}
         ORDER BY created_at`,
  );
  return rows.rows.map((row) => row.metadata);
}

function documents(id: string, who: Who = 'admin'): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${id}/documents`,
    headers: ctx.auth[who],
  });
}

function addDocument(
  id: string,
  payload: Record<string, unknown>,
  who: Who = 'dispatcher',
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${id}/documents`,
    headers: ctx.auth[who],
    payload,
  });
}

function removeDocument(id: string, fileId: string, who: Who): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/vehicle-requests/${id}/documents/${fileId}`,
    headers: ctx.auth[who],
  });
}

async function addUser(
  db: typeof AppDb,
  schema: typeof Schema,
  who: Who,
  values: { role: 'admin' | 'dispatcher' | 'operator'; counterpartyId?: string },
  passwordHash: string,
): Promise<string> {
  const [row] = await db
    .insert(schema.users)
    .values({
      email: EMAIL[who],
      lastName: 'Тестовый',
      firstName: who,
      middleName: '',
      passwordHash,
      role: values.role,
      counterpartyId: values.counterpartyId ?? null,
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return row!.id;
}

describe.skipIf(!DB_URL)('rental closing facts and request documents', () => {
  beforeAll(async () => {
    const adminClient = new pg.Client({ connectionString: ADMIN_DB });
    await adminClient.connect();
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
      await adminClient.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await adminClient.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await client.query('CREATE EXTENSION IF NOT EXISTS unaccent');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const schema = await import('../src/db/schema');
    const passwordHash = await hashPassword(PASSWORD);

    const [lessor, otherLessor] = await db
      .insert(schema.counterparties)
      .values([
        {
          name: `ТЕСТ Арендодатель закрытия (${RUN})`,
          type: 'vehicle_lessor',
          inn: String(Date.now()).slice(-10),
          comment: 'ТЕСТОВЫЕ ДАННЫЕ: закрытие аренды',
        },
        {
          name: `ТЕСТ Чужой арендодатель (${RUN})`,
          type: 'vehicle_lessor',
          inn: String(Date.now() + 1).slice(-10),
          comment: 'ТЕСТОВЫЕ ДАННЫЕ: закрытие аренды',
        },
      ])
      .returning({ id: schema.counterparties.id });
    const userId = {
      admin: await addUser(db, schema, 'admin', { role: 'admin' }, passwordHash),
      dispatcher: await addUser(db, schema, 'dispatcher', { role: 'dispatcher' }, passwordHash),
      dispatcher2: await addUser(db, schema, 'dispatcher2', { role: 'dispatcher' }, passwordHash),
      // The external executor's role is `operator`; the counterparty type makes it a lessor (ADR 0038).
      lessor: await addUser(
        db,
        schema,
        'lessor',
        { role: 'operator', counterpartyId: lessor!.id },
        passwordHash,
      ),
      otherLessor: await addUser(
        db,
        schema,
        'otherLessor',
        { role: 'operator', counterpartyId: otherLessor!.id },
        passwordHash,
      ),
    } satisfies Record<Who, string>;

    const [specialization] = await db
      .select({ id: schema.specializations.id })
      .from(schema.specializations)
      .where(sql`${schema.specializations.code} = 'driver'`);
    if (!specialization) throw new Error('no «driver» specialization: migrations not applied');
    const [person] = await db
      .insert(schema.persons)
      .values({
        lastName: 'Арендов',
        firstName: 'Тест',
        middleName: 'Машинистович',
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: закрытие аренды',
      })
      .returning({ id: schema.persons.id });
    await db.insert(schema.personSpecializations).values({
      personId: person!.id,
      specializationId: specialization.id,
      isPrimary: true,
      startedOn: '2024-01-15',
    });

    const objectRows = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY id LIMIT 1`,
    );
    const vehicleRows = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
         AND vk.code = 'special_equipment'
       ORDER BY v.registration_number
       LIMIT 1`);
    const object = objectRows.rows[0];
    const vehicle = vehicleRows.rows[0];
    if (!object || !vehicle)
      throw new Error('no site or own special vehicle: migrations not applied');

    const app = await buildApp();
    const blank = { authorization: '' };
    ctx = {
      app,
      db,
      closeDb,
      auth: {
        admin: blank,
        dispatcher: blank,
        dispatcher2: blank,
        lessor: blank,
        otherLessor: blank,
      },
      userId,
      objectId: object.id,
      kindId: vehicle.kind_id,
      ownVehicleId: vehicle.id,
      lessorCounterpartyId: lessor!.id,
      driverId: person!.id,
      today: moscowDateKeyOf(new Date()),
    };
    for (const who of Object.keys(EMAIL) as Who[]) ctx.auth[who] = await login(EMAIL[who]);
  }, 180_000);

  afterAll(async () => {
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  // ── Closing ──

  it('stores both counts and the delivery of a rental apart from the cost, and the preview names them', async () => {
    const request = await inWork({ vehicleId: await createRentalVehicle(await createType()) });

    const shown = await door(request.id, 'preview', rentalBody(request));
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as { fingerprint: string; completion: Record<string, unknown> };
    expect(dto.completion).toMatchObject({
      workedUnit: 'shifts',
      workedAmount: 3,
      workedShifts: 3,
      workedHours: 27,
      deliveryCost: 12000,
      totalCost: 36000,
    });

    // The delivery changed after the preview: what was confirmed is not what is sent.
    const changed = await door(request.id, 'apply', {
      ...rentalBody(request, { deliveryCost: 15000 }),
      previewFingerprint: dto.fingerprint,
    });
    expect(changed.statusCode, changed.body).toBe(409);

    const closed = await door(request.id, 'apply', {
      ...rentalBody(request),
      previewFingerprint: dto.fingerprint,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(await completionRow(request.id)).toMatchObject({
      worked_amount: '3.00',
      worked_shifts: '3.00',
      worked_hours: '27.00',
      delivery_cost: '12000.00',
      total_cost: '36000.00',
    });
    expect((await reload(request.id)).completion).toMatchObject({
      workedHours: 27,
      workedShifts: 3,
      deliveryCost: 12000,
    });
    const [event] = await auditOf(request.id, 'vehicle_request.complete');
    expect(event!.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'worked', to: '3 смены · 27 ч, по 9 ч на смену' }),
        expect.objectContaining({ field: 'deliveryCost' }),
      ]),
    );
  }, 120_000);

  it('the lessor closes its rental with hours and a delivery, without a date', async () => {
    const request = await inWork({ vehicleId: await createRentalVehicle(await createType()) });
    const mine = await reload(request.id, 'lessor');
    const closed = await door(
      request.id,
      'apply',
      rentalBody(mine, { workedUnit: 'hours', workedAmount: 27, deliveryCost: 8000 }, null),
      'lessor',
    );
    expect(closed.statusCode, closed.body).toBe(200);
    expect(await completionRow(request.id)).toMatchObject({
      worked_amount: '27.00',
      worked_hours: '27.00',
      worked_shifts: '3.00',
      delivery_cost: '8000.00',
      total_cost: '40500.00',
    });
  }, 120_000);

  it('refuses a delivery on a closing of the own vehicle, by name', async () => {
    const request = await inWork();
    const refused = await door(
      request.id,
      'preview',
      rentalBody(request, { workedShifts: undefined, workedHours: undefined }),
    );
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().fields).toEqual({ deliveryCost: 'Только для арендованной техники' });
    expect(await completionRow(request.id)).toBeNull();
  }, 120_000);

  it('the journal totals the delivery apart from the cost', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/vehicle-requests/history/summary',
      headers: ctx.auth.admin,
    });
    expect(res.statusCode, res.body).toBe(200);
    // The two rental closings above: 36 000 + 40 500 of cost, 12 000 + 8 000 of delivery.
    expect(res.json()).toMatchObject({
      totalCost: 76500,
      deliveryCost: 20000,
      withDelivery: 2,
    });
  });

  // ── Documents ──

  it('adds a document from «В работе» on, keeps it out of the editor’s files and merges the table', async () => {
    const attachment = await upload('admin', 'схема.pdf');
    const request = await inWork({
      vehicleId: await createRentalVehicle(await createType()),
      fileIds: [attachment],
    });
    const invoice = await upload('dispatcher', 'upd-1234.pdf');

    const added = await addDocument(request.id, {
      fileId: invoice,
      docType: 'УПД',
      docDate: shiftDateKey(ctx.today, 30),
    });
    expect(added.statusCode, added.body).toBe(200);
    const items = added.json().items as VehicleRequestDocumentDto[];
    expect(items.map((d) => [d.kind, d.docType, d.file.filename])).toEqual([
      ['attachment', null, 'схема.pdf'],
      ['document', 'УПД', 'upd-1234.pdf'],
    ]);
    expect(items[1]!.uploadedBy).toBe(ctx.userId.dispatcher);

    // The request DTO — what the editor reads — keeps the attachment only.
    expect((await reload(request.id)).files.map((f) => f.id)).toEqual([attachment]);
    const read = await documents(request.id, 'lessor');
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().items).toHaveLength(2);

    const [event] = await auditOf(request.id, 'vehicle_request.document_add');
    expect(event!.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'document', to: expect.stringMatching(/^УПД от /) }),
        expect.objectContaining({ field: 'filesAdded', to: 'upd-1234.pdf' }),
      ]),
    );

    // A file is linked once: the same upload cannot become a second document.
    const twice = await addDocument(request.id, {
      fileId: invoice,
      docType: 'Акт',
      docDate: ctx.today,
    });
    expect(twice.statusCode, twice.body).toBe(400);
  }, 120_000);

  it('refuses a document on a «Новая» request and to a user who does not run requests', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-requests',
      headers: ctx.auth.admin,
      payload: {
        requestType: 'special_equipment',
        objectId: ctx.objectId,
        vehicleTypeId: await createType(),
        dateFrom: ctx.today,
        dateTo: shiftDateKey(ctx.today, 2),
        responsibleName: SITE.name,
        responsiblePhone: SITE.phone,
        comment: 'ТЕСТ: документ к новой заявке',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const fresh = await addDocument(created.json().id as string, {
      fileId: await upload('dispatcher', 'early.pdf'),
      docType: 'Договор',
      docDate: ctx.today,
    });
    expect(fresh.statusCode, fresh.body).toBe(422);
  }, 120_000);

  it('the lessor adds paper to its own request only', async () => {
    const own = await inWork({ vehicleId: await createRentalVehicle(await createType()) });
    const mine = await addDocument(
      own.id,
      { fileId: await upload('lessor', 'act-lessor.pdf'), docType: 'Акт', docDate: ctx.today },
      'lessor',
    );
    expect(mine.statusCode, mine.body).toBe(200);
    const foreign = await addDocument(
      own.id,
      { fileId: await upload('otherLessor', 'act-other.pdf'), docType: 'Акт', docDate: ctx.today },
      'otherLessor',
    );
    expect(foreign.statusCode, foreign.body).toBe(403);
    expect((await documents(own.id, 'otherLessor')).statusCode).toBe(403);
  }, 120_000);

  it('removes a document by its uploader or an administrator, never an attachment', async () => {
    const attachment = await upload('admin', 'фото.pdf');
    const request = await inWork({
      vehicleId: await createRentalVehicle(await createType()),
      fileIds: [attachment],
    });
    const first = await upload('dispatcher', 'invoice-1.pdf');
    const second = await upload('dispatcher', 'invoice-2.pdf');
    for (const fileId of [first, second]) {
      const res = await addDocument(request.id, { fileId, docType: 'Счёт', docDate: ctx.today });
      expect(res.statusCode, res.body).toBe(200);
    }

    expect((await removeDocument(request.id, first, 'dispatcher2')).statusCode).toBe(403);
    const byUploader = await removeDocument(request.id, first, 'dispatcher');
    expect(byUploader.statusCode, byUploader.body).toBe(200);
    const byAdmin = await removeDocument(request.id, second, 'admin');
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(byAdmin.json().items.map((d: VehicleRequestDocumentDto) => d.kind)).toEqual([
      'attachment',
    ]);
    expect((await removeDocument(request.id, attachment, 'admin')).statusCode).toBe(422);

    const removed = await auditOf(request.id, 'vehicle_request.document_remove');
    expect(removed).toHaveLength(2);
    // The file leaves the request and waits for the storage cleanup like any unlinked file.
    const status = await ctx.db.execute<{ status: string }>(
      sql`SELECT status FROM files WHERE id = ${first}`,
    );
    expect(status.rows[0]!.status).toBe('deleted');
  }, 120_000);

  it('holds the document limit of a request', async () => {
    const request = await inWork({ vehicleId: await createRentalVehicle(await createType()) });
    await ctx.db.execute(sql`
      WITH uploaded AS (
        INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
        SELECT 'test', ${`rental-docs/${RUN}/limit/`} || n, 'doc-' || n || '.pdf',
               'application/pdf', 1, 'active', ${ctx.userId.dispatcher}
          FROM generate_series(1, ${VEHICLE_REQUEST_DOCUMENT_LIMIT}) AS n
        RETURNING id
      )
      INSERT INTO vehicle_request_files (vehicle_request_id, file_id, kind, doc_type, doc_date)
      SELECT ${request.id}, id, 'document', 'Акт', ${ctx.today}::date FROM uploaded`);
    const over = await addDocument(request.id, {
      fileId: await upload('dispatcher', 'one-more.pdf'),
      docType: 'Акт',
      docDate: ctx.today,
    });
    expect(over.statusCode, over.body).toBe(422);
  }, 120_000);
});
