import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { DeviceMailContext } from '@technic/contracts';
import type { db as AppDb } from '../src/db/client';
import type * as DeviceMailStorage from '../src/services/device-mail/storage';
import type * as DeviceMailProfiles from '../src/services/device-mail/profiles';

/**
 * ПРИЁМ ПИСЬМА ОТ АППАРАТА: ЖУРНАЛ, СЫРЬЁ И КУРСОР ЯЩИКА (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §9.1 — протокол по шагам; Р23–Р25, Р28, Р32).
 *
 * ФАЙЛ ДОКАЗЫВАЕТ ПЯТЬ УТВЕРЖДЕНИЙ, и каждое из них — чей-то закрытый способ потерять почту:
 *
 *   1. **повтор того же письма не заводит второй строки** — конфликт по
 *      `(account, uid_validity, uid)` штатный успех, а не ошибка, и отвечать на него отказом
 *      значило бы застопорить курсор навсегда;
 *   2. **письмо с непонятным телом ложится `unrecognized`, а не роняет ручку** — из этой очереди
 *      берутся образцы для следующего профиля, а пятисотка снаружи читается как пауза, и ящик
 *      встал бы на одном кривом письме;
 *   3. **отказ рубильника оставляет письмо в ящике**: ни строки, ни сдвига курсора, ни захода в
 *      счётчик застревания — выключенный на сутки рубильник иначе выел бы десятки писем подряд;
 *   4. **повторная сдача переростка** (тела не было вовсе) отвечает успехом, а не падает: ветка,
 *      проваливающаяся мимо `raw_state = absent` у конечного статуса, дала бы пятисотку на каждом
 *      таком письме;
 *   5. **падение между строкой и сырьём лечится повтором** — ручка дописывает сырьё и доводит
 *      разбор, а курсор до этого стоит. Сдвинь курсор первой транзакцией, и это письмо не было бы
 *      сдано никогда.
 *
 * Сверх них — счётчик застревания: он растёт на отказе, различающем письмо, и закрывает голову
 * пачки после десятого захода, иначе устойчивый отказ стоял бы вечно и не был бы виден нигде.
 *
 * ХРАНИЛИЩЕ ПОДМЕНЕНО, БАЗА НАСТОЯЩАЯ. Проверяется здесь порядок коммитов и развилка повторной
 * сдачи, а не работа S3: MinIO в воротах `check:db` нет, и тест, требующий его, молча
 * пропускался бы ровно там, где дороже всего. Ключ объекта и постановка отложенной уборки при этом
 * настоящие — они живут в том же файле и проверяются вместе с остальным.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ: файл щёлкает рубильником и считает строки во всём журнале писем, и по
 * общей базе оба утверждения были бы ложными.
 *
 * Запуск (базу тест заводит и сносит сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/device-mail-intake.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_device_mail_intake_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const TOKEN = 'device-mail-internal-token-0123456789';
const ACCOUNT = 'devices';
const INTAKE_FLAG = 'device_mail_intake';
const CURSOR = `/internal/device-mail/cursor?account=${ACCOUNT}`;
const MESSAGES = '/internal/device-mail/messages';
const UID_VALIDITY = 4242;
/** Эпоха после того, как провайдер пересоздал ящик: тем же ящиком, но с другой нумерацией. */
const NEXT_EPOCH = 4243;
/** Ещё два пересоздания: ими проверяются обе стороны барьера повторов (Р32). */
const THIRD_EPOCH = 4245;
const FOURTH_EPOCH = 4246;

/**
 * Подменённое хранилище. `vi.hoisted` — потому что фабрика `vi.mock` поднимается выше импортов и
 * обычную переменную модуля не увидит.
 */
const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>(), failing: false }));

/**
 * Подменный выбор профиля: им изображается ЖЁСТКИЙ отказ третьего коммита — того, что пишет исход
 * разбора. Отказ нужен настоящий, а не `failed`: ветка «строка `received`, сырьё `stored`» бывает
 * только тогда, когда процесс умер ПОСЛЕ записи сырья и ДО записи исхода, и план называет её самым
 * частым последствием выката.
 *
 * Изображается версией разборщика, которая заведомо не вмещается в `integer`: снимок такую
 * проходит, а `UPDATE` строки письма падает переполнением — то есть ровно там, где нужно, и
 * детерминированно.
 */
const profileStub = vi.hoisted(() => ({ poison: false, crash: false }));
const POISON_VERSION = 2 ** 31;

vi.mock('../src/services/device-mail/profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof DeviceMailProfiles>();
  return {
    ...actual,
    chooseProfile: (ctx: DeviceMailContext) => {
      // Падение `detect` любого профиля: чужой код, и права стать пятисоткой у него нет.
      if (profileStub.crash) throw new Error('detect профиля сломался');
      if (!profileStub.poison) return actual.chooseProfile(ctx);
      return {
        profile: {
          code: 'ricoh' as const,
          version: POISON_VERSION,
          detect: () => 1,
          parse: () => ({
            observations: [],
            events: [],
            identity: {
              serial: null,
              inventory: null,
              deviceName: null,
              host: null,
              ip: null,
              model: null,
            },
          }),
        },
        confidence: 1,
        recognized: true,
      };
    },
  };
});

vi.mock('../src/services/device-mail/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof DeviceMailStorage>();
  return {
    ...actual,
    putDeviceMailRaw: async (objectKey: string, raw: Buffer): Promise<void> => {
      // Отказ записи — это ПАУЗА, а не ошибка письма: ею и проверяется пятое утверждение файла.
      if (store.failing) throw new Error('хранилище недоступно');
      store.objects.set(objectKey, raw);
    },
    getDeviceMailRaw: async (objectKey: string): Promise<Buffer | null> =>
      store.objects.get(objectKey) ?? null,
  };
});

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
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
  // Уровень `fatal`, а не обычный для тестов `error`: файл НАРОЧНО роняет один заход пятисоткой
  // (ветка «сырьё легло, исход не записан»), и её трассировка в выводе ворот выглядела бы отказом
  // прогона, а не проверяемым случаем. Тише `fatal` конфиг не принимает.
  process.env.LOG_LEVEL ??= 'fatal';
  process.env.MAIL_ENABLED ??= 'false';
  process.env.INTERNAL_API_TOKEN = TOKEN;
  process.env.DEVICE_MAIL_ACCOUNT = ACCOUNT;
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function post(url: string, payload: unknown, token: string = TOKEN) {
  return ctx.app.inject({
    method: 'POST',
    url,
    headers: { 'x-internal-token': token },
    remoteAddress: nextAddress(),
    payload: payload as object,
  });
}

function get(url: string, token: string = TOKEN) {
  return ctx.app.inject({
    method: 'GET',
    url,
    headers: { 'x-internal-token': token },
    remoteAddress: nextAddress(),
  });
}

interface CursorDto {
  uidValidity: number;
  lastUid: number;
  resetUidValidity: number | null;
  resetMaxUid: number | null;
  stuckUidValidity: number | null;
  stuckUid: number | null;
  stuckAttempts: number;
}

async function cursor(): Promise<CursorDto> {
  const res = await get(CURSOR);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CursorDto;
}

/** Письмо от аппарата: обычный текстовый `.eml`, какой и шлёт МФУ. */
function eml(subject: string, body: string): Buffer {
  return Buffer.from(
    [
      'From: mfp-c2011@example.invalid',
      'To: devices@example.invalid',
      `Subject: ${subject}`,
      'Date: Tue, 16 Sep 2026 10:00:00 +0300',
      `Message-ID: <${randomUUID()}@example.invalid>`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '',
    ].join('\r\n'),
    'utf8',
  );
}

function envelope(uid: number, raw: Buffer | null, extra: Record<string, unknown> = {}) {
  return {
    account: ACCOUNT,
    uidValidity: UID_VALIDITY,
    uid,
    size: raw ? raw.byteLength : 9_000_000,
    messageIdHeader: `<uid-${uid}-${RUN}@example.invalid>`,
    dateHeader: 'Tue, 16 Sep 2026 10:00:00 +0300',
    envelopeTo: 'devices@example.invalid',
    ...(raw ? { rawBase64: raw.toString('base64') } : {}),
    ...extra,
  };
}

interface MessageRow {
  id: string;
  status: string;
  raw_state: string;
  s3_object_key: string | null;
  error_code: string;
  error_class: string;
  error_text: string;
  profile_code: string | null;
  parsed_payload: unknown;
  observation_count: number;
}

async function messageRow(uid: number): Promise<MessageRow | null> {
  const res = await ctx.db.execute<MessageRow>(sql`
    SELECT id, status::text AS status, raw_state::text AS raw_state, s3_object_key, error_code,
           error_class, error_text, profile_code, parsed_payload, observation_count
      FROM device_mail_messages
     WHERE account = ${ACCOUNT} AND uid_validity = ${UID_VALIDITY} AND uid = ${uid}`);
  return res.rows[0] ?? null;
}

async function messageCount(): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM device_mail_messages`,
  );
  return res.rows[0]!.n;
}

/** Причина, по которой курсор стоит: в ответ курсора она не едет, но очередь §10 читает именно её. */
async function mailboxLastError(): Promise<string> {
  const res = await ctx.db.execute<{ last_error: string }>(
    sql`SELECT last_error FROM device_mail_accounts WHERE account = ${ACCOUNT}`,
  );
  return res.rows[0]!.last_error;
}

/** Сколько отложенных уборок сырья заведено: ими проверяется, что сирот в хранилище не остаётся. */
async function deleteJobCount(): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM jobs WHERE type = 'delete_s3_object'`,
  );
  return res.rows[0]!.n;
}

/** Щелчок рубильника — тем же `UPDATE`, каким его щёлкает выкат: ручки у ключа нет. */
async function setIntake(isEnabled: boolean): Promise<void> {
  const res = await ctx.db.execute(
    sql`UPDATE feature_flags SET is_enabled = ${isEnabled} WHERE key = ${INTAKE_FLAG}`,
  );
  expect(res.rowCount, 'строка рубильника заведена миграцией 0317').toBe(1);
}

describe.skipIf(!DB_URL)('приём писем аппаратов: внутренние ручки и журнал письма', () => {
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
    const { buildApp } = await import('../src/app');
    // Маршруты приёма поднимает сам `app.ts` (шов Ш3) — своей регистрации у теста нет: вторая
    // подняла бы те же три ручки дважды, и Fastify отказался бы собирать приложение вовсе.
    const app = await buildApp();
    ctx = { app, db, closeDb };
  }, 120_000);

  afterAll(async () => {
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('дверь закрыта общим секретом, а строки ящика ещё нет — курсор заводится нулями', async () => {
    const denied = await get(CURSOR, 'не тот секрет');
    expect(denied.statusCode, denied.body).toBe(401);

    const state = await cursor();
    expect(state).toMatchObject({
      uidValidity: 0,
      lastUid: 0,
      resetUidValidity: null,
      resetMaxUid: null,
      stuckAttempts: 0,
    });
  });

  it('выключенный рубильник: письмо остаётся в ящике, курсор стоит, счётчик не растёт', async () => {
    // Миграция заводит ключ выключенным — состояние выката, а не подготовка теста.
    const raw = eml('Toner low', 'Toner cartridge is low');
    const res = await post(MESSAGES, envelope(101, raw));
    expect(res.statusCode, res.body).toBe(503);
    const body = res.json() as { code: string; details?: { errorCode?: string } };
    expect(body.code).toBe('device_mail_paused');
    expect(body.details?.errorCode).toBe('intake_disabled');

    expect(await messageCount(), 'отказ рубильника не заводит ни одной строки').toBe(0);
    const state = await cursor();
    expect(state.lastUid, 'курсор стоит: письмо дождётся включения').toBe(0);
    expect(state.stuckAttempts, 'пауза счётчик застревания не трогает').toBe(0);
  });

  it('первое письмо: строка, сырьё и отложенная уборка — и повтор не заводит второй строки', async () => {
    await setIntake(true);
    const raw = eml('Device status report', 'Serial Number: X-2701-0001\r\nStatus: OK');

    const first = await post(MESSAGES, envelope(110, raw));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      outcome: 'created',
      status: 'unrecognized',
      lastUid: 110,
    });

    const row = await messageRow(110);
    expect(row?.raw_state, 'сырьё легло вторым коммитом').toBe('stored');
    expect(row?.s3_object_key).toMatch(/^device-mail\/\d{4}\/\d{2}\/[0-9a-f-]+\.eml$/u);
    expect(store.objects.get(row!.s3_object_key!)?.equals(raw)).toBe(true);

    // Уборка сырья ставится тем же коммитом, что и ключ объекта (Р31).
    const jobs = await ctx.db.execute<{ n: number; far_enough: boolean }>(sql`
      SELECT count(*)::int AS n,
             bool_and(next_run_at > now() + interval '25 days') AS far_enough
        FROM jobs
       WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${row!.s3_object_key!}`);
    expect(jobs.rows[0]!.n, 'отложенное удаление сырья заведено').toBe(1);
    expect(jobs.rows[0]!.far_enough, 'срок хранения — тридцать суток от приёма').toBe(true);

    const again = await post(MESSAGES, envelope(110, raw));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json(), 'повтор — штатный успех, а не отказ').toMatchObject({
      outcome: 'existed',
      status: 'unrecognized',
      lastUid: 110,
    });
    const count = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM device_mail_messages
       WHERE account = ${ACCOUNT} AND uid_validity = ${UID_VALIDITY} AND uid = 110`);
    expect(count.rows[0]!.n, 'второй строки повтор не заводит').toBe(1);
  });

  it('непонятное тело ложится «формат не распознан», а не роняет ручку', async () => {
    await setIntake(true);
    const garbage = Buffer.from('  не письмо вовсе, а мусор', 'utf8');
    const res = await post(MESSAGES, envelope(120, garbage));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'created', status: 'unrecognized' });

    const row = await messageRow(120);
    expect(row?.error_code).toBe('no_profile');
    expect(row?.error_class, 'терминальный отказ: письмо ждёт человека, а не повтора').toBe(
      'terminal',
    );
    expect(row?.profile_code, 'профиль «не поняли» — полноправный, а не отсутствие профиля').toBe(
      'unknown',
    );
    expect(row?.parsed_payload, 'снимок разбора ложится даже у непонятого письма').not.toBeNull();
    expect(row?.raw_state, 'сырьё сохранено: перечитывание — главный клиент этого статуса').toBe(
      'stored',
    );
  });

  it('профиль сломался на выборе: письмо ложится «Ошибка разбора», а не пятисоткой', async () => {
    await setIntake(true);
    profileStub.crash = true;
    const res = await post(MESSAGES, envelope(121, eml('Status', 'Status: Ready')));
    profileStub.crash = false;
    // Пятисотка здесь читалась бы снаружи как пауза, счётчик застревания досчитал бы до десяти, и
    // письмо закрылось бы `stuck` вместо честного `failed` с кодом и причиной.
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'created', status: 'failed', lastUid: 121 });

    const row = await messageRow(121);
    expect(row?.error_code).toBe('extract_failed');
    expect(row?.error_class).toBe('terminal');
    expect(
      row?.raw_state,
      'сырьё сложено: правка профиля и «перечитать» — главный клиент failed',
    ).toBe('stored');
    expect((await cursor()).stuckAttempts, 'исход письма — не заход застревания').toBe(0);
  });

  it('переросток: конверт без сырья, и повторная сдача отвечает успехом, а не падает', async () => {
    await setIntake(true);
    const first = await post(MESSAGES, envelope(130, null, { skipReason: 'too_large' }));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ outcome: 'created', status: 'ignored', lastUid: 130 });

    const row = await messageRow(130);
    expect(row?.raw_state, 'тело не качалось вовсе — законное состояние, а не пропуск').toBe(
      'absent',
    );
    expect(row?.s3_object_key).toBeNull();
    expect(row?.error_code).toBe('too_large');

    // Повторная сдача того же переростка: ветка «конечный статус при любом raw_state» обязана
    // ответить успехом, не заходя в хранилище, — иначе на каждом таком письме была бы пятисотка.
    const again = await post(MESSAGES, envelope(130, null, { skipReason: 'too_large' }));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ outcome: 'existed', status: 'ignored', lastUid: 130 });

    // Конверт без тела и без причины — тоже терминальный исход, но со своим кодом: во втором
    // заходе такой вызов принесёт ровно то же, и общий 400 гонял бы письмо по кругу, не оставив в
    // журнале ни строки, ни кода.
    const broken = await post(MESSAGES, envelope(131, null));
    expect(broken.statusCode, broken.body).toBe(200);
    expect(broken.json()).toMatchObject({ outcome: 'created', status: 'ignored', lastUid: 131 });
    expect((await messageRow(131))?.error_code).toBe('bad_submission');
  });

  it('падение между строкой и сырьём: повтор дописывает сырьё и доводит разбор', async () => {
    await setIntake(true);
    const raw = eml('Paper jam', 'Misfeed in tray 2');

    const jobsBefore = await deleteJobCount();
    store.failing = true;
    const failed = await post(MESSAGES, envelope(140, raw));
    store.failing = false;
    expect(failed.statusCode, failed.body).toBe(503);
    expect((failed.json() as { details?: { errorCode?: string } }).details?.errorCode).toBe(
      'storage_unavailable',
    );

    const stuckRow = await messageRow(140);
    expect(stuckRow?.status, 'строка заведена отдельным коммитом и видна в очереди').toBe(
      'received',
    );
    expect(stuckRow?.raw_state).toBe('absent');
    // Уборка ставится на ключ РАНЬШЕ записи объекта (Р31): умри процесс между записью и её
    // коммитом, тело осталось бы без ссылки — строка о нём не знает, повтор кладёт новый uuid, а
    // срок хранения ходит по задачам, не по объектам. Задача, поставленная вперёд, убирает и
    // такого сироту; удаление отсутствующего объекта идемпотентно и ничего не стоит.
    expect(await deleteJobCount(), 'ключ под уборкой ещё до записи объекта').toBe(jobsBefore + 1);
    expect(stuckRow?.s3_object_key, 'а в строке ключа ещё нет').toBeNull();

    const afterFailure = await cursor();
    expect(afterFailure.lastUid, 'курсор двигает только последний коммит').toBe(131);
    expect(afterFailure.stuckAttempts, 'недоступное хранилище — пауза, а не вина письма').toBe(0);

    const repeat = await post(MESSAGES, envelope(140, raw));
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json()).toMatchObject({
      outcome: 'existed',
      status: 'unrecognized',
      lastUid: 140,
    });
    const healed = await messageRow(140);
    expect(healed?.raw_state, 'сырьё дописано повтором').toBe('stored');
    expect(store.objects.has(healed!.s3_object_key!)).toBe(true);
  });

  it('перечитывание идёт от сырья и курсора не трогает', async () => {
    await setIntake(true);
    const row = await messageRow(140);
    const res = await post(`${MESSAGES}/${row!.id}/reparse`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unrecognized' });
    expect((await cursor()).lastUid, 'перечитывание — не приём').toBe(140);

    // Сырьё унесла уборка по сроку, а строка об этом ещё не знает: перечитывание признаёт это
    // значением `purged` и отвечает «нечем», вместо того чтобы ходить кругами до конца попыток.
    store.objects.delete(row!.s3_object_key!);
    const purged = await post(`${MESSAGES}/${row!.id}/reparse`, {});
    expect(purged.statusCode, purged.body).toBe(422);
    const after = await messageRow(140);
    expect(after?.raw_state).toBe('purged');
    expect(after?.s3_object_key).toBeNull();
  });

  it('сырьё легло, а исход не записан: повтор доводит разбор и второго объекта не кладёт', async () => {
    await setIntake(true);
    const raw = eml('Service call', 'Call service: SC554-01');

    // Третий коммит рушится ПОСЛЕ того, как сырьё легло: это и есть «самое частое последствие
    // выката» — строка заведена, объект на месте, процесс убит на разборе.
    profileStub.poison = true;
    const crashed = await post(MESSAGES, envelope(145, raw));
    profileStub.poison = false;
    expect(crashed.statusCode, crashed.body).toBe(500);

    const objects = store.objects.size;
    const row = await messageRow(145);
    expect(row?.status, 'исход не записан — строка осталась незавершённой').toBe('received');
    expect(row?.raw_state, 'а сырьё уже сложено вторым коммитом').toBe('stored');
    expect((await cursor()).lastUid, 'курсор двигает только коммит исхода').toBe(140);

    const repeat = await post(MESSAGES, envelope(145, raw));
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(
      repeat.json(),
      'третья ветка развилки: сырьё на месте, остаётся довести разбор',
    ).toMatchObject({ outcome: 'existed', status: 'unrecognized', lastUid: 145 });

    const healed = await messageRow(145);
    expect(healed?.s3_object_key, 'ключ объекта прежний').toBe(row?.s3_object_key);
    expect(store.objects.size, 'второго объекта повтор не кладёт').toBe(objects);
    const jobs = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM jobs
       WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${row!.s3_object_key!}`);
    expect(jobs.rows[0]!.n, 'и второй уборки тоже: ключ у сырья один').toBe(1);
  });

  it('отказ, различающий письмо, считается заходом; после десятого письмо закрывается', async () => {
    await setIntake(true);
    // Закрытая дверь письма не различает: счётчик, набежавший на неверном секрете, закрыл бы
    // `stuck` невиновное письмо сразу после того, как секрет починят.
    const denied = await post(MESSAGES, envelope(150, eml('Cover open', 'Front cover')), 'не тот');
    expect(denied.statusCode, denied.body).toBe(401);
    expect((await cursor()).stuckAttempts, 'отказ двери заходом не считается').toBe(0);

    // Негодное тело сдачи (размер не число) — отказ, различающий письмо: во втором заходе он будет
    // тем же самым, и голова пачки стояла бы вечно, не будь счётчика.
    const broken = await post(MESSAGES, { ...envelope(150, null), size: 'не число' });
    expect(broken.statusCode, broken.body).toBe(400);
    const counted = await cursor();
    expect(counted.stuckAttempts, 'заход посчитан обработчиком ошибок маршрута').toBe(1);
    expect(counted.stuckUid).toBe(150);
    expect(counted.lastUid, 'курсор стоит на голове пачки').toBe(145);
    expect(counted.uidValidity).toBe(UID_VALIDITY);

    // Десятый заход уже был: следующий закрывает письмо сама ручка, и курсор едет дальше.
    await ctx.db.execute(
      sql`UPDATE device_mail_accounts SET stuck_attempts = 10 WHERE account = ${ACCOUNT}`,
    );
    const raw = eml('Misfeed', 'Misfeed in duplex unit');
    const closed = await post(MESSAGES, envelope(150, raw));
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'ignored', lastUid: 150 });

    const row = await messageRow(150);
    expect(row?.error_code).toBe('stuck');
    // `stuck` — единственный класс писем, где человеку разбираться ОБЯЗАТЕЛЬНО: причину знает
    // только само письмо. Значит закрытие обязано сохранить и тело, и накопленную причину, иначе
    // кнопка «перечитать» мертва по построению, а объяснения нет вовсе.
    expect(row?.raw_state, 'сырьё сохранено и у закрытого по счётчику письма').toBe('stored');
    expect(store.objects.get(row!.s3_object_key!)?.equals(raw)).toBe(true);
    expect(row?.error_text, 'причина ящика унесена в строку до того, как её стёр курсор').toContain(
      'последняя причина',
    );

    const after = await cursor();
    expect(after.stuckAttempts, 'успешный приём обнуляет счётчик').toBe(0);
  });

  it('счётчик указывает на уже закрытое письмо: ручка его не переписывает', async () => {
    await setIntake(true);
    const before = await messageRow(145);
    expect(before?.status, 'письмо закрыто прошлым случаем').toBe('unrecognized');

    // Так бывает: последний заход упал ПОСЛЕ коммита исхода — на записи ответа, на обрыве, — и
    // обработчик ошибок честно дописал попытку по уже закрытой строке.
    await ctx.db.execute(sql`
      UPDATE device_mail_accounts
         SET stuck_uid_validity = ${UID_VALIDITY}, stuck_uid = 145, stuck_attempts = 10
       WHERE account = ${ACCOUNT}`);

    const res = await post(MESSAGES, envelope(145, eml('Service call', 'Call service: SC554-01')));
    expect(res.statusCode, res.body).toBe(200);
    expect(
      res.json(),
      'короткое замыкание по конечному статусу стоит раньше счётчика',
    ).toMatchObject({ outcome: 'existed', status: 'unrecognized' });
    const after = await messageRow(145);
    expect(after?.status, 'разобранное письмо не переписано в «Отброшено»').toBe('unrecognized');
    expect(after?.error_code, 'и кодом застревания не помечено').not.toBe('stuck');
  });

  it('ящик пересоздан и отметка пришла: архивное письмо гасится барьером повторов', async () => {
    await setIntake(true);
    // Письмо прежней эпохи, дошедшее до конечного статуса со сложенным сырьём: именно против такой
    // строки барьер и работает (Р32).
    const raw = eml('Toner empty', 'Toner cartridge is empty');
    const archived = await post(MESSAGES, envelope(160, raw));
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toMatchObject({ outcome: 'created', status: 'unrecognized' });

    // Провайдер пересоздал ящик: эпоха другая, UID у всех писем новые, и портал читает архив
    // заново. Границу режима приносит worker — он один видит верхний номер ящика.
    const resubmitted = await post(MESSAGES, {
      ...envelope(200, raw),
      uidValidity: NEXT_EPOCH,
      mailboxMaxUid: 500,
    });
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    expect(resubmitted.json(), 'совпадение по dedupe_key — успех ручки, а не ошибка').toMatchObject(
      { outcome: 'existed', status: 'unrecognized', lastUid: 200 },
    );

    const fresh = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM device_mail_messages
       WHERE account = ${ACCOUNT} AND uid_validity = ${NEXT_EPOCH}`);
    expect(fresh.rows[0]!.n, 'архивный дубль второй строки не заводит').toBe(0);

    const state = await cursor();
    expect(state.uidValidity, 'эпоха сменилась, курсор сброшен и поехал заново').toBe(NEXT_EPOCH);
    expect(state.resetUidValidity).toBe(NEXT_EPOCH);
    expect(state.resetMaxUid, 'отметка границы — то, что принёс worker').toBe(500);

    // ВТОРАЯ СТОРОНА ОБЕЩАНИЯ Р32, и она дороже первой. То же самое письмо, но с UID ВЫШЕ отметки,
    // — это не архив, а свежая почта: у аппарата с севшей батарейкой RTC `Date` постоянный, и хеш
    // с датой совпадают у второго, десятого и сотого замятия. Гасить их барьером значило бы съесть
    // поток событий, который §2 плана объявляет невосстановимым.
    const above = await post(MESSAGES, {
      ...envelope(600, raw),
      uidValidity: NEXT_EPOCH,
      mailboxMaxUid: 500,
    });
    expect(above.statusCode, above.body).toBe(200);
    expect(above.json(), 'выше отметки барьера нет — письмо принимается').toMatchObject({
      outcome: 'created',
      status: 'unrecognized',
      lastUid: 600,
    });
    const afterAbove = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM device_mail_messages
       WHERE account = ${ACCOUNT} AND uid_validity = ${NEXT_EPOCH}`);
    expect(afterAbove.rows[0]!.n, 'и заводит свою строку').toBe(1);
  });

  it('ящик пересоздан без отметки: барьер не включается, письмо принимается', async () => {
    await setIntake(true);
    const raw = eml('Cover open', 'Front cover is open');
    const first = await post(MESSAGES, { ...envelope(170, raw), uidValidity: NEXT_EPOCH });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ outcome: 'created', status: 'unrecognized' });

    // Та же эпоха плюс один, отметку worker не прислал: барьер остаётся выключенным, и то же самое
    // письмо принимается новой строкой. Из двух отказов это выбранный — задвоенное лучше съеденного.
    const again = await post(MESSAGES, {
      ...envelope(210, raw),
      uidValidity: NEXT_EPOCH + 1,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json(), 'без границы барьер не включается ни на одно письмо').toMatchObject({
      outcome: 'created',
      status: 'unrecognized',
      lastUid: 210,
    });
    const state = await cursor();
    expect(state.resetMaxUid, 'отметки нет — режима дочитывания нет').toBeNull();
    expect(state.resetUidValidity).toBe(NEXT_EPOCH + 1);
  });

  it('барьер не гасит письмо, чья строка осталась незавершённой', async () => {
    await setIntake(true);
    const raw = eml('Misfeed A2', 'Misfeed at location A2');

    // Строка заведена, сырьё не легло: прошлый заход умер между двумя коммитами.
    store.failing = true;
    const paused = await post(MESSAGES, {
      ...envelope(220, raw),
      uidValidity: THIRD_EPOCH,
      mailboxMaxUid: 900,
    });
    store.failing = false;
    expect(paused.statusCode, paused.body).toBe(503);
    const stalled = await ctx.db.execute<{ status: string; raw_state: string }>(sql`
      SELECT status::text AS status, raw_state::text AS raw_state FROM device_mail_messages
       WHERE account = ${ACCOUNT} AND uid_validity = ${THIRD_EPOCH} AND uid = 220`);
    expect(stalled.rows[0], 'незавершённая строка без сырья').toMatchObject({
      status: 'received',
      raw_state: 'absent',
    });

    // Ящик пересоздан ещё раз, отметка пришла, UID ниже неё — барьер включён. Против строки
    // `received`/`absent` он не срабатывает НИКОГДА: иначе письмо погасилось бы как дубль
    // собственной пустой строки и потерялось бы совсем, вместе с событием, которого уже не будет.
    const accepted = await post(MESSAGES, {
      ...envelope(300, raw),
      uidValidity: FOURTH_EPOCH,
      mailboxMaxUid: 900,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json(), 'дубль собственной пустой строки — не дубль').toMatchObject({
      outcome: 'created',
      status: 'unrecognized',
      lastUid: 300,
    });
    const fresh = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM device_mail_messages
       WHERE account = ${ACCOUNT} AND uid_validity = ${FOURTH_EPOCH} AND uid = 300`);
    expect(fresh.rows[0]!.n, 'письмо принято своей строкой').toBe(1);
  });

  it('ящик не прочитался вовсе: причина приезжает запросом курсора и живёт до первого успеха', async () => {
    await setIntake(true);
    // Такая беда не оставляет в базе ни строки: сдачи не было вовсе, а `last_error` до сих пор
    // писал только счётчик застревания из обработчика ошибок приёма. §9.1 п. 8 обещает обратное —
    // очередь показывает состояние ящика и причину.
    const reason = 'IMAP: AUTHENTICATIONFAILED, пароль ящика не принят';
    const asked = await get(`${CURSOR}&mailboxError=${encodeURIComponent(reason)}`);
    expect(asked.statusCode, asked.body).toBe(200);
    expect(await mailboxLastError(), 'причина легла в строку ящика').toBe(reason);

    // Следующий запрос курсора причины не несёт — и не имеет права затереть её пустотой:
    // приёмник называет беду один раз и сам её забывает.
    await cursor();
    expect(await mailboxLastError(), 'молчание приёмника причину не стирает').toBe(reason);

    // Снимает её первый успешный приём, и только он: причина живёт до успеха, а не поверх него.
    const accepted = await post(MESSAGES, {
      ...envelope(310, eml('Toner low', 'Toner is low')),
      uidValidity: FOURTH_EPOCH,
      mailboxMaxUid: 900,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ outcome: 'created', status: 'unrecognized' });
    expect(await mailboxLastError(), 'успешный приём снимает причину').toBe('');
  });
});
