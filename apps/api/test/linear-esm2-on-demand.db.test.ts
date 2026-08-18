import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { issueRequestEsm2 } from './waybill-issue-helper';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ЭСМ-2 по требованию: линейный заказ ведёт бумагу не сроком, а просьбой (ADR 0100 §5, §6).
 *
 * Зачем база. Проверяется здесь не форма запроса, а стык кода со схемой и с соседними действиями:
 * признак линейности читается живым join'ом заказанного типа (снимка в заявке нет), недельный
 * лист рождается номером из серии строгой отчётности, а «одна неделя — один действующий лист»
 * держит частичный UNIQUE, переписанный миграцией 0127 на пару «неделя + машина». Ни одно из
 * этого на правилах не воспроизводится: расходятся не правила, а код и база.
 *
 * Вторая половина — соседи. Перевод в работу, смена машины и досрочное завершение зовут ту же
 * сверку, что и раньше, и линейный заказ обязан пройти через них, не потеряв уже выписанного и
 * не потребовав машиниста там, где листы не рождаются.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-linear-esm2-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: ЭСМ-2 по требованию';
/** Префикс кодов заведённых типов: по нему убираются и типы, и заказы на них. */
const TYPE_PREFIX = 'linear_esm2_';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  /** Две собственные машины одного вида: смена машины переоформляет бумагу на вторую. */
  vehicleId: string;
  otherVehicleId: string;
  /** Два водителя: у линейного заказа машинист свой на каждую неделю (ADR 0100 §6). */
  driverA: string;
  driverB: string;
  /**
   * Два типа на весь файл — линейный и обычный. Своего типа на каждый случай не заводим
   * намеренно: справочник общий с соседними тестами (обмен справочниками читает его целиком),
   * а признак типа по ходу теста не меняется — заказов на нём бывает сколько угодно.
   */
  linearTypeId: string;
  plainTypeId: string;
  dateFrom: string;
  dateTo: string;
}

let ctx: Ctx;

/** Арендная машина справочника; `null` — её в базе нет, и случай про аренду пропускается. */
let rentalVehicleId: string | null = null;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
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

async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (existing) return;
  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Администратор',
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

/**
 * Машинист: человек со специализацией «водитель». Удостоверения ему не заводим — в бланке ЭСМ-2
 * граф под него нет вовсе (ADR 0095), и выписку оно не останавливает.
 */
async function seedDriver(name: string): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  if (!specialization) throw new Error('в справочнике нет специализации «водитель»');

  const [person] = await db
    .insert(schema.persons)
    .values({
      lastName: 'Машинистов',
      firstName: name,
      middleName: 'Тестович',
      comment: PERSON_MARK,
    })
    .returning({ id: schema.persons.id });
  await db.insert(schema.personSpecializations).values({
    personId: person!.id,
    specializationId: specialization.id,
    isPrimary: true,
    startedOn: '2024-01-15',
  });
  return person!.id;
}

/**
 * Наименования заведённых типов — с «Ямобуры…», и это не шутка, а требование соседства.
 *
 * Половина db-тестов берёт тип своего вида из справочника выражением `ORDER BY vt.name LIMIT 1`
 * (рассылки, дайджесты, письма водителям). Заведённый здесь тип с именем на «А» стал бы для них
 * первым — и заявки соседних файлов молча уехали бы в другой документооборот: у линейного заказа
 * ЭСМ-2 сам не выписывается, а сводка «Техника на объектах» строится как раз по нему. Имя,
 * стоящее в справочнике последним, эту дверь закрывает.
 */
const LINEAR_TYPE_NAME = 'Ямобуры тестовые (линейные)';
const PLAIN_TYPE_NAME = 'Ямобуры тестовые (обычные)';

/**
 * Тип ТС с признаком линейности. Код уникален на прогон: справочник общий с соседними тестами и
 * с прежними прогонами, а `code` у типа уникален.
 */
let typeNo = 0;
async function createType(app: Ctx['app'], auth: Ctx['auth'], kindId: string, isLinear: boolean) {
  typeNo += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: auth,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}${Date.now()}_${typeNo}`,
      name: isLinear ? LINEAR_TYPE_NAME : PLAIN_TYPE_NAME,
      isLinear,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заказы, заведённые этим файлом: по ним и убирается за собой — по идентификаторам, не по типу. */
const createdRequests: string[] = [];

/** Заказ техники на объект этого типа, доведённый до визы: с него начинается каждый случай. */
async function approvedRequest(typeId: string): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: ctx.dateFrom,
      dateTo: ctx.dateTo,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();
  createdRequests.push(request.id as string);

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return { id: request.id, version: approved.json().version };
}

/** Перевод в работу. Машинист передаётся не всегда — в этом половина проверки. */
async function confirm(
  request: { id: string; version: number },
  options: { driverPersonId?: string } = {},
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: request.version,
      assignment: {
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        ...(options.driverPersonId ? { driverPersonId: options.driverPersonId } : {}),
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.dateFrom,
        dateTo: ctx.dateTo,
      },
    },
  });
}

/** Линейный заказ в работе — самое частое начало: заявка, виза, перевод в работу без машиниста. */
async function linearRequestInProgress(): Promise<{ id: string; version: number }> {
  const request = await approvedRequest(ctx.linearTypeId);
  const res = await confirm(request);
  expect(res.statusCode, res.body).toBe(200);
  return { id: request.id, version: res.json().version };
}

/**
 * Выписка ЭСМ-2 по требованию — через общее рукопожатие (Р21, Р21а).
 *
 * ЭСМ-2 оказался **пятым** путём выпуска номера: у машиниста бывают пробелы в документах
 * (ADR 0064), и сервер спрашивает подтверждение, как и на прочих путях. Здесь выписка — шаг
 * подготовки, а не предмет проверки, поэтому подтверждение ставит помощник; отказы других родов
 * (право, срок, версия) он не трогает и отдаёт как есть.
 */
async function issueEsm2(
  requestId: string,
  body: { weekOf: string; vehicleId?: string; driverPersonId?: string; version: number },
): Promise<Awaited<ReturnType<typeof ctx.app.inject>>> {
  const { res } = await issueRequestEsm2({
    app: ctx.app,
    headers: ctx.auth,
    requestId,
    payload: {
      weekOf: body.weekOf,
      vehicleId: body.vehicleId ?? ctx.vehicleId,
      driverPersonId: body.driverPersonId ?? ctx.driverA,
      version: body.version,
    },
    // Ответ отдаётся как есть: половина случаев этой двери проверяет настоящие отказы — день вне
    // срока, чужой статус, арендная машина, — и помощник нужен им лишь затем, чтобы снять с дороги
    // рукопожатие.
    expectIssued: false,
  });
  return res;
}

interface SheetRow {
  id: string;
  status: string;
  period_from: string;
  period_to: string;
  vehicle_id: string;
  driver_person_id: string;
}

/** Листы заявки как они лежат в журнале: действующие и сгоревшие, по неделям. */
async function sheetsOf(requestId: string): Promise<SheetRow[]> {
  const res = await ctx.db.execute<SheetRow>(sql`
    SELECT id, status, period_from::text, period_to::text, vehicle_id, driver_person_id
    FROM waybills WHERE source_request_id = ${requestId}
    ORDER BY period_from, issued_at`);
  return res.rows;
}

/** Календарный ключ `YYYY-MM-DD` человеку: им сверяются формулировки отказов. */
function ru(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

describe.skipIf(!DB_URL)('ЭСМ-2 по требованию у линейного заказа (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    // Две собственные машины одного вида и объект — из справочника: их наполняют миграции, и
    // зафиксированный здесь идентификатор разошёлся бы с ними при первой правке.
    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vk.code = 'special_equipment'
      ORDER BY v.registration_number
      LIMIT 2`);
    const rental = await db.execute<{ id: string }>(sql`
      SELECT id FROM vehicles WHERE ownership <> 'own' AND deleted_at IS NULL LIMIT 1`);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    const [first, second] = vehicles.rows;
    const object = objects.rows[0];
    if (!first || !second || !object) {
      throw new Error('в базе нет двух своих спецмашин или объекта: миграции не применены');
    }

    const today = moscowDateKeyOf(new Date());
    ctx = {
      app,
      db,
      closeDb,
      auth,
      objectId: object.id,
      vehicleId: first.id,
      otherVehicleId: second.id,
      driverA: await seedDriver('Первый'),
      driverB: await seedDriver('Второй'),
      linearTypeId: await createType(app, auth, first.kind_id, true),
      plainTypeId: await createType(app, auth, first.kind_id, false),
      // Срок — от сегодня на две недели вперёд: заявку задним числом сервер не принимает
      // (`isAllowedRequestDate`), а две недели гарантируют вторую неделю целиком внутри срока
      // при любом дне недели, в который тест запустили.
      dateFrom: today,
      dateTo: shiftDateKey(today, 13),
    };
    // Арендная машина нужна одному случаю; её в справочнике может и не быть — тогда случай
    // пропускается, а не падает на подготовке.
    rentalVehicleId = rental.rows[0]?.id ?? null;
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь заказы с бланками иначе видны
     * соседним файлам — журналу листов, отборам списка заявок, срезам и сводкам рассылок.
     * Порядок обратный ссылкам: сначала листы (талоны уходят каскадом, а сами `waybills` держат
     * и заявку, и человека внешними ключами `restrict`), потом заказы (детали, назначения и
     * история — каскадом), потом типы и люди. Учётка теста остаётся намеренно — на неё ссылается
     * журнал аудита, а `seedAdmin` переиспользует её при следующем прогоне.
     *
     * Заказы убираются **по своим идентификаторам**, а не по типу: файлы идут параллельно, и
     * заявку на здешнем типе успевает завести сосед (тип из справочника они берут запросом).
     * Снести её значило бы уронить чужой тест на полпути. По той же причине тип и человек
     * удаляются с оглядкой: остались чужие ссылки — строка переживает прогон, и это лучше, чем
     * упавшая уборка или испорченный сосед.
     */
    if (ctx?.db) {
      const mine = sql.param(createdRequests);
      await ctx.db.execute(
        sql`DELETE FROM waybills WHERE source_request_id = ANY(${mine}::uuid[])`,
      );
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ANY(${mine}::uuid[])`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
        WHERE code LIKE ${`${TYPE_PREFIX}%`}
          AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)
          AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      await ctx.db.execute(sql`
        DELETE FROM persons
        WHERE comment = ${PERSON_MARK}
          AND id NOT IN (SELECT driver_person_id FROM waybills)`);
    }
    /*
     * Журнал уборка сносит по автору: писали в него только здешние учётки, а видов записей у них
     * несколько — отбор по одному виду сущности оставлял бы остальные. `audit_log` — самая большая
     * таблица общей базы db-тестов, и набирается она как раз такими остатками.
     */
    await ctx?.db.execute(sql`
      DELETE FROM audit_log
       WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('линейный заказ уходит в работу без машиниста и без единого листа', async () => {
    const request = await approvedRequest(ctx.linearTypeId);

    // Машиниста в теле нет намеренно: листы в этот момент не рождаются, и требовать человека,
    // который неизвестно на какую неделю выйдет, не за что (ADR 0100 §5).
    const res = await confirm(request);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('confirmed');
    expect(res.json().isLinear).toBe(true);
    expect(await sheetsOf(request.id)).toEqual([]);
  });

  it('обычный заказ по-прежнему требует машиниста: там листы рождаются сами', async () => {
    const request = await approvedRequest(ctx.plainTypeId);

    const res = await confirm(request);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('Укажите машиниста');

    // С машинистом — как было: по листу на каждую неделю срока.
    const ok = await confirm(request, { driverPersonId: ctx.driverA });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().isLinear).toBe(false);
    const sheets = await sheetsOf(request.id);
    expect(sheets.length).toBeGreaterThan(1);
    expect(sheets.every((s) => s.status === 'issued')).toBe(true);
  });

  it('границы недели считает сервер: пересечение календарной недели со сроком', async () => {
    const request = await linearRequestInProgress();

    const res = await issueEsm2(request.id, { weekOf: ctx.dateFrom, version: request.version });
    expect(res.statusCode, res.body).toBe(200);

    const sheets = await sheetsOf(request.id);
    expect(sheets).toHaveLength(1);
    // Первая неделя срока обрывается воскресеньем, а начинается днём начала работ, а не
    // понедельником: в графе «Период работы» стоят фактические рабочие дни.
    expect(sheets[0]!.period_from).toBe(ctx.dateFrom);
    expect(sheets[0]!.period_to).toBe(shiftDateKey(weekStartKey(ctx.dateFrom), 6));
    expect(sheets[0]!.vehicle_id).toBe(ctx.vehicleId);
    expect(sheets[0]!.driver_person_id).toBe(ctx.driverA);

    // Событие своё: «человек попросил бланк» нельзя смешивать со «сверка переоформила бумагу».
    const audit = await ctx.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
      SELECT action, metadata FROM audit_log
      WHERE entity_type = 'waybill' AND entity_id = ${sheets[0]!.id}
      ORDER BY created_at DESC LIMIT 1`);
    expect(audit.rows[0]?.action).toBe('waybill.esm2_issue');
    expect(audit.rows[0]?.metadata.requestId).toBe(request.id);

    // Карточка заявки видит лист там же, где и раньше, — своей ручкой.
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${request.id}/waybills`,
      headers: ctx.auth,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0].formCode).toBe('esm2');
  });

  it('день вне срока заявки — отказ словами, а не пустой лист', async () => {
    const request = await linearRequestInProgress();
    const before = shiftDateKey(ctx.dateFrom, -1);

    const res = await issueEsm2(request.id, { weekOf: before, version: request.version });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toBe(
      `День ${ru(before)} вне срока заявки (${ru(ctx.dateFrom)} — ${ru(ctx.dateTo)}) — выберите день внутри срока`,
    );
    expect(await sheetsOf(request.id)).toEqual([]);
  });

  it('вторая просьба на ту же неделю той же машиной — отказ с номером выданного бланка', async () => {
    const request = await linearRequestInProgress();
    const first = await issueEsm2(request.id, {
      weekOf: ctx.dateFrom,
      version: request.version,
    });
    expect(first.statusCode, first.body).toBe(200);

    // Другой день той же недели — та же неделя: неделю называет любой её день.
    const again = await issueEsm2(request.id, {
      weekOf: shiftDateKey(weekStartKey(ctx.dateFrom), 6),
      version: first.json().version,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/уже выписан действующий лист ЭСМ-2 № /);
    expect(await sheetsOf(request.id)).toHaveLength(1);
  });

  it('ту же неделю второй машиной — можно: неделя уникальна на машину', async () => {
    const request = await linearRequestInProgress();
    const first = await issueEsm2(request.id, { weekOf: ctx.dateFrom, version: request.version });
    expect(first.statusCode, first.body).toBe(200);

    // У линейного заказа неделю закрывают две единицы, и каждой нужен свой лист со своими
    // моточасами (ADR 0100 §7, миграция 0127).
    const second = await issueEsm2(request.id, {
      weekOf: ctx.dateFrom,
      vehicleId: ctx.otherVehicleId,
      driverPersonId: ctx.driverB,
      version: first.json().version,
    });
    expect(second.statusCode, second.body).toBe(200);
    const sheets = await sheetsOf(request.id);
    expect(sheets).toHaveLength(2);
    expect(new Set(sheets.map((s) => s.vehicle_id))).toEqual(
      new Set([ctx.vehicleId, ctx.otherVehicleId]),
    );
  });

  it('нелинейный заказ руками бланка не получает: его листы ведёт портал', async () => {
    const request = await approvedRequest(ctx.plainTypeId);
    const confirmed = await confirm(request, { driverPersonId: ctx.driverA });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const res = await issueEsm2(request.id, {
      weekOf: ctx.dateFrom,
      version: confirmed.json().version,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toBe(
      `Тип «${PLAIN_TYPE_NAME}» не линейный: листы ЭСМ-2 по такому заказу портал выписывает сам, на каждую неделю срока — просить их не нужно`,
    );
  });

  it('заявка не в работе — отказ называет статус', async () => {
    const request = await approvedRequest(ctx.linearTypeId);

    const res = await issueEsm2(request.id, {
      weekOf: ctx.dateFrom,
      version: request.version,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toBe(
      'Заявка в статусе «Новая» — лист ЭСМ-2 выписывают по заявке в работе',
    );
  });

  it('арендная машина в бланк не идёт: лист на неё выписывает арендодатель', async () => {
    if (!rentalVehicleId) return;
    const request = await linearRequestInProgress();

    const res = await issueEsm2(request.id, {
      weekOf: ctx.dateFrom,
      vehicleId: rentalVehicleId,
      version: request.version,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toBe(
      'Машина арендная — путевой лист на неё выписывает арендодатель: выберите собственную технику',
    );
  });

  /**
   * Главное, ради чего сверка у линейного заказа не выключена: выданный бланк не вправе разойтись
   * с заявкой. Машину сменили — номер сгорает, и на его место выписывается новый, с тем же
   * машинистом: его называл человек на каждую неделю отдельно (ADR 0083).
   */
  /*
   * Машина в бланке — выбор человека, а не следствие назначения (ADR 0100 §7): неделю на объекте
   * закрывают две единицы. Смена машины заявки — про то, чем заказ ведут дальше, и переписывать
   * ею уже выданные листы нельзя: моточасы, объект и подпись заказчика на обороте относятся к той
   * машине, которая ту неделю работала.
   */
  it('смена машины заявки выписанных листов не трогает', async () => {
    const request = await linearRequestInProgress();
    const nextMonday = shiftDateKey(weekStartKey(ctx.dateFrom), 7);

    const first = await issueEsm2(request.id, { weekOf: ctx.dateFrom, version: request.version });
    expect(first.statusCode, first.body).toBe(200);
    const second = await issueEsm2(request.id, {
      weekOf: nextMonday,
      driverPersonId: ctx.driverB,
      version: first.json().version,
    });
    expect(second.statusCode, second.body).toBe(200);

    // Машиниста в теле нет: меняли технику, а не человека.
    const changed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/assignment`,
      headers: ctx.auth,
      payload: { vehicleId: ctx.otherVehicleId, version: second.json().version },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const sheets = await sheetsOf(request.id);
    // Ни один номер не сгорел: сверке нечего сверять — машину этих листов называл человек.
    expect(sheets.filter((s) => s.status === 'cancelled')).toHaveLength(0);
    const issued = sheets.filter((s) => s.status === 'issued');
    expect(issued).toHaveLength(2);
    expect(issued.every((s) => s.vehicle_id === ctx.vehicleId)).toBe(true);
    // Каждой неделе остался её человек: смена техники людей не пересаживает.
    expect(issued.find((s) => s.period_from === ctx.dateFrom)?.driver_person_id).toBe(ctx.driverA);
    expect(issued.find((s) => s.period_from === nextMonday)?.driver_person_id).toBe(ctx.driverB);
  });

  /*
   * Обратная сторона того же правила: неделю можно закрыть двумя листами на две машины. Это и
   * есть причина, по которой уникальность недели в базе считается вместе с машиной (миграция
   * 0127), — до неё второй лист упирался бы в индекс.
   */
  it('неделю закрывают две машины — оба листа действующие', async () => {
    const request = await linearRequestInProgress();

    const first = await issueEsm2(request.id, { weekOf: ctx.dateFrom, version: request.version });
    expect(first.statusCode, first.body).toBe(200);
    const second = await issueEsm2(request.id, {
      weekOf: ctx.dateFrom,
      vehicleId: ctx.otherVehicleId,
      driverPersonId: ctx.driverB,
      version: first.json().version,
    });
    expect(second.statusCode, second.body).toBe(200);

    const issued = (await sheetsOf(request.id)).filter((s) => s.status === 'issued');
    expect(issued).toHaveLength(2);
    expect(new Set(issued.map((s) => s.vehicle_id))).toEqual(
      new Set([ctx.vehicleId, ctx.otherVehicleId]),
    );
  });

  it('новых недель сверка линейному заказу не заводит, сколько бы ни длился срок', async () => {
    const request = await linearRequestInProgress();
    const first = await issueEsm2(request.id, { weekOf: ctx.dateFrom, version: request.version });
    expect(first.statusCode, first.body).toBe(200);

    const changed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/assignment`,
      headers: ctx.auth,
      payload: { vehicleId: ctx.otherVehicleId, version: first.json().version },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    // Срок идёт две недели, а листов по-прежнему один: вторую неделю никто не просил.
    const issued = (await sheetsOf(request.id)).filter((s) => s.status === 'issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]!.period_from).toBe(ctx.dateFrom);
  });

  /**
   * Досрочное завершение (ADR 0044) подрезает бумагу и здесь: неделя, у которой отняли дни,
   * перевыписывается по новый последний день, а выпавшая целиком аннулируется без замены.
   */
  it('сокращённый срок подрезает выписанную неделю, а выпавшую аннулирует', async () => {
    const request = await linearRequestInProgress();
    const nextMonday = shiftDateKey(weekStartKey(ctx.dateFrom), 7);
    const newDateTo = shiftDateKey(nextMonday, 2);

    const first = await issueEsm2(request.id, { weekOf: nextMonday, version: request.version });
    expect(first.statusCode, first.body).toBe(200);
    expect((await sheetsOf(request.id))[0]!.period_to).toBe(shiftDateKey(nextMonday, 6));

    const asked = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${request.id}/early-end`,
      headers: ctx.auth,
      payload: { newDateTo, reason: 'работы закончены раньше', version: first.json().version },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const decided = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/early-end`,
      headers: ctx.auth,
      payload: { approved: true, comment: '', version: asked.json().version },
    });
    expect(decided.statusCode, decided.body).toBe(200);

    const sheets = await sheetsOf(request.id);
    expect(sheets.filter((s) => s.status === 'cancelled')).toHaveLength(1);
    const issued = sheets.filter((s) => s.status === 'issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]!.period_from).toBe(nextMonday);
    expect(issued[0]!.period_to).toBe(newDateTo);
    // Машинист остался прежним: срок правили, а не человека.
    expect(issued[0]!.driver_person_id).toBe(ctx.driverA);
  });

  it('отмена заявки аннулирует и то, что выписали по требованию', async () => {
    const request = await linearRequestInProgress();
    const issued = await issueEsm2(request.id, { weekOf: ctx.dateFrom, version: request.version });
    expect(issued.statusCode, issued.body).toBe(200);

    const cancelled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'cancelled',
        comment: 'техника не понадобилась',
        version: issued.json().version,
      },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const sheets = await sheetsOf(request.id);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.status).toBe('cancelled');
  });
});
