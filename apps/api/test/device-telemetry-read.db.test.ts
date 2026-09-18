import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVICE_TELEMETRY_PAGE_SIZE,
  type DeviceTelemetryCardDto,
  type MetricCode,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ЧТЕНИЕ БЛОКА «ПОКАЗАНИЯ И СОБЫТИЯ» — маршрут `GET /office-equipment/:id/telemetry` (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10, §12).
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — выборка «последнее по паре», отбор по карточке и область
 * видимости: всё три держатся индексами, `DISTINCT ON` и предикатами области, то есть ровно тем,
 * чего на моках нет. На моках сошлись бы моки.
 *
 * Что доказывается, и почему каждое отдельно:
 *
 * - **последнее значение — ПО ПАРЕ «код + разрез» (Р33), а не по коду.** Главный случай файла:
 *   пилот цветной, письмо об уровнях несёт четыре тонера ОДНИМ кодом метрики, и «последнее по
 *   `metric_code`» потеряло бы три числа из четырёх — молча и именно те, за которыми в блок
 *   приходят;
 * - **свежесть считает `observed_at`, а не `device_time`** (Р21): часы МФУ без NTP уходят на
 *   месяцы, и ряд, упорядоченный временем аппарата, показал бы последним то, что пришло первым;
 * - **отбор по карточке**: наработка соседней единицы в блок не попадает ни строкой. Цена ошибки
 *   здесь — чужая наработка в живой карточке, и заметить её некому;
 * - **право и область**: без `officeEquipment.read` ручка отвечает `403`, и с правом, но с чужой
 *   площадкой — тоже. Ручка получает строку по `id`, и без второй проверки она отдала бы показания
 *   любому, кто этот `id` знает;
 * - **пустая карточка — `200` и пустые списки, а не `404`.** Блок встанет в карточки раньше
 *   первого письма, и «аппарат ещё не присылал» обязано быть законным ответом формы;
 * - **страницы ленты не теряют и не повторяют строк** — и отдельным случаем ТРИ СОБЫТИЯ ВНУТРИ
 *   ОДНОЙ МИЛЛИСЕКУНДЫ, листаемые по одной строке: ровно так ложится пачка, прочитанная после
 *   паузы, и ровно на этой фикстуре видно, что курсор несёт микросекунды базы, а не округлённый
 *   вниз `Date`;
 * - **нечитаемый курсор — `422` во всех видах**: курсор соседней ленты (очередь разбора), битая
 *   отметка времени, не-uuid на месте разрыва ничьей и усечённая при копировании ссылка. Первые
 *   куски уезжают в SQL приведениями, и до правки половина этих случаев была пятисоткой;
 * - **погашенная карточка**: `404` тому, у кого нет `archive.read`, и показания тому, у кого есть;
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ: файл считает МНОЖЕСТВА строк по единице и ходит по страницам, а по общей
 * базе идут параллельные прогоны.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm check:db device-telemetry-read
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`. Именно поэтому
 * ворота зовутся `check:db`, а не `vitest`: без адреса кластера `vitest` промолчал бы и отдал ноль.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_device_telemetry_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-telemetry-password-123';
const EQUIPMENT = '/api/v1/office-equipment';

/**
 * Полный адрес маршрута телеметрии — тем видом, каким его показывает само приложение.
 *
 * Нужен одной проверке при подъёме: маршрут живёт отдельным плагином, а регистрируется в `app.ts`
 * (шов Ш3). Без явного вопроса «а смонтирован ли он» пропавшая регистрация дала бы десять падений
 * по `404`, из которых причина не читается вовсе.
 */
const TELEMETRY_ROUTE = '/api/v1/office-equipment/:id/telemetry';

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Штаб площадки A: справочник открыт ролью, площадка своя, архив закрыт. */
  reader: TestUser;
  /** Тот же штаб, но площадка чужая: право есть, области нет. */
  stranger: TestUser;
  /** Подрядчик: `officeEquipment.read` у него нет вовсе — до блока он не доходит. */
  outsider: TestUser;
  /** Администратор: у него есть `archive.read` — вторая сторона случая с погашенной карточкой. */
  admin: TestUser;
  /** Единица, вокруг которой собран файл: пять наблюдений и четыре события. */
  unitId: string;
  /** Соседняя единица той же площадки: её наблюдения в блок попадать не должны. */
  otherUnitId: string;
  /** Единица без единого письма: её ответ — законная пустота. */
  silentUnitId: string;
  /**
   * Единица под микросекунды: три события внутри ОДНОЙ миллисекунды приёма.
   *
   * Отдельной карточкой, а не строками в основной: у основной проверяется порядок ленты целиком, и
   * три события с одинаковой отметкой сделали бы тот случай зависящим от разрыва ничьей.
   */
  microUnitId: string;
  /** Погашенная карточка: её телеметрия закрыта вместе с ней тем, у кого нет `archive.read`. */
  archivedUnitId: string;
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
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED ??= 'false';
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET', url: string, auth: Auth) {
  return ctx.app.inject({ method, url, headers: auth, remoteAddress: nextAddress() });
}

/**
 * ПРИЛОЖЕНИЕ БЕРЁТСЯ КАК ЕСТЬ, А МАРШРУТ СПРАШИВАЕТСЯ У НЕГО.
 *
 * Здесь стоял мост через шов Ш3: пока регистрации в `app.ts` не было, тест ставил плагин сам, а
 * задвоение после закрытия шва ловил `catch` по `FST_ERR_DUPLICATED_ROUTE`. Мост не работал и не
 * мог: `await app.register(...)` в fastify 5 сам запускает загрузку плагинов, и ошибка вылетала ДО
 * `try` — ворота покраснели ровно в тот день, когда шов закрыли, и десять случаев ушли в skip.
 *
 * Мост снят целиком, а не починен, потому что чинить было уже нечего: шов закрыт, маршрут приходит
 * из `app.ts`, и тест обязан проверять именно его — смонтированный там, где его ждёт портал. Вопрос
 * `hasRoute` заменяет мост одной строкой: пропади регистрация — файл скажет об этом словами, а не
 * десятью падениями по `404`.
 */
async function buildMountedApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const { buildApp: build } = await import('../src/app');
  const app = await build();
  await app.ready();
  // `hasRoute` отвечает только после `ready()`: до неё маршруты плагинов не объявлены.
  if (!app.hasRoute({ method: 'GET', url: TELEMETRY_ROUTE })) {
    throw new Error(
      `маршрут ${TELEMETRY_ROUTE} не смонтирован: проверьте регистрацию плагина телеметрии в app.ts`,
    );
  }
  return app;
}

// ── Фикстура телеметрии ──

/** Момент приёма порталом: он и задаёт порядок ряда (Р21). */
const T1 = '2026-09-10T06:00:00.000Z';
const T2 = '2026-09-12T06:00:00.000Z';

/**
 * Одна и та же миллисекунда приёма для трёх событий — до микросекундного хвоста.
 *
 * Значение произвольное; важно одно — миллисекунда у всех трёх общая, поэтому `Date.toISOString()`
 * любой из них даёт ОДИН И ТОТ ЖЕ курсор, а различает строки только хвост, который `Date` не
 * умеет.
 */
const MICRO_MILLISECOND_BASE = '2026-09-14T07:00:00.123';

async function observation(
  equipmentId: string,
  metricCode: MetricCode,
  component: string,
  value: string,
  unit: string,
  observedAt: string,
  deviceTime: string | null,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO device_observations (equipment_id, metric_code, component, value, unit,
                                     observed_at, device_time, source, source_ref)
    VALUES (${equipmentId}, ${metricCode}, ${component}, ${value}, ${unit},
            ${observedAt}::timestamptz, ${deviceTime}::timestamptz, 'email', ${randomUUID()}::uuid)`);
}

let ordinal = 0;
async function event(
  equipmentId: string,
  eventCode: string,
  severity: 'info' | 'warning' | 'critical',
  observedAt: string,
  deviceTime: string | null,
  text: string,
): Promise<void> {
  ordinal += 1;
  await ctx.db.execute(sql`
    INSERT INTO device_events (equipment_id, event_code, severity, observed_at, device_time,
                               source, source_ref, ordinal, text, vendor_code)
    VALUES (${equipmentId}, ${eventCode}, ${sql.raw(`'${severity}'::device_event_severity`)},
            ${observedAt}::timestamptz, ${deviceTime}::timestamptz, 'email',
            ${randomUUID()}::uuid, ${ordinal}, ${text}, 'SC552')`);
}

async function card(user: TestUser, unitId: string, query = ''): Promise<DeviceTelemetryCardDto> {
  const res = await inject('GET', `${EQUIPMENT}/${unitId}/telemetry${query}`, user.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as DeviceTelemetryCardDto;
}

/** Подпись пары «код + разрез» — тем же ключом, каким её показывает блок. */
const pairOf = (row: { metricCode: string; component: string }) =>
  `${row.metricCode}|${row.component}`;

describe.skipIf(!DB_URL)('блок «Показания и события»: чтение (живая схема)', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const passwordHash = await hashPassword(PASSWORD);

    const makeObject = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`DT-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectA = await makeObject('A');
    const objectB = await makeObject('B');

    /*
     * Подрядчик нужен ровно ради `outsider`: роль `operator` без контрагента база не принимает
     * (`users_operator_counterparty_check`), а прав на оргтехнику поставочный подрядчик не имеет
     * вовсе — это и требуется случаю «без права справочника».
     */
    const counterparty = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-Телеметрия ${RUN}`},
              ${String(Date.now()).slice(-10)})
      RETURNING id`);
    const counterpartyId = counterparty.rows[0]!.id;

    async function makeUser(
      tag: string,
      role: string,
      objectIds: string[] = [],
      opts: { counterpartyId?: string } = {},
    ): Promise<{ id: string; email: string }> {
      const email = `db-dt-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now(), ${opts.counterpartyId ?? null})
        RETURNING id`);
      const id = res.rows[0]!.id;
      for (const objectId of objectIds) {
        await db.execute(sql`
          INSERT INTO user_construction_objects (user_id, construction_object_id)
          VALUES (${id}, ${objectId})`);
      }
      return { id, email };
    }

    const readerUser = await makeUser('reader', 'shtab', [objectA]);
    // Площадка ЧУЖАЯ: право `officeEquipment.read` у штаба от роли, а области на объект A нет.
    const strangerUser = await makeUser('stranger', 'shtab', [objectB]);
    // Подрядчик: `directories.read` и ничего про оргтехнику — до блока он не доходит вовсе.
    const outsiderUser = await makeUser('outsider', 'operator', [], { counterpartyId });
    // Администратор: `archive.read` у него есть, и он — вторая сторона случая с погашенной
    // карточкой. Без него «404 на архивную» доказывал бы только то, что маршрут отвечает 404.
    const adminUser = await makeUser('admin', 'admin');

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');

    /** Карточка заводится SQL: её форма — предмет своих тестов, здесь она декорация. */
    let unitNo = 0;
    async function makeEquipment(tag: string): Promise<string> {
      unitNo += 1;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location)
        VALUES (${typeId}, ${`Ricoh Aficio ${tag} ${RUN}`}, ${`ДТ-${RUN}-${unitNo}`},
                ${objectA}, 'кабинет 214')
        RETURNING id`);
      return row.rows[0]!.id;
    }

    const app = await buildMountedApp();

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

    ctx = {
      app,
      db,
      closeDb,
      reader: await withAuth(readerUser),
      stranger: await withAuth(strangerUser),
      outsider: await withAuth(outsiderUser),
      admin: await withAuth(adminUser),
      unitId: await makeEquipment('main'),
      otherUnitId: await makeEquipment('other'),
      silentUnitId: await makeEquipment('silent'),
      microUnitId: await makeEquipment('micro'),
      archivedUnitId: await makeEquipment('archived'),
    };

    // ── Наблюдения основной единицы ──
    //
    // Счётчик наработки: два письма подряд. Второе и есть последнее.
    await observation(ctx.unitId, 'printed_impressions_total', '', '100', 'impressions', T1, null);
    await observation(ctx.unitId, 'printed_impressions_total', '', '200', 'impressions', T2, null);
    /*
     * Тонеры: ОДИН код метрики, четыре разреза (Р33). Чёрный приходит дважды — и вот у него
     * `device_time` ВТОРОГО письма нарочно СТАРШЕ первого: часы аппарата сбиты. Последним обязано
     * стать то, что пришло позже по `observed_at` (40 %), а не то, чьё время аппарата свежее.
     */
    await observation(
      ctx.unitId,
      'supply_level_percent',
      'black',
      '80.000',
      'percent',
      T1,
      '2026-09-11T05:00:00.000Z',
    );
    await observation(
      ctx.unitId,
      'supply_level_percent',
      'black',
      '40.000',
      'percent',
      T2,
      '2026-01-01T05:00:00.000Z',
    );
    await observation(ctx.unitId, 'supply_level_percent', 'yellow', '8.000', 'percent', T2, null);
    await observation(ctx.unitId, 'supply_level_percent', 'cyan', '55.000', 'percent', T2, null);
    await observation(ctx.unitId, 'supply_level_percent', 'magenta', '61.000', 'percent', T2, null);

    // Соседняя единица: те же коды, другие числа — в блок основной они попадать не должны.
    await observation(
      ctx.otherUnitId,
      'printed_impressions_total',
      '',
      '999999',
      'impressions',
      T2,
      null,
    );
    await observation(
      ctx.otherUnitId,
      'supply_level_percent',
      'black',
      '1.000',
      'percent',
      T2,
      null,
    );

    // ── События ──
    await event(
      ctx.unitId,
      'paper_jam',
      'warning',
      '2026-09-10T07:00:00.000Z',
      '2026-09-10T06:58:00.000Z',
      'Замятие в дуплексе',
    );
    await event(
      ctx.unitId,
      'toner_low',
      'warning',
      '2026-09-11T07:00:00.000Z',
      null,
      'Мало тонера',
    );
    await event(
      ctx.unitId,
      'cover_open',
      'info',
      '2026-09-12T07:00:00.000Z',
      '2026-09-12T06:59:00.000Z',
      'Открыта крышка',
    );
    await event(
      ctx.unitId,
      'toner_empty',
      'critical',
      '2026-09-13T07:00:00.000Z',
      '2026-09-13T06:30:00.000Z',
      'Тонер закончился',
    );
    await event(
      ctx.otherUnitId,
      'paper_jam',
      'warning',
      '2026-09-13T08:00:00.000Z',
      null,
      'Замятие соседа',
    );

    /*
     * ТРИ СОБЫТИЯ ВНУТРИ ОДНОЙ МИЛЛИСЕКУНДЫ — фикстура под главное обещание курсора.
     *
     * Так и ложится настоящая пачка: рубильник выключили на сутки (Р28), накопленное прочитали за
     * секунды, и десятки писем получают `observed_at` в пределах одной-двух миллисекунд. Пока все
     * события фикстуры стояли на целых секундах, мутация «курсор из `toISOString()` вместо
     * печатанного базой» проходила все случаи файла: разницы между отметкой с микросекундами и без
     * них не было ни в одной строке. Разница — вот она, и она в хвосте.
     */
    await event(
      ctx.microUnitId,
      'paper_jam',
      'warning',
      `${MICRO_MILLISECOND_BASE}123Z`,
      null,
      'Замятие первое',
    );
    await event(
      ctx.microUnitId,
      'paper_jam',
      'warning',
      `${MICRO_MILLISECOND_BASE}456Z`,
      null,
      'Замятие второе',
    );
    await event(
      ctx.microUnitId,
      'paper_jam',
      'warning',
      `${MICRO_MILLISECOND_BASE}789Z`,
      null,
      'Замятие третье',
    );

    // Погашенная карточка — со своим показанием: иначе `200` у администратора не отличался бы от
    // ответа по карточке, у которой телеметрии нет вовсе.
    await observation(
      ctx.archivedUnitId,
      'printed_impressions_total',
      '',
      '777',
      'impressions',
      T2,
      null,
    );
    await ctx.db.execute(
      sql`UPDATE office_equipment SET deleted_at = now() WHERE id = ${ctx.archivedUnitId}`,
    );
  }, 300_000);

  afterAll(async () => {
    if (!ctx?.app) return;
    await ctx.app.close();
    await ctx.closeDb();
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 120_000);

  it('последнее значение считается по паре «код + разрез», а не по коду (Р33)', async () => {
    const page = await card(ctx.reader, ctx.unitId);
    const byPair = new Map(page.metrics.map((row) => [pairOf(row), row.value]));

    // Пять пар — пять строк: четыре тонера одного кода не схлопываются в одну.
    expect(page.metrics).toHaveLength(5);
    /*
     * ФОРМА ЧИСЛА НА ПРОВОДЕ — `numeric(18,3)` КАК ЕСТЬ, с хвостом нулей, и это решение, а не
     * недосмотр: масштаб колонки — свойство схемы, а «сколько знаков показать человеку» — правило
     * показа, и живёт оно в блоке (`formatMetricValue`). Обрежь его сервер — портал всё равно
     * остался бы обязан пережить «40.000» от любого другого писателя (ручной ввод, пачка
     * коллектора), только проверять это было бы уже нечем.
     */
    expect(byPair.get('printed_impressions_total|')).toBe('200.000');
    expect(byPair.get('supply_level_percent|black')).toBe('40.000');
    expect(byPair.get('supply_level_percent|yellow')).toBe('8.000');
    expect(byPair.get('supply_level_percent|cyan')).toBe('55.000');
    expect(byPair.get('supply_level_percent|magenta')).toBe('61.000');
  });

  it('свежесть ряда держит приём порталом, а не сбитые часы аппарата (Р21)', async () => {
    const page = await card(ctx.reader, ctx.unitId);
    const black = page.metrics.find((row) => pairOf(row) === 'supply_level_percent|black');

    // У второго письма `device_time` — январь, у первого — сентябрь. Порядок по времени аппарата
    // выдал бы 80 %, то есть значение ПОЗАПРОШЛОГО письма.
    expect(black?.value).toBe('40.000');
    expect(black?.observedAt).toBe(T2);
    expect(black?.deviceTime).toBe('2026-01-01T05:00:00.000Z');
  });

  it('порядок строк задаёт контракт: наработка выше расходников, чёрный выше цветных', async () => {
    const page = await card(ctx.reader, ctx.unitId);
    expect(page.metrics.map(pairOf)).toEqual([
      'printed_impressions_total|',
      'supply_level_percent|black',
      'supply_level_percent|cyan',
      'supply_level_percent|magenta',
      'supply_level_percent|yellow',
    ]);
  });

  it('наработка соседней единицы в блок не попадает ни строкой', async () => {
    const page = await card(ctx.reader, ctx.unitId);
    expect(page.metrics.map((row) => row.value)).not.toContain('999999.000');
    expect(page.metrics.map((row) => row.value)).not.toContain('1.000');
    expect(page.events.items.map((row) => row.text)).not.toContain('Замятие соседа');

    // И обратно: у соседа своё, и ровно своё.
    const neighbour = await card(ctx.reader, ctx.otherUnitId);
    expect(neighbour.metrics.map(pairOf).sort()).toEqual([
      'printed_impressions_total|',
      'supply_level_percent|black',
    ]);
    expect(neighbour.events.items.map((row) => row.text)).toEqual(['Замятие соседа']);
  });

  it('лента идёт от свежего приёма и несёт время аппарата, когда оно есть', async () => {
    const page = await card(ctx.reader, ctx.unitId);
    expect(page.events.items.map((row) => row.eventCode)).toEqual([
      'toner_empty',
      'cover_open',
      'toner_low',
      'paper_jam',
    ]);
    // Время аппарата приезжает отдельным полем, а не подменяет приём: решение «что показать»
    // принимает портал, и для этого ему нужны оба.
    const [newest] = page.events.items;
    expect(newest?.observedAt).toBe('2026-09-13T07:00:00.000Z');
    expect(newest?.deviceTime).toBe('2026-09-13T06:30:00.000Z');
    // Письмо старой прошивки без `Date`: `null`, а не подставленный приём. Подставь его сервер —
    // портал не смог бы отличить «так сказал аппарат» от «так это к нам приехало».
    expect(page.events.items.find((row) => row.eventCode === 'toner_low')?.deviceTime).toBeNull();
  });

  it('страницы ленты не теряют и не повторяют строк', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: DeviceTelemetryCardDto = await card(
        ctx.reader,
        ctx.unitId,
        `?pageSize=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.events.items.map((row) => row.id));
      cursor = page.events.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);

    const whole = await card(ctx.reader, ctx.unitId);
    expect(seen).toEqual(whole.events.items.map((row) => row.id));
  });

  /**
   * МИКРОСЕКУНДЫ — ГЛАВНОЕ ОБЕЩАНИЕ КУРСОРА, и доказывается оно ровно здесь.
   *
   * Три события стоят в одной миллисекунде, различаясь хвостом, и страница просится по ОДНОЙ
   * строке: только так курсор каждый раз упирается в соседа по той же миллисекунде. Отметка,
   * проехавшая через `Date`, округляется вниз и точной границы из себя не даёт — сервер уходит в
   * терпимую ветку («до конца миллисекунды, кроме самой строки»), и та же пара строк выдаётся
   * заново. Проверялось пробоем: мутация «курсор из `toISOString()`» даёт двенадцать выданных
   * строк вместо трёх.
   */
  it('три события в одной миллисекунде листаются без потерь и повторов', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 12; guard += 1) {
      const page: DeviceTelemetryCardDto = await card(
        ctx.reader,
        ctx.microUnitId,
        `?pageSize=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.events.items.map((row) => row.id));
      cursor = page.events.nextCursor;
      if (!cursor) break;
    }
    // Ни одной потерянной и ни одной повторённой: длина и множество совпадают, и оба равны трём.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);

    const whole = await card(ctx.reader, ctx.microUnitId);
    expect(seen).toEqual(whole.events.items.map((row) => row.id));
    // И порядок именно микросекундный: хвост различает строки, которые `Date` считает равными.
    expect(whole.events.items.map((row) => row.text)).toEqual([
      'Замятие третье',
      'Замятие второе',
      'Замятие первое',
    ]);
  });

  /**
   * НЕЧИТАЕМЫЙ КУРСОР — `422` ВО ВСЕХ ЧЕТЫРЁХ ВИДАХ, и это не педантизм ревью.
   *
   * Кодек контракта стережёт ЛЕНТУ, а не форму кусков: метку он снимет, а «garbage» вместо отметки
   * времени поедет дальше в SQL приведением `::timestamptz` — и уронит запрос пятисоткой ровно
   * там, где маршрут сам обещает внятное «откройте заново». Усечённая при копировании ссылка
   * выглядит именно так.
   */
  it('нечитаемый курсор — отказ, а не молчаливая первая страница и не пятисотка', async () => {
    const broken = [
      // Настоящий сосед: очередь разбора листает ленту ТОЙ ЖЕ формы, и её курсор обязан быть
      // нечитаем здесь. Метка `changes` соседнего блока карточки такой проверкой не была: ленты с
      // этой формой у него нет вовсе.
      `1~device-mail-queue~2026-09-13T07:00:00.000000Z~${randomUUID()}`,
      // Отметка времени не разбирается: до правки это была пятисотка от PostgreSQL.
      `1~device-events~garbage~${randomUUID()}`,
      // Не uuid на месте разрыва ничьей — второе приведение, второй источник пятисотки.
      '1~device-events~2026-09-13T07:00:00.000000Z~not-a-uuid',
      // Ссылка, усечённая при копировании: куска попросту нет.
      '1~device-events~2026-09-13T07:00:00.000000Z',
    ];
    for (const cursor of broken) {
      const res = await inject(
        'GET',
        `${EQUIPMENT}/${ctx.unitId}/telemetry?cursor=${encodeURIComponent(cursor)}`,
        ctx.reader.auth,
      );
      expect(res.statusCode, `${cursor}: ${res.body}`).toBe(422);
    }
  });

  it('аппарат без единого письма отвечает пустотой, а не отказом', async () => {
    const page = await card(ctx.reader, ctx.silentUnitId);
    expect(page.metrics).toEqual([]);
    expect(page.events.items).toEqual([]);
    expect(page.events.hasMore).toBe(false);
    expect(page.events.nextCursor).toBeNull();
  });

  it('без права справочника блок закрыт, и чужая площадка тоже', async () => {
    const noPermission = await inject(
      'GET',
      `${EQUIPMENT}/${ctx.unitId}/telemetry`,
      ctx.outsider.auth,
    );
    expect(noPermission.statusCode, noPermission.body).toBe(403);

    // Право есть, области нет: ручка получает строку по `id`, и без проверки области она отдала бы
    // показания чужой площадки любому, кто этот `id` знает.
    const outOfScope = await inject(
      'GET',
      `${EQUIPMENT}/${ctx.unitId}/telemetry`,
      ctx.stranger.auth,
    );
    expect(outOfScope.statusCode, outOfScope.body).toBe(403);
  });

  /**
   * ПОГАШЕННАЯ КАРТОЧКА — `404` БЕЗ `archive.read`, И ЭТО ДВУСТОРОННИЙ СЛУЧАЙ.
   *
   * Ветка архива не проверялась вовсе: `assertArchiveVisible` можно было снести, и ворота остались
   * бы зелёными. `404`, а не `403`, намеренно — сам факт существования погашенной карточки под
   * известным `id` тоже не дело смотрящего (`lib/access.ts`).
   *
   * Второй половиной стоит администратор: без неё случай доказывал бы лишь то, что маршрут умеет
   * отвечать `404`, — а надо, чтобы та же карточка тому, кому архив открыт, отдавала показания.
   */
  it('телеметрия погашенной карточки закрыта вместе с ней, но не от держателя архива', async () => {
    const hidden = await inject(
      'GET',
      `${EQUIPMENT}/${ctx.archivedUnitId}/telemetry`,
      ctx.reader.auth,
    );
    expect(hidden.statusCode, hidden.body).toBe(404);

    const visible = await card(ctx.admin, ctx.archivedUnitId);
    expect(visible.metrics.map((row) => row.value)).toEqual(['777.000']);
  });

  it('размер страницы по умолчанию — из контракта', async () => {
    expect(DEVICE_TELEMETRY_PAGE_SIZE).toBe(20);
    const page = await card(ctx.reader, ctx.unitId);
    // Четыре события меньше двадцати: страница целая и продолжения не обещает.
    expect(page.events.hasMore).toBe(false);
  });
});
