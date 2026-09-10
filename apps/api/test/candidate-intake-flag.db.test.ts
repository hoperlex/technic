import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficeEquipmentCandidateDto, ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * РУБИЛЬНИК ПРИЁМА СООБЩЕНИЙ О ТЕХНИКЕ: СЕРВЕРНАЯ ПОЛОВИНА (план
 * `docs/office-equipment-request-subject-plan.md`, Р10–Р11, этап Э4; контракт — план кандидата, §14).
 *
 * Волна кандидатов (ADR 0165) написана и лежит закрытой; открывает её выдача прав, а миграция прав
 * применяется ДО перезапуска приложения — то есть без рубильника выдача немедленно открыла бы приём
 * СТАРЫМ кодом, который ни о каком включении не знает. Рубильник переворачивает порядок: код едет
 * закрытым, а открывает его `UPDATE` по работающему серверу.
 *
 * ФАЙЛ ДОКАЗЫВАЕТ РОВНО ТРИ УТВЕРЖДЕНИЯ КОНТРАКТА, и все три — про сервер, а не про портал:
 *
 *   1. выключенный ключ отвечает 403 ДАЖЕ ДЕРЖАТЕЛЮ `officeEquipment.propose` — портал прячет
 *      третью ветвь формы, но прямой запрос мимо портала прятать нечем;
 *   2. включение открывает приём БЕЗ ПЕРЕЗАПУСКА, а обратный `UPDATE` закрывает его так же —
 *      рубильник заведён ради АВАРИЙНОГО выключения, и кэш превратил бы его в «выключится потом»;
 *   3. выключение прекращает ПРИТОК, но не запирает РАЗБОР: очередь проверяющего, карточка
 *      сообщения и решения по нему работают при закрытом приёме. Разобрать накопленное всё равно
 *      кто-то должен, и второй рубильник на очереди означал бы, что аварийное выключение оставляет
 *      сообщения без разбора навсегда.
 *
 * Соседний файл `feature-flags-session.db.test.ts` доказывает другую половину — чтение ключа и его
 * отдачу в четырёх ответах сессии; здесь ключ только щёлкается, а проверяются ДВЕРИ.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл щёлкает ГЛОБАЛЬНЫМ состоянием, и параллельный
 * прогон по общей базе видел бы приём то открытым, то закрытым в середине собственного случая.
 * Утверждения «отказ не завёл ни одной строки» по общей базе тоже были бы ложными.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/candidate-intake-flag.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_candidate_intake_flag_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-intake-flag-password-123';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';
const CANDIDATES = '/api/v1/office-equipment-candidates';
const INTAKE = 'office_equipment_candidate_intake';

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
  /** Заводит карточки парка: у него словарь прав целиком. */
  admin: TestUser;
  /** Держатель `officeEquipment.propose`: именно ему рубильник обязан отвечать 403. */
  requester: TestUser;
  /** Проверяющий: `officeEquipment.review` плюс `write` — им и разбирается принятое. */
  reviewer: TestUser;
  objectId: string;
  typeId: string;
}

let ctx: Ctx;
/** Пара «кандидат + заявка», заведённая при открытом приёме: её и разбирают при закрытом. */
let accepted: { requestId: string; candidateId: string } | null = null;

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

function inject(
  method: 'GET' | 'POST',
  url: string,
  auth: Auth,
  payload?: unknown,
  headers?: Record<string, string>,
) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...auth, ...headers },
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

/**
 * Щелчок рубильника — тем же `UPDATE`, каким его щёлкает выкат (Р10). Административной ручки у ключа
 * нет и в этой волне не будет, и подменять её здесь прямой записью в таблицу — не срезание угла, а
 * единственный существующий способ переключения.
 */
async function setIntake(isEnabled: boolean): Promise<void> {
  const res = await ctx.db.execute(
    sql`UPDATE feature_flags SET is_enabled = ${isEnabled} WHERE key = ${INTAKE}`,
  );
  // Строка обязана существовать: `UPDATE` по отсутствующей молча меняет ноль строк, и весь файл
  // зеленел бы при выключенном приёме, ничего не проверив.
  expect(res.rowCount, 'строка рубильника заведена миграцией 0293').toBe(1);
}

/** Сообщение о технике: шесть заявленных реквизитов (план кандидата, Р7). */
function candidateBody(tag: string, extra: Record<string, unknown> = {}) {
  return {
    description: 'Не печатает, зажёвывает бумагу',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    equipmentCandidate: {
      equipmentTypeId: ctx.typeId,
      declaredModel: 'Kyocera ECOSYS M3145',
      inventoryNumber: `CF-${RUN}-${tag}`,
      objectId: ctx.objectId,
      location: 'каб. 214',
    },
    ...extra,
  };
}

/** Ключ идемпотентности — обязательная часть ветки кандидата (§8): без него ручка отвечает 400. */
function propose(auth: Auth, tag: string) {
  return inject('POST', REQUESTS, auth, candidateBody(tag), { 'idempotency-key': randomUUID() });
}

async function counts(): Promise<{ requests: number; candidates: number }> {
  const res = await ctx.db.execute<{ requests: number; candidates: number }>(sql`
    SELECT (SELECT count(*) FROM service_requests)::int AS requests,
           (SELECT count(*) FROM office_equipment_candidates)::int AS candidates`);
  return res.rows[0]!;
}

describe.skipIf(!DB_URL)('рубильник приёма сообщений о технике: серверный fail-closed', () => {
  /** Своя единица на случай: по одной технике незакрытая заявка бывает только одна (Р21). */
  let unitNo = 0;
  async function freshUnit(): Promise<string> {
    unitNo += 1;
    const res = await inject('POST', EQUIPMENT, ctx.admin.auth, {
      equipmentTypeId: ctx.typeId,
      name: `МФУ рубильника ${unitNo} ${RUN}`,
      objectId: ctx.objectId,
      location: 'кабинет 214',
      inventoryNumber: `CFU-${RUN}-${unitNo}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

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
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`CF-${RUN}`}, ${`Площадка ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-cf-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const requester = await makeUser('requester', 'shtab');
    const reviewer = await makeUser('reviewer', 'shtab');
    for (const userId of [requester.id, reviewer.id]) {
      await db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${userId}, ${objectId})`);
    }

    /*
     * ПРАВА ВЫДАЮТСЯ СОБРАННЫМИ НАБОРАМИ (ADR 0106), а не берутся из матрицы, и это здесь принципиально
     * для заявителя: файл доказывает, что закрытый рубильник отвечает 403 ДЕРЖАТЕЛЮ `propose`. Возьми
     * мы право из роли, случай молча превратился бы в «у него нет права» на первой же правке матрицы —
     * то есть перестал бы проверять рубильник, оставаясь зелёным.
     *
     * Строка в `grant_roles` обязательна: права набора считаются соединением с ролями держателя
     * (`grantPermissionsExpr`), и набор без неё не даёт ничего.
     */
    const makeGrant = async (
      code: string,
      permissions: string[],
      holderId: string,
    ): Promise<void> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, is_system) VALUES (${code}, ${`Набор прогона ${code}`}, false)
        RETURNING id`);
      const grantId = row.rows[0]!.id;
      await db.execute(sql`INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab')`);
      for (const permission of permissions) {
        await db.execute(sql`
          INSERT INTO grant_permissions (grant_id, permission) VALUES (${grantId}, ${permission})`);
      }
      await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
        VALUES (${holderId}, ${grantId}, ${adminUser.id}, 'manual')`);
    };
    await makeGrant(`cf_propose_${RUN}`, ['officeEquipment.propose'], requester.id);
    /*
     * Проверяющий: `review` — решать, `write` — заводить карточку подтверждением (его требует
     * `PERMISSION_REQUIRES`), `serviceRequests.read` — читать связанную заявку. Прав приёма у него
     * нет вовсе: разбор и приток — разные работы, и файл проверяет как раз то, что рубильник трогает
     * одну из них.
     */
    await makeGrant(
      `cf_review_${RUN}`,
      [
        'officeEquipment.read',
        'officeEquipment.write',
        'officeEquipment.review',
        'serviceRequests.read',
      ],
      reviewer.id,
    );

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const app = await buildApp();
    await app.ready();

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
      admin: await withAuth(adminUser),
      requester: await withAuth(requester),
      reviewer: await withAuth(reviewer),
      objectId,
      typeId,
    };
  }, 180_000);

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению, а оставленная база
    // помешала бы следующему прогону завести её заново.
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

  // ── 1. Выключенный рубильник: приём закрыт всем (Р10, Р11) ──

  describe('выключенный рубильник', () => {
    it('приём закрыт держателю officeEquipment.propose — 403 и ни одной строки', async () => {
      /*
       * СОСТОЯНИЕ ЗАДАЁТСЯ ЯВНО, И ЭТО ПЕРЕМЕНА ПРОТИВ ПЕРВОЙ РЕДАКЦИИ ТЕСТА. Раньше закрытый приём
       * брался умолчанием миграции 0293 — «тест ничего не щёлкал», и этим же доказывалось, что
       * выпуск A ехал закрытым. Итогом набора миграций доказать это больше нельзя: последний шаг
       * выпуска B переведён из ручного `UPDATE` в миграцию 0297 (ADR 0177, решение 8а), и база,
       * накатанная целиком, приходит с ОТКРЫТЫМ приёмом. Проверяемое утверждение от этого не
       * меняется — сервер обязан отбивать сообщение при выключенном рубильнике, — меняется лишь то,
       * чем задано состояние. Итог набора проверяется строкой ниже: сдвинься он обратно, тест
       * скажет об этом прежде, чем начнёт проверять отказ.
       */
      const row = await ctx.db.execute<{ is_enabled: boolean }>(
        sql`SELECT is_enabled FROM feature_flags WHERE key = ${INTAKE}`,
      );
      expect(row.rows[0]!.is_enabled, 'миграция 0297 оставила приём открытым').toBe(true);
      await setIntake(false);

      const before = await counts();
      const res = await propose(ctx.requester.auth, 'closed');
      expect(res.statusCode, res.body).toBe(403);
      /*
       * КОД ОТКАЗА СВОЙ, и проверяется он, а не текст: «вам не положено» лечится выдачей права и
       * адресовано администратору учёток, «приём закрыт» не лечится ничем на стороне человека.
       * Один код на два исхода отправлял бы половину обращений не туда.
       */
      expect(res.json().code).toBe('feature_disabled');
      expect(await counts(), 'отказ не завёл ни кандидата, ни заявки').toEqual(before);
    });

    it('две старые ветви предмета работают: обычная заявка с аппаратом заводится', async () => {
      /*
       * Отрицательный контроль, без которого первый случай ничего не стоит: рубильник обязан гасить
       * ТРЕТЬЮ ветвь предмета, а не ручку заведения целиком. Тот же субъект, та же ручка, тот же
       * закрытый ключ — и 201.
       */
      const res = await inject('POST', REQUESTS, ctx.requester.auth, {
        officeEquipmentId: await freshUnit(),
        description: 'Не печатает по сети',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      });
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  // ── 2. Включение по работающему серверу (Р11, выпуск B) ──

  describe('включённый рубильник', () => {
    it('после UPDATE пара «кандидат + заявка» заводится, без перезапуска приложения', async () => {
      await setIntake(true);
      const res = await propose(ctx.requester.auth, 'open');
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;
      expect(dto.equipment, 'предмет описан сообщением, а не ссылкой на справочник').toBeNull();

      const row = await ctx.db.execute<{ equipment_candidate_id: string | null }>(
        sql`SELECT equipment_candidate_id FROM service_requests WHERE id = ${dto.id}`,
      );
      const candidateId = row.rows[0]!.equipment_candidate_id;
      expect(candidateId).not.toBeNull();
      // Пара уезжает следующим блоку: разбор принятого проверяется уже при закрытом приёме.
      accepted = { requestId: dto.id, candidateId: candidateId! };
    });
  });

  // ── 3. Аварийное выключение: приток прекращён, разбор — нет (Р10, Р11) ──

  describe('обратное выключение', () => {
    it('приток прекращается тем же UPDATE — новое сообщение снова 403', async () => {
      await setIntake(false);
      const before = await counts();
      const res = await propose(ctx.requester.auth, 'reclosed');
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe('feature_disabled');
      expect(await counts()).toEqual(before);
    });

    it('очередь проверяющего и карточка сообщения работают при закрытом приёме', async () => {
      expect(accepted, 'пара заведена предыдущим блоком').not.toBeNull();
      const queue = await inject('GET', `${CANDIDATES}?pageSize=50`, ctx.reviewer.auth);
      expect(queue.statusCode, queue.body).toBe(200);
      const items = (queue.json() as { items: OfficeEquipmentCandidateDto[] }).items;
      expect(
        items.map((item) => item.id),
        'принятое сообщение осталось в очереди',
      ).toContain(accepted!.candidateId);

      const card = await inject('GET', `${CANDIDATES}/${accepted!.candidateId}`, ctx.reviewer.auth);
      expect(card.statusCode, card.body).toBe(200);
      expect((card.json() as OfficeEquipmentCandidateDto).status).toBe('pending');
    });

    it('решение проверяющего проходит: карточка заводится, сообщение закрывается', async () => {
      /*
       * САМОЕ ВАЖНОЕ УТВЕРЖДЕНИЕ ФАЙЛА. Подтверждение — решение, которое ПИШЕТ в справочник, и
       * оградить его рубильником было бы соблазнительнее всего: «приём закрыт — значит ничего не
       * заводим». Именно этого делать нельзя: выключение прекращает приток, а накопленную очередь
       * обязан кто-то разобрать, иначе аварийное выключение оставляет сообщения без ответа навсегда.
       */
      const res = await inject(
        'POST',
        `${CANDIDATES}/${accepted!.candidateId}/confirm`,
        ctx.reviewer.auth,
        {
          expectedVersion: 1,
          equipment: {
            equipmentTypeId: ctx.typeId,
            name: 'Kyocera ECOSYS M3145',
            inventoryNumber: `CF-${RUN}-open`,
            objectId: ctx.objectId,
            location: 'каб. 214',
          },
        },
      );
      expect(res.statusCode, res.body).toBe(200);
      const decision = res.json() as OfficeEquipmentCandidateDto;
      expect(decision.status).toBe('confirmed');
      expect(decision.resultEquipment?.id, 'карточка парка заведена').toBeTruthy();
    });
  });
});
