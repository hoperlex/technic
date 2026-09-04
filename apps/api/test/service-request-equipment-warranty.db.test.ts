import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * СРОК ГАРАНТИИ ЕДИНИЦЫ ПРИЕЗЖАЕТ В СТРОКЕ ЗАЯВКИ (фикс Ф3 плана
 * `docs/office-equipment-candidate-plan.md`, §13).
 *
 * До фикса колонку «Гарантия» в списке заявок питал ОТДЕЛЬНЫЙ запрос всего справочника — страница
 * в 500 строк, тот же потолок, что у селектора формы (Н11). Проверять там было нечего: колонка
 * показывала то, что успело поместиться, и у парка больше страницы замолкала молча. Теперь срок
 * отдаёт сервер в блоке предмета, и утверждений стало два, а не одно.
 *
 * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ.
 *
 *   1. Поле есть и в карточке, и в строке списка, и значение в них ОДНО: сборка у обеих ручек
 *      общая (`toDto`), и разойтись они могут только правкой, которая эту общность сломает.
 *   2. Значение ЖИВОЕ, а не снимок заявки. Это половина смысла фикса: срок гарантии живёт в
 *      карточке справочника и меняется после заведения заявки — талон нашли неделей позже,
 *      гарантию продлили, ошибочную дату стёрли. Снимок отвечал бы прошлым на вопрос «действует
 *      ли гарантия СЕЙЧАС».
 *   3. Три состояния разведены: дата, `null` («срок в карточке не заведён») и отсутствие блока
 *      предмета целиком («спрашивать не у чего» — карточки нет). Слейся два последних, портал
 *      отвечал бы «гарантии нет» там, где её носителя не существует.
 *   4. Поле видно ТОМУ, КОМУ ОТКРЫТ СПРАВОЧНИК (решение владельца 04.09.2026, раздел 3): живая
 *      колонка парка — не часть снимка заявки, и сервисной компании, у которой справочника нет
 *      (`COUNTERPARTY_TYPE_PERMISSIONS.service`), она не полагается. Утверждение стоит на ОДНОЙ
 *      заявке с двумя читателями: порознь «сервису не видно» зеленело бы и на заявке без срока.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Проверяемое — не «маршрут вернул поле», а СВЯЗЬ двух ручек разных
 * модулей: срок пишет справочник (`PATCH /office-equipment/:id`), читает заявка. Подмени карточку
 * моком — тест зеленел бы и тогда, когда заявка читает собственный снимок, а не соединение, то
 * есть ровно в том дефекте, ради которого фикс и делался. По той же причине срок здесь меняют
 * РУЧКОЙ СПРАВОЧНИКА, а не `UPDATE`'ом мимо маршрута.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: по общей идут параллельные прогоны, а здешние
 * утверждения про «то же значение в списке» смотрят на выдачу целиком. База заводится, мигрируется
 * с нуля и сносится в `afterAll` (образец — `service-request-inactive-equipment.db.test.ts`).
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/service-request-equipment-warranty.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_equipment_warranty_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-equipment-warranty-password-123';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';

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
  /** Администратор: им заводятся и правятся карточки справочника. */
  admin: TestUser;
  /**
   * Заявитель площадки. Он же держит два набора: системный `office_equipment_operator` — ради
   * `serviceRequests.createWithoutEquipment` — и собранный тестом набор с `officeEquipment.propose`
   * ради ветки кандидата. Один человек на все три вида заявки намеренно: сравниваются ВИДЫ
   * предмета, и разные читатели добавили бы к сравнению вторую переменную — область видимости.
   */
  requester: TestUser;
  /**
   * Сервисная компания — подрядчик, которому заявку назначили (ADR 0038). Права её учётки даёт тип
   * контрагента (`COUNTERPARTY_TYPE_PERMISSIONS.service`), и справочника оргтехники среди них нет
   * намеренно: «её» техника в парке ничем не отмечена, а реквизиты нужной единицы приезжают ей
   * снимком в самой заявке. Ради этого читателя раздел 3 и написан.
   */
  service: TestUser;
  serviceCounterpartyId: string;
  objectId: string;
  typeId: string;
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

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

/** Обязательная часть тела заведения: контакт заявителя и описание. */
function body(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    description: 'Не печатает, зажёвывает бумагу',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  };
}

async function create(
  extra: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<ServiceRequestDto> {
  const res = await inject('POST', REQUESTS, ctx.requester.auth, body(extra), headers);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request;
}

/**
 * Карточка заявки прямым заходом. Читатель по умолчанию — заявитель; раздел 3 спрашивает ту же
 * карточку от лица подрядчика, и параметр заведён ради него: одна и та же строка, два читателя —
 * ровно то, что там и проверяется.
 */
async function card(id: string, auth: Auth = ctx.requester.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/**
 * Та же заявка, но СТРОКОЙ СПИСКА. Именно она и была больным местом: колонка «Гарантия» живёт в
 * списке, и «в карточке поле есть» о ней не говорит ничего.
 */
async function row(id: string, auth: Auth = ctx.requester.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}?pageSize=100`, auth);
  expect(res.statusCode, res.body).toBe(200);
  const found = (res.json() as { items: ServiceRequestDto[] }).items.find((it) => it.id === id);
  if (!found) throw new Error(`заявки ${id} нет в выдаче списка`);
  return found;
}

describe.skipIf(!DB_URL)('гарантия единицы в строке заявки: живое значение справочника', () => {
  /**
   * Своя единица на каждый случай. Замок «одна открытая заявка на аппарат» (Р21) общей карточкой
   * связал бы случаи между собой: второй получал бы 409 вместо проверяемого ответа, и порядок
   * `it`-блоков стал бы частью утверждения.
   */
  async function makeEquipment(tag: string, warrantyUntil?: string): Promise<string> {
    const res = await inject('POST', EQUIPMENT, ctx.admin.auth, {
      equipmentTypeId: ctx.typeId,
      name: `МФУ ${tag} ${RUN}`,
      inventoryNumber: `EW-${tag}-${RUN}`,
      objectId: ctx.objectId,
      location: 'кабинет 214',
      ...(warrantyUntil === undefined ? {} : { warrantyUntil }),
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  /** Правка срока — ручкой справочника: связь «пишет справочник, читает заявка» и проверяется. */
  async function setWarranty(equipmentId: string, warrantyUntil: string | null): Promise<void> {
    const res = await inject('PATCH', `${EQUIPMENT}/${equipmentId}`, ctx.admin.auth, {
      warrantyUntil,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { warrantyUntil: string | null }).warrantyUntil).toBe(warrantyUntil);
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
      VALUES (${`EW-${RUN}`}, ${`Площадка ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    /*
     * ИНН с настоящей контрольной суммой: обмен справочниками выгружает базу целиком и на
     * выдуманном номере падает — падение выглядело бы дефектом чужого модуля.
     */
    const innOf = (base9: string): string => {
      const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
      const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
      return `${base9}${(sum % 11) % 10}`;
    };
    const counterparty = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис гарантии ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-6)}0`)})
      RETURNING id`);
    const serviceCounterpartyId = counterparty.rows[0]!.id;

    async function makeUser(
      tag: string,
      role: string,
      counterpartyId?: string,
    ): Promise<{ id: string; email: string }> {
      const email = `db-ew-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now(), ${counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const requester = await makeUser('requester', 'shtab');
    /*
     * Учётка подрядчика: роль `operator` плюс привязка к контрагенту типа `service`. Права ей
     * набирает не набор и не роль, а ТИП КОНТРАГЕНТА (ADR 0038), поэтому ничего сверх этой строки
     * ей не выдаётся — иначе прогон проверял бы выданное тестом, а не поставочный состав.
     */
    const serviceUser = await makeUser('service', 'operator', serviceCounterpartyId);
    // Площадка нужна обоим по разным причинам: заявителю — как его область, администратору —
    // чтобы карточка справочника заводилась и правилась им же без разговора об области.
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${requester.id}, ${objectId})`);

    /*
     * Набор «Оператор оргтехники» — СИСТЕМНЫЙ, тот самый, что раздаёт администратор: из него
     * заявитель берёт `serviceRequests.createWithoutEquipment`. Собранный тестом набор из одного
     * права молчал бы о том, уехало ли это право из состава наборов.
     */
    const operatorGrant = await db.execute<{ id: string }>(
      sql`SELECT id FROM grants WHERE code = 'office_equipment_operator' AND deleted_at IS NULL`,
    );
    const operatorGrantId = operatorGrant.rows[0]?.id;
    if (!operatorGrantId)
      throw new Error('в базе нет системного набора «office_equipment_operator»');

    /*
     * А право «сообщить о технике» набором пока не раздаётся: составы наборов едут выпуском B
     * плана кандидата (§14, M4), и до него набор собирается тестом — законным способом по ADR 0106.
     * Роль в `grant_roles` обязательна: права считаются соединением с ней, и набор без строки роли
     * не даёт держателю ничего.
     */
    const proposeGrant = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, is_system)
      VALUES (${`ew_propose_${RUN}`}, 'Сообщение о технике', false)
      RETURNING id`);
    const proposeGrantId = proposeGrant.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${proposeGrantId}, 'shtab')`);
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${proposeGrantId}, 'officeEquipment.propose')`);
    for (const grantId of [operatorGrantId, proposeGrantId]) {
      await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
        VALUES (${requester.id}, ${grantId}, ${adminUser.id}, 'manual')`);
    }

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
      service: await withAuth(serviceUser),
      serviceCounterpartyId,
      objectId,
      typeId,
    };
  }, 180_000);

  afterAll(async () => {
    // База своя — уносим её целиком, а не выковыриваем фикстуры по суффиксу: чужих строк в ней нет
    // по построению, и оставленная база помешала бы следующему прогону завести её заново.
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

  // ── 1. Поле есть, и оно одно на обе ручки ──

  describe('выдача', () => {
    it('срок карточки приходит и в карточке заявки, и в строке списка', async () => {
      const equipmentId = await makeEquipment('listed', '2031-05-20');
      const created = await create({ officeEquipmentId: equipmentId });

      // Ответ заведения — та же сборка, и проверяется он вместе с остальными: разойдись он с
      // карточкой, форма показывала бы одно, а список сразу после закрытия — другое.
      expect(created.equipment?.warrantyUntil).toBe('2031-05-20');
      expect((await card(created.id)).equipment?.warrantyUntil).toBe('2031-05-20');
      expect((await row(created.id)).equipment?.warrantyUntil).toBe('2031-05-20');
    });

    it('карточка без талона отдаёт null внутри блока предмета, а не пустой блок', async () => {
      /*
       * Разница содержательна: `null` — «срок не заведён», и портал рисует на него прочерк. Пустой
       * блок означал бы «аппарата у заявки нет», то есть другое состояние заявки целиком.
       */
      const equipmentId = await makeEquipment('untitled');
      const dto = await create({ officeEquipmentId: equipmentId });

      expect(dto.equipment).not.toBeNull();
      expect(dto.equipment?.id).toBe(equipmentId);
      expect(dto.equipment?.warrantyUntil).toBeNull();
      expect((await row(dto.id)).equipment?.warrantyUntil).toBeNull();
    });

    it('у заявки без аппарата блока предмета нет вовсе: спрашивать срок не у чего', async () => {
      // Заявка без аппарата (Р8): носителя гарантии не существует, и «нечего показать» выражено
      // отсутствием блока, а не значением поля внутри него.
      const dto = await create({ objectId: ctx.objectId });

      expect(dto.equipment).toBeNull();
      expect((await card(dto.id)).equipment).toBeNull();
      expect((await row(dto.id)).equipment).toBeNull();
    });

    it('у заявки с непроверенным кандидатом — тот же ответ: карточки ещё нет', async () => {
      /*
       * Сообщение о технике (план кандидата, Р2): предмет у заявки есть, но лежит он в кандидате, а
       * карточки парка — и вместе с ней гарантии — не существует до проверки. Ответ обязан
       * совпадать с заявкой без аппарата: `null` здесь читается как «нечего показать», а не как
       * «гарантии нет». После подтверждения кандидата (Р13) заявка получит ссылку на заведённую
       * карточку и срок приедет тем же полем — без второго запроса и без правки портала.
       */
      const dto = await create(
        {
          equipmentCandidate: {
            equipmentTypeId: ctx.typeId,
            declaredModel: 'Kyocera ECOSYS M3145',
            inventoryNumber: `EW-CAND-${RUN}`,
            objectId: ctx.objectId,
            location: 'каб. 214',
          },
        },
        { 'idempotency-key': randomUUID() },
      );

      expect(dto.equipment).toBeNull();
      expect((await row(dto.id)).equipment).toBeNull();
    });
  });

  // ── 2. Значение живое, а не снимок заявки ──

  describe('срок меняется в справочнике — заявка читает новый', () => {
    it('талон, найденный ПОСЛЕ заведения, виден в уже заведённой заявке', async () => {
      /*
       * Главный случай фикса и главный довод против снимка. Заявку заводят по сломанному аппарату
       * сразу, а талон поставщика находят днём позже — и решение «чинить за деньги или требовать с
       * поставщика» принимают уже после этого. Снимок, снятый при заведении, отвечал бы на него
       * пустотой навсегда, пока кто-нибудь не сообразил бы завести заявку заново.
       */
      const equipmentId = await makeEquipment('found');
      const dto = await create({ officeEquipmentId: equipmentId });
      expect(dto.equipment?.warrantyUntil).toBeNull();

      await setWarranty(equipmentId, '2032-03-01');

      expect((await card(dto.id)).equipment?.warrantyUntil).toBe('2032-03-01');
      expect((await row(dto.id)).equipment?.warrantyUntil).toBe('2032-03-01');
    });

    it('продление и снятие срока читаются там же и без правки заявки', async () => {
      // Заявку при этом не трогают вовсе: ни версия, ни один её реквизит не меняются — меняется
      // карточка. Ровно поэтому поле и не может быть снимком: обновлять его было бы нечем.
      const equipmentId = await makeEquipment('extended', '2030-01-01');
      const dto = await create({ officeEquipmentId: equipmentId });
      const versionBefore = dto.version;

      await setWarranty(equipmentId, '2033-01-01');
      expect((await row(dto.id)).equipment?.warrantyUntil).toBe('2033-01-01');

      // Снятие ошибочной даты возвращает честное «не знаем», а не вчерашнее значение.
      await setWarranty(equipmentId, null);
      const after = await card(dto.id);
      expect(after.equipment?.warrantyUntil).toBeNull();
      expect(after.version).toBe(versionBefore);
    });

    it('реквизиты предмета при этом остаются снимком: переименование карточки их не трогает', async () => {
      /*
       * Отрицательный контроль ко всему разделу и граница фикса. Живым стало ОДНО поле, а не блок:
       * реквизиты отвечают на «что чинили тогда», и переименование карточки не вправе переписать
       * заведённую заявку. Разъедься эти два правила — заявка либо потеряла бы историчность
       * реквизитов, либо оставила бы гарантию прошлогодней.
       */
      const equipmentId = await makeEquipment('renamed', '2030-06-30');
      const dto = await create({ officeEquipmentId: equipmentId });
      const nameAtCreation = dto.equipment?.name;

      const renamed = await inject('PATCH', `${EQUIPMENT}/${equipmentId}`, ctx.admin.auth, {
        name: `МФУ переименованный ${RUN}`,
        warrantyUntil: '2034-06-30',
      });
      expect(renamed.statusCode, renamed.body).toBe(200);

      const after = await card(dto.id);
      expect(after.equipment?.name).toBe(nameAtCreation);
      expect(after.equipment?.warrantyUntil).toBe('2034-06-30');
    });
  });

  // ── 3. Живое значение справочника закрыто тому, кому закрыт справочник ──

  /**
   * РЕШЕНИЕ ВЛАДЕЛЬЦА 04.09.2026, отменяющее побочный эффект Ф3. Живой срок карточки виден тому, у
   * кого есть `officeEquipment.read`; у сервисной компании его нет намеренно
   * (`COUNTERPARTY_TYPE_PERMISSIONS.service`): «её» техника в парке ничем не отмечена, право
   * означало бы весь парк компании, и реквизиты нужной единицы приходят подрядчику снимком заявки.
   * До этого раздела Ф3 отдавал ему сверх снимка живую колонку справочника — по одной дате за
   * заявку, зато на всех видимых ему сразу.
   *
   * ДВА ЧИТАТЕЛЯ НА ОДНОЙ СТРОКЕ — это и есть предмет раздела. Утверждение «сервису не видно»
   * порознь ничего не стоит: оно зеленело бы и на заявке, у которой срока нет вовсе. Поэтому
   * заявка здесь ровно одна, срок у неё заведён, и заказчик его в этой же строке видит.
   *
   * ГРАНИЦА ЗАКРЫТИЯ проверяется вторым случаем: закрыто ОДНО поле, а не блок предмета. Отбери мы
   * у подрядчика снимок — он не узнал бы, к какому аппарату ехать, и это была бы поломка модуля, а
   * не защита справочника.
   */
  describe('срок закрыт от того, кому закрыт справочник', () => {
    /**
     * Назначение подрядчика — прямым `UPDATE`, а не ручкой `assign`: ручка требует своего права,
     * своего статуса и своего разговора о коридоре переходов, то есть притащила бы в этот файл
     * половину чужого предмета. Проверяется здесь видимость ПОЛЯ, а назначение — только способ
     * сделать заявку видимой подрядчику (`serviceRequestVisibilityWhere`, ось контрагента).
     */
    async function assignService(requestId: string): Promise<void> {
      await ctx.db.execute(sql`
        UPDATE service_requests
           SET service_counterparty_id = ${ctx.serviceCounterpartyId}
         WHERE id = ${requestId}`);
    }

    it('заказчик видит срок, сервисная компания — нет: та же заявка, два читателя', async () => {
      const equipmentId = await makeEquipment('closed', '2035-04-10');
      const dto = await create({ officeEquipmentId: equipmentId });
      await assignService(dto.id);

      // Заказчику справочник открыт — срок на месте и в карточке, и в строке списка.
      expect((await card(dto.id)).equipment?.warrantyUntil).toBe('2035-04-10');
      expect((await row(dto.id)).equipment?.warrantyUntil).toBe('2035-04-10');

      /*
       * Подрядчику — `null` в обеих ручках. Ровно `null`, а не отсутствующее поле: форма ответа у
       * DTO одна на всех читателей (ADR 0160, решение 3), и портал рисует на это прочерк — то есть
       * колонка «Гарантия» молчит, а не отвечает «гарантии нет».
       */
      const serviceCard = await card(dto.id, ctx.service.auth);
      expect(serviceCard.equipment).not.toBeNull();
      expect(serviceCard.equipment?.warrantyUntil).toBeNull();
      expect((await row(dto.id, ctx.service.auth)).equipment?.warrantyUntil).toBeNull();
    });

    it('снимок предмета подрядчику приезжает целиком: закрыто одно поле, а не блок', async () => {
      /*
       * Отрицательный контроль и граница решения. Подрядчик едет чинить по этим реквизитам —
       * модель, оба номера и место, — и все они снимок САМОЙ ЗАЯВКИ, а не живая карточка. Закрыто
       * ровно то единственное поле блока, которое приходит из справочника.
       */
      const equipmentId = await makeEquipment('snapshot', '2036-01-15');
      const dto = await create({ officeEquipmentId: equipmentId });
      await assignService(dto.id);

      const serviceCard = await card(dto.id, ctx.service.auth);
      expect(serviceCard.equipment).toMatchObject({
        id: equipmentId,
        name: `МФУ snapshot ${RUN}`,
        inventoryNumber: `EW-snapshot-${RUN}`,
        location: 'кабинет 214',
        typeName: 'МФУ',
        warrantyUntil: null,
      });
    });

    it('срок, заведённый ПОСЛЕ назначения, подрядчику так и не приезжает', async () => {
      /*
       * Тот самый случай, ради которого поле сделали живым (раздел 2), — но у закрытого читателя.
       * Проверяется, что закрытие стоит в СБОРКЕ ответа, а не «в момент заведения заявки»: заявка
       * заведена без срока, срок появился в карточке позже, заказчик его видит, подрядчик — нет.
       */
      const equipmentId = await makeEquipment('later');
      const dto = await create({ officeEquipmentId: equipmentId });
      await assignService(dto.id);
      await setWarranty(equipmentId, '2037-09-09');

      expect((await card(dto.id)).equipment?.warrantyUntil).toBe('2037-09-09');
      expect((await card(dto.id, ctx.service.auth)).equipment?.warrantyUntil).toBeNull();
    });
  });
});
