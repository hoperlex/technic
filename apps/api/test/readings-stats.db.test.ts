import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type ReadingInput,
  type ReportItemSubmit,
  type VehicleReadingDayState,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as StatsNs from '../src/services/readings-stats';

/**
 * Показания глазами гаража и сводки на живой схеме (ADR 0103, Р26–Р28): состояние дня машины,
 * журнал и итог по парку за период.
 *
 * Зачем база. Читающий модуль (`services/readings-stats.ts`) не содержит почти ни одного
 * ветвления — он состоит из SQL: коррелированные подзапросы решений по расхождениям, `bool_or` по
 * группе строк ожидания, `CASE` по виду источника, два алиаса таблицы показаний под две цепочки
 * счётчиков. Ошибка здесь живёт не в условии, а в имени колонки, в приведении даты и в том, что
 * `leftJoin` отдаёт NULL там, где ждали `false`. Проверить это на подменах невозможно в принципе.
 *
 * Второе — и главное: колонка гаража и сводка обязаны отвечать про **тот же** день, который
 * собрал модуль показаний. Поэтому данные заводятся его сервисом (`openReport`/`submitReport`/
 * `acceptReport`), а не вставками в таблицы: расходись эти два понимания «сдано» — тест на
 * вставках зеленел бы ровно в тот момент, когда портал начал бы врать.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/readings-stats.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-readings-stats-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/**
 * Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам».
 * Метка **своя на прогон**: файл живёт в общем дереве, и второй его экземпляр рядом (полный
 * `vitest run` разработчика) с общей меткой унёс бы машины из-под живого теста — они исчезали бы
 * между двумя соседними утверждениями, и разбирать это пришлось бы как ошибку в SQL.
 */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: сводка показаний';
const MARK = `${MARK_PREFIX} ${randomUUID().slice(0, 8)}`;
/**
 * Номера бланков берутся из заведомо свободного диапазона: серия общая с остальной базой, а
 * `next_number` тест не двигает — свои листы он заводит прямой вставкой и сам за собой убирает.
 * Блок свой на прогон по той же причине, что и метка: за один номер два экземпляра файла дрались
 * бы отказом уникальности.
 */
const WAYBILL_NUMBER_BASE = 910_000_000 + Math.floor(Math.random() * 900) * 1_000;

/**
 * Дни отсчитываются от «сегодня минус двадцать»: у персонала окно записи тридцать дней
 * (`STAFF_SUBMIT_PAST_DAYS`), и весь отрезок сценариев обязан уместиться внутри него — иначе
 * первый же `openReport` ответит отказом окна, а не тем, ради чего его звали.
 *
 * От чужих данных отрезок не отделяет и не должен: сводка отвечает про весь парк, и разделение
 * идёт по машинам — они здесь свои, а строки сводки тест ищет по идентификатору машины.
 */
const DAY_OFFSET = -20;

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  stats: typeof StatsNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
  base: string;
}

let ctx: Ctx;
let waybillNo = 0;

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

/**
 * Уборка одного прогона. Порядок обратный ссылкам: отчёты (за ними каскадом строки, показания,
 * решения по расхождениям и обе истории), затем документы, заявки, машины и люди.
 */
async function purge(db: typeof AppDb, mark: string): Promise<void> {
  const persons = sql`(SELECT id FROM persons WHERE comment = ${mark})`;
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM waybills WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_routes WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${mark}`);
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${mark}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${mark}`);
}

/**
 * Хвосты прошлых прогонов — перед началом: упавший прогон оставляет отчёты, а ряд счётчиков
 * следующего они сдвинули бы молча.
 *
 * Убираются только заведомо мёртвые (старше часа), а не всё по префиксу: прогон, идущий рядом
 * прямо сейчас, — это живой тест, и унести его данные значит уронить его в случайном месте
 * сообщением, по которому причину не найти.
 */
async function purgeStale(db: typeof AppDb): Promise<void> {
  const marks = await db.execute<{ mark: string }>(sql`
    SELECT DISTINCT mark FROM (
      SELECT comment AS mark, created_at FROM persons WHERE comment LIKE ${`${MARK_PREFIX}%`}
      UNION ALL
      SELECT note AS mark, created_at FROM vehicles WHERE note LIKE ${`${MARK_PREFIX}%`}
    ) t WHERE created_at < now() - interval '1 hour'`);
  for (const row of marks.rows) await purge(db, row.mark);
}

async function seedAdmin(db: typeof AppDb, schema: typeof SchemaNs): Promise<string> {
  const { hashPassword } = await import('../src/auth/password');
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, ADMIN_EMAIL));
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: 'Сводочный',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** День отрезка: смещение от базы, чтобы дни сценариев не наезжали друг на друга. */
function day(offset: number): string {
  return shiftDateKey(ctx.base, offset);
}

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Сводкин', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** Своя машина: у собственной описание пустое и цен нет — этого требует `vehicles_own_fields_check`. */
async function newVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({ ownership: 'own', vehicleTypeId: ctx.typeId, status: 'active', note: MARK })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

/** Заявка-пустышка: рейсу-перегону она основание, недельному листу — источник (обе колонки NOT NULL). */
async function newRequest(): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.typeId,
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  return request!.id;
}

/**
 * Рейс-перегон: он виден в задании всегда, тогда как грузовой пропадает, оставшись без живых
 * заявок состава, — а тесту нужен источник, а не проверка отбора заданий.
 */
async function newRoute(vehicleId: string, date: string, personId: string): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: date,
      purpose: 'delivery',
      sourceRequestId: await newRequest(),
      moveFrom: 'База',
      moveTo: 'Объект',
      driverPersonId: personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  return route!.id;
}

/** Действующий недельный лист ЭСМ-2, накрывающий день: неделя целиком, от понедельника. */
async function newEsm2(vehicleId: string, personId: string, date: string): Promise<string> {
  waybillNo += 1;
  const from = weekStartKey(date);
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + waybillNo,
      formCode: 'esm2',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId,
      driverPersonId: personId,
      issuedForDate: from,
      sourceRequestId: await newRequest(),
      periodFrom: from,
      periodTo: shiftDateKey(from, 6),
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/** Числа показания: поля с умолчаниями схема заполняет сама, а сервис зовётся уже разобранным телом. */
function values(input: Partial<Omit<ReadingInput & { kind: 'values' }, 'kind'>>): ReadingInput {
  return {
    kind: 'values',
    odometerKm: null,
    engineHours: null,
    fuelFilledLiters: null,
    comment: '',
    ...input,
  } as ReadingInput;
}

function line(itemId: string, reading: ReadingInput, confirm = false): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: confirm,
    confirmEngineHoursAnomaly: confirm,
  };
}

/**
 * Весь ввод идёт «за водителя» (`mode: 'staff'`, Р26): половина дней отрезка старше водительского
 * окна записи (Р11), и сам водитель их не закрыл бы. Режим один на все сценарии намеренно — иначе
 * они отличались бы ещё и способом ввода. На состояние дня и на сводку он не влияет вовсе: режим
 * виден только в `source` показания.
 */
const STAFF = { mode: 'staff' as const };

/** Открыть день и сдать по нему числа одним движением: сценариев в файле много, шагов у них два. */
async function report(personId: string, date: string) {
  return ctx.service.openReport(personId, date, ctx.adminId, STAFF);
}

async function submit(
  personId: string,
  date: string,
  items: ReportItemSubmit[],
  reason = '',
): Promise<Awaited<ReturnType<typeof ReadingsNs.submitReport>>> {
  const current = await ctx.service.loadReport(personId, date);
  return ctx.service.submitReport(
    personId,
    date,
    { version: current!.version, items, reason },
    ctx.adminId,
    null,
    { ...STAFF, reason },
  );
}

/** Состояние дня одной машины — тем же вызовом, каким его добирает страница гаража. */
async function stateOf(date: string, vehicleId: string): Promise<VehicleReadingDayState | null> {
  const states = await ctx.stats.loadVehicleReadingStates(date, [vehicleId]);
  return states.get(vehicleId) ?? null;
}

/** Строка сводки своей машины: сводка отвечает про весь парк, и чужие строки в ней законны. */
async function statsOf(vehicleId: string, from: string, to: string) {
  const rows = await ctx.stats.loadFleetReadingStats(from, to);
  return rows.find((row) => row.vehicleId === vehicleId) ?? null;
}

describe.skipIf(!DB_URL)('показания: состояние дня, журнал и сводка', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/readings');
    const stats = await import('../src/services/readings-stats');
    await purgeStale(db);

    const adminId = await seedAdmin(db, schema);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const types = await db.execute<{ id: string }>(
      sql`SELECT vt.id FROM vehicle_types vt
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE vk.code = 'freight_transport' ORDER BY vt.code LIMIT 1`,
    );
    const organizations = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    const series = await db.execute<{ id: string }>(
      sql`SELECT id FROM waybill_series ORDER BY code LIMIT 1`,
    );
    if (!objects.rows[0] || !types.rows[0] || !organizations.rows[0] || !series.rows[0]) {
      throw new Error('В базе нет объекта, типа ТС, организации или серии бланков');
    }

    ctx = {
      db,
      schema,
      service,
      stats,
      closeDb,
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: series.rows[0].id,
      base: shiftDateKey(moscowDateKeyOf(new Date()), DAY_OFFSET),
    };
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await purge(ctx.db, MARK);
      await ctx.closeDb();
    }
  });

  /**
   * Состояние дня (Р27). Считается по строкам ожидания, а не по текущему набору источников: только
   * так колонка отвечает однозначно и при двух сменах, и после правки задания.
   */
  describe('состояние дня машины', () => {
    it('машина без строк ожидания состояния не получает вовсе, со строкой без чисел — «нет»', async () => {
      const person = await newPerson('Пустой');
      const vehicle = await newVehicle();
      const idle = await newVehicle();
      const date = day(0);
      await newRoute(vehicle, date, person);

      const opened = await report(person, date);
      expect(opened.items).toHaveLength(1);

      const states = await ctx.stats.loadVehicleReadingStates(date, [vehicle, idle]);
      // «Нет» и «нечего ждать» — разные ответы: у машины без задания колонка пустая, и красить её
      // зелёным или красным одинаково неверно.
      expect(states.get(vehicle)).toBe('none');
      expect(states.has(idle)).toBe(false);
    });

    it('часть строк закрыта — «частично», все закрыты — «сданы», в том числе видом `no_data`', async () => {
      const person = await newPerson('Двусменный');
      const vehicle = await newVehicle();
      const date = day(1);
      await newEsm2(vehicle, person, date);
      await newRoute(vehicle, date, person);

      const opened = await report(person, date);
      expect(opened.items).toHaveLength(2);
      const [first, second] = opened.items;

      await submit(person, date, [line(first!.id, values({ odometerKm: 100 }))]);
      expect(await stateOf(date, vehicle)).toBe('partial');

      // `no_data` закрывает строку наравне с числами: «счётчик не работает» — это ответ, а не
      // пропуск, и ждать по такой смене больше нечего.
      await submit(person, date, [
        line(second!.id, { kind: 'no_data', noDataReason: 'счётчик разбит', comment: '' }),
      ]);
      expect(await stateOf(date, vehicle)).toBe('reported');
    });

    it('неподтверждённая аномалия старше «сданы»: закрытый день красится расхождением', async () => {
      const person = await newPerson('Скачков');
      const vehicle = await newVehicle();
      const [first, second] = [day(2), day(3)];
      await newRoute(vehicle, first, person);
      await newRoute(vehicle, second, person);

      const start = await report(person, first);
      await submit(person, first, [line(start.items[0]!.id, values({ odometerKm: 1000 }))]);
      // Первая точка ряда предшественника не имеет, и отклонением это не является (Р20).
      expect(await stateOf(first, vehicle)).toBe('reported');

      const jump = await report(person, second);
      const sent = await submit(person, second, [
        line(jump.items[0]!.id, values({ odometerKm: 5000 })),
      ]);
      expect(sent.items[0]!.reading!.odometerAnomaly).toMatchObject({
        kind: 'implausible_jump',
        confirmed: false,
      });
      // Строк ожидания одна и она закрыта — по числам это «сданы». Колонка обязана назвать
      // главное: с этим днём надо что-то делать, и разбирать его пойдут по красному.
      expect(await stateOf(second, vehicle)).toBe('discrepancy');

      // Подтверждение — единственное, что здесь меняется: числа те же, и причина не нужна.
      await submit(person, second, [line(jump.items[0]!.id, values({ odometerKm: 5000 }), true)]);
      expect(await stateOf(second, vehicle)).toBe('reported');
    });

    it('неразобранное расхождение с источником красит день, хотя все строки закрыты', async () => {
      const person = await newPerson('Переназначенный');
      const other = await newPerson('Сменщик');
      const vehicle = await newVehicle();
      const date = day(4);
      const routeId = await newRoute(vehicle, date, person);

      const opened = await report(person, date);
      await submit(person, date, [line(opened.items[0]!.id, values({ odometerKm: 700 }))]);
      expect(await stateOf(date, vehicle)).toBe('reported');

      // Диспетчер переназначил рейс уже после того, как день сдали. Снимок строки ожидания при
      // этом не меняется — в том и смысл снимка, — а вот день обязан покраснеть: сдал показания
      // не тот, кто по нынешнему заданию ездил.
      await ctx.db
        .update(ctx.schema.vehicleRoutes)
        .set({ driverPersonId: other })
        .where(eq(ctx.schema.vehicleRoutes.id, routeId));
      expect(await stateOf(date, vehicle)).toBe('discrepancy');
    });

    it('правка после приёма — «на повторный приём»', async () => {
      const person = await newPerson('Принятый');
      const vehicle = await newVehicle();
      const date = day(5);
      await newRoute(vehicle, date, person);

      const opened = await report(person, date);
      const sent = await submit(person, date, [
        line(opened.items[0]!.id, values({ odometerKm: 200 })),
      ]);
      expect(sent.canAccept).toBe(true);
      const accepted = await ctx.service.acceptReport(sent.id, sent.version, ctx.adminId);
      expect(accepted.state).toBe('accepted');
      // Принятый день от сданного колонка не отличает: приёмка — состояние отчёта, а не показаний.
      expect(await stateOf(date, vehicle)).toBe('reported');

      // Персонал правит уже принятое число — с причиной (Р19). Отчёт уходит в `needs_reacceptance`,
      // и колонка обязана позвать принять его заново, иначе правка осталась бы незамеченной.
      const fixed = await submit(
        person,
        date,
        [line(opened.items[0]!.id, values({ odometerKm: 210 }))],
        'опечатка в одометре',
      );
      expect(fixed.state).toBe('needs_reacceptance');
      expect(await stateOf(date, vehicle)).toBe('needs_reacceptance');
    });

    it('расхождение старше повторного приёма: правка принятого дня сломала ряд', async () => {
      const person = await newPerson('Старшинов');
      const vehicle = await newVehicle();
      const [first, second] = [day(17), day(18)];

      for (const [date, km] of [
        [first, 1000],
        [second, 1100],
      ] as const) {
        await newRoute(vehicle, date, person);
        const opened = await report(person, date);
        const sent = await submit(person, date, [
          line(opened.items[0]!.id, values({ odometerKm: km })),
        ]);
        await ctx.service.acceptReport(sent.id, sent.version, ctx.adminId);
      }
      expect(await stateOf(second, vehicle)).toBe('reported');

      // Персонал правит принятое число и промахивается разрядом. Состояний у дня становится два
      // сразу — и «правили после приёма», и «прирост неправдоподобен», — а колонка одна, и назвать
      // она обязана то, с чем надо что-то делать раньше: повторно принять день с заведомо неверным
      // числом всё равно не дадут (Р22).
      const second2 = await ctx.service.loadReport(person, second);
      const broken = await submit(
        person,
        second,
        [line(second2!.items[0]!.id, values({ odometerKm: 9000 }))],
        'промах разрядом',
      );
      expect(broken.state).toBe('needs_reacceptance');
      expect(broken.items[0]!.reading!.odometerAnomaly).toMatchObject({ confirmed: false });
      expect(await stateOf(second, vehicle)).toBe('discrepancy');
    });

    it('аннулированный отчёт не считается ни колонкой, ни сводкой', async () => {
      const person = await newPerson('Аннулиров');
      const vehicle = await newVehicle();
      const date = day(6);
      await newRoute(vehicle, date, person);

      const opened = await report(person, date);
      await submit(person, date, [
        line(opened.items[0]!.id, values({ odometerKm: 300, fuelFilledLiters: 40 })),
      ]);
      expect(await stateOf(date, vehicle)).toBe('reported');
      expect(await statsOf(vehicle, date, date)).toMatchObject({ fuelFilledLiters: 40 });

      // Состояние ставится прямой правкой шапки: через сервис в `voided` уходит **опустевший**
      // отчёт — перенос уносит строки вместе с показаниями, и они считаются уже в целевом дне.
      // Проверяется же здесь ровно отбор по состоянию: без него аннулированный отчёт с уцелевшими
      // строками (а он законен, `driver_daily_reports_state_check` его пропускает) добавлял бы
      // машине и цвет, и пробег.
      await ctx.db
        .update(ctx.schema.driverDailyReports)
        .set({ state: 'voided' })
        .where(eq(ctx.schema.driverDailyReports.id, opened.id));

      expect(await stateOf(date, vehicle)).toBeNull();
      expect(await statsOf(vehicle, date, date)).toBeNull();
    });
  });

  /**
   * Сводка и журнал (Р27, Р28). Пробег и наработка — суммы разностей соседних снимков по готовой
   * цепочке; заправленное топливо — сумма литров, и ничего производного рядом с ней.
   */
  describe('сводка по парку и журнал машины', () => {
    /** Машина с рядом на три дня: её же читает журнал — цепочка у обоих одна. */
    const chain: { person: string; vehicle: string; days: string[] } = {
      person: '',
      vehicle: '',
      days: [],
    };

    it('пробег и наработка — суммы разностей, и пара считается только целиком внутри периода', async () => {
      chain.person = await newPerson('Цепочкин');
      chain.vehicle = await newVehicle();
      chain.days = [day(7), day(8), day(9)];
      const [odometer, hours, fuel] = [
        [1000, 1150, 1400],
        [10, 15, 22.5],
        [50, null, 30],
      ] as const;

      for (const [i, date] of chain.days.entries()) {
        await newRoute(chain.vehicle, date, chain.person);
        const opened = await report(chain.person, date);
        await submit(chain.person, date, [
          line(
            opened.items[0]!.id,
            values({
              odometerKm: odometer[i]!,
              engineHours: hours[i]!,
              fuelFilledLiters: fuel[i] ?? null,
            }),
          ),
        ]);
      }

      const whole = await statsOf(chain.vehicle, chain.days[0]!, chain.days[2]!);
      // 150 + 250 и 5 + 7,5: считается работа между снимками, а не сами снимки. Литры — простая
      // сумма: они не разность и от цепочки не зависят вовсе.
      expect(whole).toMatchObject({
        distanceKm: 400,
        engineHours: 12.5,
        fuelFilledLiters: 80,
        gaps: 0,
      });

      const tail = await statsOf(chain.vehicle, chain.days[1]!, chain.days[2]!);
      // У первого снимка периода предшественник остался за границей, и его разность отвечала бы
      // за работу, сделанную до начала периода: в сумму идёт только пара, обе точки которой внутри.
      expect(tail).toMatchObject({ distanceKm: 250, engineHours: 7.5, fuelFilledLiters: 30 });
    });

    it('сброс счётчика рвёт ряд: на разрыве прочерк, а не ноль, и ряд продолжается после него', async () => {
      const person = await newPerson('Сбросов');
      const vehicle = await newVehicle();
      const [first, second, third] = [day(10), day(11), day(12)];

      for (const [date, km] of [
        [first, 5000],
        [second, 10],
      ] as const) {
        await newRoute(vehicle, date, person);
        const opened = await report(person, date);
        await submit(person, date, [line(opened.items[0]!.id, values({ odometerKm: km }))]);
      }

      const broken = await statsOf(vehicle, first, second);
      // Единственная пара периода — со сброшенным счётчиком, и в расчёт она не идёт. Ноль здесь
      // означал бы «машина стояла», тогда как известно ровно обратное: она ездила, а сколько —
      // неизвестно. Число разрывов рядом и объясняет прочерк.
      expect(broken).toMatchObject({ distanceKm: null, gaps: 1 });

      await newRoute(vehicle, third, person);
      const resumed = await report(person, third);
      await submit(person, third, [line(resumed.items[0]!.id, values({ odometerKm: 300 }))]);

      const after = await statsOf(vehicle, first, third);
      // Разрыв уносит одну пару, а не весь ряд: следующая разность (300 − 10) считается как ни в
      // чём не бывало, и разрыв остаётся один.
      expect(after).toMatchObject({ distanceKm: 290, gaps: 1 });
    });

    it('пропущенная смена пару не рвёт: разность накрывает пропуск целиком', async () => {
      const person = await newPerson('Пропусков');
      const vehicle = await newVehicle();
      const days = [day(14), day(15), day(16)];
      const readings: ReadingInput[] = [
        values({ odometerKm: 1000 }),
        { kind: 'no_data', noDataReason: 'счётчик разбит', comment: '' },
        values({ odometerKm: 1400 }),
      ];

      for (const [i, date] of days.entries()) {
        await newRoute(vehicle, date, person);
        const opened = await report(person, date);
        await submit(person, date, [line(opened.items[0]!.id, readings[i]!)]);
      }

      // Предшественником последней строки цепочка назначает не вчерашний пропуск, а последний
      // снимок с числом, — и разность накрывает оба дня. Машина эти километры проехала, и терять
      // их значило бы занизить пробег периода; чего по ним не известно — распределения по дням, и
      // об этом говорит счётчик разрывов рядом. Со сбросом счётчика (тест выше) наоборот: там
      // разность не неизвестна, а заведомо неверна, и в сумму не идёт вовсе.
      expect(await statsOf(vehicle, days[0]!, days[2]!)).toMatchObject({
        distanceKm: 400,
        gaps: 1,
      });
    });

    it('в сводке есть заправленное топливо и нет ни одного производного показателя', async () => {
      const row = await statsOf(chain.vehicle, chain.days[0]!, chain.days[2]!);
      expect(row).not.toBeNull();
      // Состав строки перечислен целиком: «на 100 км» и «на моточас» портал не считает (Р28), и
      // отсутствие таких колонок — утверждение, а не умолчание. Цифра, поделённая на пробег,
      // читалась бы как расход независимо от подписи, а фактический расход требует остатков в
      // баке, которых портал не хранит.
      expect(Object.keys(row!).sort()).toEqual([
        'distanceKm',
        'engineHours',
        'fuelFilledLiters',
        'gaps',
        'vehicleId',
        'vehicleLabel',
      ]);

      const sheet = ctx.stats.readingStatsSheet([row!], '2026-08-01 – 2026-08-31');
      const header = sheet.rows[0]!;
      expect(header).toEqual([
        'Техника',
        'Пробег, км',
        'Наработка, м/ч',
        'Заправлено топлива, л',
        'Разрывов ряда',
      ]);
      // Выгрузку читают рядом с порталом: лишняя колонка в ней завела бы тот самый расход, но уже
      // вне контроля портала — в чужой книге с формулами.
      expect(header.join(' ')).not.toMatch(/100|расход/iu);
      expect(sheet.rows[1]).toEqual([row!.vehicleLabel, '400', '12,5', '80,0', '0']);
    });

    it('в выгрузке прочерк остаётся прочерком, а не нулём', async () => {
      const sheet = ctx.stats.readingStatsSheet(
        [
          {
            vehicleId: 'x',
            vehicleLabel: 'Машина',
            distanceKm: null,
            engineHours: null,
            fuelFilledLiters: 0,
            gaps: 2,
          },
        ],
        'период',
      );
      expect(sheet.rows[1]).toEqual(['Машина', '—', '—', '0,0', '2']);
    });

    it('журнал показывает каждую смену: разности по своей цепочке и строку без чисел', async () => {
      const journal = await ctx.stats.loadVehicleReadingJournal(
        chain.vehicle,
        chain.days[0]!,
        chain.days[2]!,
      );
      expect(journal!.truncated).toBe(false);
      // Свежее сверху: журнал открывают вопросом «что сдали вчера», а не «с чего всё началось».
      expect(journal!.items.map((i) => i.reportDate)).toEqual([...chain.days].reverse());
      expect(journal!.items.every((i) => i.sourceKind === 'route')).toBe(true);
      expect(journal!.items.every((i) => i.sourceLabel.startsWith('Р-'))).toBe(true);

      const [newest, , oldest] = journal!.items;
      expect(newest!.reading).toMatchObject({ odometerDelta: 250, engineHoursDelta: 7.5 });
      // У первой строки ряда предшественника нет, и прочерк здесь честнее нуля.
      expect(oldest!.reading).toMatchObject({ odometerDelta: null, engineHoursDelta: null });
      // История правок ведётся с самого показания: без неё «кто поменял чужое число» осталось бы
      // вопросом без ответа (Р19).
      expect(oldest!.edits.map((e) => e.event)).toEqual(['created']);

      // Строка без показания из журнала не выпадает: «смена была, цифр нет» и есть то, ради чего
      // журнал открывают.
      const person = await newPerson('Несдавший');
      const vehicle = await newVehicle();
      const date = day(13);
      await newRoute(vehicle, date, person);
      await report(person, date);

      const empty = await ctx.stats.loadVehicleReadingJournal(vehicle, date, date);
      expect(empty!.items).toHaveLength(1);
      expect(empty!.items[0]!.reading).toBeNull();
      expect(empty!.items[0]!.files).toEqual([]);
      expect(empty!.items[0]!.edits).toEqual([]);
    });
  });
});
