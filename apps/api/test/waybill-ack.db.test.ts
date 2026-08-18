import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  WAYBILL_ACK_REQUIRED_CODE,
  type WaybillAckRequiredDetails,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Рукопожатие выписки (Р21) — руками, без помощника.
 *
 * Единственный файл, где двухходовка написана целиком, и написана она так намеренно. Соседние
 * db-тесты выписывают лист через `waybill-issue-helper.ts`: у них бумага — состояние, в котором
 * тест застаёт заявку или журнал, и разговор о предупреждениях в них только шум. Но помощник
 * проходит рукопожатие **успешно**, а значит сам по себе ничего о нём не доказывает: заменив
 * сервер заглушкой, отвечающей 200 на всё, мы не сломали бы ни одного из тех файлов. Доказывает
 * здешний.
 *
 * Проверяется ровно то, ради чего Р21 и заводилась: окно портала проверкой не является — старая
 * вкладка, повтор запроса из истории или `curl` выписывали лист молча.
 *
 * - выписка с предупреждениями отвечает **409** `waybill_ack_required` — своим кодом, а не
 *   `version_conflict`: у портала на них два разных исхода;
 * - на отказе **номер бланка не расходуется**: ни листа по рейсу, ни сгоревшего номера серии. Это
 *   главное утверждение файла — цена ошибки здесь не «кнопка не сработала», а дыра в нумерации
 *   бланков строгой отчётности, которую через полгода никто не объяснит. Сгоревший номер считается
 *   разницей, а не сдвигом счётчика: серия у db-тестов общая (см. `burnedSince`);
 * - подложный отпечаток отвергается тем же 409: подтверждают положение дел, а не факт нажатия;
 * - принятый отпечаток попадает в `waybills.issue_warnings` конвертом `acknowledged` — вместе со
 *   списком, по которому через полгода и будут разбираться;
 * - отпечаток считается по **фактам**: сменился водитель — сменился набор, и прежнее подтверждение
 *   силы не имеет. Ровно тот случай, ради которого рукопожатие сделано отпечатком, а не флагом
 *   «да, согласен»: между показом окна и нажатием кнопки положение дел меняется.
 *
 * Зачем живая база. Набор предупреждений сервер считает под уже взятыми блокировками из одного
 * чтения (Р22), а расход номера — это `waybill_series.next_number` и вставка в `waybills` одной
 * транзакцией. Ни то, ни другое не выражается контрактами: расходятся здесь не правила, а код и
 * база, и «номер не сгорел» видно только в самой базе.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_ack \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-waybill-ack-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: рукопожатие выписки';
/** Уникальный хвост прогона: люди ищутся по нему, а база переживает прогоны. */
const RUN = Date.now().toString(36);

/**
 * Реквизиты удостоверения документированного водителя. Выдуманные, как и СНИЛС: репозиторий
 * публичный, персональных данных в нём не бывает.
 */
const LICENSE_SERIES = '00 00';
const LICENSE_ISSUED_ON = '2021-03-12';
/** Номер удостоверения — свой у прогона: пара «серия — номер» в справочнике уникальна. */
const LICENSE_NUMBER = String(Date.now() % 1_000_000).padStart(6, '0');
/**
 * СНИЛС документированного водителя — свой у каждого прогона, с верной контрольной суммой.
 *
 * Общей константы здесь нет намеренно: несколько соседних файлов заводят человека по одному и тому
 * же `11111111145`, а человек ищется по СНИЛС — и первый добежавший файл решает, с какими
 * документами этот человек живёт до конца прогона. Файлу, который проверяет **набор предупреждений
 * о документах**, чужие документы под своим номером сломали бы весь смысл.
 */
const DRIVER_SNILS = snilsOf(RUN);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: { authorization: string };
  vehicleId: string;
  /** Водитель без единого документа: он и поднимает `driver_documents` (ADR 0064). */
  barePersonId: string;
  /** Водитель со СНИЛС и действующим ВУ: с ним предупреждение о документах пропадает. */
  documentedPersonId: string;
  routeDate: string;
}

let ctx: Ctx;

/**
 * СНИЛС с верной контрольной суммой из девяти цифр, полученных из строки прогона.
 *
 * Считается, а не выдумывается: `persons.snils` проверяется на живой схеме, и подобранное «на
 * глаз» число упало бы на вставке — то есть в `beforeAll`, где отказ читается хуже всего.
 */
function snilsOf(seed: string): string {
  let digits = '';
  for (let i = 0; seed.length > 0 && digits.length < 9; i += 1) {
    digits += String(seed.charCodeAt(i % seed.length) % 10);
  }
  // Номера ниже 001-001-998 контрольной суммы не имеют вовсе — единица в старшем разряде уводит
  // сгенерированное число заведомо выше границы.
  digits = `1${digits.slice(1)}`;
  // Правило ПФР — тем же выражением, что и `isValidSnils` в контрактах: считать его вторым
  // способом значило бы завести второе мнение о том, какой номер верен.
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(digits[i]) * (9 - i);
  const rest = sum < 100 ? sum : sum % 101;
  return `${digits}${String(rest === 100 ? 0 : rest).padStart(2, '0')}`;
}

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

/**
 * Учётка администратора и два водителя. Право пустого бланка — администраторское (ADR 0071), и
 * пустой рейс здесь не прихоть: это самый короткий способ получить предупреждение, не заводя ни
 * заявки, ни точек маршрута.
 */
async function seed(): Promise<{ barePersonId: string; documentedPersonId: string }> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (!user) {
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

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  if (!specialization) throw new Error('в справочнике нет специализации «водитель»');
  const [licenseType] = await db
    .select({ id: schema.credentialTypes.id })
    .from(schema.credentialTypes)
    .where(sql`${schema.credentialTypes.code} = 'driver_license'`);
  if (!licenseType)
    throw new Error('в справочнике нет вида документа «водительское удостоверение»');

  /** Человек со специализацией «водитель»: без неё он не попадёт в подбор водителя рейса. */
  const newDriver = async (firstName: string, snils: string | null): Promise<string> => {
    const [person] = await db
      .insert(schema.persons)
      .values({
        lastName: 'Рукопожатов',
        firstName,
        middleName: 'Тестовый',
        ...(snils ? { snils } : {}),
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
  };

  const barePersonId = await newDriver('Беспаспортный', null);
  const documentedPersonId = await newDriver('Документированный', DRIVER_SNILS);

  // Категории — внутри своего вида документа: «B» и «C» есть и у удостоверения тракториста
  // (миграция 0123), а составной внешний ключ чужую категорию в ВУ не пустит.
  const categories = await db
    .select({ id: schema.qualificationCategories.id })
    .from(schema.qualificationCategories)
    .where(
      sql`${schema.qualificationCategories.credentialTypeId} = ${licenseType.id}
          AND ${schema.qualificationCategories.code} in ('b', 'c')`,
    );
  const [credential] = await db
    .insert(schema.personCredentials)
    .values({
      personId: documentedPersonId,
      credentialTypeId: licenseType.id,
      series: LICENSE_SERIES,
      number: LICENSE_NUMBER,
      issuedOn: LICENSE_ISSUED_ON,
      // Срок заведомо длинный: тест идёт «на сегодня», и истечение через несколько лет сломало бы
      // отбор водителя молча — пустым списком вместо понятного отказа.
      expiresOn: '2099-03-12',
      verificationStatus: 'verified',
      verifiedAt: new Date('2021-03-12T12:00:00Z'),
    })
    .returning({ id: schema.personCredentials.id });
  await db.insert(schema.personCredentialCategories).values(
    categories.map((c) => ({
      credentialId: credential!.id,
      qualificationCategoryId: c.id,
      credentialTypeId: licenseType.id,
      validFrom: '2021-03-12',
    })),
  );

  return { barePersonId, documentedPersonId };
}

async function login(): Promise<{ authorization: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

/** Пустой рейс на названного водителя: машина, дата и человек — всё, чего лист требует. */
async function emptyRoute(driverPersonId: string): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-routes',
    headers: ctx.admin,
    payload: { vehicleId: ctx.vehicleId, routeDate: ctx.routeDate, driverPersonId },
  });
  expect(created.statusCode, created.body).toBe(201);
  const route = created.json();
  expect(route.requests, 'рейс заводится пустым: задание ему и не нужно').toEqual([]);
  return { id: route.id, version: route.version };
}

/** Выписка одним запросом — тем самым, который в соседних файлах прячет помощник. */
async function issue(routeId: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-routes/${routeId}/waybill`,
    headers: ctx.admin,
    payload,
  });
}

/**
 * Тот же запрос, но со счётом номеров: отметка серии снимается вплотную до него, расход — вплотную
 * после. Окно нарочно короткое, в один запрос: чем оно шире, тем больше в нём чужой жизни (см.
 * `burnedSince`).
 */
async function issueCountingNumbers(
  routeId: string,
  payload: Record<string, unknown>,
): Promise<{
  res: Awaited<ReturnType<typeof issue>>;
  /** Номер, с которого серия стояла перед запросом: свой лист обязан занумероваться не ниже. */
  mark: number;
  /** Сколько номеров запрос сжёг: выдал и не превратил в документ. */
  burned: number;
}> {
  const mark = await seriesMark();
  const res = await issue(routeId, payload);
  return { res, mark, burned: await burnedSince(mark) };
}

/** Отказ рукопожатия, разобранный: своим кодом, а не текстом сообщения. */
function ackOf(res: { statusCode: number; body: string; json: () => unknown }): {
  fingerprint: string;
  warnings: { facts: { code: string } }[];
  routeId: string;
  routeNumber: string;
} {
  expect(res.statusCode, res.body).toBe(409);
  const body = res.json() as { code: string; details: WaybillAckRequiredDetails };
  expect(body.code, 'у окна подтверждения свой исход, и различает их код').toBe(
    WAYBILL_ACK_REQUIRED_CODE,
  );
  return body.details;
}

/** Листы рейса: их отсутствие и есть «номер не расходуется». */
async function waybillsOf(
  routeId: string,
): Promise<{ id: string; number: string; issue_warnings: unknown }[]> {
  const rows = await ctx.db.execute<{ id: string; number: string; issue_warnings: unknown }>(
    sql`SELECT id, number::text AS number, issue_warnings FROM waybills WHERE route_id = ${routeId}`,
  );
  return rows.rows;
}

/** Отметка основной серии: 4-П нумеруется ею (`SERIES_BY_FORM`). С неё и считается расход. */
async function seriesMark(): Promise<number> {
  const rows = await ctx.db.execute<{ next_number: string }>(
    sql`SELECT next_number FROM waybill_series WHERE code = 'main'`,
  );
  return Number(rows.rows[0]!.next_number);
}

/**
 * Сколько номеров серии сгорело с отметки: счётчик ушёл вперёд на столько-то, а листов с номерами
 * из этого промежутка — столько-то. Разница и есть дыра в журнале строгой отчётности: номер выдан
 * и документом не стал. Ровно её и стережёт Р21.
 *
 * Считается разницей, а не сравнением счётчика с запомненным числом. Абсолютное «счётчик не
 * сдвинулся» было утверждением не о нашем запросе: база у db-тестов общая, соседние файлы
 * выписывают листы той же серией параллельно, и одна такая выписка давала «номер расходуется ровно
 * один раз: ожидалось 1467, получено 1468» на ровном месте. Чужой лист разницы не создаёт — он
 * двигает обе половины разом, — а сгоревший номер по-прежнему виден единицей.
 *
 * Отсюда и требование к окну: **один запрос, не больше**. Соседи не только выписывают листы, но и
 * убирают их за собой (`DELETE FROM waybills` в их `afterAll`), а удалённый лист свой номер уже не
 * подтверждает — из последней полусотни номеров этой серии в общей базе листами заняты девять.
 * На окне в один запрос совпасть должны выписка соседа и его же уборка, а между ними у него лежит
 * целый тест.
 *
 * Проверяется отдельно от списка листов, потому что это разные утверждения. «Листа нет» сказало бы
 * только, что вставка откатилась; сгоревший номер выглядел бы точно так же — счётчик серии берётся
 * `UPDATE ... RETURNING`, и молча съеденное число видно лишь здесь.
 */
async function burnedSince(mark: number): Promise<number> {
  const rows = await ctx.db.execute<{ burned: string }>(sql`
    SELECT (s.next_number - ${mark}
            - (SELECT count(*) FROM waybills w
                WHERE w.series_id = s.id AND w.number >= ${mark}))::text AS burned
      FROM waybill_series s
     WHERE s.code = 'main'`);
  return Number(rows.rows[0]!.burned);
}

describe.skipIf(!DB_URL)(
  'рукопожатие выписки: 409, отпечаток и расход номера (живая схема)',
  () => {
    beforeAll(async () => {
      prepareEnv(DB_URL!);
      await migrate(DB_URL!);

      const { barePersonId, documentedPersonId } = await seed();
      const { buildApp } = await import('../src/app');
      const { db, closeDb } = await import('../src/db/client');
      const app = await buildApp();

      // Своя активная машина с бланком 4-П: рейс заводится только на неё.
      const vehicles = await db.execute<{ id: string }>(sql`
      SELECT v.id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p'
      LIMIT 1`);
      const vehicle = vehicles.rows[0];
      if (!vehicle) throw new Error('В базе нет своей машины с бланком 4-П: миграции не применены');

      ctx = {
        app,
        db,
        closeDb,
        admin: { authorization: '' },
        vehicleId: vehicle.id,
        barePersonId,
        documentedPersonId,
        routeDate: moscowDateKeyOf(new Date()),
      };
      ctx.admin = await login();
    }, 120_000);

    afterAll(async () => {
      if (ctx?.db) {
        /*
         * Порядок обратен порядку рождения: сначала листы, потом рейсы, потом люди — лист держит и
         * рейс, и водителя ключами `restrict`.
         *
         * Прежде уборка щадила человека, которого держит лист: снимок ссылается на него, и удалить
         * человека значило бы стереть документ. Щадила она при этом **свой же** лист — оба
         * здешних сценария кончаются удачной выпиской, — и в общей базе оседало по два водителя за
         * прогон, один из них намеренно без СНИЛС. Такой водитель и ронял потом обмен
         * справочниками у соседей. Правильный ответ не «выдать ему СНИЛС» (файл проверяет как раз
         * пробел в документах — с валидным номером предупреждение `driver_documents` исчезло бы
         * вместе со смыслом первого теста), а убрать бумагу перед человеком.
         *
         * Бумага у db-тестов расходная, и сносят её здесь тем же порядком, что соседи
         * (`route-correction`, `assignment-route-driver`). Счёт номеров это не ломает: он считается
         * разницей, а не сдвигом счётчика (см. `burnedSince`), и удалённый чужой лист там уже учтён.
         *
         * Уборка идёт по метке, а не по спискам заведённого: прибирать надо и за упавшим прогоном,
         * который до записи в список мог не дойти. Рейс без листа она переживает — упавший сценарий
         * оставляет как раз такой.
         */
        const ourPersons = sql`SELECT id FROM persons WHERE comment = ${PERSON_MARK}`;
        await ctx.db.execute(sql`DELETE FROM waybills WHERE driver_person_id IN (${ourPersons})`);
        await ctx.db.execute(
          sql`DELETE FROM vehicle_routes WHERE driver_person_id IN (${ourPersons})`,
        );
        await ctx.db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
      }
      await ctx?.app.close();
      await ctx?.closeDb();
    });

    it('предупреждения останавливают выписку: 409 со списком, и номер бланка цел', async () => {
      const route = await emptyRoute(ctx.barePersonId);

      const refused = await issueCountingNumbers(route.id, { version: route.version });
      const details = ackOf(refused.res);

      /*
       * Список — тот, что показывают человеку: пустой маршрут (ADR 0071 п. 4) и пробелы в документах
       * водителя (ADR 0064). Сверяются коды, а не сообщения: отпечаток считается от фактов, и
       * переписанный текст подтверждений не рвёт — значит и тест на текст опираться не вправе.
       */
      expect(details.routeId).toBe(route.id);
      expect(details.routeNumber, 'окно называет рейс человеку').toMatch(/^Р-\d+$/);
      expect(details.warnings.map((w) => w.facts.code).sort()).toEqual([
        'blank_task',
        'driver_documents',
      ]);
      expect(details.fingerprint).toMatch(/^[0-9a-f]{64}$/);

      // Главное утверждение файла: отказ не стоил ни листа, ни номера.
      expect(await waybillsOf(route.id)).toHaveLength(0);
      expect(refused.burned, 'на отказе номер серии не сгорает').toBe(0);

      /*
       * Подложный отпечаток — тот же 409 и тот же свежий отпечаток в ответе. Иначе рукопожатие было
       * бы формальностью: «пришли что угодно в поле `acknowledge`» ничем не отличается от «не
       * спрашивать вовсе», а именно этого Р21 и не допускает.
       */
      const forged = await issueCountingNumbers(route.id, {
        version: route.version,
        acknowledge: { fingerprint: 'f'.repeat(64) },
      });
      expect(ackOf(forged.res).fingerprint).toBe(details.fingerprint);
      expect(await waybillsOf(route.id)).toHaveLength(0);
      expect(forged.burned).toBe(0);

      // И только с настоящим отпечатком лист выписывается — вторым запросом, как это делает окно.
      const issued = await issueCountingNumbers(route.id, {
        version: route.version,
        acknowledge: { fingerprint: details.fingerprint },
      });
      expect(issued.res.statusCode, issued.res.body).toBe(200);

      /*
       * Под какими предупреждениями выдан лист — в самом листе, той же вставкой, что и документ
       * (Р21): аудит намеренно best-effort и для решения человека не хранилище.
       */
      const sheets = await waybillsOf(route.id);
      expect(sheets).toHaveLength(1);
      /*
       * «Номер расходуется ровно один раз — на выданный лист» — двумя половинами: лист у рейса
       * один и номер он взял из этого запроса, а сгоревших номеров запрос не оставил. Порознь ни
       * одна из них этого не говорит: лист мог достаться второй попытке, а нулевой расход — рейсу
       * без листа.
       */
      expect(
        Number(sheets[0]!.number),
        'лист занумерован этой выпиской, а не подобран из прежних',
      ).toBeGreaterThanOrEqual(issued.mark);
      expect(issued.burned, 'выписка стоила ровно одного номера — своего').toBe(0);
      const record = sheets[0]!.issue_warnings as {
        schemaVersion: number;
        status: string;
        fingerprint: string;
        warnings: { facts: { code: string } }[];
      };
      expect(record.status).toBe('acknowledged');
      expect(record.fingerprint).toBe(details.fingerprint);
      // Список целиком, с сообщениями: через полгода разбираться будут по нему, а не по кодам.
      expect(record.warnings.map((w) => w.facts.code).sort()).toEqual([
        'blank_task',
        'driver_documents',
      ]);
    }, 120_000);

    it('подтверждают положение дел, а не нажатие: сменился водитель — сменился отпечаток', async () => {
      const route = await emptyRoute(ctx.barePersonId);
      const stale = ackOf(await issue(route.id, { version: route.version })).fingerprint;

      /*
       * Ровно тот случай, ради которого рукопожатие сделано отпечатком: окно открыли, пока водителем
       * стоял человек без документов, а нажали кнопку после того, как рейс переписали на другого.
       * Правку рейса лист не запрещает — его ещё нет.
       */
      const moved = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-routes/${route.id}`,
        headers: ctx.admin,
        payload: { driverPersonId: ctx.documentedPersonId, version: route.version },
      });
      expect(moved.statusCode, moved.body).toBe(200);
      const version = moved.json().version as number;

      const refused = await issueCountingNumbers(route.id, {
        version,
        acknowledge: { fingerprint: stale },
      });
      const details = ackOf(refused.res);
      expect(details.fingerprint, 'набор изменился — прежнее подтверждение силы не имеет').not.toBe(
        stale,
      );
      // Пробел в документах закрылся вместе со сменой водителя, пустое задание осталось.
      expect(details.warnings.map((w) => w.facts.code)).toEqual(['blank_task']);
      expect(await waybillsOf(route.id)).toHaveLength(0);
      expect(refused.burned, 'на отказе номер серии не сгорает').toBe(0);

      const issued = await issue(route.id, {
        version,
        acknowledge: { fingerprint: details.fingerprint },
      });
      expect(issued.statusCode, issued.body).toBe(200);
      const record = (await waybillsOf(route.id))[0]!.issue_warnings as {
        status: string;
        fingerprint: string;
      };
      expect(record.status).toBe('acknowledged');
      expect(record.fingerprint).toBe(details.fingerprint);
    }, 120_000);
  },
);
