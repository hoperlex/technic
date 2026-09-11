import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` уже после того, как выставлено окружение, —
// конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * **ЗАМКИ СНЯТИЯ ОСНОВАНИЯ И ДВУСТОРОННИЕ ОГРАНИЧЕНИЯ СВЯЗИ** — решение Р6 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md` и находка §8 «Узкие места
 * реализации» (этап Э4, миграция 0309).
 *
 * ЧТО ДОКАЗЫВАЕТ ФАЙЛ.
 *
 *   З1. Страница счёта, которым предъявлен объём работ, не снимается НИ АВТОРОМ, ни держателем
 *       `files.manageAny`, и отказ НАЗЫВАЕТ ВЫХОД: новое предъявление (прежняя ревизия становится
 *       недействующей) и закрытие доступа по обращению. Запрет без выхода читается как поломка, и
 *       ищут тогда обход, а не выход.
 *   З2. Замок не «пока предъявление висит»: после возврата объёма работ в правку и ДВУХ новых
 *       предъявлений страницы первой ревизии на месте и по-прежнему не снимаются. Отозванная
 *       ревизия остаётся тем, на чём денежное решение СТОЯЛО.
 *   З3. Страховка от прямого удаления строки ревизии: `ON DELETE RESTRICT` составного внешнего
 *       ключа (миграция 0306) не отдаёт ревизию, у которой есть живая страница, — иначе уборка или
 *       правка руками унесла бы доказательство молча.
 *   З4. Правило роли ДВУСТОРОННЕЕ (0309): ни закрывающая бумага с номером ревизии, ни основание без
 *       ревизии, ни вложение с номером листа базе не годятся. Односторонняя редакция 0306 первые
 *       два случая пропускала, и у такой строки `RESTRICT` сторожил бы акт как доказательство
 *       денежного решения, а ручка снятия тот же акт отдавала бы: она спрашивает роль.
 *   З5. Адрес листа однозначен (0309): два первых листа одной ревизии отбиваются уникальностью.
 *       На этот номер обопрётся разбор документа (Р12) — два «листа 1» означают, что распознанное
 *       некуда класть.
 *
 * ПОЧЕМУ БАЗА. Четыре из пяти утверждений — про саму схему: `CHECK` роли, составной внешний ключ с
 * `RESTRICT` и частичный уникальный индекс с `NULLS NOT DISTINCT`. На моках проверялось бы
 * собственное представление о базе, а предмет спора — именно то, что накатила миграция. Первые два
 * идут ручками портала: замок обязан держать под той же блокировкой, которой идёт удаление, и
 * отвечать обеим сторонам — автору и распорядителю чужими файлами.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл переключает ГЛОБАЛЬНЫЙ рубильник документной
 * подачи, а в общей базе рядом работают соседи — переключённый ключ менял бы поведение их ручек
 * посреди прогона. Механизм тот же, что у `service-estimate-document-submit`.
 *
 * Запуск (из `apps/api`; базу тест заводит и сносит сам, из адреса берётся только кластер):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5457/postgres \
 *     npx vitest run test/service-estimate-basis-locks.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_basis_locks_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-basis-locks-password-123';
const REQUESTS = '/api/v1/service-requests';

/**
 * Заголовок входа. Псевдонимом, а не `interface`: заголовки `inject` — тип с индексной подписью, и
 * интерфейс без неё туда не присваивается.
 */
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
  /** Администратор: заводит парк и держит `files.manageAny` — отрицательная половина З1. */
  admin: TestUser;
  /** Заказчик площадки: заводит заявку. */
  customer: TestUser;
  /** «Ведение» модуля: назначает подрядчика. */
  operator: TestUser;
  /** Оператор назначенного контрагента-сервиса: предъявляет объём работ счётом и он же его автор. */
  service: TestUser;
  objectId: string;
  counterpartyId: string;
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
  // S3 здесь не участвует: страницы счёта подшиваются уже загруженными строками `files`.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // Почта выключена: предмет файла — замки связи, а включённый контур сделал бы каждый случай ещё
  // и проверкой smtp.
  process.env.MAIL_ENABLED ??= 'false';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Без расширений миграции не идут: их ставит владелец базы, а не миграция.
    for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы по адресу (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function inject(
  method: Method,
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method, url, headers: auth, remoteAddress: nextAddress() };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

function messageOf(res: LightMyRequestResponse): string {
  try {
    return (res.json() as { message?: string }).message ?? '';
  } catch {
    return res.body;
  }
}

async function card(id: string, auth: Auth = ctx.admin.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function versionOf(id: string): Promise<number> {
  return (await card(id)).version;
}

function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

let unitNo = 0;

/** Своя единица под каждую заявку: по технике разрешена одна открытая заявка. */
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `RICOH MP C2011 ${RUN}`,
    inventoryNumber: `LOCK-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 118',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заявка заказчика, назначенная подрядчику и взятая им в работу. */
async function requestInWork(description: string): Promise<string> {
  const created = await inject('POST', REQUESTS, ctx.customer.auth, {
    officeEquipmentId: await makeEquipment(),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as { request: ServiceRequestDto }).request.id;

  const assigned = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
    userIds: [],
    serviceCounterpartyId: ctx.counterpartyId,
    version: await versionOf(id),
  });
  expect(assigned.statusCode, assigned.body).toBe(200);

  const started = await inject('PATCH', `${REQUESTS}/${id}/start`, ctx.service.auth, {
    version: await versionOf(id),
  });
  expect(started.statusCode, started.body).toBe(200);
  return id;
}

/**
 * Загруженный файл строкой в `files`: настоящая загрузка идёт через presign в S3, которого в тесте
 * нет, а предмет проверки — связь файла с ревизией, а не транспорт.
 */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`locks/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'active', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Предъявление объёма работ счётом от лица подрядчика. */
async function submitDocument(id: string, fileIds: string[]): Promise<void> {
  const res = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
    mode: 'document',
    fileIds,
    version: await versionOf(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Возврат объёма работ в правку: ключ от замков висящего предъявления (Р9). */
async function reopen(id: string, reason: string): Promise<void> {
  const res = await inject('PATCH', `${REQUESTS}/${id}/estimate/reopen`, ctx.service.auth, {
    reason,
    version: await versionOf(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

interface LinkRow {
  file_id: string;
  kind: string;
  purpose: string;
  estimate_revision: number | null;
  page_no: number | null;
}

async function linksOf(id: string): Promise<LinkRow[]> {
  const res = await ctx.db.execute<LinkRow>(sql`
    SELECT file_id, kind, purpose, estimate_revision, page_no
      FROM service_request_files
     WHERE request_id = ${id}
     ORDER BY estimate_revision NULLS LAST, page_no NULLS LAST`);
  return res.rows;
}

async function revisionsOf(id: string): Promise<{ revision: number; state: string }[]> {
  const res = await ctx.db.execute<{ revision: number; state: string }>(sql`
    SELECT revision, state FROM service_request_estimate_revisions
     WHERE request_id = ${id} ORDER BY revision`);
  return res.rows;
}

/**
 * Ответ базы на запрещённую запись: код `SQLSTATE` и имя ограничения.
 *
 * Drizzle заворачивает ошибку драйвера, и оба признака лежат в причине, а не в сообщении верхнего
 * уровня: `toThrow(/имя_ограничения/)` на обёртке не срабатывает вовсе, а `toThrow()` без образца
 * прошёл бы на любом отказе — в том числе на опечатке в имени колонки, то есть проверял бы запрос, а
 * не замок.
 *
 * Точка сохранения не нужна: каждая попытка идёт своим запросом из пула, а не внутри общей
 * транзакции, — оборванной транзакции, в которой следующий запрос получил бы `25P02`, здесь нет.
 */
async function refusalOf(attempt: Promise<unknown>): Promise<{ code: string; constraint: string }> {
  try {
    await attempt;
  } catch (e) {
    const cause = (e as { cause?: { code?: string; constraint?: string } }).cause ?? e;
    const err = cause as { code?: string; constraint?: string };
    return { code: err.code ?? 'unknown', constraint: err.constraint ?? '—' };
  }
  return { code: 'принято', constraint: '—' };
}

/** Связь прямым `INSERT`: предмет З4 и З5 — сочетания, которых ручки не пишут вовсе. */
function linkDirectly(input: {
  requestId: string;
  fileId: string;
  kind: string;
  purpose: string;
  estimateRevision: number | null;
  pageNo: number | null;
}): Promise<unknown> {
  return ctx.db.execute(sql`
    INSERT INTO service_request_files (request_id, file_id, kind, purpose, estimate_revision,
                                      page_no, attached_by)
    VALUES (${input.requestId}, ${input.fileId}, ${input.kind}, ${input.purpose},
            ${input.estimateRevision}, ${input.pageNo}, ${ctx.service.id})`);
}

describe.skipIf(!DB_URL)('замки основания объёма работ и двусторонние ограничения связи', () => {
  /** Заявка З1–З3: объём работ предъявлен счётом в два листа. */
  let locked: { id: string; pages: string[] };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    await migrate(OWN_DB!);

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-locks-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-LOCK ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-7)}`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`LOCK-${RUN}`}, ${`Тестовая площадка LOCK ${RUN}`}, 'г Москва, ул Тестовая, д 2')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const adminUser = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId})`);

    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], adminUser.id);
    });

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const app = await buildApp();
    await app.ready();

    const login = async (user: { id: string; email: string }): Promise<TestUser> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: nextAddress(),
        payload: { email: user.email, password: PASSWORD },
      });
      if (res.statusCode !== 200) throw new Error(`вход ${user.email}: ${res.body}`);
      const token = (res.json() as { accessToken: string }).accessToken;
      return { ...user, auth: { authorization: `Bearer ${token}` } };
    };

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(adminUser),
      customer: await login(customer),
      operator: await login(operator),
      service: await login(service),
      objectId,
      counterpartyId,
      typeId,
    };

    /*
     * Рубильник документной подачи включается один раз на файл: выключенным он гасит ВХОД ручки
     * (422), и ни одной страницы-основания в базе не завелось бы вовсе. Сам рубильник — предмет
     * соседнего файла (`service-estimate-document-submit`), здесь он условие задачи.
     */
    const flag = await db.execute(
      sql`UPDATE feature_flags SET is_enabled = true WHERE key = 'service_estimate_document_mode'`,
    );
    expect(flag.rowCount, 'рубильник документной подачи не найден: миграция 0307 не накатана').toBe(
      1,
    );

    const id = await requestInWork('Объём работ предъявлен счётом в два листа');
    const pages = [
      await uploadedFile(ctx.service.id, `schet-list-1-${RUN}.pdf`),
      await uploadedFile(ctx.service.id, `schet-list-2-${RUN}.pdf`),
    ];
    await submitDocument(id, pages);
    locked = { id, pages };
  }, 180_000);

  afterAll(async () => {
    await ctx?.app?.close();
    await ctx?.closeDb();
    if (!DB_URL) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  // ── З1. Основание не снимается ни автором, ни распорядителем чужими файлами ──

  describe('З1. страница счёта не снимается никем', () => {
    it('автору отказ 422, и отказ называет оба выхода', async () => {
      const res = await inject(
        'DELETE',
        `${REQUESTS}/${locked.id}/files/${locked.pages[0]}`,
        ctx.service.auth,
      );
      expect(res.statusCode, res.body).toBe(422);
      const message = messageOf(res);
      expect(message).toContain('основание денежного решения');
      /*
       * ТЕКСТ ПРОВЕРЯЕТСЯ НЕ ИЗ ВЕЖЛИВОСТИ. Запрет без выхода читается как поломка: подавший не тот
       * счёт пойдёт искать обход — распорядителя чужими файлами, потом доступ к базе, — и снимет
       * связь руками, обойдя и внешний ключ. Поэтому в отказе обязаны стоять оба пути Р6: новое
       * предъявление (прежняя ревизия становится недействующей) и закрытие доступа по обращению.
       */
      expect(message).toContain('предъявите объём работ заново');
      expect(message).toContain('закрывают');
    });

    it('держателю files.manageAny — тот же отказ: замок абсолютный, а не про автора', async () => {
      const res = await inject(
        'DELETE',
        `${REQUESTS}/${locked.id}/files/${locked.pages[1]}`,
        ctx.admin.auth,
      );
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('основание денежного решения');
    });

    it('оба листа на месте, и роль у них та, которую назначил сервер', async () => {
      const rows = await linksOf(locked.id);
      expect(rows.map((r) => r.file_id)).toEqual(locked.pages);
      for (const row of rows) {
        expect(row.kind).toBe('invoice');
        expect(row.purpose).toBe('estimate_basis');
        expect(row.estimate_revision).toBe(1);
      }
      expect(rows.map((r) => r.page_no)).toEqual([1, 2]);
    });
  });

  // ── З2. Замок не про висящее предъявление ──

  describe('З2. отозванная ревизия остаётся доказательством', () => {
    it('после возврата в правку и двух новых предъявлений первый счёт по-прежнему не снимается', async () => {
      // Два новых предъявления, каждое со своим счётом: прежний замок держался условием
      // «предъявление висит», и после `reopen` он открывался — вместе с доказательством того, на
      // чём денежное решение стояло.
      for (const listNo of [2, 3]) {
        await reopen(locked.id, `Счёт ${listNo - 1} оказался не тот`);
        await submitDocument(locked.id, [
          await uploadedFile(ctx.service.id, `schet-rev${listNo}-${RUN}.pdf`),
        ]);
      }
      // Ревизий три, действующая одна — прежние помечены недействующими, а не удалены.
      expect(await revisionsOf(locked.id)).toEqual([
        { revision: 1, state: 'superseded' },
        { revision: 2, state: 'superseded' },
        { revision: 3, state: 'active' },
      ]);

      for (const auth of [ctx.service.auth, ctx.admin.auth]) {
        const res = await inject(
          'DELETE',
          `${REQUESTS}/${locked.id}/files/${locked.pages[0]}`,
          auth,
        );
        expect(res.statusCode, res.body).toBe(422);
        expect(messageOf(res)).toContain('основание денежного решения');
      }
      // Четыре страницы: два листа первой ревизии и по одному у второй и третьей.
      expect((await linksOf(locked.id)).map((r) => r.estimate_revision)).toEqual([1, 1, 2, 3]);
    });
  });

  // ── З3. Страховка от прямого удаления строки ревизии ──

  describe('З3. RESTRICT не отдаёт ревизию с живой страницей', () => {
    it('прямое удаление строки ревизии отбивается внешним ключом', async () => {
      expect(
        await refusalOf(
          ctx.db.execute(sql`
            DELETE FROM service_request_estimate_revisions
             WHERE request_id = ${locked.id} AND revision = 1`),
        ),
      ).toEqual({ code: '23503', constraint: 'service_request_files_estimate_revision_fk' });
      expect(await revisionsOf(locked.id)).toHaveLength(3);
    });
  });

  // ── З4. Правило роли двустороннее (миграция 0309) ──

  describe('З4. двусторонний CHECK роли', () => {
    it('закрывающая бумага с номером ревизии базе не годится', async () => {
      expect(
        await refusalOf(
          linkDirectly({
            requestId: locked.id,
            fileId: await uploadedFile(ctx.service.id, `akt-${RUN}.pdf`),
            kind: 'act',
            purpose: 'closing_evidence',
            estimateRevision: 1,
            pageNo: null,
          }),
        ),
      ).toEqual({ code: '23514', constraint: 'service_request_files_basis_check' });
    });

    it('вложение с номером листа базе не годится: порядок вне документа ничего не значит', async () => {
      expect(
        await refusalOf(
          linkDirectly({
            requestId: locked.id,
            fileId: await uploadedFile(ctx.service.id, `foto-${RUN}.jpg`),
            kind: 'attachment',
            purpose: 'closing_evidence',
            estimateRevision: null,
            pageNo: 1,
          }),
        ),
      ).toEqual({ code: '23514', constraint: 'service_request_files_basis_check' });
    });

    it('основание без ревизии базе не годится: замок Р6 ищет страницы по ревизии', async () => {
      expect(
        await refusalOf(
          linkDirectly({
            requestId: locked.id,
            fileId: await uploadedFile(ctx.service.id, `schet-bez-revizii-${RUN}.pdf`),
            kind: 'invoice',
            purpose: 'estimate_basis',
            estimateRevision: null,
            pageNo: 1,
          }),
        ),
      ).toEqual({ code: '23514', constraint: 'service_request_files_basis_check' });
    });
  });

  // ── З5. Адрес листа однозначен (миграция 0309) ──

  describe('З5. уникальность страницы основания', () => {
    it('два первых листа одной ревизии отбиваются уникальностью', async () => {
      expect(
        await refusalOf(
          linkDirectly({
            requestId: locked.id,
            fileId: await uploadedFile(ctx.service.id, `schet-dubl-lista-${RUN}.pdf`),
            kind: 'invoice',
            purpose: 'estimate_basis',
            estimateRevision: 1,
            pageNo: 1,
          }),
        ),
      ).toEqual({ code: '23505', constraint: 'service_request_files_basis_page_unique' });
    });

    it('два беспорядковых основания одной ревизии — тот же отказ: NULLS NOT DISTINCT', async () => {
      /*
       * Пустой `page_no` у основания схема допускает: одностраничный счёт порядка листов не имеет.
       * Но ДВА таких основания у одной ревизии — тот же неоднозначный адрес, ради которого индекс и
       * заведён, и без `NULLS NOT DISTINCT` они прошли бы оба: в B-tree `NULL <> NULL`.
       */
      const third = await uploadedFile(ctx.service.id, `schet-rev3-bez-lista-${RUN}.pdf`);
      await linkDirectly({
        requestId: locked.id,
        fileId: third,
        kind: 'invoice',
        purpose: 'estimate_basis',
        estimateRevision: 3,
        pageNo: null,
      });
      expect(
        await refusalOf(
          linkDirectly({
            requestId: locked.id,
            fileId: await uploadedFile(ctx.service.id, `schet-rev3-vtoroy-${RUN}.pdf`),
            kind: 'invoice',
            purpose: 'estimate_basis',
            estimateRevision: 3,
            pageNo: null,
          }),
        ),
      ).toEqual({ code: '23505', constraint: 'service_request_files_basis_page_unique' });
    });
  });
});
