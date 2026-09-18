import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceMailBindResultDto, DeviceMailQueueDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ОЧЕРЕДЬ «ПИСЬМА УСТРОЙСТВ» — маршрут `/device-mail` (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10, §9.1 п. 7–8, Р20, Р30).
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — ОТБОР и ТРАНЗАКЦИЯ: какие строки очередь берёт, какие нет, и что
 * именно применяет привязка по опознающему ключу против неопознающего. Отбор держится условием по
 * статусу, возрасту и закрывающему следу, а пачка — нормализованной подсказкой внутри снимка
 * `jsonb`. На моках сошлись бы моки.
 *
 * Что доказывается, и почему каждое отдельно:
 *
 * - **состав очереди**: четыре исхода разбора, зависшее в `received` дольше часа и `ignored` с
 *   кодом `stuck`. Последнее — главная находка ревью плана: закрытое счётчиком письмо иначе не
 *   видно НИГДЕ, курсор уехал дальше, и контур, съевший письмо, выглядит здоровым;
 * - **только непросмотренные**: отметка просмотра — единственный способ убрать строку, которую
 *   решить нечем, и она обязана работать как выход, а не как пометку;
 * - **отметка ЗАКРЫТА там, где выход есть**: непривязанное письмо со снимком она уводила бы из
 *   очереди навсегда, оставляя его в отборе пачки, — и будущая привязка того же серийника
 *   применила бы его молча, уже не показавшись человеку. Мусор со снимком закрывает
 *   «игнорировать»: оно меняет СТАТУС и потому выводит письмо и из очереди, и из отбора;
 * - **пачка против одиночки (Р20)**: по серийному номеру привязка применяет ВСЕ накопленные письма
 *   с этим значением, по адресу отправителя — только нажатую строку. Цена ошибки здесь названа в
 *   §6 плана: «приписывает чужую наработку живой карточке, и заметить это некому»;
 * - **каждое письмо применяет СВОЙ снимок**: у двух писем пачки разные числа, и в карточку обязаны
 *   лечь оба — И наблюдениями, И событиями (у событий свой писатель и своя уникальность, Р22), —
 *   причём временем ПРИЁМА письма, а не моментом нажатия (Р21). Повторное нажатие не добавляет ни
 *   строки;
 * - **флаг отметки просмотра**: `canReview` считается ТЕМ ЖЕ предикатом, что стоит барьером в
 *   ручке, и снят у письма, у которого выход есть. Две копии одного правила разошлись бы молча — и
 *   разошлись бы так, что экран предлагает кнопку, которую сервер отклоняет;
 * - **курсор**: своя ссылка «показать ещё» листает очередь без потерь и повторов, а чужая, битая
 *   или усечённая получает `422`. Форму кусков проверяет МАРШРУТ — кодек контракта стережёт только
 *   ленту, и без этой проверки куски уезжали бы в SQL приведениями и роняли запрос пятисоткой там,
 *   где ручка обещает внятный отказ;
 * - **право**: без `officeEquipment.telemetry` ручка отвечает `403` — и отвечает им ЧТЕНИЮ тоже.
 *   Очередь служебная, и открыть её по `officeEquipment.read` значило бы отдать срез парка всем
 *   читателям справочника.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ: файл считает множества строк по всему справочнику писем, а по общей базе
 * идут параллельные прогоны.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm check:db device-mail-review
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`. Именно поэтому
 * ворота зовутся `check:db`, а не `vitest`: без адреса кластера `vitest` промолчал бы и отдал ноль.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_device_mail_review_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-device-mail-password-123';

/** Адрес очереди внутри приложения — тот же, каким она зарегистрирована в `app.ts` (шов Ш3). */
const REVIEW_PREFIX = '/api/v1/device-mail';
const QUEUE = `${REVIEW_PREFIX}/queue`;
/** Ящик, у которого голова пачки стоит: счётчик застревания не нулевой. */
const ACCOUNT = `mfp-${RUN}@example.invalid`;
/**
 * Второй ящик, у которого всё в порядке. Нужен ровно одному утверждению — `cursorStuckAt: null` при
 * нулевом счётчике: без него мутация «отметка есть всегда» (как и «её нет никогда») проходила бы
 * набор целиком, и шапка очереди была бы не проверена ничем.
 */
const CLEAN_ACCOUNT = `zzz-clean-${RUN}@example.invalid`;

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
  /** ИТ-служба: `officeEquipment.read` плюс новое `officeEquipment.telemetry`. */
  reviewer: TestUser;
  /** Штаб: справочник открыт ролью, права на разбор писем нет вовсе. */
  outsider: TestUser;
  unitId: string;
  otherUnitId: string;
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

function inject(method: 'GET' | 'POST', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, payload, remoteAddress: nextAddress() });
}

/**
 * ШОВ Ш3 ЗАКРЫТ: маршрут зарегистрирован в `app.ts`, и приложение поднимается как есть.
 *
 * Самореґистрация плагина, стоявшая здесь до закрытия шва, снята — и снята не «за ненадобностью».
 * Она ЛОМАЛА прогон: после появления строки в `app.ts` повторный `register` давал
 * `FST_ERR_DUPLICATED_ROUTE` на `ready()`, а перехват по тексту ошибки («Method 'GET' already
 * declared…») не срабатывал никогда — кода в тексте нет. Падал `beforeAll`, и все проверки файла
 * пропускались с зелёным итогом. Отсюда правило на будущее: маршрут в тесте не поднимается
 * вторично, а `404` от незарегистрированного маршрута — это честное красное, которое и должно
 * требовать закрытия шва.
 */
async function buildReviewApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const { buildApp: build } = await import('../src/app');
  const app = await build();
  await app.ready();
  return app;
}

// ── Фикстура писем ──

interface MessageFixture {
  status: string;
  rawState?: 'absent' | 'stored' | 'purged';
  /** Возраст приёма в минутах: им и различаются «зависло» и «только что пришло». */
  agoMinutes?: number;
  errorCode?: string;
  fromAddress?: string;
  subject?: string;
  serial?: string | null;
  /** Значение наблюдения: у каждого письма пачки своё — им и доказывается «свой снимок». */
  value?: string;
  reviewed?: boolean;
}

let uid = 0;

/** Снимок разбора — ровно той формы, какую применяет слой привязки (`parsedDeviceMessageSchema`). */
function snapshot(serial: string | null, value: string): unknown {
  return {
    profileCode: 'ricoh',
    parserVersion: 1,
    observations: [
      {
        metricCode: 'printed_impressions_total',
        component: '',
        value,
        unit: 'impressions',
        deviceTime: null,
        rawLabel: 'Total Counter',
      },
    ],
    events: [
      {
        eventCode: 'paper_jam',
        ordinal: 0,
        severity: 'warning',
        deviceTime: null,
        vendorCode: 'SC552',
        text: 'Замятие в дуплексе',
      },
    ],
    identity: {
      serial,
      inventory: null,
      deviceName: null,
      host: null,
      ip: '10.10.0.7',
      model: 'Ricoh Aficio MP C2011SP',
    },
  };
}

async function message(fixture: MessageFixture): Promise<string> {
  uid += 1;
  const rawState = fixture.rawState ?? 'stored';
  const row = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO device_mail_messages (account, uid_validity, uid, status, raw_state, s3_object_key,
                                      from_address, subject, received_at, profile_code,
                                      parser_version, parsed_payload, error_code, error_class,
                                      error_text, observation_count, event_count,
                                      reviewed_by, reviewed_at)
    VALUES (${ACCOUNT}, 1, ${uid},
            ${sql.raw(`'${fixture.status}'::device_message_status`)},
            ${sql.raw(`'${rawState}'::device_raw_state`)},
            ${rawState === 'stored' ? `device-mail/2026/09/${randomUUID()}.eml` : null},
            ${fixture.fromAddress ?? `mfp-${RUN}-1@example.invalid`},
            ${fixture.subject ?? 'Device Status Report'},
            now() - ${sql.raw(`interval '${fixture.agoMinutes ?? 30} minutes'`)},
            'ricoh', 1,
            ${JSON.stringify(snapshot(fixture.serial ?? null, fixture.value ?? '100'))}::jsonb,
            ${fixture.errorCode ?? ''}, '', '', 1, 1,
            ${fixture.reviewed ? ctx.reviewer.id : null},
            ${fixture.reviewed ? sql`now()` : null})
    RETURNING id`);
  return row.rows[0]!.id;
}

async function queue(user: TestUser, query = ''): Promise<DeviceMailQueueDto> {
  const res = await inject('GET', `${QUEUE}${query}`, user.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as DeviceMailQueueDto;
}

const subjectsOf = (page: DeviceMailQueueDto): string[] =>
  page.items.items.map((row) => row.subject);

async function countEvents(equipmentId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM device_events WHERE equipment_id = ${equipmentId}`);
  return rows.rows[0]!.n;
}

async function countObservations(equipmentId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM device_observations WHERE equipment_id = ${equipmentId}`);
  return rows.rows[0]!.n;
}

describe.skipIf(!DB_URL)('очередь «Письма устройств» (живая схема)', () => {
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

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`DM-${RUN}`}, ${`Площадка ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-dmr-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      const id = res.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${id}, ${objectId})`);
      return { id, email };
    }

    const reviewerUser = await makeUser('reviewer', 'shtab');
    // Тот же штаб, но БЕЗ набора: `officeEquipment.read` у него от роли, разбора писем нет вовсе.
    const outsiderUser = await makeUser('outsider', 'shtab');

    /*
     * Новое право выдаётся НАБОРОМ, а не ролью (Р30): поставочный набор ИТ-службы здесь не берётся
     * намеренно — он несёт десяток прав, и отказ соседа доказывал бы тогда работу любого из них.
     * Свой набор из двух прав отвечает ровно на вопрос файла: пускает ли `officeEquipment.telemetry`
     * и закрыта ли очередь без него.
     */
    const grant = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, is_system)
      VALUES (${`dmr_telemetry_${RUN}`}, ${`Разбор писем ${RUN}`}, false)
      RETURNING id`);
    const grantId = grant.rows[0]!.id;
    await db.execute(
      sql`INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab'::role)`,
    );
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${grantId}, 'officeEquipment.read'), (${grantId}, 'officeEquipment.telemetry')`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${reviewerUser.id}, ${grantId}, ${reviewerUser.id}, 'manual')`);

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');

    let unitNo = 0;
    async function makeEquipment(tag: string): Promise<string> {
      unitNo += 1;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location)
        VALUES (${typeId}, ${`Ricoh Aficio ${tag} ${RUN}`}, ${`ДМ-${RUN}-${unitNo}`},
                ${objectId}, 'кабинет 214')
        RETURNING id`);
      return row.rows[0]!.id;
    }

    // Ящик заводится раньше писем: `device_mail_messages.account` ссылается на него под RESTRICT.
    await db.execute(sql`
      INSERT INTO device_mail_accounts (account, uid_validity, last_uid, last_poll_at,
                                        stuck_attempts, last_error)
      VALUES (${ACCOUNT}, 1, 10, now(), 3, 'storage_unavailable: хранилище недоступно')`);
    // Здоровый ящик: обход был, ошибок нет, счётчик нулевой.
    await db.execute(sql`
      INSERT INTO device_mail_accounts (account, uid_validity, last_uid, last_poll_at,
                                        stuck_attempts, last_error)
      VALUES (${CLEAN_ACCOUNT}, 1, 42, now(), 0, '')`);

    const app = await buildReviewApp();

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
      reviewer: await withAuth(reviewerUser),
      outsider: await withAuth(outsiderUser),
      unitId: await makeEquipment('main'),
      otherUnitId: await makeEquipment('other'),
    };
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

  /** Письма каждого случая заводятся внутри своего теста: отбор считает множества, и общая
   * фикстура связала бы случаи между собой — упавший первый ронял бы соседей. */
  async function clearMessages(): Promise<void> {
    await ctx.db.execute(sql`DELETE FROM device_observations`);
    await ctx.db.execute(sql`DELETE FROM device_events`);
    await ctx.db.execute(sql`DELETE FROM device_mail_identities`);
    await ctx.db.execute(sql`DELETE FROM device_mail_messages`);
  }

  it('берёт непривязанное, зависшее и закрытое счётчиком — и ничего сверх', async () => {
    await clearMessages();
    await message({ status: 'unmatched', subject: 'не опознан' });
    await message({ status: 'ambiguous', subject: 'подходит нескольким' });
    await message({ status: 'unrecognized', subject: 'формат не распознан' });
    await message({ status: 'failed', subject: 'ошибка разбора' });
    // Зависшее: строка заведена, исход не поставлен — и стоит так дольше часа.
    await message({ status: 'received', subject: 'зависло', agoMinutes: 180 });
    // Закрытое счётчиком застревания: иначе его не видно НИГДЕ (§9.1, п. 7).
    await message({
      status: 'ignored',
      subject: 'закрыто счётчиком',
      errorCode: 'stuck',
      rawState: 'absent',
    });

    // А это в очередь не попадает: работа по ним закончена или ещё не начиналась.
    await message({ status: 'parsed', subject: 'разобрано' });
    await message({ status: 'received', subject: 'только что пришло', agoMinutes: 5 });
    await message({
      status: 'ignored',
      subject: 'переросток',
      errorCode: 'too_large',
      rawState: 'absent',
    });

    const page = await queue(ctx.reviewer);
    expect(subjectsOf(page).sort()).toEqual(
      [
        'закрыто счётчиком',
        'зависло',
        'не опознан',
        'ошибка разбора',
        'подходит нескольким',
        'формат не распознан',
      ].sort(),
    );
    // «Перечитать» предлагается только сохранённому сырью: у закрытого счётчиком его нет.
    const stuck = page.items.items.find((row) => row.subject === 'закрыто счётчиком');
    expect(stuck?.canReparse).toBe(false);
    expect(stuck?.errorCode).toBe('stuck');

    /*
     * ФЛАГ ОТМЕТКИ ПРОСМОТРА — ТОТ ЖЕ ОТВЕТ, ЧТО И БАРЬЕР РУЧКИ (`hasExitBesidesReview`), и
     * проверяются оба его исхода на одной выдаче.
     *
     * У закрытого счётчиком письма выхода нет вовсе: ни снимка к применению, ни сырья к
     * перечитыванию, — и след «просмотрено» его единственный. А у письма, ждущего привязки, флаг
     * обязан быть снят: отметка увела бы его из очереди навсегда, оставив в отборе пачки, и будущая
     * привязка того же серийника применила бы его молча. Постоянное значение флага (в любую из двух
     * сторон) ломает ровно это утверждение — либо экран прячет единственный выход неразрешимой
     * строки, либо предлагает потерять разобранное письмо.
     */
    expect(stuck?.canReview).toBe(true);
    const waiting = page.items.items.find((row) => row.subject === 'не опознан');
    expect(waiting?.canReview).toBe(false);
    // И зависшее с сохранённым сырьём: выход у него — «перечитать», значит отметка закрыта.
    const hung = page.items.items.find((row) => row.subject === 'зависло');
    expect(hung?.canReparse).toBe(true);
    expect(hung?.canReview).toBe(false);
    // Подсказки опознания приезжают из снимка, а не из сырья: сырьё вычищается по сроку.
    expect(page.items.items.find((row) => row.subject === 'не опознан')?.identity.ip).toBe(
      '10.10.0.7',
    );
    /*
     * Состояние ящиков — в шапке, потому что застрявшее письмо своей строки может не иметь вовсе.
     * Проверяются ОБА исхода поля `cursorStuckAt`: у ящика со счётчиком отметка есть, у здорового
     * её нет. Одного из них мало — «отметка всегда» и «отметки никогда» суть две мутации, каждая из
     * которых убивает шапку, и половинная проверка пропустила бы одну из них.
     */
    expect(page.mailbox).toHaveLength(2);
    const stuckBox = page.mailbox.find((box) => box.account === ACCOUNT);
    expect(stuckBox?.stuckAttempts).toBe(3);
    expect(stuckBox?.cursorStuckAt).not.toBeNull();
    expect(typeof stuckBox?.cursorStuckAt).toBe('string');
    expect(stuckBox?.lastError).toContain('storage_unavailable');
    const cleanBox = page.mailbox.find((box) => box.account === CLEAN_ACCOUNT);
    expect(cleanBox?.stuckAttempts).toBe(0);
    expect(cleanBox?.cursorStuckAt).toBeNull();
    expect(cleanBox?.lastError).toBe('');
    expect(cleanBox?.lastPollAt).not.toBeNull();
  });

  it('просмотренное письмо уходит из очереди, и убрать так можно даже неразрешимое', async () => {
    await clearMessages();
    const stuckId = await message({
      status: 'ignored',
      subject: 'нечем решать',
      errorCode: 'stuck',
      rawState: 'absent',
    });
    await message({ status: 'unmatched', subject: 'ждёт привязки' });

    expect(subjectsOf(await queue(ctx.reviewer)).sort()).toEqual(['ждёт привязки', 'нечем решать']);

    const res = await inject(
      'POST',
      `${REVIEW_PREFIX}/messages/${stuckId}/reviewed`,
      ctx.reviewer.auth,
    );
    expect(res.statusCode, res.body).toBe(200);

    expect(subjectsOf(await queue(ctx.reviewer))).toEqual(['ждёт привязки']);
    // Обе колонки следа или ни одной — этого требует `device_mail_messages_review_shape_check`.
    const trace = await ctx.db.execute<{ by: string | null; at: string | null }>(sql`
      SELECT reviewed_by AS by, reviewed_at AS at FROM device_mail_messages WHERE id = ${stuckId}`);
    expect(trace.rows[0]!.by).toBe(ctx.reviewer.id);
    expect(trace.rows[0]!.at).not.toBeNull();
  });

  it('своя ссылка «показать ещё» листает очередь, а чужая или битая — 422, а не 500', async () => {
    await clearMessages();
    // Три письма разного возраста: страницы по одному, порядок — старые сверху.
    await message({ status: 'unmatched', subject: 'первое', agoMinutes: 180 });
    await message({ status: 'unmatched', subject: 'второе', agoMinutes: 120 });
    await message({ status: 'unmatched', subject: 'третье', agoMinutes: 90 });

    /*
     * СНАЧАЛА СВОЙ КУРСОР — и это половина случая, а не разминка. Проверка формы кусков, ради
     * которой случай и написан, обязана пропускать то, что ручка выдаёт сама: отметку с
     * МИКРОсекундами (`to_char(… 'US')`). Схема, срезающая точность до миллисекунд, отвергала бы
     * собственную ссылку «показать ещё» — то есть закрывала бы очередь длиннее одной страницы,
     * причём тем же отказом 422, которым закрывает чужую.
     */
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: DeviceMailQueueDto = await queue(
        ctx.reviewer,
        `?pageSize=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.items.items.map((row) => row.subject));
      cursor = page.items.nextCursor;
      if (!cursor) break;
    }
    // Ни потерь, ни повторов, и порядок — от старого к свежему: очередь, а не стек.
    expect(seen).toEqual(['первое', 'второе', 'третье']);

    /*
     * ТЕПЕРЬ ЧЕТЫРЕ НЕГОДНЫХ, И ВСЕ ЧЕТЫРЕ — 422.
     *
     * Кодек контракта стережёт ЛЕНТУ и требует лишь непустых кусков; форму проверяет маршрут. Без
     * его проверки куски уезжают в SQL приведениями, и `'garbage'::timestamptz` роняет запрос
     * пятисоткой — на ссылку, усечённую при копировании, с записью в журнал ошибок вместо честного
     * «откройте заново». Пятисотка ровно там, где ручка обещает внятный отказ, — худший исход.
     */
    const stamp = '2026-09-16T06:00:00.000000Z';
    const uuid = randomUUID();
    const broken: [string, string][] = [
      // Курсор СОСЕДНЕЙ ленты: он читаем, куски у него правильной формы, и без проверки метки он
      // стал бы якорем по чужому ряду — страница очереди начиналась бы с события карточки.
      ['лента блока карточки', `1~device-events~${stamp}~${uuid}`],
      ['битая отметка времени', `1~device-mail-queue~garbage~${uuid}`],
      ['не uuid в хвосте', `1~device-mail-queue~${stamp}~not-a-uuid`],
      // Усечённая при копировании ссылка: второго разделителя нет вовсе.
      ['усечённая строка', `1~device-mail-queue~${stamp.slice(0, 13)}`],
    ];
    for (const [name, value] of broken) {
      const res = await inject(
        'GET',
        `${QUEUE}?cursor=${encodeURIComponent(value)}`,
        ctx.reviewer.auth,
      );
      expect(res.statusCode, `${name}: ${res.body}`).toBe(422);
      // Отказ называет ВЫХОД: «откройте заново» — то, что человеку делать, а не код ошибки базы.
      expect(res.json().message, name).toContain('откройте её заново');
    }
  });

  it('отметка просмотра закрыта там, где у письма остаётся другой выход', async () => {
    await clearMessages();
    // Непривязанное письмо со снимком: его предмет — «привязать», и отметка просмотра ПОТЕРЯЛА бы
    // его насовсем — из очереди ушло, показания в карточку не попали, а в отборе пачки осталось.
    const waiting = await message({
      status: 'unmatched',
      subject: 'ждёт привязки',
      serial: 'W512P900777',
    });
    // Ошибка разбора с сохранённым сырьём: предмет — «перечитать» после правки профиля.
    const reparsable = await message({
      status: 'failed',
      subject: 'ошибка с сырьём',
      errorCode: 'extract_failed',
      rawState: 'stored',
    });

    for (const id of [waiting, reparsable]) {
      const res = await inject(
        'POST',
        `${REVIEW_PREFIX}/messages/${id}/reviewed`,
        ctx.reviewer.auth,
      );
      expect(res.statusCode, res.body).toBe(422);
      // Отказ называет ВЫХОД, а не запрет: человек пришёл убрать строку из очереди.
      expect(res.json().message).toContain('Игнорировать');
    }

    // Обе строки на месте: отказ не должен оказаться «тихо сработало».
    expect(subjectsOf(await queue(ctx.reviewer)).sort()).toEqual([
      'ждёт привязки',
      'ошибка с сырьём',
    ]);
    const trace = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM device_mail_messages WHERE reviewed_at IS NOT NULL`);
    expect(trace.rows[0]!.n).toBe(0);

    /*
     * И ГЛАВНОЕ: письмо, которое отметка увела бы из очереди, осталось бы применимым пачкой. Это и
     * есть цена находки — привязка того же серийника применила бы невидимое человеку письмо молча.
     * Здесь оно применяется ЗАКОННО, потому что из очереди никто его не убирал.
     */
    const bind = await inject(
      'POST',
      `${REVIEW_PREFIX}/messages/${waiting}/bind`,
      ctx.reviewer.auth,
      {
        equipmentId: ctx.unitId,
        kind: 'serial',
        value: 'W512P900777',
      },
    );
    expect(bind.statusCode, bind.body).toBe(200);
    expect((bind.json() as DeviceMailBindResultDto).appliedMessages).toBe(1);
  });

  it('«игнорировать» закрывает мусор со снимком и выводит его из отбора пачки', async () => {
    await clearMessages();
    const junk = await message({
      status: 'unmatched',
      subject: 'мусор со снимком',
      serial: 'W512P900555',
      value: '900',
    });
    const keeper = await message({
      status: 'unmatched',
      subject: 'тот же серийник, но нужное',
      serial: 'W512P900555',
      value: '901',
    });

    const res = await inject('POST', `${REVIEW_PREFIX}/messages/${junk}/ignore`, ctx.reviewer.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('ignored');

    // Из очереди ушло: статус `ignored` без кода `stuck` в отбор не попадает, да и след закрыт.
    expect(subjectsOf(await queue(ctx.reviewer))).toEqual(['тот же серийник, но нужное']);
    // След «кто решил» стоит обеими колонками — этого требует проверка схемы.
    const trace = await ctx.db.execute<{
      by: string | null;
      at: string | null;
      status: string;
    }>(sql`
      SELECT reviewed_by AS by, reviewed_at AS at, status::text AS status
        FROM device_mail_messages WHERE id = ${junk}`);
    expect(trace.rows[0]!.by).toBe(ctx.reviewer.id);
    expect(trace.rows[0]!.at).not.toBeNull();
    expect(trace.rows[0]!.status).toBe('ignored');

    /*
     * ГЛАВНОЕ ОТЛИЧИЕ ОТ ОТМЕТКИ ПРОСМОТРА: отбор пачки в `apply.ts` идёт по СТАТУСУ, и отброшенное
     * письмо в него больше не входит. Привязка того же серийника применяет ровно одно — нужное, —
     * а не тащит за собой мусор, которого человек уже не видит.
     */
    const targets = await inject(
      'GET',
      `${REVIEW_PREFIX}/messages/${keeper}/bind-targets?kind=serial&value=W512P900555`,
      ctx.reviewer.auth,
    );
    expect(targets.json().messages).toBe(1);
    const bind = await inject(
      'POST',
      `${REVIEW_PREFIX}/messages/${keeper}/bind`,
      ctx.reviewer.auth,
      {
        equipmentId: ctx.unitId,
        kind: 'serial',
        value: 'W512P900555',
      },
    );
    expect(bind.statusCode, bind.body).toBe(200);
    expect((bind.json() as DeviceMailBindResultDto).appliedMessages).toBe(1);
    const values = await ctx.db.execute<{ value: string }>(sql`
      SELECT value FROM device_observations WHERE equipment_id = ${ctx.unitId}`);
    // В карточку легло значение НУЖНОГО письма, и только оно.
    expect(values.rows.map((row) => row.value)).toEqual(['901.000']);
  });

  it('по серийному номеру привязка применяет пачку, и каждое письмо — свой снимок (Р20)', async () => {
    await clearMessages();
    const first = await message({
      status: 'unmatched',
      subject: 'пачка 1',
      serial: 'W512P900123',
      value: '100',
    });
    await message({ status: 'unmatched', subject: 'пачка 2', serial: 'W512P900123', value: '250' });
    await message({
      status: 'unmatched',
      subject: 'чужой аппарат',
      serial: 'W512P999999',
      value: '7',
    });

    // Значение набрано человеком как попало: нормализация — та же, что у номеров карточки.
    const res = await inject('POST', `${REVIEW_PREFIX}/messages/${first}/bind`, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value: '  w512p900123 ',
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json() as DeviceMailBindResultDto;
    expect(result.appliedMessages).toBe(2);
    expect(result.skippedMessages).toBe(0);

    // ДВА наблюдения, а не одно: «применить снимок ко всем письмам» читалось бы как «записать
    // данные одного письма от имени сотни», и такой реализации здесь не заказывали.
    expect(await countObservations(ctx.unitId)).toBe(2);
    const values = await ctx.db.execute<{ value: string }>(sql`
      SELECT value FROM device_observations WHERE equipment_id = ${ctx.unitId} ORDER BY value`);
    expect(values.rows.map((row) => row.value)).toEqual(['100.000', '250.000']);

    /*
     * И ДВА СОБЫТИЯ. Отдельным утверждением, потому что у событий своя уникальность
     * `(source, source_ref, event_code, ordinal)` и свой писатель: привязка, потерявшая ленту, при
     * целых счётчиках выглядит совершенно здоровой, а `event_count` строки очереди при этом
     * обещает человеку «одно событие приедет». Р22 называет это место прямо: писателей у событий
     * два, и двойное применение удваивало бы аварии, оставив счётчики целыми.
     */
    expect(await countEvents(ctx.unitId)).toBe(2);
    const events = await ctx.db.execute<{ code: string; ordinal: number; refs: number }>(sql`
      SELECT event_code AS code, ordinal, count(DISTINCT source_ref)::int AS refs
        FROM device_events WHERE equipment_id = ${ctx.unitId}
       GROUP BY event_code, ordinal`);
    // Один код, один номер вхождения — и ДВА разных источника: события различает `source_ref`
    // письма, а не порядок строк.
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.refs).toBe(2);

    /*
     * ПОРЯДОК РЯДА ДЕРЖИТ ПРИЁМ ПИСЬМА, А НЕ МОМЕНТ НАЖАТИЯ (Р21). `observed_at` наблюдения обязан
     * совпасть с `received_at` своего письма: возьми применение `now()` — и весь архив лёг бы одной
     * секундой, то есть монотонный ряд счётчиков потерял бы порядок, а будущие месячные дельты
     * считались бы по нему же.
     *
     * Сравнение с допуском в СЕКУНДУ, а не точным равенством, и допуск этот не от лени: `received_at`
     * пишет база с микросекундами, а обратно он приезжает драйвером в `Date`, у которого точность
     * заканчивается миллисекундой, — точное равенство падало бы на этом округлении, ничего не
     * говоря о предмете. Подмена же на `now()` даёт здесь полчаса: письма фикстуры приняты
     * тридцатью минутами раньше.
     */
    const drift = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM device_observations o
        JOIN device_mail_messages m ON m.id = o.mail_message_id
       WHERE o.equipment_id = ${ctx.unitId}
         AND abs(extract(epoch FROM (o.observed_at - m.received_at))) > 1`);
    expect(drift.rows[0]!.n).toBe(0);

    // Письмо чужого аппарата пачка не тронула и в очереди оставила.
    expect(subjectsOf(await queue(ctx.reviewer))).toEqual(['чужой аппарат']);

    /*
     * ПОВТОРНОЕ НАЖАТИЕ НЕ ДОБАВЛЯЕТ НИ СТРОКИ — ни в ряд, ни в ленту. Двое открыли одну строку
     * очереди, или человек нажал дважды: уникальность `(source, source_ref, …)` гасит повтор, а
     * сами письма уже вышли из применимых статусов. Ответ при этом честно нулевой — экран называет
     * это «письмо уже разобрано», а не «применено 0 писем» бодрым успехом.
     */
    const again = await inject(
      'POST',
      `${REVIEW_PREFIX}/messages/${first}/bind`,
      ctx.reviewer.auth,
      { equipmentId: ctx.unitId, kind: 'serial', value: 'W512P900123' },
    );
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as DeviceMailBindResultDto).appliedMessages).toBe(0);
    expect(await countObservations(ctx.unitId)).toBe(2);
    expect(await countEvents(ctx.unitId)).toBe(2);
  });

  it('по адресу отправителя применяется только нажатая строка', async () => {
    await clearMessages();
    const shared = `shared-${RUN}@example.invalid`;
    const pressed = await message({
      status: 'unmatched',
      subject: 'нажатая строка',
      fromAddress: shared,
      serial: null,
      value: '11',
    });
    await message({
      status: 'unmatched',
      subject: 'сосед по адресу',
      fromAddress: shared,
      serial: null,
      value: '22',
    });

    const res = await inject(
      'POST',
      `${REVIEW_PREFIX}/messages/${pressed}/bind`,
      ctx.reviewer.auth,
      {
        equipmentId: ctx.otherUnitId,
        kind: 'fromAddress',
        value: shared,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as DeviceMailBindResultDto).appliedMessages).toBe(1);

    // ИТ-служба сплошь и рядом прописывает парку один служебный адрес: пачка по нему одним
    // нажатием приписала бы сотни писем разных аппаратов одной карточке.
    expect(await countObservations(ctx.otherUnitId)).toBe(1);
    expect(subjectsOf(await queue(ctx.reviewer))).toEqual(['сосед по адресу']);
  });

  it('число затронутых писем считает сервер тем же отбором, что и применение', async () => {
    await clearMessages();
    const first = await message({ status: 'unmatched', subject: 'счёт 1', serial: 'S-COUNT-1' });
    await message({ status: 'unmatched', subject: 'счёт 2', serial: 'S-COUNT-1' });
    await message({ status: 'unmatched', subject: 'счёт 3', serial: 'S-COUNT-2' });

    const batch = await inject(
      'GET',
      `${REVIEW_PREFIX}/messages/${first}/bind-targets?kind=serial&value=s-count-1`,
      ctx.reviewer.auth,
    );
    expect(batch.statusCode, batch.body).toBe(200);
    expect(batch.json().messages).toBe(2);

    // Неопознающий ключ — всегда одна строка, и число обязано это показывать ДО подтверждения.
    const single = await inject(
      'GET',
      `${REVIEW_PREFIX}/messages/${first}/bind-targets?kind=fromAddress&value=${encodeURIComponent(`mfp-${RUN}-1@example.invalid`)}`,
      ctx.reviewer.auth,
    );
    expect(single.statusCode, single.body).toBe(200);
    expect(single.json().messages).toBe(1);
  });

  it('без права `officeEquipment.telemetry` закрыты и действия, и само чтение очереди', async () => {
    await clearMessages();
    const id = await message({ status: 'unmatched', subject: 'чужому не видно' });

    // Справочник штабу открыт ролью — и именно поэтому случай доказывает работу НОВОГО права.
    expect((await inject('GET', QUEUE, ctx.outsider.auth)).statusCode).toBe(403);
    expect(
      (await inject('POST', `${REVIEW_PREFIX}/messages/${id}/reviewed`, ctx.outsider.auth))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await inject('POST', `${REVIEW_PREFIX}/messages/${id}/bind`, ctx.outsider.auth, {
          equipmentId: ctx.unitId,
          kind: 'serial',
          value: 'W512P900123',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await inject('POST', `${REVIEW_PREFIX}/messages/${id}/reparse`, ctx.outsider.auth))
        .statusCode,
    ).toBe(403);
    expect(
      (await inject('POST', `${REVIEW_PREFIX}/messages/${id}/ignore`, ctx.outsider.auth))
        .statusCode,
    ).toBe(403);
  });
});
