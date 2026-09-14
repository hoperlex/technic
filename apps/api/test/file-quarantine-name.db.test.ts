import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type { buildApp } from '../src/app';

/**
 * КАРАНТИН И ИМЯ ФАЙЛА: пятая дверь к улике — не содержимое, а ПОДПИСЬ (план
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6, п. 4).
 *
 * Соседи доказывают другое: `file-quarantine.db.test.ts` — что закрыт доступ к содержимому,
 * `file-quarantine-evidence.db.test.ts` — что улику не уносят снятие вложения, уборка воркера,
 * подшивка и очередь распознавания. Осталась утечка, которой не нужен ни один из этих путей:
 * «Паспорт_Иванова_1984.pdf» в списке вложений карточки читает всякий, кому видна сама заявка. Имя
 * файла само бывает персональными данными, и карантин, закрывший содержимое, но оставивший подпись,
 * закрывает не инцидент, а его половину.
 *
 * ПОЧЕМУ ТЕСТ ХОДИТ В ТРИ РАЗНЫХ МОДУЛЯ. Вложения перечисляют десять сборщиков разных модулей, и
 * каждый собирает свой DTO своим кодом. Правило здесь одно и живёт в одном месте
 * (`services/file-view.ts`), а проверять его в одном модуле значило бы проверять одну из десяти
 * копий — ровно то состояние, из которого эта работа и начиналась. Взяты три сборщика, сходящиеся в
 * общей функции разными путями: карточка и список вывоза мусора (`routes/waste-requests.ts`,
 * `fileView`), экран разбора талонов (`routes/waste-tickets.ts`, `fileNameView` в чужом DTO со
 * своими полями), карточка механизации (`services/mech-request-dto.ts`, общий сборщик списка и
 * карточки) и карточка со списком заявок оргтехники (`routes/service-requests.ts`,
 * `filesByRequest`). Убери условие в общей функции — падают все четыре.
 *
 * ЧЕТВЁРТЫЙ ДОБАВЛЕН ПОЗЖЕ ОСТАЛЬНЫХ И НЕ ЗА КОМПАНИЮ: карантин заведён решением Р6 плана заявок
 * ОРГТЕХНИКИ, а сборщик этого модуля был единственным из десяти, кто правила не спрашивал вовсе.
 * Проверка «в трёх чужих модулях» зелёная, пока свой течёт, — ровно та слепота, из-за которой дыра и
 * дожила до исполнения.
 *
 * ОБРАТНАЯ СТОРОНА В КАЖДОМ СЛУЧАЕ. Рядом с запертым файлом всюду идёт обычный, и он обязан отдать
 * имя: без этой половины «пустое имя» одинаково хорошо объяснялось бы сломанной фикстурой — связью
 * не того вида, файлом не в том статусе, заявкой, которой сборщик вообще не видит.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Идентификатор файла остаётся на месте, и это проверяется: доступ
 * закрывает замок в `canAccessFile`, а вторая проверка в DTO раздвоила бы правило доступа. Строка
 * вложения тоже остаётся: «документ скрыт по обращению» и «документа не было» — разные факты.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test file-quarantine-name
 *
 * Без `TEST_DATABASE_URL` файл пропускается. Живого хранилища он не требует: постановка в карантин
 * считает хеш ПОСЛЕ закрытия доступа и недосчитанный оставляет пустым (Р6), а на хеш здесь не
 * опирается ни одно утверждение.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-quarantine-name-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
/** Метка своих заявок: база у db-тестов общая и переживает повторный запуск. */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: карантин и имя вложения';
/**
 * Префикс ключей объектов: по нему уборка находит своё, включая оставленное падением.
 *
 * Префиксы и адреса НАМЕРЕННО свои, не пересекающиеся с соседними файлами про карантин: база общая,
 * прогоны идут параллельно, и уборка соседа по своему `LIKE` унесла бы учётку этого файла посреди
 * его подготовки.
 */
const KEY_PREFIX = 'db-quarantine-name/';
const OBJECT_CODE = 'QNM-TEST';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
}

let ctx: Ctx;
let fileNo = 0;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // Адрес хранилища заведомо мёртвый: хеш карантинного файла не считается, отказ приходит сразу, а
  // не таймаутом, и ни одно утверждение теста от хеша не зависит.
  process.env.S3_ENDPOINT ??= 'http://127.0.0.1:9';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED = 'false';
  process.env.AI_PROVIDER_MODE = 'stub';
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
 * Уборка своих строк — и ПЕРЕД прогоном тоже: упавшая подготовка оставляет мусор, а база общая.
 * Порядок задан внешними ключами: заявки (за ними каскадом связи файлов), файлы, журнал, учётка и
 * только в конце площадка — её держит `RESTRICT`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const admin = sql`(SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`;
  await db.execute(sql`
    DELETE FROM jobs
     WHERE type = 'delete_s3_object' AND payload->>'objectKey' LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${admin}`);
  await db.execute(sql`DELETE FROM mech_requests WHERE created_by IN ${admin}`);
  // Заявки оргтехники — до файлов и до площадки: связи вложений уходят каскадом за заявкой, а
  // площадку держит `RESTRICT` со снимка.
  await db.execute(sql`DELETE FROM service_requests WHERE created_by IN ${admin}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${admin}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code = ${OBJECT_CODE}`);
}

// ── Фикстуры ──

interface TestFile {
  id: string;
  filename: string;
}

/** Файл строкой в `files`: имя у каждого своё, чтобы перепутать отданное было нельзя. */
async function newFile(): Promise<TestFile> {
  fileNo += 1;
  const filename = `документ-${fileNo}-${randomUUID().slice(0, 8)}.pdf`;
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${KEY_PREFIX}${randomUUID()}`,
      filename,
      contentType: 'application/pdf',
      size: 2048,
      status: 'active',
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  return { id: row!.id, filename };
}

/**
 * Заявка на вывоз металлолома: у неё нет предмета вовсе (ADR 0067), поэтому фикстуре не нужны ни
 * тип мусора, ни объём, ни тариф, а талоны читаются у заявок любого типа (ADR 0150).
 */
async function newWasteRequest(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'metal_removal',
      deliveryAt: new Date(),
      status: 'new',
      createdBy: ctx.adminId,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      comment: MARK,
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

async function newMechRequest(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.mechRequests)
    .values({
      objectId: ctx.objectId,
      plannedFrom: '2026-09-01',
      plannedTo: '2026-09-10',
      responsibleName: 'Петров Пётр Петрович',
      responsiblePhone: '9990000001',
      status: 'new',
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.mechRequests.id });
  return row!.id;
}

/**
 * Связи файлов вставляются напрямую, а не штатной правкой заявки: проверяется СБОРЩИК ответа, и
 * путь, которым файл стал вложением, на его работу не влияет. Карантин, наоборот, ставится
 * настоящей ручкой — его поведение и есть предмет проверки.
 */
/**
 * Заявка оргтехники БЕЗ АППАРАТА: предмет здесь ни при чём — проверяется сборщик вложений, а
 * `office_equipment_id` у заявки необязателен (заявка «от отдела»). Так фикстуре не нужны ни
 * карточка парка, ни её тип, ни порядок уборки между ними.
 */
async function newServiceRequest(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.serviceRequests)
    .values({
      equipmentObjectId: ctx.objectId,
      equipmentName: '',
      description: `${MARK}: заявка оргтехники`,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.serviceRequests.id });
  return row!.id;
}

async function linkWasteFile(
  requestId: string,
  fileId: string,
  kind: 'attachment' | 'ticket',
): Promise<void> {
  await ctx.db.insert(ctx.schema.requestFiles).values({ requestId, fileId, kind });
}

async function linkMechFile(requestId: string, fileId: string): Promise<void> {
  await ctx.db.insert(ctx.schema.mechRequestFiles).values({ requestId, fileId });
}

async function linkServiceFile(requestId: string, fileId: string): Promise<void> {
  await ctx.db.insert(ctx.schema.serviceRequestFiles).values({ requestId, fileId, kind: 'act' });
}

async function quarantine(fileId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/quarantine`,
    headers: ctx.auth,
    payload: { reason: 'Приложен чужой документ с персональными данными — обращение прогона' },
  });
  expect(res.statusCode, `постановка в карантин: ${res.body}`).toBe(200);
}

async function releaseQuarantine(fileId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/quarantine/release`,
    headers: ctx.auth,
    payload: { reason: 'Разбор окончен, документ к заявке относится — обращение прогона' },
  });
  expect(res.statusCode, `снятие карантина: ${res.body}`).toBe(200);
}

async function get(url: string): Promise<{ statusCode: number; body: unknown }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: ctx.auth });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return { statusCode: res.statusCode, body: res.json() };
}

/** Вложение глазами читающего экрана — ровно те поля, о которых идёт спор. */
interface SeenFile {
  id?: string;
  fileId?: string;
  filename: string;
  quarantined?: boolean;
}

function pick(list: SeenFile[], id: string): SeenFile {
  const found = list.find((f) => (f.id ?? f.fileId) === id);
  expect(found, `строка файла ${id} осталась в ответе`).toBeDefined();
  return found!;
}

/**
 * Что обязан увидеть читающий экран у запертого файла. Проверяется ТРОЙКА, а не одно поле: строка
 * на месте (скрывать её — переписывать историю заявки), имени нет, и состояние названо признаком.
 */
function expectHidden(list: SeenFile[], fileId: string): void {
  const seen = pick(list, fileId);
  // Пустая строка, а не слово-заглушка: «Документ скрыт» в списке файлов читается как имя файла, и
  // первый же человек пойдёт искать такой документ у себя.
  expect(seen.filename).toBe('');
  expect(seen.quarantined).toBe(true);
}

/** Обратная сторона: обычный файл отдаёт имя, и признака у него НЕТ вовсе — отсутствие и есть «нет». */
function expectVisible(list: SeenFile[], file: TestFile): void {
  const seen = pick(list, file.id);
  expect(seen.filename).toBe(file.filename);
  expect(seen.quarantined).toBeUndefined();
}

describe.skipIf(!DB_URL)('карантин: имя вложения наружу не уходит (Р6, п. 4)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    // Сперва уборка: упавший прогон оставляет учётку и площадку, а имена у них те же.
    await cleanup(db);

    const { hashPassword } = await import('../src/auth/password');
    const [admin] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: 'Имени',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    // Площадка СВОЯ, а не «первая попавшаяся»: чужую у соседнего файла уносит его `afterAll`
    // посреди прогона — так уже падала пара db-тестов.
    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: OBJECT_CODE,
        name: 'Тестовая площадка имени вложения',
        address: 'г Москва, ул Тестовая, д 2',
      })
      .returning({ id: schema.constructionObjects.id });

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      schema,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken as string}` },
      adminId: admin!.id,
      objectId: object!.id,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 1. Вывоз мусора: карточка и список — один сборщик, две ручки
  // ──────────────────────────────────────────────────────────────────────────────────────────

  describe('вывоз мусора (routes/waste-requests.ts)', () => {
    it('в карточке у карантинного вложения имя пусто, признак стоит, ссылка на месте', async () => {
      const requestId = await newWasteRequest();
      const locked = await newFile();
      const plain = await newFile();
      await linkWasteFile(requestId, locked.id, 'attachment');
      await linkWasteFile(requestId, plain.id, 'attachment');
      await quarantine(locked.id);

      const { body } = await get(`/api/v1/waste-requests/${requestId}`);
      const dto = body as { files: SeenFile[] };
      expectHidden(dto.files, locked.id);
      expectVisible(dto.files, plain);

      // Идентификатор остаётся — и это решение, а не недоделка: содержимое закрывает приоритетный
      // запрет в `canAccessFile`, и вторая проверка в DTO раздвоила бы правило доступа.
      expect(pick(dto.files, locked.id).id).toBe(locked.id);
    });

    it('то же в списке: правило живёт в сборщике, а не в ручке', async () => {
      const requestId = await newWasteRequest();
      const locked = await newFile();
      const plain = await newFile();
      await linkWasteFile(requestId, locked.id, 'attachment');
      await linkWasteFile(requestId, plain.id, 'attachment');
      await quarantine(locked.id);

      const { body } = await get('/api/v1/waste-requests?limit=100');
      const page = body as { items: { id: string; files: SeenFile[] }[] };
      const row = page.items.find((r) => r.id === requestId);
      expect(row, 'заявка нашлась в списке').toBeDefined();
      expectHidden(row!.files, locked.id);
      expectVisible(row!.files, plain);
    });

    it('снятие карантина возвращает имя: признак — состояние файла, а не клеймо', async () => {
      const requestId = await newWasteRequest();
      const file = await newFile();
      await linkWasteFile(requestId, file.id, 'attachment');
      await quarantine(file.id);

      const hidden = (await get(`/api/v1/waste-requests/${requestId}`)).body as {
        files: SeenFile[];
      };
      expectHidden(hidden.files, file.id);

      await releaseQuarantine(file.id);

      const shown = (await get(`/api/v1/waste-requests/${requestId}`)).body as {
        files: SeenFile[];
      };
      expectVisible(shown.files, file);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 2. Разбор талонов: чужой DTO со своими полями — и то же правило
  // ──────────────────────────────────────────────────────────────────────────────────────────

  describe('разбор талонов (routes/waste-tickets.ts)', () => {
    it('в списке листов у карантинного талона имя пусто, а строка и её причина остаются', async () => {
      const requestId = await newWasteRequest();
      const locked = await newFile();
      const plain = await newFile();
      await linkWasteFile(requestId, locked.id, 'ticket');
      await linkWasteFile(requestId, plain.id, 'ticket');
      await quarantine(locked.id);

      const { body } = await get(`/api/v1/waste-requests/${requestId}/tickets`);
      const dto = body as { files: (SeenFile & { status: string; reason: string })[] };
      expectHidden(dto.files, locked.id);
      expectVisible(dto.files, plain);

      // Строка разбора не пустеет следом за именем: человеку по-прежнему сказано, почему талона нет
      // в разборе, — иначе вместо объяснения он увидел бы молчание.
      const seen = dto.files.find((f) => f.fileId === locked.id)!;
      expect(seen.status).toBe('not_queued');
      expect(seen.reason).not.toBe('');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 3. Механизация: другой модуль, другой сборщик, то же правило
  // ──────────────────────────────────────────────────────────────────────────────────────────

  describe('механизация (services/mech-request-dto.ts)', () => {
    it('в карточке аренды у карантинного вложения имя пусто и стоит признак', async () => {
      const requestId = await newMechRequest();
      const locked = await newFile();
      const plain = await newFile();
      await linkMechFile(requestId, locked.id);
      await linkMechFile(requestId, plain.id);
      await quarantine(locked.id);

      const { body } = await get(`/api/v1/mech-requests/${requestId}`);
      const dto = body as { files: SeenFile[] };
      expectHidden(dto.files, locked.id);
      expectVisible(dto.files, plain);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 4. Оргтехника: модуль, РАДИ КОТОРОГО карантин и заведён
  // ──────────────────────────────────────────────────────────────────────────────────────────

  /**
   * ЧЕТВЁРТЫЙ СБОРЩИК — И ГЛАВНЫЙ. Карантин заведён решением Р6 плана
   * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, то есть плана заявок оргтехники, и
   * буквальный сценарий решения — ошибочно приложенный к заявке чужой документ с персональными
   * данными. Сборщик вложений этого модуля (`filesByRequest` в `routes/service-requests.ts`)
   * собирает `ServiceRequestFileDto` своим кодом и дольше всех оставался единственным из десяти, кто
   * правила не спрашивал: имя запертого файла уходило и в карточку, и в список, и в ответ каждого
   * действия — всем, кому видна заявка.
   *
   * Список проверяется рядом с карточкой не для симметрии: в модуле это РАЗНЫЕ ручки с одной
   * пакетной догрузкой, и утечка в списке видна большему числу людей, чем утечка в карточке.
   */
  describe('оргтехника (routes/service-requests.ts)', () => {
    it('в карточке заявки у карантинного вложения имя пусто, признак стоит, ссылка на месте', async () => {
      const requestId = await newServiceRequest();
      const locked = await newFile();
      const plain = await newFile();
      await linkServiceFile(requestId, locked.id);
      await linkServiceFile(requestId, plain.id);
      await quarantine(locked.id);

      const { body } = await get(`/api/v1/service-requests/${requestId}`);
      const dto = body as { files: SeenFile[] };
      expectHidden(dto.files, locked.id);
      expectVisible(dto.files, plain);
      expect(pick(dto.files, locked.id).id).toBe(locked.id);
    });

    it('то же в списке заявок: правило живёт в сборщике, а не в ручке', async () => {
      const requestId = await newServiceRequest();
      const locked = await newFile();
      const plain = await newFile();
      await linkServiceFile(requestId, locked.id);
      await linkServiceFile(requestId, plain.id);
      await quarantine(locked.id);

      const { body } = await get('/api/v1/service-requests?limit=100');
      const page = body as { items: { id: string; files: SeenFile[] }[] };
      const row = page.items.find((r) => r.id === requestId);
      expect(row, 'заявка нашлась в списке').toBeDefined();
      expectHidden(row!.files, locked.id);
      expectVisible(row!.files, plain);
    });

    it('снятие карантина возвращает имя и здесь — признак остаётся состоянием файла', async () => {
      const requestId = await newServiceRequest();
      const file = await newFile();
      await linkServiceFile(requestId, file.id);
      await quarantine(file.id);

      const hidden = (await get(`/api/v1/service-requests/${requestId}`)).body as {
        files: SeenFile[];
      };
      expectHidden(hidden.files, file.id);

      await releaseQuarantine(file.id);

      const shown = (await get(`/api/v1/service-requests/${requestId}`)).body as {
        files: SeenFile[];
      };
      expectVisible(shown.files, file);
    });
  });
});
