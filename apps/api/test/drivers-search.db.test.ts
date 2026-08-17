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
 * Справочник водителей на живой схеме, через настоящий HTTP-путь: поиск по контактам и должность
 * как признак документа (ADR 0095).
 *
 * Зачем база. В графе «Контакты» стоят адрес и телефон, и поиск в её шапке обязан находить по
 * обоим. Для адреса это подстрока, а для телефона — нет: хранится он десятью цифрами, показан как
 * «+7 (926) 123 45 67», а набирают его в поиске как придётся — со скобками, через 8, подряд. Всё
 * это разбирает SQL (`phoneSearchCondition`), и проверить его может только сервер с базой:
 * контракты формы запроса о совпадении ничего не знают.
 *
 * По той же причине здесь же проверяется должность: и фильтр списка, и подсчёт комплекта документов
 * выражены запросом — приведение должности к сравнимому виду и выбор вида документа считает
 * Postgres, а не TypeScript, и разойтись с правилом контрактов они могут только на живой базе.
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

/** Короткий набор, которым проверяется, что две цифры телефоном не считаются. */
const SHORT_PROBE = '26';

/**
 * СНИЛС генерируется, а не берётся из сида: база у db-тестов общая и живёт между прогонами, и
 * номера сида в ней заняты живыми карточками. Контрольное число считается правилами ПФР — иначе
 * разбор отвергнет номер раньше, чем дело дойдёт до базы.
 *
 * Номера с коротким набором внутри отбрасываются: тот же запрос ищет и по СНИЛСу подстрокой, и
 * случайно попавшие в него две цифры прочитались бы как «поиск по «26» отобрал водителя» —
 * проверка телефона провалилась бы на своих же данных.
 */
function makeSnils(): string {
  for (;;) {
    const digits = Array.from({ length: 9 }, (_, i) =>
      i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
    );
    const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
    const rest = sum < 100 ? sum : sum % 101;
    const checksum = rest === 100 ? 0 : rest;
    const snils = `${digits.join('')}${String(checksum).padStart(2, '0')}`;
    if (!snils.includes(SHORT_PROBE)) return snils;
  }
}

const SNILS_WITH_CONTACTS = makeSnils();
const SNILS_WITHOUT_PHONE = makeSnils();
/** Машинист с удостоверением тракториста-машиниста — по нему комплект полон (ADR 0095). */
const SNILS_MACHINIST_TRACTOR = makeSnils();
/** Машинист, у которого заведено только водительское: комплекта нет, документ не того вида. */
const SNILS_MACHINIST_DRIVER = makeSnils();

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
const CYRILLIC = 'абвгдежзиклмнопрстуфхцшщэюя';
const SURNAME = `Контактов${tag(CYRILLIC)}`;
/**
 * Машинисты — своей фамилией: должность у них общая с половиной справочника, и отбирать их из
 * общей базы приходится вместе с поиском, иначе счёт сходился бы то с чужими строками, то без них.
 */
const MACHINIST_SURNAME = `Экскаваторов${tag(CYRILLIC)}`;
const PHONE = '9261234567';
const EMAIL = `${tag(LATIN)}@example.invalid`;
const EMAIL_WITHOUT_PHONE = `${tag(LATIN)}@example.invalid`;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  /** Машинист с тракторным удостоверением: ему заводят второй документ в проверке видов. */
  machinistId: string;
  /** Категория водительского удостоверения — чужая для тракторного (ADR 0095). */
  driverCategoryId: string;
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

async function createDriver(payload: Record<string, unknown>): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/drivers',
    headers: ctx.auth,
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Страница справочника с произвольным набором фильтров — их сочетания и проверяются. */
async function list(query: string): Promise<DriverDto[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/drivers?pageSize=200&${query}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as DriverDto[];
}

/** Кого нашёл поиск — фамилиями: их и видит человек в списке. */
async function found(search: string): Promise<string[]> {
  return (await list(`search=${encodeURIComponent(search)}`)).map((d) => d.lastName);
}

/** Машинисты этого прогона — СНИЛСами: фамилия у них одна на двоих, а номер у каждого свой. */
async function machinists(query: string): Promise<string[]> {
  const rows = await list(`search=${encodeURIComponent(MACHINIST_SURNAME)}&${query}`);
  return rows.map((d) => d.snils).sort();
}

/** Категории вида документа — ими заполняется форма заведения удостоверения. */
async function categoriesOf(type?: string): Promise<{ id: string; code: string }[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/drivers/license-categories${type ? `?type=${type}` : ''}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; code: string }[];
}

describe.skipIf(!DB_URL)('справочник водителей: поиск и должности (живая схема)', () => {
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
    ctx = {
      app,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      machinistId: '',
      driverCategoryId: '',
    };

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

    const driverCategories = await categoriesOf();
    ctx.driverCategoryId = driverCategories[0]!.id;

    // Машинист с тракторным удостоверением: категорий у него нет — в кадровой выгрузке их не
    // бывает, — а номер и дата выдачи есть, и этого хватает и бланку, и комплекту.
    ctx.machinistId = await createDriver({
      lastName: MACHINIST_SURNAME,
      firstName: 'Семён',
      middleName: 'Семёнович',
      snils: SNILS_MACHINIST_TRACTOR,
      jobTitle: 'Машинист экскаватора',
      license: {
        credentialType: 'tractor_license',
        number: '900001',
        issuedOn: '2021-05-05',
        categories: [],
      },
    });
    // Второй машинист — с одним водительским удостоверением, и должность у него записана иначе:
    // другой регистр и лишние пробелы. Кадровая выгрузка так и присылает, а должность у них одна.
    await createDriver({
      lastName: MACHINIST_SURNAME,
      firstName: 'Тимофей',
      middleName: 'Тимофеевич',
      snils: SNILS_MACHINIST_DRIVER,
      jobTitle: '  машинист   ЭКСКАВАТОРА ',
      license: {
        number: '900002',
        issuedOn: '2021-05-05',
        categories: [{ categoryId: driverCategories[0]!.id }],
      },
    });
  });

  afterAll(async () => {
    if (!ctx) return;
    // Убирается только заведённое этим тестом: номера сгенерированы, ссылаться на них нечему.
    await ctx.app.close();
    const { db } = await import('../src/db/client');
    await db.execute(
      sql`DELETE FROM persons WHERE snils IN (${SNILS_WITH_CONTACTS}, ${SNILS_WITHOUT_PHONE},
        ${SNILS_MACHINIST_TRACTOR}, ${SNILS_MACHINIST_DRIVER})`,
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
    /*
     * Иначе поиск по «26» вернул бы всех, у кого номер вообще заполнен (`phoneSearchDigits`).
     *
     * Проверяются **свои** люди, а не пустота справочника: база у db-тестов общая и живёт между
     * прогонами, и соседние файлы заводят водителей, которых их же уборка удалить не вправе —
     * человека, попавшего в выданный лист, снести значило бы стереть документ. Ждать `[]` от
     * всего справочника значило бы ждать, что база пуста; проверяемое утверждение не в этом, а в
     * том, что короткий набор **не отбирает по телефону**.
     */
    expect(await found(SHORT_PROBE)).not.toContain(SURNAME);
    expect(await found(SHORT_PROBE)).not.toContain(MACHINIST_SURNAME);
  });

  it('фильтр по должности сравнивает нормализованные значения, а не строки', async () => {
    // Должность приходит из кадров свободным текстом: у одного машиниста она записана с большой
    // буквы, у второго — вразрядку и заглавными. Фильтр обязан считать это одной должностью,
    // иначе выпадающий список предлагал бы значение, по которому половина строк не находится.
    const both = [SNILS_MACHINIST_DRIVER, SNILS_MACHINIST_TRACTOR].sort();
    expect(await machinists(`jobTitle=${encodeURIComponent('Машинист экскаватора')}`)).toEqual(
      both,
    );
    expect(await machinists(`jobTitle=${encodeURIComponent('  МАШИНИСТ   экскаватора ')}`)).toEqual(
      both,
    );
  });

  it('чужая должность машинистов не показывает', async () => {
    expect(await machinists(`jobTitle=${encodeURIComponent('Водитель')}`)).toEqual([]);
  });

  it('комплект машиниста считается по тракторному удостоверению, а не по водительскому', async () => {
    // Смена смысла фильтра «Полный комплект» (ADR 0095): у второго машиниста водительское
    // удостоверение заполнено целиком, но за экскаватор по нему не садятся — комплекта нет.
    const jobTitle = `jobTitle=${encodeURIComponent('Машинист экскаватора')}`;
    expect(await machinists(`${jobTitle}&documents=complete`)).toEqual([SNILS_MACHINIST_TRACTOR]);
    expect(await machinists(`${jobTitle}&documents=incomplete`)).toEqual([SNILS_MACHINIST_DRIVER]);
  });

  it('карточка отдаёт документы обоих видов с пометкой вида', async () => {
    const rows = await machinists(`jobTitle=${encodeURIComponent('Машинист экскаватора')}`);
    expect(rows).toHaveLength(2);
    const items = await list(`search=${encodeURIComponent(MACHINIST_SURNAME)}`);
    const tractor = items.find((d) => d.snils === SNILS_MACHINIST_TRACTOR)!;
    const driver = items.find((d) => d.snils === SNILS_MACHINIST_DRIVER)!;
    expect(tractor.licenses.map((l) => l.credentialTypeCode)).toEqual(['tractor_license']);
    expect(driver.licenses.map((l) => l.credentialTypeCode)).toEqual(['driver_license']);
  });

  it('список должностей называет вид документа и считает людей', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/drivers/job-titles',
      headers: ctx.auth,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json() as { jobTitle: string; credentialTypeCode: string; count: number }[];

    // Два написания одной должности — одна строка списка: по счётчику администратор и замечает
    // опечатку кадровой выгрузки, а два написания одного и того же опечаткой не являются.
    const excavator = rows.filter(
      (r) => r.jobTitle.trim().replace(/\s+/gu, ' ').toLowerCase() === 'машинист экскаватора',
    );
    expect(excavator).toHaveLength(1);
    expect(excavator[0]!.credentialTypeCode).toBe('tractor_license');
    expect(excavator[0]!.count).toBeGreaterThanOrEqual(2);

    // Пустых должностей в списке нет — фильтровать по ним нечего.
    expect(rows.filter((r) => r.jobTitle.trim() === '')).toEqual([]);
    // Порядок: частые сверху. Ими фильтром и пользуются.
    expect(rows.map((r) => r.count)).toEqual([...rows.map((r) => r.count)].sort((a, b) => b - a));
  });

  it('категории отдаются по виду документа: буквы у них общие, а допуски разные', async () => {
    const tractor = await categoriesOf('tractor_license');
    expect(tractor.map((c) => c.code)).toEqual(['a1', 'a2', 'a3', 'a4', 'b', 'c', 'd', 'e', 'f']);

    // Умолчание — водительское: так эту ручку зовёт форма, заведённая до второго вида документа.
    const driver = await categoriesOf();
    const driverIds = new Set(driver.map((c) => c.id));
    expect(tractor.filter((c) => driverIds.has(c.id))).toEqual([]);
    // «C» есть у обоих видов, и это разные категории, а не одна.
    expect(driver.some((c) => c.code === 'c')).toBe(true);
    expect(tractor.some((c) => c.code === 'c')).toBe(true);
  });

  it('категория чужого вида отклоняется понятной ошибкой, а не ошибкой базы', async () => {
    // Составной внешний ключ такую пару и так не пропустит, но ответом была бы пятисотка с
    // текстом про ограничение — а перепутать «C» водительского с «C» тракторного проще простого.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${ctx.machinistId}/licenses`,
      headers: ctx.auth,
      payload: {
        credentialType: 'tractor_license',
        number: '900003',
        issuedOn: '2022-06-06',
        categories: [{ categoryId: ctx.driverCategoryId }],
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().fields?.categories).toBeTruthy();
  });
});
