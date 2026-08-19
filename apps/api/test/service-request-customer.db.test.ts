import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * От чьего имени заявка на обслуживание: площадка или отдел (план `docs/department-requests-plan.md`,
 * криты К4 и К12, решения Р12 и Р12б).
 *
 * Зачем база. Предмет проверки — три разных ответа одного поля, и ни один из них не выводится из
 * тела запроса: `undefined` разбирается подсказкой из **карточки техники** и набора отделов
 * принципала, `null` — правилом области по снимку `equipment_department_id`, а «прислали прежнее»
 * сверяется со **строкой заявки**. Сквозная область «Согласования ИТ» здесь тоже настоящая: она
 * приходит назначением (`replaceUserAddons` пишет `user_grants`), а не полем принципала. Собрать
 * это на моках — значит проверить моки.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test service-request-customer
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Роль без отдельской оси: граница площадки (Р12) её не касается вовсе. */
  admin: Auth;
  /** Роль отдела с **одним** отделом: на ней читаются ветки «своя техника» и «чужая». */
  dept: Auth;
  /**
   * Роль отдела с **двумя** отделами: без неё ветки подсказки неразличимы — у учётки с одним
   * отделом владелец техники и единственный отдел дают один и тот же ответ.
   */
  multiDept: Auth;
  /** Согласующий от ИТ: роль отдела плюс сквозная область модуля (ADR 0106, решение 2). */
  itApprover: Auth;
  objectId: string;
  /** Отдел учёток `dept` и `multiDept`. */
  ownDepartmentId: string;
  /** Второй отдел `multiDept`: за ним числится техника, дающая подсказку. */
  secondDepartmentId: string;
  /** Отдел согласующего от ИТ — чужой для всех прочих учёток файла. */
  itDepartmentId: string;
  /** Своя единица на каждый сценарий: по одной технике незакрытая заявка бывает только одна (Р21). */
  newEquipment: (tag: string, ownerDepartmentId?: string | null) => Promise<string>;
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
  // S3 и почта в этом файле не участвуют: предмет — поле заказчика, а не транспорт.
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

/** Свой адрес на каждый вход: попытки входа ограничены по IP, а учёток здесь четыре. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.40.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/**
 * Заведение заявки. Дополнительные поля передаются объектом, и **отсутствие ключа** в нём — часть
 * проверки: `customerDepartmentId: null` и «ключа нет» должны расходиться в ответах (Р12).
 */
function create(auth: Auth, officeEquipmentId: string, extra: Record<string, unknown> = {}) {
  return inject('POST', '/api/v1/service-requests', auth, {
    officeEquipmentId,
    description: 'Не печатает',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  });
}

async function createOk(
  auth: Auth,
  officeEquipmentId: string,
  extra: Record<string, unknown> = {},
): Promise<ServiceRequestDto> {
  const res = await create(auth, officeEquipmentId, extra);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request;
}

async function card(id: string, auth: Auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/**
 * Заказчик прямо из колонки. DTO отвечает связкой с отделом, а решение Р12 сформулировано про
 * `customer_department_id IS NULL`: сверять стоит то, что записано, а не то, что показано.
 */
async function customerColumn(id: string): Promise<string | null> {
  const res = await ctx.db.execute<{ customer_department_id: string | null }>(
    sql`SELECT customer_department_id FROM service_requests WHERE id = ${id}`,
  );
  return res.rows[0]!.customer_department_id;
}

/**
 * Чужая для согласующего от ИТ заявка: заказчик — отдел, к которому он не приписан, а техника не
 * размечена вовсе. Значит видит он её **только** сквозной областью — ровно то положение, из
 * которого К12 и вырастает.
 */
async function foreignRequest(tag: string): Promise<ServiceRequestDto> {
  const dto = await createOk(ctx.dept, await ctx.newEquipment(tag), {
    customerDepartmentId: ctx.ownDepartmentId,
  });
  expect(dto.customerDepartment?.id).toBe(ctx.ownDepartmentId);
  expect(dto.equipmentDepartment).toBeNull();
  return dto;
}

describe.skipIf(!DB_URL)('заказчик заявки на обслуживание: площадка и отдел (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    // Учётки, площадка и отделы заводятся SQL: форма учётки — предмет своих тестов, а здесь они
    // декорации, без которых не разложить оси области.
    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`SRC-${RUN}`}, ${`Площадка заказчика ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const makeDepartment = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`SRC-${tag}-${RUN}`}, ${`Тестовый отдел ${tag} ${RUN}`})
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const ownDepartmentId = await makeDepartment('D');
    const secondDepartmentId = await makeDepartment('D2');
    const itDepartmentId = await makeDepartment('IT');

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-src-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: row.rows[0]!.id, email };
    }

    const admin = await makeUser('admin', 'admin');
    const dept = await makeUser('dept', 'department');
    const multiDept = await makeUser('dept2', 'department');
    // Согласующий от ИТ приписан к **своему** отделу, чужому для остальных учёток: так проверяется,
    // что заявки он видит надстройкой, а не осью роли.
    const itApprover = await makeUser('it', 'department');

    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${dept.id}, ${ownDepartmentId}),
             (${multiDept.id}, ${ownDepartmentId}),
             (${multiDept.id}, ${secondDepartmentId}),
             (${itApprover.id}, ${itDepartmentId})`);
    // Надстройка выдаётся сервисом, а не вставкой в таблицу: с шага 1a реформы (ADR 0106) она
    // пишет и `user_grants`, откуда область и читается. Прямая вставка оставила бы половину, и
    // сквозной области у согласующего просто не было бы.
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, itApprover.id, ['office_equipment_it_approver'], admin.id);
    });

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const newEquipment = async (
      tag: string,
      ownerDepartmentId: string | null = null,
    ): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id,
                                      owner_department_id, location)
        VALUES (${typeId}, ${`МФУ ${tag}`}, ${`ЗК-${RUN}-${tag}`}, ${objectId},
                ${ownerDepartmentId}, 'кабинет 214')
        RETURNING id`);
      return row.rows[0]!.id;
    };

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
      admin: await login(admin.email),
      dept: await login(dept.email),
      multiDept: await login(multiDept.email),
      itApprover: await login(itApprover.email),
      objectId,
      ownDepartmentId,
      secondDepartmentId,
      itDepartmentId,
      newEquipment,
    };
  }, 180_000);

  /**
   * Уборка: база у db-тестов общая и живёт между прогонами, поэтому файл уносит ровно то, что
   * завёл сам, и в порядке внешних ключей. История статусов уходит каскадом за заявкой, но
   * `changed_by` держит учётку `RESTRICT` — значит заявки удаляются раньше людей.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`ЗК-${RUN}-%`}`;
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-src-%-${RUN}@example.invalid`}`;
      await ctx.db.execute(
        sql`DELETE FROM service_requests WHERE office_equipment_id IN (${equipment})`,
      );
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`ЗК-${RUN}-%`}`,
      );
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-src-%-${RUN}@example.invalid`}`,
      );
      // Отделы раньше площадок: у отдела бывает своя площадка (ADR 0062), и ссылка на неё —
      // `RESTRICT`. У отделов этого файла её нет, но порядок не должен зависеть от этого.
      await ctx.db.execute(sql`DELETE FROM departments WHERE code LIKE ${`SRC-%${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`SRC-${RUN}`}`);
    }
    await ctx?.closeDb();
  });

  // ── Явный `null`: заявка от площадки (К4, Р12) ──

  it('явный null даёт заявку от площадки, и роли без отдельской оси граница не касается', async () => {
    const dto = await createOk(ctx.admin, await ctx.newEquipment('site', ctx.itDepartmentId), {
      customerDepartmentId: null,
    });
    expect(dto.customerDepartment).toBeNull();
    // Записано именно `NULL`, а не подставленный отдел: «от площадки» выражается отсутствием
    // заказчика, и до Р12 оно молча превращалось в отдел-владельца техники.
    expect(await customerColumn(dto.id)).toBeNull();
    // Техника чужого отдела площадку администратору не запирает: граница Р12 спрашивается только
    // у отдельской оси, потому что только её область держится этим снимком.
    expect(dto.equipmentDepartment?.id).toBe(ctx.itDepartmentId);
  });

  // ── Поля нет вовсе: подсказка работает как прежде (Р12а — старые клиенты и интеграции) ──

  it('без поля подсказку даёт отдел-владелец техники, а не набор отделов автора', async () => {
    const dto = await createOk(
      ctx.multiDept,
      await ctx.newEquipment('hint-owner', ctx.secondDepartmentId),
    );
    // Отделов у автора два, и первый из набора — не ответ: техника числится за вторым, от его
    // имени заявка и заведена.
    expect(dto.customerDepartment?.id).toBe(ctx.secondDepartmentId);
  });

  it('без поля и без подсказки из техники берётся единственный отдел автора', async () => {
    const dto = await createOk(ctx.dept, await ctx.newEquipment('hint-sole'));
    expect(dto.customerDepartment?.id).toBe(ctx.ownDepartmentId);
    expect(dto.equipmentDepartment).toBeNull();
  });

  // ── Граница площадки для роли отдела (Р12) ──

  it('роль отдела заводит заявку от площадки по технике своего отдела, и подсказка к ней не применяется', async () => {
    // Та же техника, тот же автор — расходятся только ответы поля. На этой паре и видно, что
    // `null` подсказку отменяет: без поля сервер поставил бы отдел, с `null` не ставит ничего.
    const hinted = await createOk(
      ctx.dept,
      await ctx.newEquipment('own-hint', ctx.ownDepartmentId),
    );
    expect(hinted.customerDepartment?.id).toBe(ctx.ownDepartmentId);

    const site = await createOk(ctx.dept, await ctx.newEquipment('own-site', ctx.ownDepartmentId), {
      customerDepartmentId: null,
    });
    expect(site.customerDepartment).toBeNull();
    expect(await customerColumn(site.id)).toBeNull();
    // Заявка осталась в области автора — держит её отдел-владелец техники
    // (`serviceRequestScopeWhere`), и ровно поэтому площадка здесь разрешена.
    expect((await card(site.id, ctx.dept)).equipmentDepartment?.id).toBe(ctx.ownDepartmentId);
  });

  it('по чужой и по неразмеченной технике площадка роли отдела недоступна — 403', async () => {
    const foreign = await create(ctx.dept, await ctx.newEquipment('alien', ctx.itDepartmentId), {
      customerDepartmentId: null,
    });
    // 403, а не 422: дело не в состоянии заявки, а в том, что такой заявки учётке не видеть — обе
    // отдельские колонки оказались бы чужими.
    expect(foreign.statusCode, foreign.body).toBe(403);
    expect(foreign.json().message).toContain('только по технике своего отдела');

    // Неразмеченная техника — тот же случай: «не закреплена» не значит «моя».
    const free = await create(ctx.dept, await ctx.newEquipment('free-site'), {
      customerDepartmentId: null,
    });
    expect(free.statusCode, free.body).toBe(403);
  });

  // ── Правка: проверяется только фактическая смена заказчика (К12, Р12б) ──

  it('неизменённый площадочный заказчик правку не запирает — держатель «Согласования ИТ» правит чужую заявку', async () => {
    const dto = await createOk(ctx.dept, await ctx.newEquipment('keep-site', ctx.ownDepartmentId), {
      customerDepartmentId: null,
    });
    // Заявка чужая согласующему по обеим осям: заказчика нет, техника отдела, к которому он не
    // приписан, — видит он её сквозной областью модуля.
    const res = await inject('PATCH', `/api/v1/service-requests/${dto.id}`, ctx.itApprover, {
      customerDepartmentId: null,
      responsiblePhone: '+79991112233',
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as ServiceRequestDto;
    // Телефон схема нормализует (`contactPhoneSchema`), поэтому сверяется хранимая форма.
    expect(after.responsiblePhone).toBe('9991112233');
    // Прежний площадочный заказчик правкой не сбрасывается и не подменяется подсказкой.
    expect(after.customerDepartment).toBeNull();
    expect(await customerColumn(dto.id)).toBeNull();
  });

  it('неизменённый отдел-заказчик правку не запирает, хотя отдел согласующему чужой', async () => {
    const dto = await foreignRequest('keep-dept');
    // Ключевой случай К12. Поле присылается **присутствующим** и равным исходному — именно так
    // отправляет форма (Р12а). Пропусти мы его, проверка ушла бы в ветку `undefined` и связки
    // «портал шлёт всегда → сервер сверяет со строкой» не увидела бы вовсе.
    const res = await inject('PATCH', `/api/v1/service-requests/${dto.id}`, ctx.itApprover, {
      customerDepartmentId: ctx.ownDepartmentId,
      responsiblePhone: '+79992223344',
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as ServiceRequestDto;
    expect(after.responsiblePhone).toBe('9992223344');
    expect(after.customerDepartment?.id).toBe(ctx.ownDepartmentId);
  });

  it('смена заказчика на чужой отдел у того же держателя — 403', async () => {
    const dto = await foreignRequest('change-dept');
    const res = await inject('PATCH', `/api/v1/service-requests/${dto.id}`, ctx.itApprover, {
      customerDepartmentId: ctx.secondDepartmentId,
      version: dto.version,
    });
    // Сквозная область даёт видеть и править чужую заявку, но состав поля заказчика она не
    // расширяет (Р11б): от имени чужого отдела заявок не заводят и не переписывают.
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toContain('только от своих отделов');
    // Отказ ничего не записал: заказчик остался прежним.
    expect(await customerColumn(dto.id)).toBe(ctx.ownDepartmentId);
  });
});
