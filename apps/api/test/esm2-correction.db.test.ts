import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useReadModeDatabase } from './assignment-read-mode';
import { esm2Periods, moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { issueRequestEsm2 } from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Коррекция назначения задним числом у заказа техники на объект (ADR 0101, Р8, Р11, Р21).
 *
 * Зачем база. Проверяется здесь не форма запроса, а сцепка четырёх механик, каждая из которых
 * живёт в своей таблице: недельный лист ЭСМ-2 с его частичным UNIQUE на пару «неделя + машина»
 * (миграция 0127), запись операции с ключом идемпотентности (`waybill_corrections`, миграция
 * 0129), связь операции с заявкой и подписи объекта под днями работы. Ни одно из этого на правилах
 * не воспроизводится: расходятся не правила, а код и схема.
 *
 * Случаи идут по одному сюжету: заказ заводят задним числом (техника вышла раньше, чем оформили),
 * у него остаётся отработанная неделя без бумаги, и дальше эту бумагу приводят к тому, что было.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

/*
 * ЭСМ2-РАЗРЕЗ. Файл заводит свою базу механикой двух режимов: он переключает `read_mode`, а строка
 * режима одна на базу. Обёртка стоит уже сейчас, чтобы окно выката тратилось на переключение, а не
 * на переделку тестов; сегодня половины совпадают — бумагу везде пишет недельная сверка.
 */
const readMode = useReadModeDatabase('esm2corr');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

const ADMIN_EMAIL = 'db-esm2-correction-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: коррекция ЭСМ-2';
/** Префикс кодов заведённых типов: по нему убираются и типы, и заказы на них. */
const TYPE_PREFIX = 'esm2_corr_';

/**
 * Наименования типов — с «Ямобуры…» по той же причине, что и у соседнего файла про линейную
 * технику: половина db-тестов берёт тип своего вида выражением `ORDER BY vt.name LIMIT 1`, и тип с
 * именем на «А» увёл бы их заявки в другой документооборот.
 */
const LINEAR_TYPE_NAME = 'Ямобуры тестовые (коррекция, линейные)';
const PLAIN_TYPE_NAME = 'Ямобуры тестовые (коррекция, обычные)';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  vehicleId: string;
  otherVehicleId: string;
  driverA: string;
  driverB: string;
  linearTypeId: string;
  plainTypeId: string;
  /** Понедельник и воскресенье прошлой календарной недели: она и есть «отработанная». */
  pastFrom: string;
  pastTo: string;
  today: string;
}

let ctx: Ctx;

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
 * Машинист: человек со специализацией «водитель». `endedOn` задаётся случаем — им и проверяется
 * одностороннее окно `findMachinist` (ADR 0101 п. 15): уволенный после своей недели из листа за эту
 * неделю не исчезает, уволенный до неё — не появляется.
 */
async function seedDriver(name: string, ended: string | null = null): Promise<string> {
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
      lastName: 'Коррекцев',
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
    endedOn: ended,
  });
  return person!.id;
}

let typeNo = 0;
async function createType(kindId: string, isLinear: boolean): Promise<string> {
  typeNo += 1;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
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

/**
 * Заказ техники на объект, заведённый **задним числом** (Р15), и сразу завизированный.
 *
 * Задним числом — потому что иначе отработанной недели у заявки взяться неоткуда: сегодняшний
 * заказ начинается сегодня, а неделя, которую правит коррекция, обязана уже кончиться.
 */
async function backdatedRequest(typeId: string): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: ctx.pastFrom,
      dateTo: ctx.today,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      backdateReason: 'Техника вышла раньше, чем оформили заявку',
      operationId: crypto.randomUUID(),
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

/** Перевод в работу на первую машину; машинист нужен обычному заказу и не нужен линейному. */
async function confirm(
  request: { id: string; version: number },
  options: { driverPersonId?: string } = {},
): Promise<{ id: string; version: number }> {
  const res = await ctx.app.inject({
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
        dateFrom: ctx.pastFrom,
        dateTo: ctx.today,
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: request.id, version: res.json().version };
}

interface CorrectionBody {
  operationId: string;
  reason: string;
  unlockWaybillIds?: string[];
}

function changeAssignment(
  request: { id: string; version: number },
  body: { vehicleId?: string; correction?: CorrectionBody },
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/assignment`,
    headers: ctx.auth,
    payload: {
      vehicleId: body.vehicleId ?? ctx.otherVehicleId,
      version: request.version,
      ...(body.correction ? { correction: body.correction } : {}),
    },
  });
}

/**
 * Выписка ЭСМ-2 по требованию за **прошедшую** неделю — то есть операция задним числом (ADR 0101
 * п. 4, дыра 3 плана): у прошедшей недели ручка спрашивает причину и ключ операции наравне с
 * выпиской листа по рейсу. Здесь это подготовка к самой коррекции: чтобы переоформлять отработанную
 * неделю, её сначала надо чем-то закрыть.
 */
/**
 * Выписка по требованию — через общее рукопожатие (Р21а): ЭСМ-2 оказался пятым путём выпуска
 * номера, и у машиниста бывают пробелы в документах (ADR 0064). Здесь выписка — шаг подготовки к
 * коррекции, поэтому подтверждение ставит помощник; ответ отдаётся как есть — эта дверь
 * проверяется и настоящими отказами.
 */
async function issueOnDemand(
  requestId: string,
  body: { vehicleId: string; driverPersonId: string; version: number; weekOf?: string },
): Promise<Awaited<ReturnType<typeof ctx.app.inject>>> {
  const { res } = await issueRequestEsm2({
    app: ctx.app,
    headers: ctx.auth,
    requestId,
    expectIssued: false,
    payload: {
      weekOf: body.weekOf ?? ctx.pastFrom,
      vehicleId: body.vehicleId,
      driverPersonId: body.driverPersonId,
      version: body.version,
      reason: 'Машина отработала неделю, бланк выписываем по факту',
      operationId: crypto.randomUUID(),
    },
  });
  return res;
}

interface SheetRow {
  id: string;
  status: string;
  number: string;
  period_from: string;
  period_to: string;
  vehicle_id: string;
  driver_person_id: string;
  correction_id: string | null;
  cancel_correction_id: string | null;
  corrects_waybill_id: string | null;
  correction_reason: string;
  cancel_reason: string;
  driver_fio: string;
}

/** Листы заявки как они лежат в журнале: действующие и сгоревшие, по неделям. */
async function sheetsOf(requestId: string): Promise<SheetRow[]> {
  const res = await ctx.db.execute<SheetRow>(sql`
    SELECT id, status, number::text, period_from::text, period_to::text, vehicle_id,
           driver_person_id, correction_id, cancel_correction_id, corrects_waybill_id,
           correction_reason, cancel_reason, data->>'driver_fio' AS driver_fio
    FROM waybills WHERE source_request_id = ${requestId}
    ORDER BY period_from, issued_at`);
  return res.rows;
}

/** Действующий лист прошлой недели — предмет всех случаев этого файла. */
function pastSheet(sheets: SheetRow[]): SheetRow | undefined {
  return sheets.find((s) => s.status === 'issued' && s.period_to === ctx.pastTo);
}

describe.skipIf(!DB_URL)('коррекция назначения задним числом (живая схема)', () => {
  beforeAll(async () => {
    // Окружение и своя база готовы хуком механики — остаётся посеять администратора.
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

    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vk.code = 'special_equipment'
      ORDER BY v.registration_number
      LIMIT 2`);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    const [first, second] = vehicles.rows;
    const object = objects.rows[0];
    if (!first || !second || !object) {
      throw new Error('в базе нет двух своих спецмашин или объекта: миграции не применены');
    }

    const today = moscowDateKeyOf(new Date());
    const monday = weekStartKey(today);
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
      linearTypeId: '',
      plainTypeId: '',
      // Прошлая календарная неделя целиком: её конец — вчерашнее воскресенье, и она отработана
      // при любом дне, в который тест запустили.
      pastFrom: shiftDateKey(monday, -7),
      pastTo: shiftDateKey(monday, -1),
      today,
    };
    ctx.linearTypeId = await createType(first.kind_id, true);
    ctx.plainTypeId = await createType(first.kind_id, false);
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь заказы с бланками иначе видны
     * соседним файлам. Порядок обратный ссылкам: сначала листы (они держат и заявку, и человека
     * ключами `restrict`, а между собой — цепочкой коррекций), потом операции коррекции, потом
     * заказы, типы и люди. Цепочка листов рвётся отдельным `UPDATE`: `corrects_waybill_id`
     * ссылается на соседний лист той же заявки с `ON DELETE RESTRICT`.
     */
    if (ctx?.db) {
      const mine = sql.param(createdRequests);
      await ctx.db.execute(sql`
        UPDATE waybills SET corrects_waybill_id = NULL
        WHERE source_request_id = ANY(${mine}::uuid[])`);
      await ctx.db.execute(
        sql`DELETE FROM waybills WHERE source_request_id = ANY(${mine}::uuid[])`,
      );
      await ctx.db.execute(sql`
        DELETE FROM waybill_corrections
        WHERE id NOT IN (SELECT correction_id FROM waybills WHERE correction_id IS NOT NULL)
          AND id NOT IN (
            SELECT cancel_correction_id FROM waybills WHERE cancel_correction_id IS NOT NULL)
          AND id IN (
            SELECT correction_id FROM vehicle_request_corrections
            WHERE request_id = ANY(${mine}::uuid[]))`);
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

  /**
   * Дыра 3 из §1 плана и её закрытие (Р21). Неделя, кончившаяся до сегодня, сверкой не
   * выписывается — ни при переводе в работу, ни обычной сменой техники, — и появляется только у
   * операции, за которую спросили право и причину.
   */
  it('прошедшая неделя выписывается только коррекцией, а не переводом в работу', async () => {
    const request = await confirm(await backdatedRequest(ctx.plainTypeId), {
      driverPersonId: ctx.driverA,
    });

    const afterConfirm = await sheetsOf(request.id);
    expect(afterConfirm.length).toBeGreaterThan(0);
    expect(pastSheet(afterConfirm)).toBeUndefined();

    // Обычная смена техники прошедшую неделю тоже не трогает: право её никто не спрашивал.
    const plain = await changeAssignment(request, { vehicleId: ctx.otherVehicleId });
    expect(plain.statusCode, plain.body).toBe(200);
    expect(pastSheet(await sheetsOf(request.id))).toBeUndefined();

    // А с признаком коррекции — выписывается, и номер объяснён причиной операции.
    const corrected = await changeAssignment(
      { id: request.id, version: plain.json().version },
      {
        vehicleId: ctx.otherVehicleId,
        correction: { operationId: crypto.randomUUID(), reason: 'Работала вторая машина' },
      },
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    const sheet = pastSheet(await sheetsOf(request.id));
    expect(sheet).toBeDefined();
    expect(sheet!.vehicle_id).toBe(ctx.otherVehicleId);
    expect(sheet!.correction_reason).toBe('Работала вторая машина');
    expect(sheet!.correction_id).not.toBeNull();
    // Заменять было нечего: недели без листа заменяют пустоту (Р35).
    expect(sheet!.corrects_waybill_id).toBeNull();

    // Операция связана с заявкой: «что делали с ней задним числом» спрашивают со стороны заявки.
    const links = await ctx.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM vehicle_request_corrections l
      JOIN waybill_corrections c ON c.id = l.correction_id
      WHERE l.request_id = ${request.id} AND c.kind = 'esm2'`);
    expect(links.rows[0]!.n).toBe('1');
  });

  /**
   * Р11: разблокировка адресная, и названный лист переоформляется целиком — старый номер списан
   * операцией, новый на неё же ссылается и называет заменённый.
   */
  it('названный лист отработанной недели переоформляется, а повтор ничего не жжёт', async () => {
    const request = await confirm(await backdatedRequest(ctx.plainTypeId), {
      driverPersonId: ctx.driverA,
    });
    // Первая коррекция заводит бумагу за отработанную неделю — её и будем править.
    const seeded = await changeAssignment(request, {
      vehicleId: ctx.vehicleId,
      correction: { operationId: crypto.randomUUID(), reason: 'Бумага за отработанную неделю' },
    });
    expect(seeded.statusCode, seeded.body).toBe(200);
    const before = pastSheet(await sheetsOf(request.id))!;

    const operationId = crypto.randomUUID();
    const body = {
      vehicleId: ctx.otherVehicleId,
      correction: {
        operationId,
        reason: 'На объекте работала вторая машина',
        unlockWaybillIds: [before.id],
      },
    };
    const res = await changeAssignment({ id: request.id, version: seeded.json().version }, body);
    expect(res.statusCode, res.body).toBe(200);

    const after = await sheetsOf(request.id);
    const burned = after.find((s) => s.id === before.id)!;
    expect(burned.status).toBe('cancelled');
    expect(burned.cancel_reason).toBe('На объекте работала вторая машина');
    expect(burned.cancel_correction_id).not.toBeNull();

    const replacement = pastSheet(after)!;
    expect(replacement.vehicle_id).toBe(ctx.otherVehicleId);
    expect(replacement.corrects_waybill_id).toBe(before.id);
    expect(replacement.correction_id).toBe(burned.cancel_correction_id);
    expect(replacement.number).not.toBe(burned.number);

    /*
     * Повтор после обрыва связи (Р31): тот же ключ и то же тело возвращают прежний результат.
     * Версия заявки при этом уже другая — и именно поэтому повтор узнаётся по ключу до всех
     * прочих проверок: иначе человек прочёл бы «конфликт версий» о работе, которая сделана.
     */
    const again = await changeAssignment({ id: request.id, version: seeded.json().version }, body);
    expect(again.statusCode, again.body).toBe(200);
    expect(await sheetsOf(request.id)).toHaveLength(after.length);

    // Тот же ключ с другой командой — не повтор, а другая команда под чужим ключом.
    const foreign = await changeAssignment(
      { id: request.id, version: again.json().version },
      {
        vehicleId: ctx.vehicleId,
        correction: { operationId, reason: 'Другая команда тем же ключом' },
      },
    );
    expect(foreign.statusCode, foreign.body).toBe(409);
  });

  /**
   * Ограничение, найденное на этапе 1: недельный замок сверки считается по понедельнику, и в
   * неделе с двумя действующими листами разблокировка одного дала бы аннулирование без
   * перевыписки. Сервер такую неделю не берёт вовсе и называет оба номера (Р11).
   */
  it('в неделе с листами двух машин коррекция отказывает и называет номера', async () => {
    const request = await confirm(await backdatedRequest(ctx.linearTypeId));

    // Линейному заказу листы выписывает человек — отдельной просьбой на каждую машину
    // (ADR 0100 §6, §7); внутри просьбы неделя может разрезаться концом месяца.
    let version = request.version;
    for (const vehicleId of [ctx.vehicleId, ctx.otherVehicleId]) {
      const issued = await issueOnDemand(request.id, {
        vehicleId,
        driverPersonId: ctx.driverA,
        version,
      });
      expect(issued.statusCode, issued.body).toBe(200);
      version = issued.json().version;
    }
    const sheets = (await sheetsOf(request.id)).filter((s) => s.status === 'issued');
    // Один запрос на машину может дать два строгих документа, если внутри недели кончается месяц
    // (ADR 0142). Предмет случая — две машины одной недели, а не записанная цифрой пара листов.
    const expectedSheetCount = esm2Periods(ctx.pastFrom, ctx.pastTo).length * 2;
    expect(sheets).toHaveLength(expectedSheetCount);

    const res = await changeAssignment(
      { id: request.id, version },
      {
        vehicleId: ctx.otherVehicleId,
        correction: {
          operationId: crypto.randomUUID(),
          reason: 'Правим один из двух листов недели',
          unlockWaybillIds: [sheets[0]!.id],
        },
      },
    );
    expect(res.statusCode, res.body).toBe(422);
    // В отказе стоят оба номера: человеку нужно понять, какой бланк ему мешает.
    expect(res.json().message).toContain(sheets[0]!.number.replace(/^0+/, '').slice(-4));
    expect(res.json().message).toContain('по требованию');

    // Ни один номер при этом не сгорел.
    expect((await sheetsOf(request.id)).filter((s) => s.status === 'issued')).toHaveLength(
      expectedSheetCount,
    );
  });

  /** Чужой и уже сгоревший номер в перечне — ошибка, а не молча пропущенная строка (Р11). */
  it('лист чужой заявки в перечне разблокировки отклоняется', async () => {
    const mine = await confirm(await backdatedRequest(ctx.plainTypeId), {
      driverPersonId: ctx.driverA,
    });
    const alien = await confirm(await backdatedRequest(ctx.plainTypeId), {
      driverPersonId: ctx.driverA,
    });
    const alienSheets = (await sheetsOf(alien.id)).filter((s) => s.status === 'issued');
    expect(alienSheets.length).toBeGreaterThan(0);

    const res = await changeAssignment(mine, {
      correction: {
        operationId: crypto.randomUUID(),
        reason: 'Чужой номер в перечне',
        unlockWaybillIds: [alienSheets[0]!.id],
      },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('не найден');
  });

  /**
   * Р5: подпись объекта под днём работы снимается коррекцией — и только ею. Обычная смена машины
   * об эту подпись по-прежнему разбивается (ADR 0048), а прежние `approvedBy`/`approvedAt`
   * остаются в снимке операции: «кто принял часы» спрашивают через два месяца.
   */
  it('подтверждённый день снимается коррекцией, а обычной смене техники мешает', async () => {
    const request = await confirm(await backdatedRequest(ctx.plainTypeId), {
      driverPersonId: ctx.driverA,
    });
    const day = ctx.pastTo;
    const filled = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/vehicle-requests/${request.id}/shifts/${day}`,
      headers: ctx.auth,
      payload: { machineHours: 11.5, refuel: '', comment: '' },
    });
    expect(filled.statusCode, filled.body).toBe(200);
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${request.id}/shifts/${day}/approval`,
      headers: ctx.auth,
      payload: { approved: true },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const plain = await changeAssignment(request, { vehicleId: ctx.otherVehicleId });
    expect(plain.statusCode, plain.body).toBe(422);
    expect(plain.json().message).toContain('подтверждённые дни');

    const res = await changeAssignment(request, {
      vehicleId: ctx.otherVehicleId,
      correction: { operationId: crypto.randomUUID(), reason: 'Часы приняли не за ту машину' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const shift = await ctx.db.execute<{ approved_at: string | null; machine_hours: string }>(sql`
      SELECT approved_at, machine_hours::text FROM vehicle_request_shifts
      WHERE request_id = ${request.id} AND shift_date = ${day}`);
    // Подпись снята, часы остались: их вносил объект, и коррекция машины их не опровергает.
    expect(shift.rows[0]!.approved_at).toBeNull();
    expect(Number(shift.rows[0]!.machine_hours)).toBe(11.5);

    const payload = await ctx.db.execute<{ approvals: string }>(sql`
      SELECT c.payload->>'shiftApprovals' AS approvals
      FROM waybill_corrections c
      JOIN vehicle_request_corrections l ON l.correction_id = c.id
      WHERE l.request_id = ${request.id}
      ORDER BY c.created_at DESC LIMIT 1`);
    const saved = JSON.parse(payload.rows[0]!.approvals) as { date: string; approvedBy: string }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.date).toBe(day);
    expect(saved[0]!.approvedBy).not.toBe('');
  });

  /**
   * Специализация машиниста печати его фамилии не решает (ADR 0164): в лист идёт тот, кого назвали
   * листу, — и уволенный после своей недели, и уволенный до неё. Прежде второй не получал бланка
   * вовсе (рукой) или получал его с пустой графой ФИО (сверкой), хотя назначить его машинистом
   * заявке портал позволял.
   *
   * Одностороннее окно кадровых записей (ADR 0101 п. 15 в редакции Р21) осталось там, где оно
   * что-то значит: им читаются табельный номер и должность, а должностью — вид документа.
   */
  it('машинист печатается в листе и с закрытой до его недели специализацией', async () => {
    const request = await confirm(await backdatedRequest(ctx.linearTypeId));
    const leftAfter = await seedDriver('Уволенный после', ctx.today);
    const leftBefore = await seedDriver('Уволенный до', shiftDateKey(ctx.pastFrom, -1));

    const ok = await issueOnDemand(request.id, {
      vehicleId: ctx.vehicleId,
      driverPersonId: leftAfter,
      version: request.version,
    });
    expect(ok.statusCode, ok.body).toBe(200);

    const also = await issueOnDemand(request.id, {
      vehicleId: ctx.otherVehicleId,
      driverPersonId: leftBefore,
      version: ok.json().version,
    });
    expect(also.statusCode, also.body).toBe(200);

    // Графа ФИО заполнена у обоих: фамилию печатает карточка человека, а не кадровая запись.
    const issued = (await sheetsOf(request.id)).filter((s) => s.status === 'issued');
    for (const personId of [leftAfter, leftBefore]) {
      const sheet = issued.find((s) => s.driver_person_id === personId);
      expect(sheet, `лист машиниста ${personId}`).toBeDefined();
      expect(sheet!.driver_fio).toContain('Коррекцев');
    }
  });

  /**
   * Прошлое снятой карточкой не закрывается (план `machinist-card-removal`, Р3): человек отработал
   * неделю до того, как его карточку сняли, и лист за неё выписывается — граница проходит по
   * **последнему дню документа**, а не по «числится ли он сегодня».
   */
  it('за отработанную до удаления неделю лист выписывается и на снятую карточку', async () => {
    const request = await confirm(await backdatedRequest(ctx.linearTypeId));
    const removed = await seedDriver('Снятый');
    await ctx.db.execute(sql`UPDATE persons SET deleted_at = now() WHERE id = ${removed}`);

    const issued = await issueOnDemand(request.id, {
      vehicleId: ctx.vehicleId,
      driverPersonId: removed,
      version: request.version,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const sheet = (await sheetsOf(request.id)).find((s) => s.driver_person_id === removed);
    expect(sheet?.driver_fio).toContain('Коррекцев');
  });

  /**
   * А вперёд — не выписывается (Р3, Р6): день удаления ещё рабочий, но неделя, кончающаяся позже
   * него, лист на этого человека уже не получает. Отказ называет и человека, и период — по одному
   * идентификатору поддержка искала бы обоих руками.
   */
  it('на неделю, кончающуюся после удаления, снятого машиниста рукой не назначить', async () => {
    const request = await confirm(await backdatedRequest(ctx.linearTypeId));
    const removed = await seedDriver('Снятый вперёд');
    // Карточку сняли вчера: сегодняшняя неделя кончается позже, и лист на неё уже не выписывается.
    await ctx.db.execute(
      sql`UPDATE persons SET deleted_at = now() - interval '1 day' WHERE id = ${removed}`,
    );

    const refused = await issueOnDemand(request.id, {
      vehicleId: ctx.vehicleId,
      driverPersonId: removed,
      version: request.version,
      weekOf: ctx.today,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().message).toContain('снята из справочника');
    expect(refused.json().message).toContain('Коррекцев');
  });

  /**
   * Та же карточка со стороны сверки (правка ADR 0164 от 14.09.2026). Человека здесь никто не
   * выбирает: переоформление берёт его из бумаги заявки, и отказ означал бы, что заявку с удалённым
   * машинистом нельзя ни продлить, ни сократить, ни закрыть. Бланк при этом остаётся действительным
   * — удаление мягкое, ФИО в карточке на месте.
   */
  it('сверка переоформляет бумагу и на снятую карточку машиниста', async () => {
    const request = await confirm(await backdatedRequest(ctx.plainTypeId), {
      driverPersonId: ctx.driverA,
    });
    await ctx.db.execute(sql`UPDATE persons SET deleted_at = now() WHERE id = ${ctx.driverA}`);
    try {
      const changed = await changeAssignment(request, { vehicleId: ctx.otherVehicleId });
      expect(changed.statusCode, changed.body).toBe(200);
      const issued = (await sheetsOf(request.id)).filter((s) => s.status === 'issued');
      expect(issued.length).toBeGreaterThan(0);
      for (const sheet of issued) {
        expect(sheet.driver_person_id).toBe(ctx.driverA);
        expect(sheet.driver_fio).toContain('Коррекцев');
      }
    } finally {
      // Карточка общая на весь файл: оставленная снятой, она увела бы соседние случаи.
      await ctx.db.execute(sql`UPDATE persons SET deleted_at = NULL WHERE id = ${ctx.driverA}`);
    }
  });

  /**
   * Удаление карточки перестало быть тихим (план `machinist-card-removal`, Э2). Человека, который
   * ведёт действующий заказ, справочник снимает только с подтверждением, и подтверждают конкретный
   * перечень: отпечаток чужого или устаревшего перечня дверь не принимает.
   */
  it('карточку машиниста действующего заказа снимают только подтверждением перечня', async () => {
    const machinist = await seedDriver('Занятый');
    const request = await confirm(await backdatedRequest(ctx.plainTypeId), {
      driverPersonId: machinist,
    });
    expect((await sheetsOf(request.id)).length).toBeGreaterThan(0);

    const remove = (payload?: unknown): ReturnType<typeof ctx.app.inject> =>
      ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/drivers/${machinist}`,
        headers: ctx.auth,
        ...(payload ? { payload } : {}),
      });

    // Без тела — отказ с перечнем: номер заказа назван, число листов посчитано планом.
    const asked = await remove();
    expect(asked.statusCode, asked.body).toBe(409);
    const details = asked.json().details as {
      fullName: string;
      orders: { num: number; futureSheets: number; assumedDateTo: string }[];
      totalFutureSheets: number;
      fingerprint: string;
    };
    expect(details.fullName).toContain('Коррекцев');
    expect(details.orders.length).toBe(1);
    expect(details.orders[0]!.num).toBeGreaterThan(0);
    expect(details.fingerprint).toMatch(/^[0-9a-f]{64}$/u);

    // Чужой отпечаток не проходит: подтверждали не этот перечень.
    const stale = await remove({ acknowledge: { fingerprint: 'a'.repeat(64) } });
    expect(stale.statusCode, stale.body).toBe(409);
    const stillThere = await ctx.db.execute<{ deleted: string | null }>(
      sql`SELECT deleted_at::text AS deleted FROM persons WHERE id = ${machinist}`,
    );
    expect(stillThere.rows[0]!.deleted).toBeNull();

    // Со своим — снимается, и заявка после этого продолжает жить: бумага наследует человека.
    const done = await remove({ acknowledge: { fingerprint: details.fingerprint } });
    expect(done.statusCode, done.body).toBe(204);
    const removed = await ctx.db.execute<{ deleted: string | null }>(
      sql`SELECT deleted_at::text AS deleted FROM persons WHERE id = ${machinist}`,
    );
    expect(removed.rows[0]!.deleted).not.toBeNull();

    const extended = await changeAssignment(request, { vehicleId: ctx.otherVehicleId });
    expect(extended.statusCode, extended.body).toBe(200);
  });

  /** Карточка без единой связи снимается как раньше — одним нажатием и молча. */
  it('карточка без заказов снимается без подтверждения', async () => {
    const idle = await seedDriver('Свободный');
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/drivers/${idle}`,
      headers: ctx.auth,
    });
    expect(removed.statusCode, removed.body).toBe(204);
  });

  /** Пустая коррекция отклоняется (Р31): блок `correction` не должен становиться отмычкой. */
  it('коррекция, которой нечего править задним числом, не проходит', async () => {
    // Заказ на сегодня: отработанных недель у него нет вовсе, подписей тоже.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-requests',
      headers: ctx.auth,
      payload: {
        requestType: 'special_equipment',
        objectId: ctx.objectId,
        vehicleTypeId: ctx.plainTypeId,
        dateFrom: ctx.today,
        dateTo: ctx.today,
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    createdRequests.push(created.json().id as string);
    const approved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${created.json().id}/approval`,
      headers: ctx.auth,
      payload: { approved: true, version: created.json().version },
    });
    const request = await confirmToday(
      { id: created.json().id as string, version: approved.json().version },
      ctx.driverA,
    );

    const res = await changeAssignment(request, {
      vehicleId: ctx.otherVehicleId,
      correction: { operationId: crypto.randomUUID(), reason: 'Править нечего' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('ничего не правит задним числом');
  });
});

/** Перевод в работу заказа на сегодня: срок здесь свой, а не общий с задним числом. */
async function confirmToday(
  request: { id: string; version: number },
  driverPersonId: string,
): Promise<{ id: string; version: number }> {
  const res = await ctx.app.inject({
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
        driverPersonId,
      },
      schedule: { requestType: 'special_equipment', dateFrom: ctx.today, dateTo: ctx.today },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: request.id, version: res.json().version };
}
