import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * РУБИЛЬНИК ПРИЁМА В ОТВЕТАХ СЕССИИ (план `docs/office-equipment-request-subject-plan.md`, Р10,
 * этап Э4; контракт — `docs/office-equipment-candidate-plan.md`, §14).
 *
 * Проверяется ровно одно утверждение и его цена: **все четыре ответа, устанавливающие сессию
 * (`login`, `refresh`, `/auth/me`, смена пароля), отдают одно и то же значение**, по умолчанию
 * выключенное, и `UPDATE` по строке меняет его во всех четырёх сразу.
 *
 * ПОЧЕМУ ЧЕТЫРЕ, А НЕ ОДИН `/auth/me`. Сборщик ответа в `routes/auth.ts` один, и «поле появилось»
 * проверялось бы одним запросом. Но каждая из четырёх ручек — самостоятельная дыра: портал рисует
 * экраны по ответу ВХОДА, ещё не спросив `/auth/me`; `refresh` обязан донести аварийное выключение
 * до открытой вкладки; смена пароля выдаёт новую сессию и вместе с ней новый ответ. Забытое поле в
 * одной из них означало бы, что приём кандидатов открыт или закрыт в зависимости от того, КАК
 * человек вошёл, — и поймать это можно только запросом в каждую.
 *
 * ЗАЧЕМ БАЗА. Значение живёт строкой (`feature_flags`, миграция 0293), и всё, что здесь
 * утверждается, — про эту строку: что миграция её завела, что умолчание выключенное и что `UPDATE`
 * доезжает до ответа без перезапуска приложения. На подменах проверялась бы сборка ответа, то есть
 * ровно та половина, которая и так видна глазами.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: тест ПЕРЕКЛЮЧАЕТ глобальную строку состояния, и в
 * общей базе он ломал бы соседние прогоны — а его собственное «по умолчанию выключено» ломал бы
 * любой сосед, оставивший рубильник включённым. База заводится, мигрируется с нуля и сносится в
 * `afterAll` (образец — `service-request-candidate-intake.db.test.ts`).
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/feature-flags-session.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_feature_flags_session_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
/** Приметы адреса и ФИО в пароль попадать не должны (`passwordIdentityIssue` при регистрации). */
const PASSWORD = 'db-feature-flags-secret-123';
const NEW_PASSWORD = 'db-feature-flags-secret-456';

const INTAKE = 'office_equipment_candidate_intake';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Читатель рубильника — тот же, что зовёт маршрут заявок: ответ ручки сверяется с ним. */
  isFeatureEnabled: (
    reader: typeof AppDb,
    key: 'office_equipment_candidate_intake',
  ) => Promise<boolean>;
}

let ctx: Ctx;
let seq = 0;

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
  // Смена пароля уведомляет владельца ящика письмом; к рубильнику это отношения не имеет, и с
  // выключенной почтой операция состоится без письма.
  process.env.MAIL_ENABLED = 'false';
}

/**
 * Свой адрес на каждое обращение: ручки входа ограничены десятью попытками в минуту с адреса, а
 * этот файл только их и дёргает.
 */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Учётка с настоящим паролем: предмет проверки — ответы входа, и хеш здесь обязан быть живым. */
async function newUser(): Promise<string> {
  seq += 1;
  const email = `db-feature-flags-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  await ctx.db.execute(sql`
    INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                       is_active, email_verified_at)
    VALUES (${email}, 'Тестовый', 'Держатель', ${`Сессионный ${seq}`},
            ${await hashPassword(PASSWORD)}, 'shtab', true, now())`);
  return email;
}

interface SessionResponse {
  accessToken: string;
  user: AuthUser;
}

function cookieJar(cookies: { name: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(cookies.map((c) => [c.name, c.value]));
}

/**
 * Все четыре ответа сессии одной учётки, в порядке жизни вкладки: вход → `refresh` → `/auth/me` →
 * смена пароля. Учётка на каждый вызов своя: смена пароля отзывает сессии и меняет пароль, и
 * второй прогон по тому же человеку проверял бы уже не рубильник, а порядок вызовов.
 */
async function sessionResponses(): Promise<Record<string, AuthUser>> {
  const email = await newUser();
  const loginRes = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email, password: PASSWORD },
  });
  expect(loginRes.statusCode, loginRes.body).toBe(200);
  const login = loginRes.json<SessionResponse>();
  const jar = cookieJar(loginRes.cookies as { name: string; value: string }[]);

  const refreshRes = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    remoteAddress: nextAddress(),
    cookies: jar,
  });
  expect(refreshRes.statusCode, refreshRes.body).toBe(200);
  const refresh = refreshRes.json<SessionResponse>();

  const meRes = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    remoteAddress: nextAddress(),
    headers: { authorization: `Bearer ${refresh.accessToken}` },
  });
  expect(meRes.statusCode, meRes.body).toBe(200);

  const changeRes = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/change-password',
    remoteAddress: nextAddress(),
    headers: { authorization: `Bearer ${refresh.accessToken}` },
    payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  expect(changeRes.statusCode, changeRes.body).toBe(200);

  return {
    login: login.user,
    refresh: refresh.user,
    me: meRes.json<AuthUser>(),
    changePassword: changeRes.json<SessionResponse>().user,
  };
}

/** Что ответили все четыре — списком, чтобы расхождение было видно с именем ручки. */
function featuresOf(responses: Record<string, AuthUser>): Record<string, string[] | undefined> {
  return Object.fromEntries(Object.entries(responses).map(([name, user]) => [name, user.features]));
}

/**
 * Есть ли СВОЙ ключ в каждом из четырёх ответов — и ничего про чужие.
 *
 * Полным равенством списка это писалось, пока рубильник был один. Ключей с тех пор стало больше
 * (приём писем от аппаратов открыт миграцией 0328), и равенство ломало бы этот тест на чужой
 * работе, ничего не проверив про этот ключ. Строгость за своим ключом остаётся полная: он обязан
 * быть во всех четырёх ответах или не быть ни в одном — половинчатый ответ и есть та беда, ради
 * которой файл написан.
 */
function intakeIn(responses: Record<string, AuthUser>): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(featuresOf(responses)).map(([name, keys]) => [
      name,
      // `undefined` — ответ СТАРОГО сервера, не знающего поля вовсе; для этого файла он такой же
      // «нет ключа», но различать их полезнее, чем схлопывать в `false` молча.
      Array.isArray(keys) && keys.includes(INTAKE),
    ]),
  );
}

/** Ожидание «ключ виден всюду» / «не виден нигде» — одной строкой на четыре ответа. */
const everywhere = (seen: boolean) => ({
  login: seen,
  refresh: seen,
  me: seen,
  changePassword: seen,
});

async function setIntake(isEnabled: boolean): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE feature_flags SET is_enabled = ${isEnabled}, updated_at = now() WHERE key = ${INTAKE}`,
  );
}

describe.skipIf(!DB_URL)('рубильник приёма в ответах сессии (живая схема)', () => {
  beforeAll(async () => {
    /*
     * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе
     * (`pgcrypto` для `gen_random_uuid`, `citext` для адреса учётки, `pg_trgm` для поиска).
     */
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
    const { isFeatureEnabled } = await import('../src/services/feature-flags');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();
    ctx = { app, db, closeDb, isFeatureEnabled };
  }, 180_000);

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению, а оставленная помешала бы
    // следующему прогону завести её заново.
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

  describe('итог набора миграций', () => {
    it('строка рубильника заведена и включена', async () => {
      /*
       * СПРАШИВАЕТСЯ СВОЙ КЛЮЧ, А НЕ ВЕСЬ СОСТАВ ТАБЛИЦЫ. Рубильник у волны кандидатов был первым и
       * какое-то время единственным, отчего утверждение и писалось составом; ключей с тех пор стало
       * больше — их заводят соседние волны, — и состав таблицы ломал бы этот тест на чужой работе,
       * ничего не проверив про эту. За своим ключом при этом остаётся вся строгость: он обязан
       * существовать в единственном экземпляре и быть включённым.
       */
      const res = await ctx.db.execute<{ key: string; is_enabled: boolean }>(
        sql`SELECT key, is_enabled FROM feature_flags WHERE key = ${INTAKE}`,
      );
      /*
       * УМОЛЧАНИЕ СМЕНИЛОСЬ ВМЕСТЕ СО СПОСОБОМ ВКЛЮЧЕНИЯ (ADR 0177, решение 8а). 0293 заводит строку
       * выключенной — выпуск A обязан ехать закрытым, — а 0297 делает тот же `UPDATE … = true`,
       * который прежде набирали руками по живому серверу. Накатанная целиком база приходит поэтому
       * с открытым приёмом, и проверяется здесь именно итог набора: он и достаётся каждому стенду,
       * поднятому из миграций, — рассинхрон контуров, стоивший разбирательства 09.09.2026, начинался
       * ровно с того, что итог у прода и дева был разный.
       *
       * Строка обязана СУЩЕСТВОВАТЬ: «нет строки» читается тем же fail-closed, и включать 0297 было
       * бы нечего — `UPDATE` по отсутствующей строке молча меняет ноль строк.
       */
      expect(res.rows).toEqual([{ key: INTAKE, is_enabled: true }]);
    });

    it('все четыре ответа сессии называют включённый ключ', async () => {
      const responses = await sessionResponses();

      // Поле присутствует во всех четырёх и называет ключ. Отсутствие ключа клиент трактует как
      // «закрыто» (fail-closed), и подмена одного другим прошла бы незамеченной без этой строгости.
      expect(intakeIn(responses)).toEqual(everywhere(true));
    });

    it('читатель рубильника отвечает то же, что ответы сессии', async () => {
      // Ту же функцию зовёт `POST /service-requests`, отбивая прямой запрос мимо портала: разойдись
      // эти два ответа — портал прятал бы дверь, которую сервер открывает, или наоборот.
      expect(await ctx.isFeatureEnabled(ctx.db, INTAKE)).toBe(true);
    });
  });

  describe('аварийное выключение и обратное включение', () => {
    it('обратный UPDATE закрывает приём: во всех четырёх ответах пустой список', async () => {
      await setIntake(false);
      const responses = await sessionResponses();

      /*
       * ПОРЯДОК ПАРЫ ПЕРЕВЁРНУТ ВСЛЕД ЗА УМОЛЧАНИЕМ: пока набор миграций оставлял приём закрытым,
       * первым проверялось включение. Теперь первым идёт выключение — иначе `setIntake(true)` на
       * уже открытом рубильнике не проверял бы ничего и зеленел бы даже при сломанном чтении.
       *
       * Fail-closed проверяется выставленным состоянием, а не умолчанием набора: пропавший ключ
       * здесь означает «выключили», и это ровно тот путь, которым приём гасят на проде.
       */
      expect(intakeIn(responses)).toEqual(everywhere(false));
      expect(await ctx.isFeatureEnabled(ctx.db, INTAKE)).toBe(false);
    });

    it('обратно открывается тем же UPDATE, без перезапуска приложения', async () => {
      await setIntake(true);
      const responses = await sessionResponses();

      expect(intakeIn(responses)).toEqual(everywhere(true));
      // Перезапуска приложения не было: значение читается на каждый ответ, а не при старте — иначе
      // аварийное выключение не действовало бы вовсе, а обратное включение требовало бы рестарта.
      expect(await ctx.isFeatureEnabled(ctx.db, INTAKE)).toBe(true);
    });
  });
});
