import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  licenseNumberTakenMessage,
  type DriverDto,
  type DriverLicenseDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Занятый номер документа, замена со снятием прежнего и удаление документа — на живой схеме, через
 * настоящие HTTP-пути (ADR 0021, ADR 0095).
 *
 * Зачем база. Всё, что здесь проверяется, держит один частичный уникальный индекс
 * `person_credentials_number_unique` — «пара серия + номер занята, пока документ не удалён». Его
 * поведение и есть предмет проверки: занятый номер обязан приходить отказом формы с названным
 * полем, а не пятисоткой из драйвера (так и было — повтор пары у того же водителя падал ошибкой
 * базы), снятие прежнего документа обязано освобождать номер до вставки нового, а удаление —
 * возвращать пару в оборот. Ни одно из этих утверждений не про TypeScript: сверить их можно только
 * с Postgres.
 *
 * Файл идёт **шагами одного сценария**: каждый `it` продолжает предыдущий — сначала номер занят,
 * потом он освобождён заменой, потом удалением. Порядок здесь часть проверки.
 *
 * Запуск — как у остальных db-тестов (README, `docs/runbook.md`):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test driver-license-delete
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база у db-тестов общая и переживает повторный запуск. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

function digits(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');
}

/**
 * Пара «серия + номер» — случайная и своя на прогон: индекс стережёт её по всей базе, и номер,
 * оставшийся от упавшего прогона, отобрал бы у теста как раз то, что он проверяет.
 */
const SERIES = digits(4);
const NUMBER = digits(12);
/** Второй номер: им заводится документ там, где занятость проверять не надо. */
const SPARE_NUMBER = digits(12);

/**
 * СНИЛС генерируется, а не берётся из сида: номера сида в общей базе заняты живыми карточками.
 * Контрольное число считается правилами ПФР — иначе разбор отвергнет номер раньше базы.
 */
function makeSnils(): string {
  const nums = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = nums.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${nums.join('')}${String(checksum).padStart(2, '0')}`;
}

const SNILS_OWNER = makeSnils();
const SNILS_OTHER = makeSnils();

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: только у него `records.purge` — снятие прежнего документа и удаление. */
  admin: Auth;
  /**
   * Держатель справочника (роль `manager`): водителей ведёт, документы заводит и аннулирует, но
   * убирать заведённое ему не положено. Им и проверяется, что галочка замены не обходит право.
   */
  keeper: Auth;
  /** Водитель, вокруг чьего документа идёт весь сценарий. */
  driverId: string;
  /** Второй водитель: на нём проверяется занятость номера чужой карточкой. */
  otherDriverId: string;
  /** Категория водительского удостоверения: без неё документ этого вида не завести. */
  categoryId: string;
}

let ctx: Ctx;

/** Что сценарий накопил по дороге: документ, который сначала заменяют, а потом удаляют. */
const state = { licenseId: '' };

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

/** Свой адрес на каждый вход: попытки входа ограничены по IP, а учёток в файле две. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST' | 'DELETE', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/** Заведение документа той же ручкой, что зовёт форма: вид по умолчанию — водительское. */
function addLicense(driverId: string, license: Record<string, unknown>, auth: Auth = ctx.admin) {
  return inject('POST', `/api/v1/drivers/${driverId}/licenses`, auth, license);
}

async function card(driverId: string, auth: Auth = ctx.admin): Promise<DriverDto> {
  const res = await inject('GET', `/api/v1/drivers/${driverId}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as DriverDto;
}

/** Водительские удостоверения карточки: тракторные к номеру этого сценария отношения не имеют. */
function driverLicenses(dto: DriverDto): DriverLicenseDto[] {
  return dto.licenses.filter((l) => l.credentialTypeCode === 'driver_license');
}

describe.skipIf(!DB_URL)(
  'документы водителя: занятый номер, замена и удаление (живая схема)',
  () => {
    beforeAll(async () => {
      prepareEnv(DB_URL!);
      await migrate(DB_URL!);

      const { db, closeDb } = await import('../src/db/client');
      const { hashPassword } = await import('../src/auth/password');
      const { buildApp } = await import('../src/app');

      const passwordHash = await hashPassword(PASSWORD);
      // Учётки заводятся SQL: форма учётки — предмет своих тестов, здесь нужны только две роли,
      // различающиеся ровно правом `records.purge`.
      const emailOf = (tag: string): string => `db-lic-${tag}-${RUN}@example.invalid`;
      async function makeUser(tag: string, role: string): Promise<string> {
        await db.execute(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${emailOf(tag)}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())`);
        return emailOf(tag);
      }
      const adminEmail = await makeUser('admin', 'admin');
      const keeperEmail = await makeUser('keeper', 'manager');

      const app = await buildApp();
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

      ctx = {
        app,
        db,
        closeDb,
        admin: await login(adminEmail),
        keeper: await login(keeperEmail),
        driverId: '',
        otherDriverId: '',
        categoryId: '',
      };

      const categories = await inject('GET', '/api/v1/drivers/license-categories', ctx.admin);
      expect(categories.statusCode, categories.body).toBe(200);
      ctx.categoryId = (categories.json() as { id: string }[])[0]!.id;

      async function createDriver(payload: Record<string, unknown>): Promise<string> {
        const res = await inject('POST', '/api/v1/drivers', ctx.admin, payload);
        expect(res.statusCode, res.body).toBe(201);
        return res.json().id as string;
      }
      ctx.driverId = await createDriver({
        lastName: 'Удостоверенцев',
        firstName: 'Иван',
        middleName: 'Иванович',
        snils: SNILS_OWNER,
        jobTitle: 'Водитель',
        license: {
          series: SERIES,
          number: NUMBER,
          issuedOn: '2021-05-05',
          categories: [{ categoryId: ctx.categoryId }],
        },
      });
      ctx.otherDriverId = await createDriver({
        lastName: 'Удостоверенцев',
        firstName: 'Пётр',
        middleName: 'Петрович',
        snils: SNILS_OTHER,
        jobTitle: 'Водитель',
      });

      state.licenseId = driverLicenses(await card(ctx.driverId))[0]!.id;
    });

    afterAll(async () => {
      if (!ctx) return;
      await ctx.app.close();
      // Убирается только заведённое этим прогоном: документы уходят каскадом за человеком, а журнал
      // держит учётки внешним ключом — поэтому он снимается раньше их.
      await ctx.db.execute(
        sql`DELETE FROM persons WHERE snils IN (${SNILS_OWNER}, ${SNILS_OTHER})`,
      );
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-lic-%-${RUN}@example.invalid`}`;
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-lic-%-${RUN}@example.invalid`}`,
      );
      await ctx.closeDb();
    });

    it('та же серия и номер у того же водителя — отказ формы, а не ошибка базы', async () => {
      // Регресс: уникальный индекс отвечал прямо из драйвера, и человек, заводивший переоформленный
      // документ с прежним номером, получал пятисотку вместо подсказки, что делать дальше.
      const res = await addLicense(ctx.driverId, {
        series: SERIES,
        number: NUMBER,
        issuedOn: '2024-06-06',
        categories: [{ categoryId: ctx.categoryId }],
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().code).toBe('validation_error');
      // Поле названо, и текст — из контрактов: до отправки то же самое говорит форма.
      expect(res.json().fields?.number).toBe(licenseNumberTakenMessage(true));
    });

    it('та же пара у другого работника — тот же отказ, но текстом про чужую карточку', async () => {
      // Разные тексты не украшение: своему документу помогает галочка замены, а чужой номер значит,
      // что бумагу с ним завели не туда, — и снимать его надо в той карточке.
      const res = await addLicense(ctx.otherDriverId, {
        series: SERIES,
        number: NUMBER,
        issuedOn: '2024-06-06',
        categories: [{ categoryId: ctx.categoryId }],
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().fields?.number).toBe(licenseNumberTakenMessage(false));
      // Чужая карточка от неудавшейся попытки документов не набрала.
      expect(driverLicenses(await card(ctx.otherDriverId))).toEqual([]);
    });

    it('замена со снятием прежнего принимает тот же номер и оставляет один документ', async () => {
      const res = await addLicense(ctx.driverId, {
        series: SERIES,
        number: NUMBER,
        issuedOn: '2024-06-06',
        categories: [{ categoryId: ctx.categoryId }],
        deletePrevious: true,
      });
      expect(res.statusCode, res.body).toBe(201);

      // Прежний снят до вставки — иначе пара упёрлась бы в собственный старый документ. В карточке
      // остаётся один документ этого вида, и это новый: у него своя дата выдачи.
      const licenses = driverLicenses(res.json() as DriverDto);
      expect(licenses).toHaveLength(1);
      expect(licenses[0]!.id).not.toBe(state.licenseId);
      expect(licenses[0]!.number).toBe(NUMBER);
      expect(licenses[0]!.issuedOn).toBe('2024-06-06');
      state.licenseId = licenses[0]!.id;
    });

    it('удаление документа убирает его из карточки и освобождает серию с номером', async () => {
      const res = await inject(
        'DELETE',
        `/api/v1/drivers/${ctx.driverId}/licenses/${state.licenseId}`,
        ctx.admin,
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(driverLicenses(res.json() as DriverDto)).toEqual([]);
      // Ответ маршрута и карточка сходятся: документ снят пометкой, а читают её все запросы разом.
      expect(driverLicenses(await card(ctx.driverId))).toEqual([]);

      // Ради этого удаление и заведено: пока ошибочная строка лежит рядом, настоящий документ с тем
      // же номером не завести вовсе — индекс частичный и считает только неудалённые.
      const again = await addLicense(ctx.driverId, {
        series: SERIES,
        number: NUMBER,
        issuedOn: '2024-07-07',
        categories: [{ categoryId: ctx.categoryId }],
      });
      expect(again.statusCode, again.body).toBe(201);
      state.licenseId = driverLicenses(again.json() as DriverDto)[0]!.id;
    });

    it('снять прежний документ галочкой замены нельзя без права на удаление', async () => {
      const res = await addLicense(
        ctx.driverId,
        {
          series: SERIES,
          number: SPARE_NUMBER,
          issuedOn: '2025-08-08',
          categories: [{ categoryId: ctx.categoryId }],
          deletePrevious: true,
        },
        ctx.keeper,
      );
      expect(res.statusCode, res.body).toBe(403);
      // Отказ именно за галочку, а не за маршрут: тот же документ без неё держатель справочника
      // заводит — замена копит историю, и это его обычная работа.
      const allowed = await addLicense(
        ctx.driverId,
        {
          series: SERIES,
          number: SPARE_NUMBER,
          issuedOn: '2025-08-08',
          categories: [{ categoryId: ctx.categoryId }],
        },
        ctx.keeper,
      );
      expect(allowed.statusCode, allowed.body).toBe(201);
      expect(driverLicenses(allowed.json() as DriverDto)).toHaveLength(2);
    });
  },
);
