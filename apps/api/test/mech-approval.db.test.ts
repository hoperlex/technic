import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type MechRequestDto,
  type RequestHistoryEntryDto,
  type Role,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';

/**
 * Виза площадки в модуле механизации (план `docs/mechanization-approval-and-grants-plan.md`,
 * Р3, Р5, Р6, Р11, Р12; ADR 0171).
 *
 * **Зачем этому файлу база.** Правила визы выражены чистыми функциями и проверены без базы
 * (`mech-approval-contracts.test.ts`); здесь проверяется то, что на подменах выглядит правильным
 * всегда:
 *
 * 1. **область подписи** считается по принципалу, собранному из настоящих строк
 *    `user_construction_objects` и `department_construction_objects`. «Руководитель отдела не
 *    визирует заявку самой площадки» — это ответ SQL, а не функции: производный список площадок
 *    отдела приходит подзапросом, и ошибка здесь не отказ, а лишняя подпись;
 * 2. **автовиза подачей** ставится в той же вставке, что и сама заявка. Проверить, что подпись
 *    появилась атомарно и с верным автором, можно только по сохранённой строке;
 * 3. **снятие визы правкой по существу** живёт внутри транзакции правки рядом с CAS по версии:
 *    вопрос стоит ровно в том, снялась ли подпись у той же строки и тем же запросом;
 * 4. **порядок отказов** (409 «перечитай» раньше 422 «правило запрещает») наблюдаем только на
 *    настоящем запросе с устаревшей версией;
 * 5. **события истории** собираются из журнала аудита и таблицы статусов — их форма проверяема
 *    только через ручку карточки.
 *
 * Запуск — как у остальных db-тестов (общая база, поимённо):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-approval.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: база общая, а коды объектов, отделов и адреса учёток уникальны. */
const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-mech-approval-${RUN}`;
/**
 * Коды с «яя» в начале — требование соседства: половина db-тестов берёт объект выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const CODE_PREFIX = `яя-MECHAPPR-${RUN}`;
/** Метка своих контрагентов: уборка идёт по ней, а не «по последним строкам». */
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: виза механизации ${RUN}`;

const TODAY = moscowDateKeyOf(new Date());
const PLANNED_TO = shiftDateKey(TODAY, 14);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  closeDb: () => Promise<void>;
  /** Площадка, на которой работают все сцены файла, и вторая — чужая. */
  objectId: string;
  otherObjectId: string;
  /** Отдел-заявитель, за которым закреплена площадка. */
  departmentId: string;
  /** Арендодатель: без договорённости заявку не взять в работу. */
  lessorId: string;
  modelId: string;
  users: {
    /** Ответственный площадки: право визы плюс объектная ось. */
    rukstroy: string;
    /** Второй ответственный, но на чужой площадке: право есть, области нет. */
    otherRukstroy: string;
    /** Заказчик без права визы: заводит заявки, подписать не может. */
    shtab: string;
    /** Руководитель отдела: подписывает заявки своего отдела. */
    head: string;
    /** Офис: ведёт аренду, правит заявку, визы не имеет. */
    manager: string;
    admin: string;
  };
}

let ctx: Ctx;
let seq = 0;

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

/** Уникальный ИНН: `counterparties_inn_unique` смотрит на всю базу, а она общая. */
function nextInn(): string {
  seq += 1;
  return `9${String(Date.now() % 100_000_000).padStart(8, '0')}${seq % 10}`;
}

async function newUser(
  tag: string,
  role: Role,
  scope: { objectIds?: string[]; departmentIds?: string[] } = {},
): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${seq}-${tag}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Сотрудник',
      middleName: tag,
      // Входа по паролю в файле нет: access-токен подписывается напрямую — предмет проверки не
      // вход, а виза, и argon2 на шести учётках стоил бы секунд на пустом месте.
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  for (const objectId of scope.objectIds ?? []) {
    await ctx.db
      .insert(ctx.schema.userConstructionObjects)
      .values({ userId: row!.id, constructionObjectId: objectId });
  }
  for (const departmentId of scope.departmentIds ?? []) {
    await ctx.db
      .insert(ctx.schema.userDepartments)
      .values({ userId: row!.id, departmentId, isHead: true });
  }
  return row!.id;
}

type Headers = { authorization: string };

/** Заголовок с access-токеном: область принципал считает на каждом запросе, в токене её нет. */
async function headersOf(userId: string): Promise<Headers> {
  const [row] = await ctx.db
    .select({ role: ctx.schema.users.role, authVersion: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  const token = await ctx.tokens.signAccessToken({
    sub: userId,
    role: row!.role,
    av: row!.authVersion,
  });
  return { authorization: `Bearer ${token}` };
}

function call(
  headers: Headers,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/mech-requests${url}`,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
}

function ok(res: Awaited<ReturnType<typeof call>>, code = 200): Record<string, unknown> {
  expect(res.statusCode, res.body).toBe(code);
  return res.json();
}

async function createRequest(
  headers: Headers,
  input: { objectId?: string; departmentId?: string } = {},
): Promise<MechRequestDto> {
  const res = await call(headers, 'POST', '/', {
    objectId: input.objectId ?? ctx.objectId,
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    mechModelId: ctx.modelId,
    plannedFrom: TODAY,
    plannedTo: PLANNED_TO,
    responsibleName: 'Иванов Иван',
    responsiblePhone: '9990000000',
    comment: MARK,
  });
  return ok(res, 201) as unknown as MechRequestDto;
}

async function card(headers: Headers, id: string): Promise<MechRequestDto> {
  return ok(await call(headers, 'GET', `/${id}`)) as unknown as MechRequestDto;
}

async function setApproval(headers: Headers, request: MechRequestDto, approved: boolean) {
  return call(headers, 'PATCH', `/${request.id}/approval`, {
    approved,
    version: request.version,
  });
}

async function history(headers: Headers, id: string): Promise<RequestHistoryEntryDto[]> {
  const res = await call(headers, 'GET', `/${id}/history`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestHistoryEntryDto[];
}

describe.skipIf(!DB_URL)('виза площадки в механизации', () => {
  let auth: Record<keyof Ctx['users'], Headers>;

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');

    ctx = {
      app: await buildApp(),
      db,
      schema,
      tokens,
      closeDb,
      objectId: '',
      otherObjectId: '',
      departmentId: '',
      lessorId: '',
      modelId: '',
      users: {
        rukstroy: '',
        otherRukstroy: '',
        shtab: '',
        head: '',
        manager: '',
        admin: '',
      },
    };

    const object = async (tag: string): Promise<string> => {
      const [row] = await db
        .insert(schema.constructionObjects)
        .values({
          code: `${CODE_PREFIX}-${tag}`,
          name: `Площадка ${tag} ${RUN}`,
          address: 'г. Москва, тестовый проезд, 1',
        })
        .returning({ id: schema.constructionObjects.id });
      return row!.id;
    };

    ctx.objectId = await object('site');
    ctx.otherObjectId = await object('other');

    const [department] = await db
      .insert(schema.departments)
      .values({ code: `${CODE_PREFIX}-DEP`, name: `Отдел снабжения ${RUN}` })
      .returning({ id: schema.departments.id });
    ctx.departmentId = department!.id;
    // Площадка закреплена за отделом (ADR 0062/0144): без этой строки отдел не завёл бы заявку и
    // тем более не подписал бы её.
    await db
      .insert(schema.departmentConstructionObjects)
      .values({ departmentId: ctx.departmentId, constructionObjectId: ctx.objectId });

    const [lessor] = await db
      .insert(schema.counterparties)
      .values({
        type: 'mech_lessor',
        name: `Арендодатель ${RUN}`,
        inn: nextInn(),
        isActive: true,
        comment: MARK,
      })
      .returning({ id: schema.counterparties.id });
    ctx.lessorId = lessor!.id;

    const [model] = await db
      .insert(schema.mechModels)
      .values({
        code: `mech-approval-${RUN}`,
        name: `Виброплита ${RUN}`,
        isActive: true,
      })
      .returning({ id: schema.mechModels.id });
    ctx.modelId = model!.id;

    ctx.users = {
      rukstroy: await newUser('rukstroy', 'rukstroy', { objectIds: [ctx.objectId] }),
      otherRukstroy: await newUser('other-rukstroy', 'rukstroy', {
        objectIds: [ctx.otherObjectId],
      }),
      shtab: await newUser('shtab', 'shtab', { objectIds: [ctx.objectId] }),
      head: await newUser('head', 'department_head', { departmentIds: [ctx.departmentId] }),
      manager: await newUser('manager', 'manager'),
      admin: await newUser('admin', 'admin'),
    };

    auth = {
      rukstroy: await headersOf(ctx.users.rukstroy),
      otherRukstroy: await headersOf(ctx.users.otherRukstroy),
      shtab: await headersOf(ctx.users.shtab),
      head: await headersOf(ctx.users.head),
      manager: await headersOf(ctx.users.manager),
      admin: await headersOf(ctx.users.admin),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.db.execute(
      sql`DELETE FROM mech_requests WHERE object_id IN
            (SELECT id FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`})`,
    );
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE comment = ${MARK}`);
    await ctx.db.execute(sql`DELETE FROM mech_models WHERE code = ${`mech-approval-${RUN}`}`);
    await ctx.db.execute(
      sql`DELETE FROM department_construction_objects WHERE department_id IN
            (SELECT id FROM departments WHERE code = ${`${CODE_PREFIX}-DEP`})`,
    );
    await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM departments WHERE code = ${`${CODE_PREFIX}-DEP`}`);
    await ctx.db.execute(
      sql`DELETE FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`}`,
    );
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Подпись и её отзыв (Р3) ──

  it('ответственный площадки визирует заявку заказчика и снимает свою визу', async () => {
    const request = await createRequest(auth.shtab);
    expect(request.approvedAt).toBeNull();

    const approved = ok(
      await setApproval(auth.rukstroy, request, true),
    ) as unknown as MechRequestDto;
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.approvedBy).toBe(ctx.users.rukstroy);
    expect(approved.approvedByName).toContain('Тестовый');
    expect(approved.version).toBe(request.version + 1);

    const revoked = ok(
      await setApproval(auth.rukstroy, approved, false),
    ) as unknown as MechRequestDto;
    expect(revoked.approvedAt).toBeNull();
    expect(revoked.approvedBy).toBeNull();

    // Оба действия оставили след в карточке: после отзыва колонки пусты, и что подпись была,
    // помнят только эти две записи (Р12).
    const kinds = (await history(auth.rukstroy, request.id)).map((e) => e.kind);
    expect(kinds).toContain('approved');
    expect(kinds).toContain('approvalRevoked');
  }, 60_000);

  it('повторная постановка той же визы ничего не меняет и не пишет второго события', async () => {
    const request = await createRequest(auth.shtab);
    const approved = ok(
      await setApproval(auth.rukstroy, request, true),
    ) as unknown as MechRequestDto;
    const again = ok(await setApproval(auth.rukstroy, approved, true)) as unknown as MechRequestDto;
    expect(again.version).toBe(approved.version);
    expect(again.approvedAt).toBe(approved.approvedAt);
    expect(
      (await history(auth.rukstroy, request.id)).filter((e) => e.kind === 'approved'),
    ).toHaveLength(1);
  }, 60_000);

  // ── Область подписи (Р5) ──

  it('чужую площадку не визируют, а без права визы не визирует и свой заказчик', async () => {
    const request = await createRequest(auth.shtab);

    // Чужая площадка: у ответственного соседнего объекта право есть, области нет. Отказ приходит
    // от барьера видимости модуля — тем же ответом, что и на любое другое действие с чужой
    // заявкой.
    const alien = await setApproval(auth.otherRukstroy, request, true);
    expect(alien.statusCode, alien.body).toBe(403);

    // Заказчик своей же площадки: право визы ему не выдано вовсе, и это отказ стража маршрута.
    const noRight = await setApproval(auth.shtab, request, true);
    expect(noRight.statusCode, noRight.body).toBe(403);

    expect((await card(auth.shtab, request.id)).approvedAt).toBeNull();
  }, 60_000);

  it('заявку отдела подписывают и площадка, и руководитель отдела; заявку без отдела — только площадка', async () => {
    // Заявку от лица отдела заводит офис: штабу это запрещено (`assertMechRequesterAllowed`), а
    // заведи её сам руководитель отдела — подпись появилась бы автовизой, и проверять было бы
    // нечего.
    const byDepartment = await createRequest(auth.manager, { departmentId: ctx.departmentId });
    const signedByHead = ok(
      await setApproval(auth.head, byDepartment, true),
    ) as unknown as MechRequestDto;
    expect(signedByHead.approvedBy).toBe(ctx.users.head);

    // Та же заявка доступна и площадке: поле визы одно, и кто первый — тот и завизировал.
    ok(await setApproval(auth.rukstroy, signedByHead, false));

    // Заявка самой площадки руководителю отдела не принадлежит: его сторона — заявитель, а его
    // здесь нет вовсе.
    const bySite = await createRequest(auth.shtab);
    const refused = await setApproval(auth.head, bySite, true);
    expect(refused.statusCode, refused.body).toBe(403);
  }, 60_000);

  // ── Автовиза подачей (Р6) ──

  it('заявка ответственного площадки согласована подачей, а заявка администратора — нет', async () => {
    const own = await createRequest(auth.rukstroy);
    expect(own.approvedAt).not.toBeNull();
    expect(own.approvedBy).toBe(ctx.users.rukstroy);

    const byAdmin = await createRequest(auth.admin);
    expect(byAdmin.approvedAt).toBeNull();

    // Дублирование — заведение новой заявки: виза исходной на копию не переносится.
    const copy = ok(
      await call(auth.admin, 'POST', `/${own.id}/duplicate`, {}),
      201,
    ) as unknown as MechRequestDto;
    expect(copy.approvedAt).toBeNull();
  }, 60_000);

  // ── Барьер входа в работу (Р3) ──

  it('незавизированную заявку в работу не берут, завизированную — берут', async () => {
    const request = await createRequest(auth.shtab);
    const refused = await call(auth.manager, 'PATCH', `/${request.id}/status`, {
      status: 'confirmed',
      version: request.version,
      deal: { lessorId: ctx.lessorId, rate: 1200, rateUnit: 'hour' },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().message).toContain('после визы');

    const approved = ok(
      await setApproval(auth.rukstroy, request, true),
    ) as unknown as MechRequestDto;
    const taken = ok(
      await call(auth.manager, 'PATCH', `/${request.id}/status`, {
        status: 'confirmed',
        version: approved.version,
        deal: { lessorId: ctx.lessorId, rate: 1200, rateUnit: 'hour' },
      }),
    ) as unknown as MechRequestDto;
    expect(taken.status).toBe('confirmed');

    // Визу взятой в работу заявки не снимают: она уже основание договорённости с арендодателем.
    const locked = await setApproval(auth.rukstroy, taken, false);
    expect(locked.statusCode, locked.body).toBe(422);
    expect(locked.json().message).toContain('«Новая»');

    // Откат в «Новую» подпись бережёт: он стирает договорённость, но согласия площадки не
    // отменяет — иначе заявку пришлось бы подписывать заново после каждой правки офиса.
    const rolled = ok(
      await call(auth.admin, 'PATCH', `/${request.id}/status`, {
        status: 'new',
        version: taken.version,
        comment: 'Договорённость пересматривается',
      }),
    ) as unknown as MechRequestDto;
    expect(rolled.approvedAt).not.toBeNull();
  }, 60_000);

  // ── Снятие визы правкой по существу (Р11) ──

  it('правка офисом по существу снимает визу, а правка комментария и правка визирующим — нет', async () => {
    const request = await createRequest(auth.shtab);
    const approved = ok(
      await setApproval(auth.rukstroy, request, true),
    ) as unknown as MechRequestDto;

    // Комментарий сути не меняет: подписывают технику, срок и место.
    const commented = ok(
      await call(auth.manager, 'PATCH', `/${request.id}`, {
        comment: `${MARK} (уточнение)`,
        version: approved.version,
      }),
    ) as unknown as MechRequestDto;
    expect(commented.approvedAt).toBe(approved.approvedAt);

    // Срок — меняет, и правит его офис: подпись уходит вместе со сроком, который подписывали.
    const moved = ok(
      await call(auth.manager, 'PATCH', `/${request.id}`, {
        plannedTo: shiftDateKey(PLANNED_TO, 7),
        version: commented.version,
      }),
    ) as unknown as MechRequestDto;
    expect(moved.approvedAt).toBeNull();
    expect(
      (await history(auth.rukstroy, request.id)).some((e) => e.kind === 'approvalRevoked'),
    ).toBe(true);

    // Та же правка рукой визирующего визу не снимает: он подтверждает изменение самим фактом
    // правки.
    const second = await createRequest(auth.shtab);
    const signed = ok(await setApproval(auth.rukstroy, second, true)) as unknown as MechRequestDto;
    const editedByApprover = ok(
      await call(auth.rukstroy, 'PATCH', `/${second.id}`, {
        plannedTo: shiftDateKey(PLANNED_TO, 3),
        version: signed.version,
      }),
    ) as unknown as MechRequestDto;
    expect(editedByApprover.approvedAt).toBe(signed.approvedAt);
  }, 60_000);

  // ── Протокол мутаций (Р12) ──

  it('устаревшая версия отвечает 409 раньше предметных правил', async () => {
    const request = await createRequest(auth.shtab);
    const approved = ok(
      await setApproval(auth.rukstroy, request, true),
    ) as unknown as MechRequestDto;

    // Версия из первого ответа уже неактуальна: 409 «перечитай», а не 422 про правило.
    const stale = await setApproval(auth.rukstroy, request, false);
    expect(stale.statusCode, stale.body).toBe(409);
    expect((await card(auth.rukstroy, request.id)).approvedAt).toBe(approved.approvedAt);
  }, 60_000);

  // ── Фильтр (Р13) ──

  it('фильтр отбирает по подписи, а не по статусу', async () => {
    const waiting = await createRequest(auth.shtab);
    const signed = await createRequest(auth.shtab);
    ok(await setApproval(auth.rukstroy, signed, true));

    const nums = async (query: string): Promise<number[]> => {
      const res = await call(
        auth.manager,
        'GET',
        `/?pageSize=100&placeObjectId=${ctx.objectId}&${query}`,
      );
      return ((ok(res) as { items: MechRequestDto[] }).items ?? []).map((r) => r.num);
    };

    expect(await nums('approved=false')).toContain(waiting.num);
    expect(await nums('approved=false')).not.toContain(signed.num);
    expect(await nums('approved=true')).toContain(signed.num);
  }, 60_000);
});
