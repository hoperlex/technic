import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EquipmentHistoryEventDto,
  EquipmentHistoryPageDto,
  EquipmentServiceRequestEvent,
  OfficeEquipmentServiceEntryDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { readWorkbook } from '../src/lib/xlsx';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Деньги ремонта в КАРТОЧКЕ ЕДИНИЦЫ оргтехники: история обслуживания, лента событий и её выгрузка
 * (план `docs/office-equipment-requester-card-plan.md`, Р13; ADR 0160, решение 10).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, когда проекция карточки заявки уже проверена. Это ВТОРАЯ дверь к той же
 * сумме, и она самая неочевидная: вход сюда открывает `officeEquipment.read` — право, которое есть
 * у заказчика по роли, — а сумма ремонта выведена строкой в «Историю обслуживания», событием в
 * ленту аппарата и столбцом в `history.xlsx`. Про карточку заявки помнят все, про историю принтера
 * — никто.
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТСЯ, помимо «сумма не пришла»:
 *
 *   • гарантии ремонта остаются обеим сторонам — план убирает ДЕНЬГИ, а не факт «что чинили»:
 *     обращаться по гарантии будет заявитель (матрица §4.1, граница Г2);
 *   • аудитория считается ПО КАЖДОЙ ЗАЯВКЕ, а не по субъекту целиком: у внутреннего исполнителя
 *     одна и та же лента несёт назначенную ему заявку с суммой и соседнюю — без. Это и есть
 *     смешанная выдача §4.2, и мока она не терпит: назначение лежит строкой в
 *     `service_request_executors`, а право `serviceRequests.execute` — в наборах учётки, которые
 *     `loadPrincipal` перечитывает на каждом запросе;
 *   • события, за которыми заявки нет вовсе (переезд, правка карточки, гарантия самой техники),
 *     приходят обеим сторонам ОДИНАКОВЫМИ: проекция применяется и к ним (fail-closed по умолчанию),
 *     и обеднить их она не должна;
 *   • выгрузка проверяется ПО СОДЕРЖИМОМУ КНИГИ, а не по коду ответа: своей ветки у экспорта нет,
 *     он печатает то, что ему дали, — и ровно это утверждение здесь и проверяется. Книга
 *     разбирается тем же `readWorkbook`, которым портал читает чужие книги (`xlsx.test.ts`,
 *     `readings-export.test.ts`).
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — пара «человек ↔ эта заявка»: назначение и область живут строками,
 * а `serviceAudienceByRequest` собирает их отдельным плоским запросом (коррелированный подзапрос в
 * односоставном запросе драйвер молча переписывает — `office-equipment-sql-correlation.test.ts`).
 * На моках ни одно из этих утверждений не наблюдаемо.
 *
 * Запуск (база общая, поэтому только этот файл и в один поток):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_links_test \
 *     pnpm --filter @technic/api test -- office-equipment-history-audience.db
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база общая и переживает прогоны, а уборка ищет своё по нему. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

/**
 * Суммы — свои и «неудобные»: они ищутся в книге подстрокой, и круглые тысячи совпали бы с чужой
 * строкой соседнего прогона в общей базе.
 */
const ASSIGNED_AMOUNT = '74125.50';
const NEIGHBOUR_AMOUNT = '31502.30';

/** Суммы заявок ЧУЖОЙ площадки: те же правила поиска подстрокой, поэтому и они «неудобные». */
const FAR_ASSIGNED_AMOUNT = '58210.70';
const FAR_NEIGHBOUR_AMOUNT = '19844.10';

/** Заголовок входа: у `inject` заголовки — тип с индексной подписью, интерфейс туда не ложится. */
type Auth = { authorization: string };

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: заводит перемещения и правит карточку — ими и получаются события без заявки. */
  admin: TestUser;
  /** Заказчик площадки A: `officeEquipment.read` и `serviceRequests.read` по роли, `finance` нет. */
  requester: TestUser;
  /** «Ведение»: набор `office_equipment_operator` поверх роли штаба — с ним приходит `finance`. */
  lead: TestUser;
  /**
   * Внутренний исполнитель: `serviceRequests.execute` прогонным набором и НИ ОДНОГО права на
   * деньги. Сумму ему открывает только назначение, и только на своей заявке.
   */
  executor: TestUser;
  /**
   * Тот же набор исполнителя, но площадка одна — та, где стоит аппарат. Им проверяется третья ось
   * видимости (Р1): заявки площадки C он по роли не видит вовсе, и назначение — единственное, чем
   * его собственный ремонт попадает в карточку и ленту.
   */
  outsider: TestUser;
  equipmentId: string;
  objectId: string;
  otherObjectId: string;
  /** Площадка, к которой не привязан никто из фикстуры: на ней живут «дальние» заявки. */
  farObjectId: string;
  /** Заявка, на которую исполнитель назначен поимённо. */
  assignedRequestId: string;
  /** Заявка той же площадки и того же аппарата, к которой исполнитель отношения не имеет. */
  neighbourRequestId: string;
  /** Дальняя заявка (площадка C), на которую поимённо назначен `outsider`. */
  farAssignedRequestId: string;
  /** Дальняя заявка того же аппарата без назначения: она обязана остаться невидимой. */
  farNeighbourRequestId: string;
  grantCode: string;
}

let ctx: Ctx;

/** ИНН с настоящей контрольной суммой: обмен справочниками выгружает общую базу целиком. */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

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

let requestNo = 0;
/** Свой адрес каждому входу: у логина есть ограничитель по адресу, и общий на всех его исчерпал бы. */
function nextAddress(): string {
  requestNo += 1;
  return `10.41.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/** Карточка единицы: секция «История обслуживания» приходит в ней самой (§8.2). */
async function serviceHistory(auth: Auth): Promise<OfficeEquipmentServiceEntryDto[]> {
  const res = await inject('GET', `/api/v1/office-equipment/${ctx.equipmentId}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { serviceHistory?: OfficeEquipmentServiceEntryDto[] };
  expect(
    body.serviceHistory,
    'секция обслуживания обязана прийти: право модуля есть',
  ).toBeDefined();
  return body.serviceHistory!;
}

async function history(auth: Auth): Promise<EquipmentHistoryEventDto[]> {
  const res = await inject(
    'GET',
    `/api/v1/office-equipment/${ctx.equipmentId}/history?pageSize=200`,
    auth,
  );
  expect(res.statusCode, res.body).toBe(200);
  const page = res.json() as EquipmentHistoryPageDto;
  expect(page.serviceVisible).toBe(true);
  return page.items;
}

/** Строка истории обслуживания по заявке: искать её по номеру в массиве — в каждом случае заново. */
function entryOf(entries: OfficeEquipmentServiceEntryDto[], requestId: string) {
  const entry = entries.find((row) => row.id === requestId);
  expect(entry, `в истории обслуживания нет заявки ${requestId}`).toBeDefined();
  return entry!;
}

/** Событие ленты про заявку — то самое, где живут деньги. */
function requestEventOf(
  events: EquipmentHistoryEventDto[],
  requestId: string,
): EquipmentServiceRequestEvent {
  const event = events.find(
    (row): row is EquipmentServiceRequestEvent =>
      row.kind === 'service_request' && row.requestId === requestId,
  );
  expect(event, `в ленте нет события заявки ${requestId}`).toBeDefined();
  return event!;
}

/** Все ячейки книги одной плоской строкой: искать сумму по столбцам незачем — её не должно быть нигде. */
async function exportedCells(auth: Auth): Promise<string[]> {
  const res = await inject('GET', `/api/v1/office-equipment/${ctx.equipmentId}/history.xlsx`, auth);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['content-type']).toContain('spreadsheetml');
  const sheets = readWorkbook(new Uint8Array(res.rawPayload));
  expect(sheets).toHaveLength(1);
  return sheets[0]!.rows.flat();
}

describe.skipIf(!DB_URL)('деньги ремонта в карточке единицы: аудитории (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    // Декорации заводятся SQL: форма учётки, справочник контрагентов и заведение заявки — предмет
    // своих тестов, а здесь без них не разложить три аудитории по одной единице техники.
    const makeObject = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`OEHA-${tag}-${RUN}`}, ${`Площадка ${tag} ОЭХА ${RUN}`},
                'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectId = await makeObject('A');
    const otherObjectId = await makeObject('B');
    const farObjectId = await makeObject('C');

    const makeUser = async (
      tag: string,
      role: string,
      objects: string[] = [objectId, otherObjectId],
    ): Promise<{ id: string; email: string }> => {
      const email = `db-oeha-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      const id = row.rows[0]!.id;
      if (role !== 'admin') {
        // По умолчанию обе площадки: перемещение увозит аппарат на B и возвращает, и субъект без
        // второй привязки терял бы карточку из области на полпути. Список открыт ради `outsider`:
        // ему нужна ровно одна площадка, иначе «заявка вне области» не получится.
        for (const objId of objects) {
          await db.execute(sql`
            INSERT INTO user_construction_objects (user_id, construction_object_id)
            VALUES (${id}, ${objId})`);
        }
      }
      return { id, email };
    };

    const admin = await makeUser('admin', 'admin');
    const requester = await makeUser('req', 'shtab');
    const lead = await makeUser('lead', 'shtab');
    const executor = await makeUser('exec', 'shtab');
    // Одна площадка — та, где стоит аппарат: карточку единицы он открывает, а заявки площадки C
    // его области не касаются вовсе.
    const outsider = await makeUser('out', 'shtab', [objectId]);

    /*
     * «Ведение» — надстройкой роли и СЕРВИСОМ, а не прямым SQL: с шага 1a перехода на назначаемые
     * полномочия (ADR 0106) выдача пишет две таблицы одной транзакцией, и вставка в одну из них
     * оставила бы половину — субъект молча остался бы без `serviceRequests.finance`, и «Ведение»
     * стало бы неотличимо от заказчика.
     */
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, lead.id, ['office_equipment_operator'], admin.id);
    });

    /*
     * Набор внутреннего исполнителя — СВОИМ кодом на прогон, а не системным
     * `office_equipment_it_approver`: у того есть и `serviceRequests.finance`, и сквозная область
     * модуля, то есть ровно те два свойства, которые сделали бы смешанную выдачу ненаблюдаемой.
     * Здесь нужен субъект, которому сумму открывает ТОЛЬКО назначение.
     *
     * Роль в `grant_roles` обязательна: права набора считаются через гейт совместимости с ролью
     * (`grantPermissionsExpr`), и без строки `shtab` учётка не получила бы ни одного права.
     */
    const grantCode = `oe-exec-oeha-${RUN}`;
    const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${grantCode}, ${`Оргтехника: исполнитель ОЭХА ${RUN}`},
              'Набор внутреннего исполнителя заявок оргтехники (план карточки по аудиториям, Р13)',
              false, ${admin.id})
      RETURNING id`);
    const grantId = grantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      SELECT ${grantId}, permission
      FROM unnest(ARRAY['serviceRequests.read', 'serviceRequests.execute',
                        'serviceRequests.files']) AS permission`);
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab'::role)`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${executor.id}, ${grantId}, ${admin.id}), (${outsider.id}, ${grantId}, ${admin.id})`);

    const digits = String(Date.now()).slice(-6);
    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-ОЭХА ${RUN}`}, ${innOf(`77${digits}0`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    /*
     * Срок гарантии САМОЙ ЕДИНИЦЫ в прошлом — ради события `warranty` вида `equipment`: оно
     * вычисляется, заявки за ним нет, и обеим сторонам обязано прийти одинаковым.
     *
     * Суффикс прогона стоит и в наименовании: с миграции 0171 наименование карточки — это имя
     * строки справочника `office_equipment_models`, и вставка без `model_id` заводит модель сама.
     * По суффиксу уборка её и находит.
     */
    const equipmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id,
                                    warranty_until)
      VALUES (${typeId}, ${`Kyocera OEHA ${RUN}`}, ${`OEHA-${RUN}`}, ${objectId}, '2020-02-02')
      RETURNING id`);
    const equipmentId = equipmentRow.rows[0]!.id;

    /*
     * Две ЗАКРЫТЫЕ заявки на один аппарат: открытая по виду `repair` бывает только одна
     * (`service_requests_open_repair_unique`), а нужны обе разом — назначенная и соседняя.
     *
     * Контрагент-исполнитель проставлен обеим намеренно. Во-первых, у сумм появляется имя сервиса —
     * так строка истории выглядит как настоящая. Во-вторых, снятие поимённого назначения ниже
     * (§смешанная выдача) иначе упёрлось бы в отложенный `service_request_executors_present`:
     * заявка в рабочем статусе без единого исполнителя — нарушение инварианта схемы, а предмет
     * случая — аудитория, а не проверка триггера.
     */
    const makeRequest = async (
      description: string,
      amount: string,
      completedOn: string,
      requestObjectId: string = objectId,
    ): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO service_requests (office_equipment_id, equipment_object_id, equipment_name,
                                      equipment_inventory_number, description, responsible_name,
                                      responsible_phone, status, service_counterparty_id,
                                      final_total_amount, completed_at, accepted_by, accepted_at,
                                      acceptance_source, created_by)
        VALUES (${equipmentId}, ${requestObjectId}, ${`Kyocera OEHA ${RUN}`}, ${`OEHA-${RUN}`},
                ${description}, 'Тестовый Пользователь', '9990000000',
                'accepted'::service_request_status, ${counterpartyId}, ${amount},
                ${completedOn}::timestamptz, ${lead.id}, ${completedOn}::timestamptz,
                'human', ${requester.id})
        RETURNING id`);
      return row.rows[0]!.id;
    };
    // В описаниях нет ни одной цифры: книга проверяется поиском суммы подстрокой, и число,
    // названное заявителем словами, план всё равно не вычищает (граница Г4).
    const assignedRequestId = await makeRequest(
      'Не печатает, полосы по всему листу',
      ASSIGNED_AMOUNT,
      '2026-08-20T10:00:00+03:00',
    );
    const neighbourRequestId = await makeRequest(
      'Замялась бумага в лотке, шумит подача',
      NEIGHBOUR_AMOUNT,
      '2026-08-25T10:00:00+03:00',
    );

    /*
     * Две заявки ЧУЖОЙ площадки на тот же аппарат. Площадка у заявки — снимок на момент заведения
     * (аппарат переезжает, заявка остаётся там, где случилась), поэтому такая пара — не выдумка:
     * так выглядит ремонт, заведённый до переезда техники.
     *
     * Ими проверяется третья ось: `outsider` привязан только к площадке аппарата, и в его области
     * нет ни одной из этих двух. Разницу между ними делает единственный факт — поимённое
     * назначение.
     */
    const farAssignedRequestId = await makeRequest(
      'Не тянет из нижней кассеты, встал на площадке до переезда',
      FAR_ASSIGNED_AMOUNT,
      '2026-07-14T10:00:00+03:00',
      farObjectId,
    );
    const farNeighbourRequestId = await makeRequest(
      'Гудит блок закрепления, чинили без нас',
      FAR_NEIGHBOUR_AMOUNT,
      '2026-07-18T10:00:00+03:00',
      farObjectId,
    );

    // Гарантия ремонта: она обязана дойти до ОБЕИХ сторон — план убирает деньги, а не факт «что
    // чинили». Срок в будущем, иначе строка ушла бы из действующих гарантий карточки.
    await db.execute(sql`
      INSERT INTO service_request_items (request_id, kind, name, quantity, unit_price, performed,
                                         warranty_months, warranty_until)
      VALUES (${assignedRequestId}, 'part', 'Ролик захвата бумаги', 1, 4500, true, 12,
              (CURRENT_DATE + INTERVAL '6 months')::date)`);

    await db.execute(sql`
      INSERT INTO service_request_executors (request_id, user_id, assigned_by)
      VALUES (${assignedRequestId}, ${executor.id}, ${admin.id}),
             (${farAssignedRequestId}, ${outsider.id}, ${admin.id})`);

    const app = await buildApp();
    const login = async (email: string): Promise<Auth> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    };
    const withAuth = async (u: { id: string; email: string }): Promise<TestUser> => ({
      ...u,
      auth: await login(u.email),
    });

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      requester: await withAuth(requester),
      lead: await withAuth(lead),
      executor: await withAuth(executor),
      outsider: await withAuth(outsider),
      equipmentId,
      objectId,
      otherObjectId,
      farObjectId,
      assignedRequestId,
      neighbourRequestId,
      farAssignedRequestId,
      farNeighbourRequestId,
      grantCode,
    };

    // События БЕЗ заявки — своими ручками, а не вставкой строк: перемещение пишет журнал, правка
    // карточки — аудит с диффом, и лента собирает их ровно из этих следов.
    const move = async (toObjectId: string, movedOn: string, reason: string): Promise<void> => {
      const res = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.admin.auth,
        {
          objectId: toObjectId,
          movedOn,
          reason,
        },
      );
      expect(res.statusCode, res.body).toBe(201);
    };
    await move(otherObjectId, '2026-08-10', 'Временный перенос в офис');
    await move(objectId, '2026-08-11', 'Возврат на площадку');

    const patched = await inject(
      'PATCH',
      `/api/v1/office-equipment/${equipmentId}`,
      ctx.admin.auth,
      { location: 'Кабинет главного инженера' },
    );
    expect(patched.statusCode, patched.body).toBe(200);
  }, 120_000);

  /**
   * Уборка: база общая и живёт между прогонами, поэтому файл уносит ровно то, что завёл сам.
   * Порядок задан внешними ключами: заявки держат технику, автора и контрагента (`RESTRICT`),
   * техника — площадку, аудит — автора.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-oeha-%-${RUN}@example.invalid`}`;
      // Строки сметы и поимённые назначения уходят каскадом за заявкой.
      await ctx.db.execute(
        sql`DELETE FROM service_requests WHERE office_equipment_id = ${ctx.equipmentId}`,
      );
      await ctx.db.execute(
        sql`DELETE FROM office_equipment_movements WHERE equipment_id = ${ctx.equipmentId}`,
      );
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE entity_id = ${ctx.equipmentId}`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(sql`DELETE FROM office_equipment WHERE id = ${ctx.equipmentId}`);
      // Модель, заведённую карточкой этого файла, удаление карточки за собой не уносит.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-oeha-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(sql`DELETE FROM grants WHERE code = ${ctx.grantCode}`);
      await ctx.db.execute(sql`DELETE FROM counterparties WHERE name = ${`Сервис-ОЭХА ${RUN}`}`);
      await ctx.db.execute(
        sql`DELETE FROM construction_objects WHERE code LIKE ${`OEHA-%-${RUN}`}`,
      );
      await ctx.closeDb();
    }
  });

  it('«История обслуживания» карточки: заказчику без сумм, «Ведению» — с суммами', async () => {
    const forRequester = await serviceHistory(ctx.requester.auth);
    const forLead = await serviceHistory(ctx.lead.auth);

    // Обе заявки видны обоим: план убирает деньги, а не строки — «ремонтов не было» и «сумму не
    // показываем» разные вещи, и вторая не имеет права выглядеть как первая.
    for (const entries of [forRequester, forLead]) {
      expect(entries.map((row) => row.id).sort()).toEqual(
        [ctx.assignedRequestId, ctx.neighbourRequestId].sort(),
      );
    }

    expect(entryOf(forRequester, ctx.assignedRequestId).totalAmount).toBeNull();
    expect(entryOf(forRequester, ctx.neighbourRequestId).totalAmount).toBeNull();
    expect(entryOf(forLead, ctx.assignedRequestId).totalAmount).toBe(Number(ASSIGNED_AMOUNT));
    expect(entryOf(forLead, ctx.neighbourRequestId).totalAmount).toBe(Number(NEIGHBOUR_AMOUNT));

    // Гарантия ремонта — у обоих и одна и та же: обращаться по ней будет заявитель (Г2).
    const warrantyNames = (entries: OfficeEquipmentServiceEntryDto[]) =>
      entryOf(entries, ctx.assignedRequestId).warranties.map((row) => row.name);
    expect(warrantyNames(forRequester)).toEqual(['Ролик захвата бумаги']);
    expect(warrantyNames(forLead)).toEqual(warrantyNames(forRequester));
    expect(entryOf(forRequester, ctx.assignedRequestId).warranties).toEqual(
      entryOf(forLead, ctx.assignedRequestId).warranties,
    );

    // Остальные поля строки от аудитории не зависят: вычтена ровно одна цифра, а не половина ответа.
    const { totalAmount: _requesterAmount, ...requesterRest } = entryOf(
      forRequester,
      ctx.assignedRequestId,
    );
    const { totalAmount: _leadAmount, ...leadRest } = entryOf(forLead, ctx.assignedRequestId);
    expect(requesterRest).toEqual(leadRest);
  });

  it('лента аппарата: событие заявки заказчику без суммы, «Ведению» — с суммой', async () => {
    const forRequester = await history(ctx.requester.auth);
    const forLead = await history(ctx.lead.auth);

    expect(requestEventOf(forRequester, ctx.assignedRequestId).totalAmount).toBeNull();
    expect(requestEventOf(forRequester, ctx.neighbourRequestId).totalAmount).toBeNull();
    expect(requestEventOf(forLead, ctx.assignedRequestId).totalAmount).toBe(
      Number(ASSIGNED_AMOUNT),
    );
    expect(requestEventOf(forLead, ctx.neighbourRequestId).totalAmount).toBe(
      Number(NEIGHBOUR_AMOUNT),
    );

    // Описание поломки писал сам заявитель — скрывать от него его же текст незачем; имя сервиса и
    // статус тоже остаются. Проекция вычитает деньги, а не событие.
    const requesterEvent = requestEventOf(forRequester, ctx.assignedRequestId);
    const leadEvent = requestEventOf(forLead, ctx.assignedRequestId);
    expect(requesterEvent.description).toBe('Не печатает, полосы по всему листу');
    expect(requesterEvent.serviceName).toBe(`Сервис-ОЭХА ${RUN}`);
    expect({ ...requesterEvent, totalAmount: leadEvent.totalAmount }).toEqual(leadEvent);

    // Порядок и состав ленты от аудитории не зависят: аудитория применяется к странице после
    // отбора и сортировки, а курсор считается по непроецированному событию.
    expect(forRequester.map((event) => event.sortId)).toEqual(forLead.map((event) => event.sortId));
  });

  it('события без заявки приходят обеим сторонам одинаковыми', async () => {
    const withoutRequest = (events: EquipmentHistoryEventDto[]) =>
      events.filter((event) => event.kind !== 'service_request' && event.kind !== 'service_step');

    const forRequester = withoutRequest(await history(ctx.requester.auth));
    const forLead = withoutRequest(await history(ctx.lead.auth));

    // Проверка имела бы смысл и на пустом списке — поэтому сначала о том, что события есть все три.
    const kinds = new Set(forRequester.map((event) => event.kind));
    expect(kinds).toContain('movement');
    expect(kinds).toContain('card_change');
    expect(kinds).toContain('warranty');
    expect(forRequester).toEqual(forLead);

    // Ссылка на заявку у перемещения — не деньги, и живёт она под своим именем: «переехал по
    // заявке» отвечает на вопрос «почему аппарат не на месте». Здесь переезды сами по себе.
    const movements = forRequester.filter((event) => event.kind === 'movement');
    expect(movements).toHaveLength(2);
    expect(movements.every((event) => event.kind === 'movement' && event.reason !== '')).toBe(true);
  });

  it('выгрузка истории: в книге заказчика суммы нет, в книге «Ведения» — есть', async () => {
    const forRequester = await exportedCells(ctx.requester.auth);
    const forLead = await exportedCells(ctx.lead.auth);

    // Книга собрана и не пуста: иначе «суммы нет» доказывало бы только то, что выгрузка сломалась.
    expect(forRequester).toContain('Не печатает, полосы по всему листу; ' + `Сервис-ОЭХА ${RUN}`);
    expect(forRequester.filter((cell) => cell === 'Обслуживание')).toHaveLength(2);

    // Ни числа, ни знака рубля: `money(null)` даёт пустую строку, и ячейка «Подробности» просто
    // обрывается на имени сервиса. Ноль здесь был бы враньём — «починили бесплатно».
    for (const cell of forRequester) {
      expect(cell).not.toContain('₽');
      expect(cell).not.toContain(ASSIGNED_AMOUNT);
      expect(cell).not.toContain(NEIGHBOUR_AMOUNT);
    }

    // Та же книга «Ведению» — с обеими суммами: своей ветки у экспорта нет, он печатает то, что
    // ему дали, и разница между книгами обязана быть ровно в этом.
    expect(forLead.some((cell) => cell.includes(`${ASSIGNED_AMOUNT} ₽`))).toBe(true);
    expect(forLead.some((cell) => cell.includes(`${NEIGHBOUR_AMOUNT} ₽`))).toBe(true);
  });

  /**
   * Смешанная выдача (§4.2) — то, ради чего аудитория считается по КАЖДОЙ заявке, а не по субъекту.
   *
   * Идёт последним: снятие назначения меняет состояние на весь остаток файла, и делённое с кем-то
   * оно сделало бы порядок случаев частью проверки.
   */
  it('внутреннему исполнителю: назначенная заявка с суммой, соседняя — без', async () => {
    const events = await history(ctx.executor.auth);
    expect(requestEventOf(events, ctx.assignedRequestId).totalAmount).toBe(Number(ASSIGNED_AMOUNT));
    expect(requestEventOf(events, ctx.neighbourRequestId).totalAmount).toBeNull();

    // Карточка единицы отвечает так же: две двери к одной сумме обязаны решать одинаково.
    const entries = await serviceHistory(ctx.executor.auth);
    expect(entryOf(entries, ctx.assignedRequestId).totalAmount).toBe(Number(ASSIGNED_AMOUNT));
    expect(entryOf(entries, ctx.neighbourRequestId).totalAmount).toBeNull();

    // Выгрузка исполнителя — тем же составом: одна сумма в книге, вторая — пустой ячейкой.
    const cells = await exportedCells(ctx.executor.auth);
    expect(cells.some((cell) => cell.includes(`${ASSIGNED_AMOUNT} ₽`))).toBe(true);
    expect(cells.every((cell) => !cell.includes(NEIGHBOUR_AMOUNT))).toBe(true);

    /*
     * Снятие назначения тем же токеном: права и назначения не кэшируются в JWT, `loadPrincipal`
     * перечитывает их на каждом запросе. Без этого шага «назначенный видит сумму» неотличимо от
     * «держатель `execute` видит суммы всегда».
     */
    await ctx.db.execute(sql`
      DELETE FROM service_request_executors
       WHERE request_id = ${ctx.assignedRequestId} AND user_id = ${ctx.executor.id}`);

    const afterRevoke = await history(ctx.executor.auth);
    expect(requestEventOf(afterRevoke, ctx.assignedRequestId).totalAmount).toBeNull();
    expect(requestEventOf(afterRevoke, ctx.neighbourRequestId).totalAmount).toBeNull();

    const entriesAfter = await serviceHistory(ctx.executor.auth);
    expect(entriesAfter.every((row) => row.totalAmount === null)).toBe(true);
    // Гарантия ремонта при этом на месте: она не деньги и назначением не открывается.
    expect(entryOf(entriesAfter, ctx.assignedRequestId).warranties).toHaveLength(1);

    const cellsAfter = await exportedCells(ctx.executor.auth);
    for (const cell of cellsAfter) {
      expect(cell).not.toContain('₽');
      expect(cell).not.toContain(ASSIGNED_AMOUNT);
    }
  });

  /**
   * Третья ось видимости в КАРТОЧКЕ ЕДИНИЦЫ и её ленте (план аудита исполнителей, Р1 и Р2).
   *
   * ЗАЧЕМ ЕЩЁ ОДИН СЛУЧАЙ, когда смешанная выдача уже проверена выше. Тот случай — про ДЕНЬГИ: обе
   * заявки субъекту видны, и назначение решает лишь, придёт ли сумма. Этот — про сам СОСТАВ: до
   * перевода карточки на общий предикат история единицы отбирала заявки одной осью, заказчиком, и
   * поимённо назначенный исполнитель не находил в ней СВОЙ ремонт, если тот случился вне его
   * площадки. Карточка самой заявки ему при этом открывалась — витрина была у́же карточки, а К3 §8
   * требует обратного.
   *
   * ВТОРАЯ ПОЛОВИНА ВАЖНЕЕ ПЕРВОЙ: соседняя заявка той же чужой площадки обязана остаться
   * невидимой. Иначе «починили» переводом на предикат, который видимость не сужает, а раздаёт, — и
   * прежняя неполнота (Н4: ось подрядчика держалась на закрытом справочнике) сменилась бы дырой
   * пошире.
   */
  it('назначенный видит в карточке свой ремонт вне своей площадки — и только свой', async () => {
    const entries = await serviceHistory(ctx.outsider.auth);
    const ids = entries.map((row) => row.id);
    expect(ids, 'назначение открывает заявку, которой в области субъекта нет').toContain(
      ctx.farAssignedRequestId,
    );
    expect(ids, 'соседняя заявка той же чужой площадки остаётся закрытой').not.toContain(
      ctx.farNeighbourRequestId,
    );
    // Сумма на своей заявке приходит той же аудиторией (Р13): назначение открывает и строку, и
    // деньги в ней — иначе исполнитель видел бы ремонт, за который отвечает, без его цены.
    expect(entryOf(entries, ctx.farAssignedRequestId).totalAmount).toBe(
      Number(FAR_ASSIGNED_AMOUNT),
    );

    // Лента аппарата — вторая дверь к тому же составу, и отвечает она так же.
    const events = await history(ctx.outsider.auth);
    expect(requestEventOf(events, ctx.farAssignedRequestId).id).toBe(ctx.farAssignedRequestId);
    expect(
      events.some(
        (row) => row.kind === 'service_request' && row.requestId === ctx.farNeighbourRequestId,
      ),
      'в ленте не должно быть чужой заявки чужой площадки',
    ).toBe(false);

    /*
     * Снятие назначения тем же токеном: без этого шага «видит по назначению» неотличимо от «видит
     * по чему-то ещё» — например по площадке аппарата, которая у субъекта своя.
     */
    await ctx.db.execute(sql`
      DELETE FROM service_request_executors
       WHERE request_id = ${ctx.farAssignedRequestId} AND user_id = ${ctx.outsider.id}`);

    const afterRevoke = await serviceHistory(ctx.outsider.auth);
    expect(afterRevoke.map((row) => row.id)).not.toContain(ctx.farAssignedRequestId);
    // А заявки своей площадки на месте: ось назначения добавляет строки, но не подменяет область.
    expect(afterRevoke.map((row) => row.id).sort()).toEqual(
      [ctx.assignedRequestId, ctx.neighbourRequestId].sort(),
    );
  });
});
