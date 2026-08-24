import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeEquipmentHistoryCursor,
  type EquipmentHistoryEventDto,
  type EquipmentHistoryPageDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Лента истории единицы оргтехники (план `docs/office-equipment-mail-and-history-plan.md`,
 * Р75–Р81) и её выгрузка (Р80).
 *
 * Проверяется то, из-за чего лента и стала одним потоком. Порядок: у половины событий нет времени —
 * перемещение датировано днём, истечение гарантии тоже, — и без общего правила они встают
 * вперемешку. Курсор: страница «после» обязана не повторить показанное и не пропустить строку, в
 * том числе на стыке разных видов одного дня. Область: ремонтная часть закрыта и правом, и
 * областью заявок, и второе важнее — «право есть, а заявка чужого отдела» иначе утекает через
 * справочник.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test equipment-history-feed
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Test-Password-123';

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Auth;
  /** Держатель справочников: карточку видит, обслуживание — нет. */
  keeper: Auth;
  equipmentId: string;
  objectId: string;
  otherObjectId: string;
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

let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.40.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

async function history(auth: Auth, query = ''): Promise<EquipmentHistoryPageDto> {
  const res = await inject(
    'GET',
    `/api/v1/office-equipment/${ctx.equipmentId}/history${query}`,
    auth,
  );
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EquipmentHistoryPageDto;
}

const kindsOf = (page: EquipmentHistoryPageDto) => page.items.map((e) => e.kind);

describe.skipIf(!DB_URL)('лента истории единицы (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const object = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`HF-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectId = await object('A');
    const otherObjectId = await object('B');

    async function makeUser(tag: string, role: string): Promise<string> {
      const email = `db-hf-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      if (role !== 'admin') {
        await db.execute(sql`
          INSERT INTO user_construction_objects (user_id, construction_object_id)
          VALUES (${row.rows[0]!.id}, ${objectId})`);
      }
      return email;
    }

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    // Суффикс прогона стоит и в наименовании, а не только в инвентарном номере: с миграции
    // `0171` наименование карточки — это имя строки справочника `office_equipment_models`, и
    // вставка без `model_id` заводит модель сама. По этому же суффиксу уборка её и находит —
    // причём обе: переименование ниже заводит вторую, а карточка остаётся одна.
    const equipmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id,
                                    warranty_until)
      VALUES (${typeRow.rows[0]!.id}, ${`Kyocera M3145 ${RUN}`}, ${`ХФ-${RUN}`}, ${objectId},
              '2020-01-01')
      RETURNING id`);

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

    const adminEmail = await makeUser('admin', 'admin');
    const keeperEmail = await makeUser('keeper', 'manager');
    ctx = {
      app,
      db,
      closeDb,
      admin: await login(adminEmail),
      keeper: await login(keeperEmail),
      equipmentId: equipmentRow.rows[0]!.id,
      objectId,
      otherObjectId,
    };
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE entity_id = ${ctx.equipmentId}`);
      await ctx.db.execute(
        sql`DELETE FROM office_equipment_movements WHERE equipment_id = ${ctx.equipmentId}`,
      );
      await ctx.db.execute(sql`DELETE FROM office_equipment WHERE id = ${ctx.equipmentId}`);
      // Модели, заведённые карточками этого файла. С миграции `0171` наименование карточки — это
      // имя строки справочника `office_equipment_models`, и вставка без `model_id` заводит модель
      // сама; удаление карточки её за собой не уносит, а база у db-тестов общая — за неделю
      // прогонов справочник зарастёт именами фикстур. Отбор идёт по суффиксу прогона в самом
      // наименовании: копию боевого парка в этой базе он не заденет. Проверка «карточек не
      // осталось» — страховка от `ON DELETE RESTRICT` у ссылки карточки: пережившая уборку
      // карточка уронила бы `afterAll` отказом внешнего ключа вместо тихо оставленной строки.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-hf-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`HF-%-${RUN}`}`);
      await ctx.closeDb();
    }
  });

  it('правка карточки попадает в ленту с диффом, а гарантия — отдельным событием', async () => {
    const patched = await inject(
      'PATCH',
      `/api/v1/office-equipment/${ctx.equipmentId}`,
      ctx.admin,
      { name: `Kyocera M3145dn ${RUN}`, warrantyUntil: '2027-03-01' },
    );
    expect(patched.statusCode, patched.body).toBe(200);

    const page = await history(ctx.admin);
    const change = page.items.find((e) => e.kind === 'card_change');
    expect(change).toBeDefined();
    expect(change?.kind === 'card_change' && change.changes.map((c) => c.field)).toContain('name');
    // Гарантия отдельным событием, и в списке правок её нет: одно действие — одна строка (Р76).
    expect(change?.kind === 'card_change' && change.changes.map((c) => c.field)).not.toContain(
      'warrantyUntil',
    );

    const warranty = page.items.find((e) => e.kind === 'warranty' && e.action === 'moved');
    expect(warranty).toBeDefined();
  });

  it('истёкшая гарантия — вычисляемое событие, действующая события не даёт', async () => {
    // Срок из будущего: строки «истекла» быть не должно.
    await inject('PATCH', `/api/v1/office-equipment/${ctx.equipmentId}`, ctx.admin, {
      warrantyUntil: '2099-01-01',
    });
    const future = await history(ctx.admin);
    expect(future.items.some((e) => e.kind === 'warranty' && e.action === 'expired')).toBe(false);

    // Срок в прошлом: событие появляется, и оно вычисляется — своей строки в базе у него нет.
    await inject('PATCH', `/api/v1/office-equipment/${ctx.equipmentId}`, ctx.admin, {
      warrantyUntil: '2020-05-05',
    });
    const past = await history(ctx.admin);
    const expired = past.items.find((e) => e.kind === 'warranty' && e.action === 'expired');
    expect(expired).toBeDefined();
    expect(expired?.sortId).toContain('warranty-expired:equipment:');
    // Время у вычисляемого события детерминировано — полночь дня в UTC (Р79).
    expect(expired?.recordedAt).toBe('2020-05-05T00:00:00.000Z');
  });

  it('переезд и жизненный цикл идут одной лентой, свежее сверху', async () => {
    const moved = await inject(
      'POST',
      `/api/v1/office-equipment/${ctx.equipmentId}/move`,
      ctx.admin,
      {
        objectId: ctx.otherObjectId,
        movedOn: '2026-08-09',
        reason: 'Перевод бухгалтерии',
      },
    );
    expect(moved.statusCode, moved.body).toBe(201);

    const page = await history(ctx.admin);
    expect(kindsOf(page)).toContain('movement');
    // Даты идут по убыванию — это и есть «свежее сверху».
    const days = page.items.map((e) => e.occurredOn);
    expect([...days].sort().reverse()).toEqual(days);
  });

  /**
   * Курсор — главная механика страницы: он обязан пройти всю ленту без повторов и пропусков, в том
   * числе там, где события одного дня разного вида разрезаны границей страницы.
   */
  it('курсор проходит ленту без повторов и пропусков', async () => {
    const all = await history(ctx.admin, '?pageSize=200');
    expect(all.items.length).toBeGreaterThan(3);

    const seen: EquipmentHistoryEventDto[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: EquipmentHistoryPageDto = await history(
        ctx.admin,
        `?pageSize=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen.map((e) => e.sortId)).toEqual(all.items.map((e) => e.sortId));
    expect(new Set(seen.map((e) => e.sortId)).size).toBe(seen.length);
  });

  it('кривой курсор — отказ словами, а не первая страница', async () => {
    const res = await inject(
      'GET',
      `/api/v1/office-equipment/${ctx.equipmentId}/history?cursor=%D1%87%D1%83%D1%88%D1%8C`,
      ctx.admin,
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('не читается');
    // Курсор со страницы разбирается: он не uuid, и схема обязана его принимать.
    const page = await history(ctx.admin, '?pageSize=1');
    expect(decodeEquipmentHistoryCursor(page.nextCursor!)).not.toBeNull();
  });

  it('без права модуля лента отдаётся без ремонтной части', async () => {
    const page = await history(ctx.keeper);
    expect(page.serviceVisible).toBe(false);
    expect(kindsOf(page)).not.toContain('service_request');
    // Перемещения и правки карточки держателю справочника видны: право у него есть.
    expect(kindsOf(page)).toContain('movement');
  });

  it('выгрузка отдаёт файл и пишется в аудит', async () => {
    const res = await inject(
      'GET',
      `/api/v1/office-equipment/${ctx.equipmentId}/history.xlsx`,
      ctx.admin,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    // Книга — это zip: первые байты обязаны быть сигнатурой, иначе Excel её не откроет.
    expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');

    const audit = await ctx.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM audit_log
       WHERE action = 'officeEquipment.historyExport' AND entity_id = ${ctx.equipmentId}`);
    expect(Number(audit.rows[0]!.count)).toBe(1);
  });
});
