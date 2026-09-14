import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestChangeDto, RequestHistoryEntryDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type { buildApp } from '../src/app';

/**
 * КАРАНТИН И ИСТОРИЯ ЗАЯВКИ: шестая дверь к улике — не вложение в карточке, а СОБЫТИЕ ПРАВКИ (план
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6, п. 4).
 *
 * Соседи доказывают другое: `file-quarantine.db.test.ts` — что закрыто содержимое,
 * `file-quarantine-evidence.db.test.ts` — что улику не уносят снятие вложения, уборка воркера и
 * подшивка, `file-quarantine-name.db.test.ts` — что имя не уходит ни из одного сборщика вложений.
 * Оставалась дорога, которой сборщик вложений не нужен вовсе: «Паспорт_Иванова_1984.pdf» записан в
 * `audit_log.metadata.changes` в момент ПОДШИВКИ и читается из истории всякий раз, когда карточку
 * открывают, — даже после того, как вложение сняли. Карантин, закрывший содержимое и имя в списке
 * файлов, но оставивший имя в ленте событий, закрывает не инцидент, а его половину.
 *
 * ПОЧЕМУ ЭТОМУ ФАЙЛУ НУЖНА БАЗА. Утечка живёт РОВНО между писателем и читателем: дифф складывает
 * событие (`services/request-diff.ts`), маршрут пишет его в `audit_log`, а карточка читает журнал
 * обратно (`services/request-history.ts`) — и имя в журнале остаётся тем, каким было до карантина.
 * Ни одну из половин по отдельности проверять бессмысленно: у писателя карантина ещё нет, а
 * подменённый журнал вернёт то, что в него положили. Вопрос стоит в том, что приезжает в
 * `RequestHistoryEntryDto` после НАСТОЯЩЕЙ записи, настоящего карантина и настоящего чтения.
 *
 * ЧТО ИМЕННО УТВЕРЖДАЕТСЯ
 *
 * 1. имя запертого файла не уходит в истории НИ ОДНОМУ читателю — ни площадке, ни администратору,
 *    который этот файл и загрузил (доступ автора к неподшитому файлу карантин закрывает первым, и
 *    история обязана вести себя так же);
 * 2. обратная сторона: имя обычного файла в истории остаётся. Без неё «имени нет» одинаково хорошо
 *    объяснялось бы сломанной фикстурой — правкой, которой не было, или событием не того вида;
 * 3. снятие вложения имя не возвращает: событие «откреплены файлы» проходит то же правило;
 * 4. снятие карантина возвращает имя в историю — признак описывает состояние файла, а не клеймо;
 * 5. ЗАПИСЬ СТАРОГО ОБРАЗЦА (без пар «идентификатор → имя») читается как прежде. Такие записи в
 *    журнале останутся навсегда: историю заявки не переписывают, и читатель обязан их переживать.
 *
 * Читатель истории у вывоза мусора, заказа ТС и механизации ОДИН (`mergeHistory`), и правило имени
 * живёт в нём одном, поэтому сцена взята одна — заявка вывоза. Проверять то же трижды значило бы
 * проверять один и тот же вызов с трёх сторон; а вот сборщиков вложений десять, и там наоборот —
 * соседний файл ходит в три модуля осознанно.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test file-quarantine-history
 *
 * Без `TEST_DATABASE_URL` файл пропускается. Живого хранилища не требует: постановка в карантин
 * считает хеш ПОСЛЕ закрытия доступа и недосчитанный оставляет пустым (Р6), а на хеш здесь не
 * опирается ни одно утверждение.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-quarantine-history-admin@example.invalid';
const SITE_EMAIL = 'db-quarantine-history-site@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка своих заявок: база у db-тестов общая и переживает повторный запуск. */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: карантин и история заявки';
/**
 * Префиксы и код площадки СВОИ, не пересекающиеся с соседними файлами про карантин: база общая,
 * прогоны идут параллельно, и уборка соседа по своему `LIKE` унесла бы учётку этого файла посреди
 * его подготовки.
 */
const KEY_PREFIX = 'db-quarantine-history/';
const OBJECT_CODE = 'QHIST-TEST';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  /** Администратор: он и загрузил файлы, и правит заявку. */
  admin: { authorization: string };
  /** Площадка: видит заявку по своему объекту и файлов не загружала. */
  site: { authorization: string };
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
  process.env.RATE_LIMIT_MAX ??= '100000';
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
 * Порядок задан внешними ключами: заявки (за ними каскадом связи файлов), файлы, журнал, учётки и
 * только в конце площадка — её держит `RESTRICT`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const mine = sql`(SELECT id FROM users WHERE email IN (${ADMIN_EMAIL}, ${SITE_EMAIL}))`;
  await db.execute(sql`
    DELETE FROM jobs
     WHERE type = 'delete_s3_object' AND payload->>'objectKey' LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${mine}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${mine}`);
  await db.execute(sql`DELETE FROM users WHERE email IN (${ADMIN_EMAIL}, ${SITE_EMAIL})`);
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
      // Загрузил администратор — он же потом читает историю: автору файла имя тоже не уходит.
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  return { id: row!.id, filename };
}

/**
 * Заявка на вывоз металлолома: у неё нет предмета вовсе (ADR 0067), поэтому фикстуре не нужны ни
 * тип мусора, ни объём, ни тариф. Заводится прямой вставкой — спор идёт о событии ПРАВКИ, а не о
 * заведении, — зато сама правка идёт штатной ручкой: только она и пишет событие в журнал.
 */
async function newWasteRequest(): Promise<{ id: string; version: number }> {
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
    .returning({ id: ctx.schema.wasteRequests.id, version: ctx.schema.wasteRequests.version });
  return { id: row!.id, version: row!.version };
}

/** Штатная правка заявки: подшивка и снятие вложения — ровно те действия, что пишут событие. */
async function patchFiles(
  requestId: string,
  version: number,
  body: { addFileIds?: string[]; removeFileIds?: string[] },
): Promise<number> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/waste-requests/${requestId}`,
    headers: ctx.admin,
    payload: { version, ...body },
  });
  expect(res.statusCode, `правка заявки: ${res.body}`).toBe(200);
  return res.json().version as number;
}

async function quarantine(fileId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/quarantine`,
    headers: ctx.admin,
    payload: { reason: 'Приложен чужой документ с персональными данными — обращение прогона' },
  });
  expect(res.statusCode, `постановка в карантин: ${res.body}`).toBe(200);
}

async function releaseQuarantine(fileId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/quarantine/release`,
    headers: ctx.admin,
    payload: { reason: 'Разбор окончен, документ к заявке относится — обращение прогона' },
  });
  expect(res.statusCode, `снятие карантина: ${res.body}`).toBe(200);
}

/** История глазами названного читателя: ручка одна, а читателей у неё несколько. */
async function history(
  requestId: string,
  as: { authorization: string },
): Promise<{ entries: RequestHistoryEntryDto[]; raw: string }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/${requestId}/history`,
    headers: as,
  });
  expect(res.statusCode, `история заявки: ${res.body}`).toBe(200);
  return { entries: res.json() as RequestHistoryEntryDto[], raw: res.body };
}

function changesOf(entries: RequestHistoryEntryDto[], field: string): RequestChangeDto[] {
  return entries.flatMap((e) => e.changes.filter((c) => c.field === field));
}

function onlyChange(entries: RequestHistoryEntryDto[], field: string): RequestChangeDto {
  const found = changesOf(entries, field);
  expect(found, `событие «${field}» в истории`).toHaveLength(1);
  return found[0]!;
}

/**
 * Файл в событии истории. Проверяется ТРОЙКА, как и у вложения в карточке: строка на месте
 * (скрывать её — переписывать историю заявки), имени нет, состояние названо признаком.
 */
function expectHidden(change: RequestChangeDto, fileId: string): void {
  const seen = change.files?.find((f) => f.id === fileId);
  expect(seen, `строка файла ${fileId} осталась в событии`).toBeDefined();
  // Пустая строка, а не слово-заглушка: «Документ скрыт» читается как имя файла, и первый же
  // человек пойдёт искать такой документ у себя.
  expect(seen!.filename).toBe('');
  expect(seen!.quarantined).toBe(true);
}

/** Обратная сторона: обычный файл имя отдаёт, и признака у него НЕТ вовсе. */
function expectVisible(change: RequestChangeDto, file: TestFile): void {
  const seen = change.files?.find((f) => f.id === file.id);
  expect(seen, `строка файла ${file.id} осталась в событии`).toBeDefined();
  expect(seen!.filename).toBe(file.filename);
  expect(seen!.quarantined).toBeUndefined();
}

describe.skipIf(!DB_URL)('карантин: имя файла не уходит в истории заявки (Р6, п. 4)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    // Сперва уборка: упавший прогон оставляет учётки и площадку, а имена у них те же.
    await cleanup(db);

    const { hashPassword } = await import('../src/auth/password');
    const passwordHash = await hashPassword(PASSWORD);
    const [admin] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: 'Исторический',
        passwordHash,
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
        name: 'Тестовая площадка истории вложения',
        address: 'г Москва, ул Тестовая, д 3',
      })
      .returning({ id: schema.constructionObjects.id });

    // Второй читатель — объектная роль на той же площадке: заявку она видит, а файл грузила не
    // она. Без него «имени нет» доказывало бы только поведение администратора.
    const [site] = await db
      .insert(schema.users)
      .values({
        email: SITE_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Комендант',
        middleName: 'Площадочный',
        passwordHash,
        role: 'site',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    await db
      .insert(schema.userConstructionObjects)
      .values({ userId: site!.id, constructionObjectId: object!.id });

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    const login = async (email: string): Promise<{ authorization: string }> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, `вход ${email}: ${res.body}`).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken as string}` };
    };

    ctx = {
      app,
      db,
      schema,
      closeDb,
      admin: await login(ADMIN_EMAIL),
      site: await login(SITE_EMAIL),
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

  it('имя запертого файла не уходит ни одному читателю, имя обычного остаётся', async () => {
    const request = await newWasteRequest();
    const locked = await newFile();
    const plain = await newFile();
    await patchFiles(request.id, request.version, { addFileIds: [locked.id, plain.id] });

    // До карантина событие называет оба файла: иначе дальнейшее «имени нет» ничего не доказывает —
    // его объяснила бы и правка, которой не было.
    const before = await history(request.id, ctx.admin);
    expect(before.raw).toContain(locked.filename);
    expectVisible(onlyChange(before.entries, 'filesAdded'), locked);

    await quarantine(locked.id);

    for (const [who, as] of [
      ['администратор, он же автор загрузки', ctx.admin],
      ['площадка', ctx.site],
    ] as const) {
      const seen = await history(request.id, as);
      const added = onlyChange(seen.entries, 'filesAdded');
      expectHidden(added, locked.id);
      expectVisible(added, plain);
      // Строка события собирается заново из имён, прошедших правило: в ней остаётся только
      // обычный файл.
      expect(added.to).toBe(plain.filename);
      // Последняя проверка — по всему ответу целиком: имя не должно уехать НИ ОДНИМ полем, включая
      // те, которых в этом тесте ещё нет. Читатель назван в сообщении — падение скажет, кто видел.
      expect(seen.raw, `имя запертого файла в истории: ${who}`).not.toContain(locked.filename);
      expect(seen.raw).toContain(plain.filename);
    }
  });

  it('снятие вложения имя не возвращает: событие «откреплены» проходит то же правило', async () => {
    const request = await newWasteRequest();
    const locked = await newFile();
    const version = await patchFiles(request.id, request.version, { addFileIds: [locked.id] });
    await quarantine(locked.id);
    await patchFiles(request.id, version, { removeFileIds: [locked.id] });

    const seen = await history(request.id, ctx.admin);
    // Оба события о файле на месте: «документ скрыт по обращению» и «документа не было» — разные
    // факты, и стирать строку значило бы переписывать историю заявки.
    expectHidden(onlyChange(seen.entries, 'filesAdded'), locked.id);
    expectHidden(onlyChange(seen.entries, 'filesRemoved'), locked.id);
    expect(seen.raw).not.toContain(locked.filename);
  });

  it('снятие карантина возвращает имя в историю: признак — состояние файла, а не клеймо', async () => {
    const request = await newWasteRequest();
    const locked = await newFile();
    await patchFiles(request.id, request.version, { addFileIds: [locked.id] });
    await quarantine(locked.id);
    expectHidden(
      onlyChange((await history(request.id, ctx.admin)).entries, 'filesAdded'),
      locked.id,
    );

    await releaseQuarantine(locked.id);

    const seen = await history(request.id, ctx.admin);
    expectVisible(onlyChange(seen.entries, 'filesAdded'), locked);
    expect(seen.raw).toContain(locked.filename);
  });

  it('запись старого образца — без идентификаторов — читается как прежде', async () => {
    const request = await newWasteRequest();
    /*
     * Запись СТАРОГО ОБРАЗЦА собирается прямым INSERT: дифф такие больше не пишет, а в журнале они
     * останутся навсегда — историю заявки не переписывают. Пар «идентификатор → имя» в ней нет, и
     * спросить правило карантина не о чем: по имени файл не ищется (их бывает два одинаковых, а
     * строки файла может уже не быть), и угадывание гасило бы чужие строки либо пропускало свои.
     */
    await ctx.db.insert(ctx.schema.auditLog).values({
      actorUserId: ctx.adminId,
      action: 'waste_request.update',
      entityType: 'waste_request',
      entityId: request.id,
      metadata: { changes: [{ field: 'filesAdded', from: null, to: 'старый-акт.pdf' }] },
    });

    const seen = await history(request.id, ctx.admin);
    const added = onlyChange(seen.entries, 'filesAdded');
    expect(added.to).toBe('старый-акт.pdf');
    // Пустого списка файлов у такой записи тоже не появляется: «файлов нет» и «о файлах не
    // записано» читаются по-разному, а дорисовать второе до первого не из чего.
    expect(added.files).toBeUndefined();
  });
});
