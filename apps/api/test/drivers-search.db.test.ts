import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DriverDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';

/**
 * Поиск по справочнику водителей — на живой схеме, через настоящий HTTP-путь.
 *
 * Зачем база. В графе «Контакты» стоят адрес и телефон, и поиск в её шапке обязан находить по
 * обоим. Для адреса это подстрока, а для телефона — нет: хранится он десятью цифрами, показан как
 * «+7 (926) 123 45 67», а набирают его в поиске как придётся — со скобками, через 8, подряд. Всё
 * это разбирает SQL (`phoneSearchCondition`), и проверить его может только сервер с базой:
 * контракты формы запроса о совпадении ничего не знают.
 *
 * Запуск — как у остальных db-тестов (README, `docs/runbook.md`):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test drivers-search
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-test@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';

/**
 * СНИЛС генерируется, а не берётся из сида: база у db-тестов общая и живёт между прогонами, и
 * номера сида в ней заняты живыми карточками. Контрольное число считается правилами ПФР — иначе
 * разбор отвергнет номер раньше, чем дело дойдёт до базы.
 */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

const SNILS_WITH_CONTACTS = makeSnils();
const SNILS_WITHOUT_PHONE = makeSnils();

/**
 * Фамилия и адрес свои на прогон: однофамильцы в общей базе испортили бы отбор по ФИО, а адрес,
 * оставшийся от прошлого прогона, — отбор по контактам. Метка фамилии кириллическая, метка адреса
 * латинская: в части ФИО допустимы только буквы одной письменности (`namePartIssue`), а в адресе —
 * латиница.
 */
function tag(alphabet: string): string {
  return Array.from(
    { length: 8 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join('');
}

const LATIN = 'abcdefghijklmnopqrstuvwxyz';
const SURNAME = `Контактов${tag('абвгдежзиклмнопрстуфхцшщэюя')}`;
const PHONE = '9261234567';
const EMAIL = `${tag(LATIN)}@example.invalid`;
const EMAIL_WITHOUT_PHONE = `${tag(LATIN)}@example.invalid`;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
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

/** Администратор для входа: заводится один раз и переиспользуется прогонами. */
async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (user) return;
  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Администратор',
    middleName: '',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

async function createDriver(payload: Record<string, unknown>): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/drivers',
    headers: ctx.auth,
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** Кого нашёл поиск — фамилиями: их и видит человек в списке. */
async function found(search: string): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/drivers?pageSize=200&search=${encodeURIComponent(search)}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as DriverDto[]).map((d) => d.lastName);
}

describe.skipIf(!DB_URL)('справочник водителей: поиск по контактам (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    await seedAdmin();
    const { buildApp } = await import('../src/app');
    const { closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    ctx = { app, closeDb, auth: { authorization: `Bearer ${login.json().accessToken}` } };

    await createDriver({
      lastName: SURNAME,
      firstName: 'Иван',
      middleName: 'Иванович',
      snils: SNILS_WITH_CONTACTS,
      phone: PHONE,
      email: EMAIL,
    });
    // Второй — без телефона: по нему видно, что отбор по номеру не превращается в «у кого он есть».
    await createDriver({
      lastName: SURNAME,
      firstName: 'Пётр',
      middleName: 'Петрович',
      snils: SNILS_WITHOUT_PHONE,
      email: EMAIL_WITHOUT_PHONE,
    });
  });

  afterAll(async () => {
    if (!ctx) return;
    // Убирается только заведённое этим тестом: номера сгенерированы, ссылаться на них нечему.
    await ctx.app.close();
    const { db } = await import('../src/db/client');
    await db.execute(
      sql`DELETE FROM persons WHERE snils IN (${SNILS_WITH_CONTACTS}, ${SNILS_WITHOUT_PHONE})`,
    );
    await ctx.closeDb();
  });

  it('фамилия находит обоих: поиск по контактам прежнего не сломал', async () => {
    expect(await found(SURNAME)).toHaveLength(2);
  });

  it('адрес находит целиком и подстрокой — по нему разбирают, кому ушло задание', async () => {
    expect(await found(EMAIL)).toEqual([SURNAME]);
    expect(await found(EMAIL.slice(0, 5))).toEqual([SURNAME]);
    expect(await found(EMAIL_WITHOUT_PHONE)).toEqual([SURNAME]);
  });

  it('номер находит, как бы он ни был набран', async () => {
    for (const term of [
      PHONE,
      '+7 (926) 123 45 67',
      '8 (926) 123-45-67',
      '+79261234567',
      '123-45-67',
    ]) {
      expect(await found(term), term).toEqual([SURNAME]);
    }
  });

  it('чужой номер не находит никого', async () => {
    expect(await found('9990001122')).toEqual([]);
  });

  it('короткий набор номером не считается: две цифры телефон не отбирают', async () => {
    // Иначе поиск по «26» вернул бы всех, у кого номер вообще заполнен (`phoneSearchDigits`).
    expect(await found('26')).toEqual([]);
  });
});
