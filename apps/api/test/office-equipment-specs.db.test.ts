import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  OfficeEquipmentDto,
  OfficeEquipmentModelDto,
  OfficeEquipmentSpecDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` после того, как выставлено окружение —
// конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Характеристики моделей оргтехники: цветность печати второй строкой в колонке «Тип»
 * (план `docs/office-equipment-specs-plan.md`, миграции
 * [0252](../drizzle/0252_office_equipment_specs.sql) и
 * [0253](../drizzle/0253_office_equipment_print_color_seed.sql)).
 *
 * ЗАЧЕМ БАЗА. Главное в этой работе живёт не в коде, а в схеме, и на моках проверялись бы моки:
 *
 * - **два замка целостности** (Р5) — составные ключи, запрещающие значение чужой характеристики и
 *   характеристику, не положенную типу модели. Маршрут говорит то же самое словами, но правилом
 *   остаётся база: маршрут, забывший проверку, ничего сломать не должен;
 * - **«н/д» отсутствием строки** (Р3) — DTO обязан отличать «вопрос законен, ответа нет» (`value:
 *   null`) от «вопроса не задают вовсе» (пустой массив), а это склейка `type_specs ⟕ model_specs`,
 *   а не поле;
 * - **карточка без модели** (Р9) — состояние выпуска A: `model_id` ещё nullable, и характеристики
 *   считаются по типу, когда модели нет вовсе. Через маршрут такую карточку не завести — только
 *   прямым `UPDATE`;
 * - **коррелированный подзапрос** в списках: drizzle сокращает односоставный запрос до псевдонима,
 *   и вписанная колонка внешней таблицы становится ссылкой на саму себя без единой ошибки (тот же
 *   капкан, что у `modelIdRef`). Ловится только настоящим SQL.
 *
 * ИЗОЛЯЦИЯ. База db-тестов общая и живёт между прогонами: всё своё помечено суффиксом прогона
 * `RUN`, и `afterAll` уносит ровно его. Характеристику файл не заводит и не гасит — она приезжает
 * миграцией и общая для всех прогонов.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_archive_test \
 *     pnpm --filter @technic/api test office-equipment-specs
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

const MFP_MODEL = `Ricoh IM 350 SPEC ${RUN}`;
const MFP_MODEL_2 = `Kyocera M2040 SPEC ${RUN}`;
const MONITOR_MODEL = `Dell P2422H SPEC ${RUN}`;

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: { id: string; email: string; auth: Auth };
  objectId: string;
  mfpTypeId: string;
  monitorTypeId: string;
  /** Характеристика «Цветность печати» и её значения — как их завела миграция 0252. */
  colorSpecId: string;
  colorValueId: string;
  monoValueId: string;
}

let ctx: Ctx;

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

let cardNo = 0;
function nextInventory(): string {
  cardNo += 1;
  return `OES-${RUN}-${cardNo}`;
}

function inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: ctx.admin.auth,
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

async function createModel(input: {
  typeId: string;
  name: string;
  specs?: { specId: string; valueId: string | null }[];
}): Promise<OfficeEquipmentModelDto> {
  const res = await inject('POST', '/api/v1/office-equipment-models', {
    equipmentTypeId: input.typeId,
    name: input.name,
    ...(input.specs === undefined ? {} : { specs: input.specs }),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentModelDto;
}

async function createCard(modelId: string, typeId: string): Promise<OfficeEquipmentDto> {
  const res = await inject('POST', '/api/v1/office-equipment', {
    equipmentTypeId: typeId,
    modelId,
    inventoryNumber: nextInventory(),
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentDto;
}

/** Строка списка техники: именно она рисует вторую строку колонки «Тип». */
async function cardInList(id: string): Promise<OfficeEquipmentDto> {
  const res = await inject('GET', `/api/v1/office-equipment?pageSize=100&search=OES-${RUN}`);
  expect(res.statusCode, res.body).toBe(200);
  const items = (res.json() as { items: OfficeEquipmentDto[] }).items;
  const row = items.find((i) => i.id === id);
  if (!row) throw new Error(`карточки ${id} нет в списке`);
  return row;
}

async function modelInList(id: string): Promise<OfficeEquipmentModelDto> {
  const res = await inject(
    'GET',
    `/api/v1/office-equipment-models?pageSize=100&search=${encodeURIComponent(`SPEC ${RUN}`)}`,
  );
  expect(res.statusCode, res.body).toBe(200);
  const items = (res.json() as { items: OfficeEquipmentModelDto[] }).items;
  const row = items.find((i) => i.id === id);
  if (!row) throw new Error(`модели ${id} нет в перечне`);
  return row;
}

/**
 * Имя нарушенного ограничения. Drizzle заворачивает ошибку драйвера в свою («Failed query: …»), и
 * `toThrow(/constraint/)` на обёртке не срабатывает — предмет проверки лежит в `cause`. Тот же
 * разбор, что у маршрутов (`lib/pg-error.ts`), и берётся он оттуда же, а не пишется заново.
 */
async function constraintOf(run: () => Promise<unknown>): Promise<string | undefined> {
  const { pgErrorOf } = await import('../src/lib/pg-error');
  try {
    await run();
  } catch (e) {
    return pgErrorOf(e)?.constraint;
  }
  return undefined;
}

const describeDb = DB_URL ? describe : describe.skip;

describeDb('характеристики моделей оргтехники (db)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);
    const email = `db-oes-admin-${RUN}@example.invalid`;
    const userRes = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Тестовый', 'Пользователь', 'admin', ${passwordHash},
              'admin'::role, true, now())
      RETURNING id`);

    const objectRes = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OES-${RUN}`}, ${`Тестовая площадка характеристик ${RUN}`},
              'г Москва, ул Тестовая, д 1')
      RETURNING id`);

    const app = await buildApp();
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(loginRes.statusCode, loginRes.body).toBe(200);

    const types = await db.execute<{ id: string; code: string }>(
      sql`SELECT id, code FROM office_equipment_types WHERE code IN ('mfp', 'monitor')`,
    );
    const mfpTypeId = types.rows.find((r) => r.code === 'mfp')?.id;
    const monitorTypeId = types.rows.find((r) => r.code === 'monitor')?.id;
    if (!mfpTypeId || !monitorTypeId) {
      throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');
    }

    const spec = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_specs WHERE code = 'print_color'`,
    );
    const values = await db.execute<{ id: string; code: string }>(sql`
      SELECT v.id, v.code FROM office_equipment_spec_values v
        JOIN office_equipment_specs s ON s.id = v.spec_id
       WHERE s.code = 'print_color'`);
    const colorSpecId = spec.rows[0]?.id;
    const colorValueId = values.rows.find((r) => r.code === 'color')?.id;
    const monoValueId = values.rows.find((r) => r.code === 'mono')?.id;
    if (!colorSpecId || !colorValueId || !monoValueId) {
      throw new Error('в базе нет цветности печати: миграция 0252 не применена');
    }

    ctx = {
      app,
      db,
      closeDb,
      admin: {
        id: userRes.rows[0]!.id,
        email,
        auth: { authorization: `Bearer ${loginRes.json().accessToken}` },
      },
      objectId: objectRes.rows[0]!.id,
      mfpTypeId,
      monitorTypeId,
      colorSpecId,
      colorValueId,
      monoValueId,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx?.db) return;
    // Порядок задан внешними ключами: карточки, потом значения характеристик, потом модели.
    await ctx.db.execute(sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`OES-${RUN}-%`}`);
    await ctx.db.execute(sql`
      DELETE FROM office_equipment_model_specs ms
       USING office_equipment_models m
       WHERE m.id = ms.model_id AND m.name LIKE ${`%SPEC ${RUN}%`}`);
    await ctx.db.execute(sql`DELETE FROM office_equipment_models WHERE name LIKE ${`%SPEC ${RUN}%`}`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`OES-${RUN}`}`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${ctx.admin.email}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('миграция завела цветность печати у МФУ и принтеров, но не у монитора', async () => {
    const res = await inject('GET', `/api/v1/office-equipment-types/${ctx.mfpTypeId}/specs`);
    expect(res.statusCode, res.body).toBe(200);
    const specs = res.json() as OfficeEquipmentSpecDto[];
    expect(specs).toHaveLength(1);
    expect(specs[0]!.code).toBe('print_color');
    expect(specs[0]!.showInList).toBe(true);
    // Сокращения приходят с сервера: правило «как это зовут коротко» — свойство значения (Р8).
    expect(specs[0]!.values.map((v) => v.shortName)).toEqual(['цв.', 'ч/б']);

    const monitor = await inject(
      'GET',
      `/api/v1/office-equipment-types/${ctx.monitorTypeId}/specs`,
    );
    expect(monitor.statusCode, monitor.body).toBe(200);
    expect(monitor.json()).toEqual([]);
  });

  it('значение ставится при заведении модели и видно в перечне', async () => {
    const model = await createModel({
      typeId: ctx.mfpTypeId,
      name: MFP_MODEL,
      specs: [{ specId: ctx.colorSpecId, valueId: ctx.monoValueId }],
    });
    expect(model.specs).toHaveLength(1);
    expect(model.specs[0]!.value?.shortName).toBe('ч/б');
    expect((await modelInList(model.id)).specs[0]!.value?.name).toBe('Чёрно-белая');
  });

  it('незаполненная характеристика приходит со значением null — это и есть «н/д»', async () => {
    const model = await createModel({ typeId: ctx.mfpTypeId, name: MFP_MODEL_2 });
    // Массив НЕ пуст: вопрос у типа есть, ответа у модели нет. Пустой массив означал бы, что
    // цветность у МФУ не спрашивают вовсе, и строка «н/д» тогда не появилась бы (Р3, Р4).
    expect(model.specs).toHaveLength(1);
    expect(model.specs[0]!.value).toBeNull();
  });

  it('у модели типа без характеристик массив пуст — вопроса не задают', async () => {
    const model = await createModel({ typeId: ctx.monitorTypeId, name: MONITOR_MODEL });
    expect(model.specs).toEqual([]);
  });

  it('правка ставит и снимает значение: пусто снова означает «н/д»', async () => {
    const model = await modelInList((await modelInList((await createModel({
      typeId: ctx.mfpTypeId,
      name: `Pantum M6500 SPEC ${RUN}`,
      specs: [{ specId: ctx.colorSpecId, valueId: ctx.colorValueId }],
    })).id)).id);
    expect(model.specs[0]!.value?.code).toBe('color');

    const changed = await inject('PATCH', `/api/v1/office-equipment-models/${model.id}`, {
      specs: [{ specId: ctx.colorSpecId, valueId: ctx.monoValueId }],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((changed.json() as OfficeEquipmentModelDto).specs[0]!.value?.code).toBe('mono');

    const cleared = await inject('PATCH', `/api/v1/office-equipment-models/${model.id}`, {
      specs: [{ specId: ctx.colorSpecId, valueId: null }],
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as OfficeEquipmentModelDto).specs[0]!.value).toBeNull();
    // Снятое значение — это отсутствие строки, а не третье значение перечня (Р3).
    const rows = await ctx.db.execute<{ c: string }>(
      sql`SELECT count(*) AS c FROM office_equipment_model_specs WHERE model_id = ${model.id}`,
    );
    expect(Number(rows.rows[0]!.c)).toBe(0);
  });

  it('карточка техники берёт цветность у своей модели — и в списке, и в карточке', async () => {
    const model = await createModel({
      typeId: ctx.mfpTypeId,
      name: `Ricoh MP C2011 SPEC ${RUN}`,
      specs: [{ specId: ctx.colorSpecId, valueId: ctx.colorValueId }],
    });
    const card = await createCard(model.id, ctx.mfpTypeId);
    expect(card.specs[0]!.value?.shortName).toBe('цв.');
    // Список — отдельный запрос со своим подзапросом: именно он рисует вторую строку колонки.
    expect((await cardInList(card.id)).specs[0]!.value?.shortName).toBe('цв.');
    const one = await inject('GET', `/api/v1/office-equipment/${card.id}`);
    expect(one.statusCode, one.body).toBe(200);
    expect((one.json() as OfficeEquipmentDto).specs[0]!.value?.shortName).toBe('цв.');
  });

  it('карточка без модели отвечает «н/д», а не прячет вопрос (выпуск A, Р9)', async () => {
    const model = await createModel({
      typeId: ctx.mfpTypeId,
      name: `HP LaserJet SPEC ${RUN}`,
      specs: [{ specId: ctx.colorSpecId, valueId: ctx.monoValueId }],
    });
    const card = await createCard(model.id, ctx.mfpTypeId);

    /*
     * Карточки без модели маршрутом не завести, и вне маршрута тоже: `BEFORE`-триггер зеркала
     * объявлен `ENABLE ALWAYS` (0171) — он переживает и `session_replication_role = replica`,
     * потому и объявлен так. Остаётся `DISABLE TRIGGER`, а это DDL, видимый всем сессиям базы;
     * на общей базе прогона он снял бы зеркало у соседей. Поэтому вся проверка живёт внутри одной
     * транзакции с откатом — и ответ читается там же, тем же выражением, каким его читает список
     * (`modelSpecsExpr`), а не копией запроса.
     *
     * Запрос здесь ОДНОСОСТАВНЫЙ (`FROM office_equipment` без единого `JOIN`) — и это не
     * случайность: именно в такой форме drizzle сокращает таблицу до псевдонима, и ссылка на
     * внешнюю строку, написанная колонкой, превратилась бы в ссылку на саму себя. Тест на списке
     * этого не поймал бы никогда: там `JOIN` есть.
     */
    class Rollback extends Error {}
    const { officeEquipment } = await import('../src/db/schema');
    const { modelSpecsExpr } = await import('../src/services/office-equipment-specs');
    const { eq } = await import('drizzle-orm');

    let specs: OfficeEquipmentDto['specs'] = [];
    await ctx.db
      .transaction(async (tx) => {
        await tx.execute(
          sql`ALTER TABLE office_equipment DISABLE TRIGGER office_equipment_model_mirror`,
        );
        await tx.execute(sql`UPDATE office_equipment SET model_id = NULL WHERE id = ${card.id}`);
        const rows = await tx
          .select({
            specs: modelSpecsExpr(
              sql`${officeEquipment}."model_id"`,
              sql`${officeEquipment}."equipment_type_id"`,
            ),
          })
          .from(officeEquipment)
          .where(eq(officeEquipment.id, card.id));
        specs = rows[0]!.specs;
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });

    // Не пустой массив: вопрос задаёт ТИП карточки, и он на месте — нет только ответа (Р9).
    expect(specs).toHaveLength(1);
    expect(specs[0]!.value).toBeNull();
  });

  it('маршрут отвечает словами на характеристику чужого типа и на чужое значение', async () => {
    const monitor = await createModel({
      typeId: ctx.monitorTypeId,
      name: `Dell U2723 SPEC ${RUN}`,
    });
    const alien = await inject('PATCH', `/api/v1/office-equipment-models/${monitor.id}`, {
      specs: [{ specId: ctx.colorSpecId, valueId: ctx.monoValueId }],
    });
    expect(alien.statusCode, alien.body).toBe(400);
    expect(alien.json().message).toContain('не спрашивают');

    const model = await createModel({ typeId: ctx.mfpTypeId, name: `Canon SPEC ${RUN}` });
    const strangeValue = await inject('PATCH', `/api/v1/office-equipment-models/${model.id}`, {
      specs: [{ specId: ctx.colorSpecId, valueId: randomUUID() }],
    });
    expect(strangeValue.statusCode, strangeValue.body).toBe(400);
    expect(strangeValue.json().message).toContain('Значение характеристики не найдено');
  });

  it('замок базы не пускает значение чужой характеристики мимо маршрута', async () => {
    // Маршрут проверяет то же самое словами, но правилом остаётся схема (Р5): вставка прямым SQL
    // обязана упереться в составной ключ, а не завести бессмыслицу.
    const model = await createModel({ typeId: ctx.mfpTypeId, name: `Brother SPEC ${RUN}` });
    const other = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment_specs (code, name)
      VALUES (${`probe_${RUN}`}, ${`Проверочная ${RUN}`})
      RETURNING id`);
    const otherValue = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment_spec_values (spec_id, code, name, short_name)
      VALUES (${other.rows[0]!.id}, 'x', 'Икс', 'x')
      RETURNING id`);

    expect(
      await constraintOf(() =>
        ctx.db.execute(sql`
          INSERT INTO office_equipment_model_specs (model_id, equipment_type_id, spec_id, value_id)
          VALUES (${model.id}, ${ctx.mfpTypeId}, ${ctx.colorSpecId}, ${otherValue.rows[0]!.id})`),
      ),
    ).toBe('office_equipment_model_specs_value_fk');

    await ctx.db.execute(sql`DELETE FROM office_equipment_specs WHERE id = ${other.rows[0]!.id}`);
  });

  it('замок базы не пускает характеристику, не положенную типу модели', async () => {
    const monitor = await createModel({
      typeId: ctx.monitorTypeId,
      name: `LG 24MK SPEC ${RUN}`,
    });
    expect(
      await constraintOf(() =>
        ctx.db.execute(sql`
          INSERT INTO office_equipment_model_specs (model_id, equipment_type_id, spec_id, value_id)
          VALUES (${monitor.id}, ${ctx.monitorTypeId}, ${ctx.colorSpecId}, ${ctx.colorValueId})`),
      ),
    ).toBe('office_equipment_model_specs_type_spec_fk');
  });

  it('снять характеристику с типа, пока у моделей есть значения, база не даёт', async () => {
    await createModel({
      typeId: ctx.mfpTypeId,
      name: `Xerox SPEC ${RUN}`,
      specs: [{ specId: ctx.colorSpecId, valueId: ctx.monoValueId }],
    });
    // Иначе заполненное человеком исчезло бы одной строкой в другой таблице.
    expect(
      await constraintOf(() =>
        ctx.db.execute(sql`
          DELETE FROM office_equipment_type_specs
           WHERE equipment_type_id = ${ctx.mfpTypeId} AND spec_id = ${ctx.colorSpecId}`),
      ),
    ).toBe('office_equipment_model_specs_type_spec_fk');
  });

  it('удаление модели уносит её значения', async () => {
    const model = await createModel({
      typeId: ctx.mfpTypeId,
      name: `Sharp SPEC ${RUN}`,
      specs: [{ specId: ctx.colorSpecId, valueId: ctx.colorValueId }],
    });
    const res = await inject('DELETE', `/api/v1/office-equipment-models/${model.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const rows = await ctx.db.execute<{ c: string }>(
      sql`SELECT count(*) AS c FROM office_equipment_model_specs WHERE model_id = ${model.id}`,
    );
    expect(Number(rows.rows[0]!.c)).toBe(0);
  });
});
