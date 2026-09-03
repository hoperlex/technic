import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIRECTORY_DATA_SHEET, mechModelNameKey } from '@technic/contracts';
import { applyMigrations, readMigration } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type { AnyDirectory } from '../src/services/directory-transfer/types';
import type * as TransferEngine from '../src/services/directory-transfer/engine';
import type * as Xlsx from '../src/lib/xlsx';
import { pgErrorOf } from '../src/lib/pg-error';

/**
 * Справочник моделей малой механизации на живой схеме (план
 * `docs/mechanization-models-directory-plan.md`, этап Э1; миграции 0249 и 0250, маршруты
 * `routes/mech-models.ts`, обмен — `services/directory-transfer/defs/mech.ts`).
 *
 * ЗАЧЕМ БАЗА. На моках проверялись бы моки: всё, ради чего справочник заводился, живёт в схеме и в
 * согласии кода с ней.
 *
 *  - НАПОЛНЕНИЕ. Сид — не «данные для тестов», а сам предмет этапа: заказчик прислал список, и
 *    вопрос «доехал ли он до базы дословно» задаётся только базе. Список сюда не переписан руками —
 *    тест читает саму миграцию 0250 и сверяет с тем, что в таблице: переписанная копия
 *    разошлась бы с оригиналом на первой же правке и «подтверждала» бы сама себя.
 *  - НОРМАЛИЗАЦИЯ. Ключ наименования считает GENERATED-колонка, а сервер и загрузка файлом
 *    отвечают «такая модель уже есть» по копии правила в контрактах (`mechModelNameKey`). Копия
 *    расходится с оригиналом молча: `\s` в JavaScript шире, чем в Postgres, и на неразрывном
 *    пробеле ответы разъезжаются — сервер говорит «свободно», индекс отвергает вставку. Сверяются
 *    они здесь и на настоящих строках, а не на глаз.
 *  - УНИКАЛЬНОСТЬ. Что вторую «Wacker DPU 3070Н» не пустит именно база, а не только ручка,
 *    доказывается прямой вставкой мимо сервера.
 *  - ОБМЕН. Выгруженный файл обязан загружаться без единой правки — свойство трёх модулей сразу
 *    (описание, печать ячейки, разбор), и проверить его можно только на настоящем справочнике.
 *
 * ИЗОЛЯЦИЯ. База db-тестов общая и живёт между прогонами: в ней лежит тот же справочник, что в
 * проде. Поэтому всё своё помечено суффиксом прогона `RUN` — коды, наименования, адреса учёток, —
 * и `afterAll` уносит ровно его. Присланных сидом строк тест не трогает вовсе: он их только читает.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test mech-models.db
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

/** Префикс кодов этого прогона: по нему `afterAll` находит своё в общем справочнике. */
const CODE = `mech-test-${RUN}`;

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
  /** Администратор: у его роли есть и ведение справочников, и удаление насовсем. */
  admin: TestUser;
  /** Роль штаба: `directories.read` у неё есть, `directories.write` — нет. */
  reader: TestUser;
  directory: AnyDirectory;
  engine: typeof TransferEngine;
  xlsx: typeof Xlsx;
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

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

/**
 * Имя ограничения, на котором споткнулась вставка. Через `pgErrorOf`, а не по тексту ошибки:
 * drizzle оборачивает ошибку драйвера в свою, и наверху остаётся только «Failed query» — сверка по
 * тексту прошла бы на любом отказе, включая совсем не тот, что проверяется.
 */
async function отказБазы(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    return pgErrorOf(e)?.constraint ?? '';
  }
  throw new Error('база приняла строку, которую должна была отвергнуть');
}

let modelNo = 0;
function nextCode(): string {
  modelNo += 1;
  return `${CODE}-${modelNo}`;
}

/** Строки сида как они записаны в самой миграции: код, наименование, порядок. */
function seededRows(): { code: string; name: string; sortOrder: number }[] {
  const text = readMigration('0250_mech_models_seed.sql');
  const rows: { code: string; name: string; sortOrder: number }[] = [];
  const re = /\('([a-z0-9-]+)',\s*'((?:[^']|'')*)',\s*(\d+)\)/gu;
  for (const m of text.matchAll(re)) {
    rows.push({ code: m[1]!, name: m[2]!.replace(/''/gu, "'"), sortOrder: Number(m[3]) });
  }
  return rows;
}

describe.skipIf(!DB_URL)('справочник моделей механизации', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const { directoryFor } = await import('../src/services/directory-transfer/registry');

    const passwordHash = await hashPassword(PASSWORD);
    // Учётки заводятся SQL: форма учётки — предмет своих тестов, здесь она декорация, без которой
    // не разложить два набора прав.
    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-mech-models-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const admin = await makeUser('admin', 'admin');
    const reader = await makeUser('reader', 'shtab');

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

    const directory = directoryFor('mech-models');
    expect(directory, 'описание справочника не зарегистрировано в реестре обмена').toBeDefined();

    ctx = {
      app,
      db,
      admin: { ...admin, auth: await login(admin.email) },
      reader: { ...reader, auth: await login(reader.email) },
      directory: directory!,
      engine: await import('../src/services/directory-transfer/engine'),
      xlsx: await import('../src/lib/xlsx'),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx?.db) return;
    await ctx.app?.close();
    await ctx.db.execute(sql`DELETE FROM mech_models WHERE code LIKE ${`${CODE}%`}`);
    const учётки = sql`SELECT id FROM users WHERE email LIKE ${`db-mech-models-%-${RUN}@example.invalid`}`;
    // Журнал — раньше учёток: `audit_log.actor_user_id` стоит под `RESTRICT`.
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${учётки})`);
    await ctx.db.execute(
      sql`DELETE FROM users WHERE email LIKE ${`db-mech-models-%-${RUN}@example.invalid`}`,
    );
    const { closeDb } = await import('../src/db/client');
    await closeDb();
  });

  // ── Наполнение ──

  it('сид положил присланный список дословно: 103 строки, коды и порядок из миграции', async () => {
    const expected = seededRows();
    expect(expected).toHaveLength(103);

    // Справочник читается целиком: в нём сотня строк, а списком кодов в параметре запрос вышел бы
    // длиннее и хрупче — сравнение всё равно идёт в памяти.
    const rows = await ctx.db.execute<{ code: string; name: string; sort_order: number }>(
      sql`SELECT code, name, sort_order FROM mech_models`,
    );
    const byCode = new Map(rows.rows.map((r) => [r.code, r]));

    const missing = expected.filter((r) => !byCode.has(r.code)).map((r) => r.code);
    expect(missing, 'миграция 0250 не доехала до базы').toEqual([]);

    const wrong = expected.filter((r) => {
      const row = byCode.get(r.code)!;
      return row.name !== r.name || Number(row.sort_order) !== r.sortOrder;
    });
    expect(wrong.map((r) => r.code), 'наименование или порядок разошлись с миграцией').toEqual([]);
  });

  it('пометки заказчика сохранены знак в знак: «(см)», серийный номер, «б/у», «(компл)»', async () => {
    const метки = await ctx.db.execute<{ name: string }>(sql`
      SELECT name FROM mech_models
       WHERE name LIKE '%(см)%' OR name LIKE '%б/у%' OR name LIKE '%сер.%'
       ORDER BY name`);
    const names = метки.rows.map((r) => r.name);
    expect(names).toContain('Компрессор XAS970 Dd Euro Box сер.№06253380730709');
    expect(names).toContain('Компрессор поршневой стационарный С416 б/у');
    expect(names.filter((n) => n.includes('(см)'))).toHaveLength(5);
  });

  it('повтор присланного списка схлопнут: правильно-гибочный станок заведён один раз', async () => {
    const res = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM mech_models
       WHERE name = 'Правильно-гибочный станок SGW12D-3D'`);
    expect(Number(res.rows[0]!.n)).toBe(1);
  });

  // ── Ключ наименования ──

  it('нормализация контрактов совпадает с той, что считает база', async () => {
    // Строки подобраны по местам, где копия правила расходится с оригиналом молча: края, двойные
    // пробелы, табуляция, неразрывный пробел, регистр обеих азбук.
    const образцы = [
      '  Виброплита реверсивная Wacker DPU 3070Н  ',
      'Виброплита  реверсивная\tWacker DPU 3070Н',
      'ВИБРОПЛИТА РЕВЕРСИВНАЯ WACKER DPU 3070Н',
      'Компрессор Ganta ac500/050 ofs (см)',
      'Станок резьбонарезной Rex NP50A 1/2"-2" в комплекте с подставкой',
    ];
    for (const образец of образцы) {
      // Слеш сдвоен намеренно: `sql` — тегированный шаблон, и `\s` в нём «сварился» бы в обычную
      // `s` — запрос сверял бы копию правила совсем с другим выражением, чем стоит в колонке.
      const res = await ctx.db.execute<{ key: string }>(
        sql`SELECT lower(btrim(regexp_replace(${образец}, '\\s+', ' ', 'g'))) AS key`,
      );
      expect(mechModelNameKey(образец), образец).toBe(res.rows[0]!.key);
    }
  });

  it('вторая модель с тем же наименованием не проходит мимо сервера — её отвергает индекс', async () => {
    const created = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, {
      code: nextCode(),
      name: `Виброплита тестовая ${RUN}`,
    });
    expect(created.statusCode, created.body).toBe(201);

    // Прямая вставка, минуя ручку: доказывается, что уникальность держит база, а не проверка в
    // маршруте, — иначе прямой запрос завёл бы вторую строку, глазами неотличимую от первой.
    const constraint = await отказБазы(
      ctx.db.execute(sql`
        INSERT INTO mech_models (code, name)
        VALUES (${nextCode()}, ${`ВИБРОПЛИТА  ТЕСТОВАЯ ${RUN}`})`),
    );
    expect(constraint).toBe('mech_models_name_key_unique');
  });

  it('наименование из одних пробельных знаков база не принимает', async () => {
    const constraint = await отказБазы(
      ctx.db.execute(sql`INSERT INTO mech_models (code, name) VALUES (${nextCode()}, '   ')`),
    );
    expect(constraint).toMatch(/^mech_models_name_(not_blank|key_not_blank)_check$/u);
  });

  it('код не того формата база не принимает: kebab латиницей и ничего больше', async () => {
    const constraint = await отказБазы(
      ctx.db.execute(sql`
        INSERT INTO mech_models (code, name)
        VALUES ('Vibroplita--Wacker', ${`Виброплита формат ${RUN}`})`),
    );
    expect(constraint).toBe('mech_models_code_format_check');
  });

  // ── Ручки ──

  it('заведение, правка и деактивация — под правом ведения справочников', async () => {
    const code = nextCode();
    const created = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, {
      code,
      name: `Каток тестовый ${RUN}`,
      sortOrder: 500,
    });
    expect(created.statusCode, created.body).toBe(201);
    const dto = created.json();
    expect(dto).toMatchObject({ code, name: `Каток тестовый ${RUN}`, sortOrder: 500, isActive: true });

    const renamed = await inject('PATCH', `/api/v1/mech-models/${dto.id}`, ctx.admin.auth, {
      name: `Каток тестовый переименованный ${RUN}`,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().name).toBe(`Каток тестовый переименованный ${RUN}`);

    const down = await inject('PATCH', `/api/v1/mech-models/${dto.id}`, ctx.admin.auth, {
      isActive: false,
    });
    expect(down.statusCode, down.body).toBe(200);
    expect(down.json().isActive).toBe(false);
  });

  it('повтор кода и повтор наименования — отказ словами, а не ответом базы', async () => {
    const code = nextCode();
    const name = `Компрессор тестовый ${RUN}`;
    const first = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, { code, name });
    expect(first.statusCode, first.body).toBe(201);

    const sameCode = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, {
      code,
      name: `Компрессор другой ${RUN}`,
    });
    expect(sameCode.statusCode).toBe(409);
    expect(sameCode.json().error?.message ?? sameCode.body).toContain('кодом');

    // Другое написание того же наименования: регистр и лишние пробелы модель не различают.
    const sameName = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, {
      code: nextCode(),
      name: `КОМПРЕССОР  ТЕСТОВЫЙ ${RUN}`,
    });
    expect(sameName.statusCode, sameName.body).toBe(409);
    expect(sameName.json().error?.message ?? sameName.body).toContain(name);
  });

  it('правка своим же наименованием проходит: строка не спорит сама с собой', async () => {
    const created = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, {
      code: nextCode(),
      name: `Насос тестовый ${RUN}`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const res = await inject('PATCH', `/api/v1/mech-models/${created.json().id}`, ctx.admin.auth, {
      name: `Насос тестовый ${RUN}`,
      sortOrder: 700,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().sortOrder).toBe(700);
  });

  it('код неверного формата не доходит до базы: его отвергает схема', async () => {
    const res = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, {
      code: 'Виброплита',
      name: `Виброплита кириллическая ${RUN}`,
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('читать справочник может роль площадки, вести — нет', async () => {
    const list = await inject('GET', '/api/v1/mech-models?pageSize=50', ctx.reader.auth);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().total).toBeGreaterThanOrEqual(103);

    const refused = await inject('POST', '/api/v1/mech-models', ctx.reader.auth, {
      code: nextCode(),
      name: `Штабная модель ${RUN}`,
    });
    expect(refused.statusCode).toBe(403);
  });

  it('поиск идёт и по наименованию, и по коду', async () => {
    const byName = await inject(
      'GET',
      `/api/v1/mech-models?search=${encodeURIComponent('Виброплита реверсивная Wacker DPU 3070Н')}`,
      ctx.admin.auth,
    );
    expect(byName.statusCode, byName.body).toBe(200);
    expect(byName.json().items[0]?.code).toBe('vibroplita-reversivnaya-wacker-dpu-3070n');

    const byCode = await inject(
      'GET',
      '/api/v1/mech-models?search=vibroplita-reversivnaya-wacker-dpu-3070n',
      ctx.admin.auth,
    );
    expect(byCode.json().items).toHaveLength(1);
  });

  it('удаление насовсем — только после деактивации (ADR 0060)', async () => {
    const created = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, {
      code: nextCode(),
      name: `Ошибочная модель ${RUN}`,
    });
    const id = created.json().id;

    const live = await inject('DELETE', `/api/v1/mech-models/${id}/purge`, ctx.admin.auth);
    expect(live.statusCode, live.body).toBe(409);

    await inject('PATCH', `/api/v1/mech-models/${id}`, ctx.admin.auth, { isActive: false });
    const purged = await inject('DELETE', `/api/v1/mech-models/${id}/purge`, ctx.admin.auth);
    expect(purged.statusCode, purged.body).toBe(200);

    const gone = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM mech_models WHERE id = ${id}`,
    );
    expect(Number(gone.rows[0]!.n)).toBe(0);
  });

  it('модель, на которую ссылается заявка, не сносится насовсем — и отказ называет заявки', async () => {
    const created = await inject('POST', '/api/v1/mech-models', ctx.admin.auth, {
      code: nextCode(),
      name: `Занятая модель ${RUN}`,
    });
    const id = created.json().id as string;

    // Заявка заводится прямым запросом: маршрут заявки — предмет соседних файлов, здесь нужна
    // только САМА ССЫЛКА, из-за которой справочник и держит строку (ADR 0156, миграция 0251).
    const scene = await ctx.db.execute<{ object_id: string; user_id: string }>(sql`
      WITH o AS (
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`яя-${CODE}-obj`}, ${`Площадка ссылки ${RUN}`}, 'г. Москва, тестовый проезд, 1')
        RETURNING id
      )
      SELECT o.id AS object_id, u.id AS user_id
      FROM o, users u WHERE u.id = ${ctx.admin.id}`);
    const { object_id: objectId, user_id: userId } = scene.rows[0]!;
    await ctx.db.execute(sql`
      INSERT INTO mech_requests (
        object_id, mech_model_id, planned_from, planned_to,
        responsible_name, responsible_phone, created_by
      ) VALUES (
        ${objectId}, ${id}, '2026-09-01', '2026-09-30',
        'Иванов И.И.', '9990000000', ${userId}
      )`);

    await inject('PATCH', `/api/v1/mech-models/${id}`, ctx.admin.auth, { isActive: false });
    const refused = await inject('DELETE', `/api/v1/mech-models/${id}/purge`, ctx.admin.auth);
    expect(refused.statusCode, refused.body).toBe(409);
    // Без строки `mech_requests` в карте `directory-purge` человек прочитал бы безликое «на запись
    // ссылаются другие данные» и не знал бы, где искать. Отказ обязан назвать заявки.
    expect(refused.json().message).toContain('заявки механизации');

    // Убираем за собой в том же порядке, в каком стоят ссылки: заявка, потом площадка. Саму
    // модель заберёт `afterAll` по префиксу кода — но только после того, как заявки не станет.
    await ctx.db.execute(sql`DELETE FROM mech_requests WHERE mech_model_id = ${id}`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE id = ${objectId}`);
  }, 60_000);

  // ── Обмен файлом (ADR 0073) ──

  it('выгруженный файл загружается без единой правки', async () => {
    const { bytes } = await ctx.engine.exportDirectory(ctx.directory);
    const sheet = ctx.xlsx.readWorkbook(bytes).find((s) => s.name === DIRECTORY_DATA_SHEET)!;
    const report = await ctx.engine.importDirectory(
      ctx.directory,
      ctx.xlsx.writeWorkbook([{ name: DIRECTORY_DATA_SHEET, rows: sheet.rows }]),
      { dryRun: true, actorUserId: ctx.admin.id },
    );
    const detail = JSON.stringify(
      { created: report.created, updated: report.updated, problems: report.problems },
      null,
      2,
    );
    expect(report.problems, detail).toEqual([]);
    expect(report.created, detail).toEqual([]);
    expect(report.updated, detail).toEqual([]);
    expect(report.unchanged, detail).toBe(sheet.rows.length - 1);
  }, 60_000);

  it('файл с двумя написаниями одной модели отвергается целиком, а не наполовину', async () => {
    const { bytes } = await ctx.engine.exportDirectory(ctx.directory);
    const sheet = ctx.xlsx.readWorkbook(bytes).find((s) => s.name === DIRECTORY_DATA_SHEET)!;
    const header = sheet.rows[0]!;
    const codeAt = header.indexOf('Код');
    const nameAt = header.indexOf('Наименование');

    const twin = header.map(() => '');
    twin[codeAt] = nextCode();
    // То же наименование, что у первой строки справочника, но в другом написании: база ответила бы
    // на такую строку кодом 23505 посреди записи, а человеку нужно знать, какая строка с какой
    // совпала.
    twin[nameAt] = (sheet.rows[1]![nameAt] ?? '').toUpperCase();
    const rows = [...sheet.rows, twin];

    const preview = await ctx.engine.importDirectory(
      ctx.directory,
      ctx.xlsx.writeWorkbook([{ name: DIRECTORY_DATA_SHEET, rows }]),
      { dryRun: true, actorUserId: ctx.admin.id },
    );
    expect(preview.problems.join('\n')).toMatch(/уже занято моделью/u);

    // Не только предпросмотр: применение такого файла обязано отказать целиком. «Половина
    // заведённого справочника» хуже невыполненной загрузки — её потом сверять построчно.
    await expect(
      ctx.engine.importDirectory(
        ctx.directory,
        ctx.xlsx.writeWorkbook([{ name: DIRECTORY_DATA_SHEET, rows }]),
        { dryRun: false, actorUserId: ctx.admin.id },
      ),
    ).rejects.toThrow(/уже занято моделью/u);

    const written = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM mech_models WHERE code = ${twin[codeAt]}`,
    );
    expect(Number(written.rows[0]!.n)).toBe(0);
  }, 60_000);
});
