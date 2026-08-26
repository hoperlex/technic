import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  trailerTitle,
  type HitchTrailerResultDto,
  type UpdateVehicleTypeResult,
  type VehicleTrailerDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { pgErrorOf } from '../src/lib/pg-error';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Реестр прицепов на живой схеме (план `docs/vehicle-trailers-plan.md`, §12 «Шаг 2»).
 *
 * ЗАЧЕМ БАЗА. Всё ценное в этом модуле — свойство пары «схема + транзакция», и в коде его не
 * видно. Уникальность госномера считается по генерируемому столбцу и только среди живых строк;
 * «слот занят один раз» — частичный уникальный индекс; переназначение занятого слота — две правки
 * в одной транзакции, порядок которых упирается в тот же индекс; а встречная перестановка вообще
 * не существует в одном соединении. Контрактный тест ничего из этого не увидит: он проверяет
 * форму, а ломается здесь база.
 *
 * ЧЕГО ФАЙЛ НЕ ПРОВЕРЯЕТ. Данных миграции `0209` — шести полуприцепов со сканов: их предмет —
 * конкретная боевая база, и на пустом деве такая проверка подтверждала бы саму себя (§12).
 * Ничего из накопленного в базе файл не считает: собственные строки помечены и убираются, а
 * «в реестре ровно N прицепов» не спрашивается нигде — шесть строк `0209` лежат здесь же.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_trailers_probe \
 *     npx vitest run --maxWorkers=1 test/vehicle-trailers.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Своя метка на прогон: файл переживает повторный запуск на той же базе, а уборка добирает хвосты
 * прежних падений по общему префиксу.
 *
 * Префикс латинский и начинается на `ZZ` не для красоты: госномера портала пишут кириллицей, и
 * буквы `Z` в разрешённом наборе нет вовсе. Значит `LIKE 'ZZTRL%'` не заденет ни одной настоящей
 * записи — ни в реестре прицепов, ни в технике, — как бы её ни завели соседи по базе.
 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const MARK = 'ZZTRL';
/** Метка техники этого файла: арендная машина госномера не имеет вовсе, и метить её нечем больше. */
const VEHICLE_MARK = `${MARK}-TEST`;
const PASSWORD = 'db-test-password-123';

interface TestUser {
  id: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Полный доступ: заводит, привязывает, восстанавливает и сносит насовсем. */
  admin: TestUser;
  /**
   * Ведёт справочники и не работает с архивом: `directories.write` у него есть, а
   * `archive.restore` и `records.purge` — нет. Он и проверяет два сторожа архива.
   */
  keeper: TestUser;
  /** Тип с бланком 4-П: у него графы прицепа есть. */
  tractorTypeId: string;
  /** Тип с бланком «форма № 3»: граф прицепа нет вовсе (ADR 0071). */
  carTypeId: string;
  /** Арендодатель для предложения аренды — им проверяется отказ «это не машина парка». */
  lessorId: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в этом сценарии не участвует, но конфиг обязателен — заглушки заведомо нерабочие.
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

/** Свой адрес на каждый вход: попытки ограничены по IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Учётка нужной роли: заводится строкой, входит настоящим маршрутом — токен нужен живой. */
async function makeUser(role: 'admin' | 'manager'): Promise<TestUser> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');
  const email = `db-trailers-${role}-${RUN}@example.invalid`;
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: role === 'admin' ? 'Администратор' : 'Справочники',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    })
    .returning({ id: schema.users.id });
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const body = login.json() as { accessToken: string };
  return { id: created!.id, auth: { authorization: `Bearer ${body.accessToken}` } };
}

/** Счётчик реквизитов: каждый прицеп и каждая машина получают свой номер в пределах прогона. */
let serial = 0;
function nextTag(): string {
  serial += 1;
  return `${MARK}${RUN}${serial.toString().padStart(2, '0')}`;
}

interface VehicleOpts {
  typeId?: string;
  ownership?: 'own' | 'rental';
  status?: 'active' | 'inactive' | 'maintenance' | 'retired';
  deleted?: boolean;
}

/**
 * Машина строкой, а не маршрутом: файл проверяет прицепы, и полный путь заведения техники со всеми
 * её ветками принадлежности здесь ничего не добавил бы. Метка `source_name` — единственное, чем
 * помечается **арендное** предложение: госномера у него нет по устройству схемы.
 */
async function makeVehicle(opts: VehicleOpts = {}): Promise<string> {
  const typeId = opts.typeId ?? ctx.tractorTypeId;
  const deleted = opts.deleted ? sql`now()` : null;
  if (opts.ownership === 'rental') {
    const rows = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicles
        (ownership, vehicle_type_id, lessor_id, lessor_type, lessor_is_active,
         description, price_per_hour, status, source_name, deleted_at)
      VALUES ('rental', ${typeId}, ${ctx.lessorId}, 'vehicle_lessor', true,
              ${`Предложение аренды ${nextTag()}`}, 2500, ${opts.status ?? 'active'},
              ${VEHICLE_MARK}, ${deleted})
      RETURNING id`);
    return rows.rows[0]!.id;
  }
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicles
      (ownership, vehicle_type_id, registration_number, status, source_name, deleted_at)
    VALUES ('own', ${typeId}, ${nextTag()}, ${opts.status ?? 'active'}, ${VEHICLE_MARK}, ${deleted})
    RETURNING id`);
  return rows.rows[0]!.id;
}

/**
 * Свой тип техники на случай, а не общий из миграций: проверка ниже **переводит тип на форму № 3**,
 * и сделать это с `tractor_trailers` значило бы оставить всей базе — и соседним db-тестам — легковой
 * бланк у тягачей, если прогон упадёт на середине.
 *
 * Код латинский строчный (`vehicle_types_code_format_check`) и с той же меткой `zztrl`, что и
 * госномера: уборка сносит типы по ней же.
 */
async function makeVehicleType(): Promise<string> {
  const kind = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM vehicle_kinds WHERE is_active ORDER BY id LIMIT 1`,
  );
  const code = nextTag().toLowerCase();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.admin.auth,
    payload: {
      kindId: kind.rows[0]!.id,
      code,
      name: `Тип прицепного теста ${code}`,
      // Бланк назван явно, хотя он же и умолчание: обе проверки ниже начинаются с «у типа графы
      // прицепа есть», и молчаливое умолчание пришлось бы перечитывать в контрактах.
      waybillFormCode: '4p',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

interface TrailerOpts {
  registrationNumber?: string;
  model?: string;
  status?: 'active' | 'inactive' | 'maintenance' | 'retired';
}

/** Прицеп — настоящей ручкой: заведение и есть один из проверяемых путей. */
async function makeTrailer(opts: TrailerOpts = {}): Promise<VehicleTrailerDto> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-trailers',
    headers: ctx.admin.auth,
    payload: {
      kind: 'semi_trailer',
      model: opts.model ?? 'ШМИТЦ SPR-24',
      registrationNumber: opts.registrationNumber ?? nextTag(),
      status: opts.status ?? 'active',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as VehicleTrailerDto;
}

function hitch(
  trailerId: string,
  vehicleId: string,
  position: 1 | 2,
  user: TestUser = ctx.admin,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-trailers/${trailerId}/hitch`,
    headers: user.auth,
    payload: { vehicleId, position },
  });
}

async function getTrailer(id: string): Promise<VehicleTrailerDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-trailers/${id}`,
    headers: ctx.admin.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as VehicleTrailerDto;
}

/**
 * Нарушение именно этого ограничения — и проверяется оно по коду ошибки, а не по её тексту.
 * Drizzle заворачивает ошибку драйвера в свою, и на верхнем объекте от Postgres не остаётся
 * ничего, кроме «Failed query»: сверка по сообщению зеленела бы на любом другом отказе базы.
 */
async function expectConstraint(run: () => Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(pgErrorOf(caught)?.constraint, `ожидалось нарушение ${constraint}`).toBe(constraint);
}

/** Где стоит прицеп — прямо из базы: показ и его соединения здесь не при чём. */
async function hitchOf(
  trailerId: string,
): Promise<{ vehicleId: string | null; position: number | null }> {
  const rows = await ctx.db.execute<{ v: string | null; p: number | null }>(sql`
    SELECT hitched_vehicle_id AS v, hitch_position AS p
      FROM vehicle_trailers WHERE id = ${trailerId}`);
  const row = rows.rows[0]!;
  return { vehicleId: row.v, position: row.p };
}

/**
 * Последняя запись журнала о типе: число снятых привязок портал говорит **только** здесь — ответ
 * ручки правки типа объявлен в контрактах голым `VehicleTypeDto`, и поля под исход операции в нём
 * нет. Значит журнал и есть то место, где обещание §7 «портал говорит, сколько сняло» проверяется.
 */
async function lastTypeAudit(
  typeId: string,
): Promise<{ action: string; metadata: Record<string, unknown> }> {
  const rows = await ctx.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
    SELECT action, metadata FROM audit_log
     WHERE entity_type = 'vehicle_type' AND entity_id = ${typeId}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`);
  return rows.rows[0]!;
}

describe.skipIf(!DB_URL)('реестр прицепов (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();

    const tractor = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_types WHERE code = 'tractor_trailers'`,
    );
    const car = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_types WHERE code = 'passenger_cars'`,
    );
    const lessor = await db.execute<{ id: string }>(
      sql`SELECT id FROM counterparties WHERE type = 'vehicle_lessor' AND is_active ORDER BY id LIMIT 1`,
    );
    if (!tractor.rows[0] || !car.rows[0] || !lessor.rows[0]) {
      throw new Error('В базе нет справочников миграций: типы ТС или арендодатели не наполнены');
    }

    // ctx заполняется по частям: `makeUser` входит через уже собранное приложение.
    ctx = {
      app,
      db,
      closeDb,
      admin: undefined as never,
      keeper: undefined as never,
      tractorTypeId: tractor.rows[0].id,
      carTypeId: car.rows[0].id,
      lessorId: lessor.rows[0].id,
    };
    ctx.admin = await makeUser('admin');
    ctx.keeper = await makeUser('manager');
  }, 180_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Файл убирает за собой полностью: база у db-тестов общая и живёт между прогонами, а
       * прицепы с техникой видны всем соседям — оставленная привязка увела бы чужую проверку
       * «за машиной ничего не закреплено» в ложное падение.
       *
       * Метка — префиксы, а не список заведённого: прибирать надо и за упавшим прогоном, поэтому
       * взяты они шире одного прогона (`ZZTRL%`, а не `ZZTRL<RUN>%`). Латинская `Z` в госномерах
       * портала не встречается, так что чужого под эти шаблоны не попадает.
       *
       * Порядок обратен ссылкам: прицеп держит машину (`ON DELETE RESTRICT`), поэтому реестр
       * сносится первым, а техника — второй и только та, которую никто не держит: соседние
       * db-тесты берут «первую попавшуюся свою активную машину», и на нашу мог успеть лечь чужой
       * рейс или лист. Сносить чужую бумагу ради своей машины уборка не вправе.
       */
      await ctx.db.execute(
        sql`DELETE FROM vehicle_trailers WHERE registration_number LIKE 'ZZTRL%'`,
      );
      await ctx.db.execute(sql`
        DELETE FROM vehicles
         WHERE source_name = ${VEHICLE_MARK}
           AND id NOT IN (SELECT vehicle_id FROM waybills)
           AND id NOT IN (SELECT vehicle_id FROM vehicle_routes)
           AND id NOT IN (SELECT vehicle_id FROM vehicle_request_assignments)
           AND id NOT IN (SELECT hitched_vehicle_id FROM vehicle_trailers
                           WHERE hitched_vehicle_id IS NOT NULL)`);
      /*
       * Свои типы техники — после машин и только те, за которыми не осталось ни одной: ссылка
       * `vehicles.vehicle_type_id` объявлена `ON DELETE RESTRICT`, а машина этого файла могла
       * пережить уборку, если на неё успел лечь чужой рейс или лист.
       */
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
         WHERE code LIKE 'zztrl%'
           AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      /*
       * Журнал — по автору и раньше сноса учёток: `actor_user_id` при удалении учётки обнуляется,
       * а не удаляется, — и записи о привязках остались бы висеть без хозяина.
       */
      const ourUsers = sql`SELECT id FROM users WHERE email LIKE 'db-trailers-%@example.invalid'`;
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  // ── Реквизиты реестра ──

  describe('госномер', () => {
    it('уникален среди живых, а удалённый его освобождает', async () => {
      const reg = nextTag();
      const first = await makeTrailer({ registrationNumber: reg });

      // Второй с тем же номером в другом написании: уникальность считает нормализованное
      // значение, а не строку. Разойдись это правило с техникой — «вх 933277» из бланка и
      // «ВХ933277» из реестра перестали бы быть одним номером.
      const dup = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/vehicle-trailers',
        headers: ctx.admin.auth,
        payload: {
          kind: 'semi_trailer',
          model: 'КРОНА SDP27',
          registrationNumber: reg.toLowerCase().replace(/(.{4})/, '$1 '),
        },
      });
      expect(dup.statusCode, dup.body).toBe(409);

      // Уход в архив номер отпускает — тот же приём, что у техники: строка живёт дальше, но
      // занятым номер больше не считается.
      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicle-trailers/${first.id}`,
        headers: ctx.admin.auth,
      });
      expect(removed.statusCode, removed.body).toBe(200);

      const second = await makeTrailer({ registrationNumber: reg });
      expect(second.registrationNumber).toBe(reg);

      // И обратная сторона той же уникальности: восстановление отказывает, потому что номер за
      // время архива заняли. Иначе в реестре оказались бы два живых прицепа с одним номером —
      // ровно то, от чего индекс и поставлен.
      const restore = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/vehicle-trailers/${first.id}/restore`,
        headers: ctx.admin.auth,
      });
      expect(restore.statusCode, restore.body).toBe(409);
    });

    it('ищется в нормализованном виде — как госномер техники', async () => {
      const trailer = await makeTrailer();
      const query = trailer.registrationNumber.toLowerCase().replace(/(.{5})/, '$1 ');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/vehicle-trailers?search=${encodeURIComponent(query)}&pageSize=50`,
        headers: ctx.admin.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as { items: VehicleTrailerDto[] };
      // Ищется по нашему прицепу, а не по «в списке ровно один»: в реестре лежат шесть строк
      // миграции `0209` и всё, что завели соседи.
      expect(page.items.map((t) => t.id)).toContain(trailer.id);
    });
  });

  describe('ограничения таблицы', () => {
    it('половина привязки невозможна: машина без слота и слот без машины', async () => {
      // CHECK, а не проверка сервиса: пара заполняется и пустеет только целиком, и на это
      // опирается показ — «слот без машины» он не разбирает вовсе.
      const trailer = await makeTrailer();
      await expectConstraint(
        () =>
          ctx.db.execute(sql`
            UPDATE vehicle_trailers SET hitch_position = 1 WHERE id = ${trailer.id}`),
        'vehicle_trailers_hitch_pair',
      );
      const vehicle = await makeVehicle();
      await expectConstraint(
        () =>
          ctx.db.execute(sql`
            UPDATE vehicle_trailers SET hitched_vehicle_id = ${vehicle} WHERE id = ${trailer.id}`),
        'vehicle_trailers_hitch_pair',
      );
    });

    it('слот занят один раз — это индекс, а не вежливость сервиса', async () => {
      // Проверяется прямой записью: команда `hitch` занятый слот освобождает сама, и через неё
      // индекс не увидеть. А он и есть то, из-за чего команда устроена именно так.
      const vehicle = await makeVehicle();
      const a = await makeTrailer();
      const b = await makeTrailer();
      const hitchRaw = (trailerId: string): Promise<unknown> =>
        ctx.db.execute(sql`
          UPDATE vehicle_trailers
             SET hitched_vehicle_id = ${vehicle}, hitch_position = 1
           WHERE id = ${trailerId}`);
      await hitchRaw(a.id);
      await expectConstraint(() => hitchRaw(b.id), 'vehicle_trailers_hitch_slot_unique');
    });

    it('списанный и удалённый за машиной не стоят — физически', async () => {
      // Снятие привязки при списании держит сервис, а это — запрет на случай, если сервис
      // забудут: забытая привязка пережила бы списание и подставилась бы в рейс из архива.
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);
      await expectConstraint(
        () =>
          ctx.db.execute(sql`
            UPDATE vehicle_trailers SET status = 'retired' WHERE id = ${trailer.id}`),
        'vehicle_trailers_hitch_status_check',
      );
      await expectConstraint(
        () =>
          ctx.db.execute(sql`
            UPDATE vehicle_trailers SET deleted_at = now() WHERE id = ${trailer.id}`),
        'vehicle_trailers_hitch_alive_check',
      );
    });

    it('порядок масс держит база, когда правят одну графу из пары', async () => {
      // Форме второй половины пары не видно: PATCH приезжает с одной графой, и сверить её не с
      // чем. Поэтому правило продублировано ограничением — иначе односторонняя правка тихо
      // оставила бы в карточке снаряжённую массу выше технически допустимой.
      const trailer = await makeTrailer();
      await ctx.db.execute(sql`
        UPDATE vehicle_trailers SET max_mass_kg = 39000, curb_mass_kg = 6500
         WHERE id = ${trailer.id}`);
      await expectConstraint(
        () =>
          ctx.db.execute(sql`
            UPDATE vehicle_trailers SET max_mass_kg = 6000 WHERE id = ${trailer.id}`),
        'vehicle_trailers_mass_order',
      );
    });
  });

  // ── Привязка к тягачу ──

  describe('привязка', () => {
    it('прицеп стоит за одним тягачом: вторая команда переносит, а не добавляет', async () => {
      // Инвариант физический — привязка живёт одной строкой у прицепа (Р8), — и проверяется он
      // именно так: после переноса за прежней машиной не остаётся ничего.
      const x = await makeVehicle();
      const y = await makeVehicle();
      const trailer = await makeTrailer();

      expect((await hitch(trailer.id, x, 1)).statusCode).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: x, position: 1 });

      // Второй слот берётся при пустом первом намеренно: реестр такой привязке не мешает, и
      // проверка это фиксирует. Порядок слотов — правило **рейса** (CHECK
      // `vehicle_routes_trailer_order_check`), а не закрепления; про закрепление план не решает
      // ничего, и здесь записано, как оно себя ведёт сегодня.
      expect((await hitch(trailer.id, y, 2)).statusCode).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: y, position: 2 });

      const behindX = await ctx.db.execute<{ c: string }>(sql`
        SELECT count(*)::text AS c FROM vehicle_trailers WHERE hitched_vehicle_id = ${x}`);
      expect(behindX.rows[0]!.c).toBe('0');
    });

    it('две графы бланка — два прицепа за одной машиной', async () => {
      const vehicle = await makeVehicle();
      const first = await makeTrailer();
      const second = await makeTrailer();
      expect((await hitch(first.id, vehicle, 1)).statusCode).toBe(200);
      expect((await hitch(second.id, vehicle, 2)).statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/vehicle-trailers?hitchedVehicleId=${vehicle}&pageSize=50`,
        headers: ctx.admin.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as { items: VehicleTrailerDto[] };
      expect(page.items.map((t) => t.id).sort()).toEqual([first.id, second.id].sort());

      // Заодно — соединения карточки: в самой таблице лежит только ключ машины, а человеку в
      // строке нужен госномер. Возьми показ его не оттуда — колонка «за какой машиной» осталась бы
      // пустой ровно у тех прицепов, которые и стоят за машиной.
      const reg = await ctx.db.execute<{ r: string | null }>(
        sql`SELECT registration_number AS r FROM vehicles WHERE id = ${vehicle}`,
      );
      const dto = await getTrailer(first.id);
      expect(dto.hitchedVehicle?.registrationNumber).toBe(reg.rows[0]!.r);
      expect(dto.hitchPosition).toBe(1);
    });

    it('переназначение занятого слота — одна команда, и она называет вытесненного', async () => {
      // Главный случай раздела. Наивная правка полем упёрлась бы в `UNIQUE` вместо результата, а
      // «сначала отцепите» означало бы транзакцию руками, в середине которой можно застрять.
      const vehicle = await makeVehicle();
      const sitting = await makeTrailer({ model: 'КОГЕЛЬ SN24' });
      const coming = await makeTrailer({ model: 'МАЗ 938660-044' });
      expect((await hitch(sitting.id, vehicle, 1)).statusCode).toBe(200);

      const res = await hitch(coming.id, vehicle, 1);
      expect(res.statusCode, res.body).toBe(200);
      const answer = res.json() as HitchTrailerResultDto;

      // Обе строки изменились одной командой: новый стоит, прежний отцеплен.
      expect(await hitchOf(coming.id)).toEqual({ vehicleId: vehicle, position: 1 });
      expect(await hitchOf(sitting.id)).toEqual({ vehicleId: null, position: null });

      // И об этом сказано словами, а не кодом: диспетчер, занявший чужой слот, обязан узнать о
      // чужом отцеплении от портала, а не из чужой жалобы. Подпись — та же, что в таблице.
      expect(answer.notice).toBe(`Слот 1 занимал ${trailerTitle(sitting)} — он отцеплен`);
      expect(answer.trailer.hitchedVehicle?.id).toBe(vehicle);
      expect(answer.trailer.hitchPosition).toBe(1);
    });

    it('в собственный слот — не вытеснение: ответ молчит', async () => {
      // Повторное нажатие той же кнопки (две вкладки диспетчера) не должно рождать сообщение
      // «прежний прицеп отцеплен» про сам этот прицеп.
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);
      const again = await hitch(trailer.id, vehicle, 1);
      expect(again.statusCode, again.body).toBe(200);
      expect((again.json() as HitchTrailerResultDto).notice).toBe(null);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: vehicle, position: 1 });
    });

    it('отцепление уже отцепленного — не ошибка', async () => {
      // Две вкладки нажимают одну кнопку, и отказ на втором нажатии описывал бы состояние,
      // которого человек и добивался.
      const trailer = await makeTrailer();
      const vehicle = await makeVehicle();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);
      for (const _ of [1, 2]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/vehicle-trailers/${trailer.id}/unhitch`,
          headers: ctx.admin.auth,
        });
        expect(res.statusCode, res.body).toBe(200);
        expect((res.json() as VehicleTrailerDto).hitchedVehicle).toBe(null);
      }
    });
  });

  // ── Допустимость привязки (§4.2.3) ──

  describe('что можно закрепить', () => {
    it('арендная машина — не машина парка, а строка прайса', async () => {
      const rental = await makeVehicle({ ownership: 'rental' });
      const trailer = await makeTrailer();
      const res = await hitch(trailer.id, rental, 1);
      expect(res.statusCode, res.body).toBe(422);
    });

    it('удалённая машина не находится вовсе', async () => {
      const gone = await makeVehicle({ deleted: true });
      const trailer = await makeTrailer();
      const res = await hitch(trailer.id, gone, 1);
      expect(res.statusCode, res.body).toBe(400);
    });

    it('у формы № 3 граф прицепа нет — за легковым не закрепляют', async () => {
      // Правило про бланк, а не про тип: сужать до тягачей нельзя — прицеп цепляют и к бортовому
      // автомобилю, и к самосвалу. Проверяется поэтому именно легковой, у которого граф нет.
      const car = await makeVehicle({ typeId: ctx.carTypeId });
      const trailer = await makeTrailer();
      const res = await hitch(trailer.id, car, 1);
      expect(res.statusCode, res.body).toBe(422);
    });

    it('за списанной машиной закреплять нечего', async () => {
      const retired = await makeVehicle({ status: 'retired' });
      const trailer = await makeTrailer();
      const res = await hitch(trailer.id, retired, 1);
      expect(res.statusCode, res.body).toBe(422);
    });

    it('списанный прицеп за машиной не стоит', async () => {
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer({ status: 'retired' });
      const res = await hitch(trailer.id, vehicle, 1);
      expect(res.statusCode, res.body).toBe(422);
    });

    it('ремонт — не помеха ни одной из сторон', async () => {
      // Закрепление говорит, что полуприцеп физически стоит за этой машиной, а не что на ней
      // завтра поедут. Запрети портал ремонт — он запретил бы описывать то, что есть на площадке.
      const vehicle = await makeVehicle({ status: 'maintenance' });
      const trailer = await makeTrailer({ status: 'maintenance' });
      const res = await hitch(trailer.id, vehicle, 1);
      expect(res.statusCode, res.body).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: vehicle, position: 1 });
    });
  });

  // ── Снятие привязки состоянием (§4.2.3) ──

  /*
   * СТОРОНА ПРИЦЕПА ЗДЕСЬ РАБОТАЕТ, СТОРОНА МАШИНЫ — НЕТ, И ТРИ СЛУЧАЯ НИЖЕ КРАСНЫЕ.
   *
   * Таблица §4.2.3 симметрична и перечисляет четыре события: списание прицепа, его мягкое
   * удаление, списание машины и её мягкое удаление; пятой строкой — смена бланка машины на
   * «форму № 3». Первые два держит `routes/vehicle-trailers.ts` — и их проверки зелёные. Остальные
   * три принадлежат `routes/vehicles.ts`, а он о реестре прицепов не знает вовсе: во всём
   * `apps/api/src` слово `vehicleTrailers` встречается только в схеме, в сборке приложения и в
   * самом модуле прицепов.
   *
   * Случаи оставлены красными намеренно. Они описывают решение плана, а не догадку, и зазеленеют
   * ровно тогда, когда снятие появится на стороне машины: списание, мягкое удаление и смена типа
   * обязаны снимать привязки той же транзакцией и тем же порядком захвата (`withHitchLocks`) —
   * собственный порядок в `vehicles.ts` вернёт ту самую взаимоблокировку, ради которой порядок и
   * объявлен один на модуль.
   */
  describe('смена состояния снимает привязку', () => {
    it('списание прицепа снимает его привязку', async () => {
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-trailers/${trailer.id}`,
        headers: ctx.admin.auth,
        payload: { status: 'retired' },
      });
      // Снятие, а не отказ: закрепление — удобство подстановки, а не учётный факт, и держать
      // списание заложником у него не за что.
      expect(res.statusCode, res.body).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: null, position: null });
    });

    it('мягкое удаление прицепа снимает привязку, а восстановление её не возвращает', async () => {
      // Невозврат — не мелочь: пока прицеп лежал в архиве, слот мог занять другой, и «вернуть как
      // было» упёрлось бы в `UNIQUE` ровно в тот момент, когда человек меньше всего ждёт отказа.
      // Здесь слот и правда занимают — иначе проверка доказывала бы только то, что код ленив.
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicle-trailers/${trailer.id}`,
        headers: ctx.admin.auth,
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: null, position: null });

      const other = await makeTrailer();
      expect((await hitch(other.id, vehicle, 1)).statusCode).toBe(200);

      const restored = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/vehicle-trailers/${trailer.id}/restore`,
        headers: ctx.admin.auth,
      });
      expect(restored.statusCode, restored.body).toBe(200);
      expect((restored.json() as VehicleTrailerDto).hitchedVehicle).toBe(null);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: null, position: null });
      // А занявший слот остался на месте: восстановление чужой работы не отменяет.
      expect(await hitchOf(other.id)).toEqual({ vehicleId: vehicle, position: 1 });
    });

    it('списание машины снимает её привязки', async () => {
      // Симметрия сторон — решение §4.2.3, а не удобство: правило «одна сторона снимает, другая
      // держит» человеку не запомнить, а чинить он будет то, что сломалось. Без снятия за
      // списанной машиной остаётся закреплённый прицеп, которого не видно ни в одном списке
      // техники, — и он подставится в рейс, как только подстановку включат (шаг 4).
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicles/${vehicle}`,
        headers: ctx.admin.auth,
        payload: { status: 'retired' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: null, position: null });
    });

    it('мягкое удаление машины снимает её привязки', async () => {
      // Тот же случай с другой двери. Он опаснее списания: удалённая машина исчезает из списков
      // совсем, и привязка к ней становится ссылкой в никуда — карточка прицепа продолжает
      // называть тягача, которого в портале уже нет.
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicles/${vehicle}`,
        headers: ctx.admin.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: null, position: null });
    });

    it('смена бланка машины на «форму № 3» снимает её привязки', async () => {
      // Третья строка той же таблицы §4.2.3: графы, которые привязка наполняла, у формы № 3
      // исчезли — значит исчезает и она. Иначе за легковым остаётся закрепление, которое сам же
      // портал завести не даст (см. случай выше), и реестр начинает описывать невозможное.
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicles/${vehicle}`,
        headers: ctx.admin.auth,
        payload: { vehicleTypeId: ctx.carTypeId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: null, position: null });
    });
  });

  // ── Четвёртая дверь: бланк правится и у самого типа (§4.2.3) ──

  describe('смена бланка у типа', () => {
    it('перевод типа на «форму № 3» снимает привязки у всех его машин, число называет журнал', async () => {
      /*
       * Пятая строка таблицы §4.2.3 говорит про машину — «у машины сменили тип», — но то же поле
       * `waybill_form_code` правится и у самого типа. Разница не в правиле, а в размере: перевод
       * типа осиротит привязки у ВСЕХ его машин разом, и ни одна из них при этом не менялась.
       *
       * Две машины и три привязки — нарочно неравные числа: совпадай они, ошибка счёта («сколько
       * привязок» вместо «у скольких машин») зеленела бы вместе с правильным ответом.
       */
      const typeId = await makeVehicleType();
      const first = await makeVehicle({ typeId });
      const second = await makeVehicle({ typeId });
      const trailers = [await makeTrailer(), await makeTrailer(), await makeTrailer()];
      expect((await hitch(trailers[0]!.id, first, 1)).statusCode).toBe(200);
      expect((await hitch(trailers[1]!.id, first, 2)).statusCode).toBe(200);
      expect((await hitch(trailers[2]!.id, second, 1)).statusCode).toBe(200);

      // Чужая машина рядом: она другого типа, и перевод обязан пройти мимо неё. Без этой строки
      // проверка одинаково зеленела бы на «снял у типа» и на «снял у всех подряд».
      const stranger = await makeVehicle();
      const strangerTrailer = await makeTrailer();
      expect((await hitch(strangerTrailer.id, stranger, 1)).statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-types/${typeId}`,
        headers: ctx.admin.auth,
        payload: { waybillFormCode: 'leg3' },
      });
      expect(res.statusCode, res.body).toBe(200);
      const answer = res.json() as UpdateVehicleTypeResult;
      expect(answer.type.waybillFormCode).toBe('leg3');

      for (const t of trailers) {
        expect(await hitchOf(t.id)).toEqual({ vehicleId: null, position: null });
      }
      expect(await hitchOf(strangerTrailer.id)).toEqual({ vehicleId: stranger, position: 1 });

      /*
       * Числа спрашиваются в ДВУХ местах, и оба обязательны.
       *
       * В ответе — потому что им портал говорит человеку, что его правка отцепила чужие
       * полуприцепы (§7): без этого одно нажатие в справочнике молча меняет состав нескольких
       * машин. В журнале — потому что через полгода «мой полуприцеп отцепился» не объясняется
       * больше ничем.
       *
       * Числа нарочно разные (3 привязки у 2 машин): будь они равны, тест прошёл бы и при одном
       * счётчике, размноженном в два поля.
       *
       * Расхождение ответа с журналом здесь и ловится: журнал при нуле ключей не пишет вовсе, а
       * ответ отдаёт нули значением, и имена полей у них общие нарочно — одно событие не должно
       * называться в двух местах по-разному.
       */
      expect(answer.unhitchedTrailers).toBe(3);
      expect(answer.unhitchedVehicles).toBe(2);

      const record = await lastTypeAudit(typeId);
      expect(record.action).toBe('vehicle_type.waybill_form');
      expect(record.metadata.unhitchedTrailers).toBe(3);
      expect(record.metadata.unhitchedVehicles).toBe(2);
    });

    it('перевод на другой бланк привязки не трогает', async () => {
      /*
       * Обратная сторона: снимает не «правка типа», а именно перевод на форму № 3 — ту, у которой
       * граф прицепа нет. Проверяется это дорогой назад: тип, стоящий на форме № 3, переводят на
       * 4-П, и привязка обязана правку пережить.
       *
       * Форму № 3 типу ставит прямой SQL, а не ручка: пройди она порталом, привязка снялась бы
       * ровно той правкой, которую здесь и проверяют. Такая строка — то самое наследство §4.2.3:
       * привязка, легшая в базу до правила или помимо портала.
       */
      const typeId = await makeVehicleType();
      const vehicle = await makeVehicle({ typeId });
      const trailer = await makeTrailer();
      expect((await hitch(trailer.id, vehicle, 1)).statusCode).toBe(200);
      await ctx.db.execute(
        sql`UPDATE vehicle_types SET waybill_form_code = 'leg3' WHERE id = ${typeId}::uuid`,
      );

      const changed = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-types/${typeId}`,
        headers: ctx.admin.auth,
        payload: { waybillFormCode: '4p' },
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: vehicle, position: 1 });

      // И правка, бланка не касающаяся вовсе: у неё не должно быть даже записи о снятии — нули в
      // журнале рассказывали бы о событии, которого не было.
      const renamed = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-types/${typeId}`,
        headers: ctx.admin.auth,
        payload: { name: `Тип прицепного теста ${RUN} (переименован)` },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: vehicle, position: 1 });

      const record = await lastTypeAudit(typeId);
      expect(record.action).toBe('vehicle_type.update');
      expect(record.metadata.unhitchedTrailers).toBeUndefined();
      expect(record.metadata.unhitchedVehicles).toBeUndefined();
    });
  });

  // ── Права ──

  describe('права', () => {
    it('восстановление из архива закрыто `archive.restore`', async () => {
      // Ведущий справочник заводит, правит и удаляет — но архив не его работа (ADR 0021):
      // удаление могло быть осознанным решением, и отменяет его администратор.
      const trailer = await makeTrailer();
      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicle-trailers/${trailer.id}`,
        headers: ctx.keeper.auth,
      });
      expect(removed.statusCode, removed.body).toBe(200);

      const denied = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/vehicle-trailers/${trailer.id}/restore`,
        headers: ctx.keeper.auth,
      });
      expect(denied.statusCode, denied.body).toBe(403);

      const allowed = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/vehicle-trailers/${trailer.id}/restore`,
        headers: ctx.admin.auth,
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
    });

    it('закреплённый прицеп держит машину: снести её насовсем нельзя', async () => {
      // Ссылка объявлена `ON DELETE RESTRICT`, и это единственная настоящая связь прицепа с
      // остальным порталом, пока Р6 открыта: рейс и лист хранят текст-снимок, а не ключ. Отказ
      // приходит понятным 409, а не пятисоткой про внешний ключ, — за перевод отвечает общий
      // модуль вычистки. Назвать прицеп в тексте он сегодня не может: `vehicle_trailers` нет в
      // карте `REFERENCING_TABLE_LABELS`, и человек читает общее «ссылаются другие данные».
      const vehicle = await makeVehicle();
      const trailer = await makeTrailer();
      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicles/${vehicle}`,
        headers: ctx.admin.auth,
      });
      expect(removed.statusCode, removed.body).toBe(200);

      /*
       * Привязка кладётся **после** ухода машины в архив и прямым SQL, а не ручкой.
       *
       * Так эта строка только и может теперь появиться. Через двери портала — не может: цепляют
       * лишь к живой машине, а мягкое удаление и списание сами снимают привязку в той же
       * транзакции (§4.2.3). Прежняя редакция теста цепляла ручкой до удаления и ждала, что
       * привязка переживёт архив, — то есть проверяла ровно обратное решению плана; после его
       * исполнения ждать 409 стало не от чего.
       *
       * Проверка от этого не обесценилась, а сменила предмет: она о **наследстве** — строках,
       * легших в базу до правила или помимо портала (миграции, правки руками). Внешний ключ
       * `ON DELETE RESTRICT` обязан держать такую машину от вычистки и после того, как двери
       * закрыли, — иначе `purge` унесёт запись, на которую ссылается живой прицеп.
       */
      await ctx.db.execute(sql`
        UPDATE vehicle_trailers
           SET hitched_vehicle_id = ${vehicle}::uuid, hitch_position = 1
         WHERE id = ${trailer.id}::uuid`);

      const purged = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicles/${vehicle}/purge`,
        headers: ctx.admin.auth,
      });
      expect(purged.statusCode, purged.body).toBe(409);
    });

    it('удаление насовсем закрыто `records.purge` и только из архива', async () => {
      const trailer = await makeTrailer();
      const purge = (user: TestUser): ReturnType<typeof ctx.app.inject> =>
        ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/vehicle-trailers/${trailer.id}/purge`,
          headers: user.auth,
        });

      expect((await purge(ctx.keeper)).statusCode).toBe(403);
      // Живую запись насовсем не сносят и администратору: у вычистки два шага, и первый — архив.
      const live = await purge(ctx.admin);
      expect(live.statusCode, live.body).toBe(409);

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicle-trailers/${trailer.id}`,
        headers: ctx.admin.auth,
      });
      expect(removed.statusCode, removed.body).toBe(200);
      const gone = await purge(ctx.admin);
      expect(gone.statusCode, gone.body).toBe(200);
      expect(await getTrailerRowCount(trailer.id)).toBe(0);
    });
  });

  // ── Встречная перестановка (§4.2.1) ──

  it('две встречные перестановки расходятся без взаимоблокировки', async () => {
    /*
     * ПРЕДМЕТ — ПОРЯДОК ЗАХВАТА, А НЕ УДАЧА. Команда трогает до четырёх строк в двух таблицах:
     * целевой тягач, прежний тягач перемещаемого прицепа, сам прицеп и вытесняемый жилец слота.
     * Два диспетчера, меняющих полуприцепы местами, дают классическую встречную пару: «A: X→Y» и
     * одновременно «B: Y→X». Возьми команды строки в порядке своего сюжета — первая держала бы Y
     * и просила X, вторая держала бы X и просила Y, и Postgres разорвал бы одну из транзакций
     * как взаимную блокировку (`40P01`); наружу это выходит пятисоткой на кнопке.
     *
     * ПОЧЕМУ ПОВТОР. Клинч случается только при определённом переплетении шагов, и на одном
     * прогоне сломанный порядок зеленеет чаще, чем падает: транзакции нередко успевают разойтись
     * по очереди. Один прогон здесь ничего не доказывает — падение приходило бы на чужой ветке
     * раз в несколько запусков. Поэтому пара повторяется, и повторяется на новых строках: те же
     * машины во второй раз означали бы, что вторая пара застаёт мир уже переставленным.
     *
     * ЧТО ЗНАЧИТ «ИТОГ НЕПРОТИВОРЕЧИВ». Обе команды доходят до конца, и в каком бы порядке они
     * ни легли, результат один: прицепы поменялись местами. Кто именно вытеснил соседа — зависит
     * от очереди, поэтому проверяется не «кто», а «ровно один»: второй приходит в уже свободный
     * слот и вытеснять ему некого.
     */
    for (let round = 0; round < 10; round += 1) {
      const x = await makeVehicle();
      const y = await makeVehicle();
      const a = await makeTrailer({ model: 'КРОНА SDP27' });
      const b = await makeTrailer({ model: 'КОГЕЛЬ SN24' });
      expect((await hitch(a.id, x, 1)).statusCode).toBe(200);
      expect((await hitch(b.id, y, 1)).statusCode).toBe(200);

      const [first, second] = await Promise.all([hitch(a.id, y, 1), hitch(b.id, x, 1)]);
      expect(first.statusCode, `круг ${round}: A→Y — ${first.body}`).toBe(200);
      expect(second.statusCode, `круг ${round}: B→X — ${second.body}`).toBe(200);

      expect(await hitchOf(a.id)).toEqual({ vehicleId: y, position: 1 });
      expect(await hitchOf(b.id)).toEqual({ vehicleId: x, position: 1 });

      const notices = [first, second].map((r) => (r.json() as HitchTrailerResultDto).notice);
      expect(notices.filter((n) => n !== null)).toHaveLength(1);
    }
  }, 120_000);

  it('контрольный клинч: встречный порядок захвата действительно рвёт транзакцию', async () => {
    /*
     * Без этого случая предыдущий ничего не стоит: тест, в котором взаимоблокировка невозможна в
     * принципе, зелен и на сломанном коде. Здесь она изображается сырым SQL — двумя соединениями,
     * берущими те же две строки в противоположном порядке, — и обязана кончиться `40P01`.
     *
     * Это и есть цена, которую платит `withHitchLocks`: строки берутся по одной, `vehicles`
     * раньше `vehicle_trailers`, внутри таблицы по возрастанию `id`. Единый порядок — не стиль, а
     * единственное, что отличает работающую пару команд от этой картины.
     */
    const [left, right] = [await makeTrailer(), await makeTrailer()];
    const ordered = [left.id, right.id].sort();
    const clients = [
      new pg.Client({ connectionString: DB_URL! }),
      new pg.Client({ connectionString: DB_URL! }),
    ];
    const lock = (client: pg.Client, id: string): Promise<unknown> =>
      client.query('SELECT id FROM vehicle_trailers WHERE id = $1 FOR UPDATE', [id]);
    try {
      for (const client of clients) {
        await client.connect();
        // Предел ожидания — чтобы ошибка порядка проявлялась текстом, а не зависшим прогоном.
        await client.query('SET lock_timeout = 8000');
        await client.query('BEGIN');
      }
      // Каждое соединение берёт «свою» первую строку — встречный порядок начинается отсюда.
      await lock(clients[0]!, ordered[0]!);
      await lock(clients[1]!, ordered[1]!);
      // …и просит вторую, которую уже держит сосед. Обе ждут — детектор Postgres рвёт одну.
      const outcome = await Promise.allSettled([
        lock(clients[0]!, ordered[1]!),
        lock(clients[1]!, ordered[0]!),
      ]);
      const failures = outcome.filter((r) => r.status === 'rejected');
      expect(failures).toHaveLength(1);
      const reason: unknown = failures[0]!.status === 'rejected' ? failures[0]!.reason : null;
      expect(String(reason)).toMatch(/deadlock|Взаимная блокировка/i);
    } finally {
      for (const client of clients) {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end().catch(() => undefined);
      }
    }
  }, 60_000);
});

/** Осталась ли строка в таблице: вычистка сносит запись насовсем, и проверять её нечем, кроме базы. */
async function getTrailerRowCount(id: string): Promise<number> {
  const rows = await ctx.db.execute<{ c: string }>(
    sql`SELECT count(*)::text AS c FROM vehicle_trailers WHERE id = ${id}`,
  );
  return Number(rows.rows[0]!.c);
}
