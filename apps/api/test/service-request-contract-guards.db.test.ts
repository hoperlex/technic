import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';

/**
 * Обходы, закрытые схемой выпуска 2 (план `docs/office-equipment-requests-rework-plan.md`, §8
 * тест 11; миграции M8–M10 — `0197`, `0198`, `0199`).
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ОТДЕЛЬНО ОТ `service-request-flow.db`. Там проверяется, что МАРШРУТ не даёт
 * сделать лишнего; здесь — что этого не даёт сделать БАЗА, даже когда маршрута нет вовсе. Разница
 * не теоретическая: скрипт обслуживания, чужая миграция и psql администратора ходят мимо
 * приложения, а половина правил выпуска 2 существует именно ради них — в приложении этих путей
 * нет и не было.
 *
 * ПОЧЕМУ ВСЁ ПРЯМЫМ SQL. Ни один случай ниже маршрутом не воспроизводится: приложение таких тел не
 * составляет. Тест поэтому пишет в таблицу сам и ждёт отказа — а вместе с отказом проверяет ИМЯ
 * ограничения или текст исключения: «упало» и «упало там, где мы думаем» — разные утверждения, и
 * первое зелено даже когда правило сломано, а падает соседнее.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Backfill миграций M8 и M9 (перевод мёртвых статусов, простановка `human`) этим
 * файлом не проверяется и проверен быть не может: к моменту первого случая миграции уже накатаны,
 * а завести строку «до backfill» мешают те самые ограничения, которые backfill и предваряет.
 * Проверяется он накатом на копию базы с legacy-данными — см. §11.5 плана.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/service-request-contract-guards.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  objectId: string;
  userId: string;
  counterpartyId: string;
  typeId: string;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  // Ключи подписи конфиг требует при импорте, даже когда токенов этот файл не выпускает вовсе.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
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

/** Отказ базы: код, имя ограничения и текст — по ним и опознаётся, ЧТО сработало. */
async function refusal(
  run: Promise<unknown>,
): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await run;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string; cause?: unknown };
    const cause = err.cause as { code?: string; constraint?: string; message?: string } | undefined;
    return {
      code: err.code ?? cause?.code,
      constraint: err.constraint ?? cause?.constraint,
      message: `${err.message ?? ''} ${cause?.message ?? ''}`,
    };
  }
  throw new Error('база приняла запись, которой не должно быть');
}

/** Заявка нужного вида: статусы и подписи ставятся сразу, чтобы не спорить с ограничениями пути. */
async function makeRequest(tag: string, extra = sql``): Promise<string> {
  const inv = `CG-${RUN}-${tag}`;
  const res = await ctx.db.execute<{ id: string }>(sql`
    WITH e AS (
      INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location,
                                    created_by)
      VALUES (${ctx.typeId}, ${`МФУ ${tag}`}, ${inv}, ${ctx.objectId}, 'к1', ${ctx.userId})
      RETURNING id
    )
    INSERT INTO service_requests (office_equipment_id, equipment_object_id, equipment_name,
                                  description, status, service_counterparty_id, created_by
                                  ${extra})
    SELECT e.id, ${ctx.objectId}, 'МФУ', ${`Страж ${tag}`}, 'in_work'::service_request_status,
           ${ctx.counterpartyId}, ${ctx.userId}
      FROM e
    RETURNING id`);
  return res.rows[0]!.id;
}

describe.skipIf(!DB_URL)('обходы, закрытые схемой выпуска 2 (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const user = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${`db-cg-${RUN}@example.invalid`}, 'Тестовый', 'Страж', ${RUN}, 'x', 'admin'::role,
              true, now())
      RETURNING id`);
    const object = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`CG-${RUN}`}, ${`Площадка стражей ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const party = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис стражей ${RUN}`},
              ${String(7700000000 + Math.abs(Number.parseInt(RUN, 16)) % 99999999).slice(0, 10)})
      RETURNING id`);
    const type = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    if (!type.rows[0]) throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');

    ctx = {
      db,
      closeDb,
      userId: user.rows[0]!.id,
      objectId: object.rows[0]!.id,
      counterpartyId: party.rows[0]!.id,
      typeId: type.rows[0]!.id,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx?.db) return;
    const заявки = sql`SELECT id FROM service_requests WHERE office_equipment_id IN (
      SELECT id FROM office_equipment WHERE inventory_number LIKE ${`CG-${RUN}-%`})`;
    await ctx.db.execute(sql`DELETE FROM service_requests WHERE id IN (${заявки})`);
    await ctx.db.execute(
      sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`CG-${RUN}-%`}`,
    );
    await ctx.db.execute(sql`
      DELETE FROM office_equipment_models m
       WHERE m.name LIKE ${`МФУ %`}
         AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${`db-cg-${RUN}@example.invalid`}`);
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE name = ${`Сервис стражей ${RUN}`}`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`CG-${RUN}`}`);
    await ctx.closeDb();
  }, 60_000);

  // ── M8: мёртвые статусы ──

  it('мёртвый статус не поставить заявке ни прямым UPDATE, ни через заморозку', async () => {
    const id = await makeRequest('dead');

    for (const status of ['it_approved', 'diagnostics']) {
      const res = await refusal(
        ctx.db.execute(
          sql`UPDATE service_requests SET status = ${status}::service_request_status
               WHERE id = ${id}::uuid`,
        ),
      );
      expect(res.code, status).toBe('23514');
      expect(res.constraint, status).toBe('service_requests_dead_status_check');
    }

    // Вторая половина ограничения — заморозка: «откуда отложили» тоже не бывает мёртвым, иначе
    // возврат из `on_hold` привёл бы заявку в статус, которого нет.
    const held = await refusal(
      ctx.db.execute(sql`
        UPDATE service_requests
           SET status = 'on_hold', held_from_status = 'diagnostics', hold_reason = 'ждём'
         WHERE id = ${id}::uuid`),
    );
    expect(held.constraint).toBe('service_requests_dead_status_check');

    // Живая заморозка при этом проходит: ограничение отсекает мёртвые значения, а не саму дугу.
    await ctx.db.execute(sql`
      UPDATE service_requests
         SET status = 'on_hold', held_from_status = 'in_work', hold_reason = 'ждём запчасть'
       WHERE id = ${id}::uuid`);
    const row = await ctx.db.execute<{ status: string }>(
      sql`SELECT status FROM service_requests WHERE id = ${id}::uuid`,
    );
    expect(row.rows[0]!.status).toBe('on_hold');
  });

  // ── M9: приёмка и её источник ──

  it('приёмка и источник существуют только парой', async () => {
    const id = await makeRequest('acc');

    // Принята, но кем закрыта — неизвестно.
    const noSource = await refusal(
      ctx.db.execute(sql`
        UPDATE service_requests SET status = 'accepted', accepted_at = now(),
               accepted_by = ${ctx.userId}
         WHERE id = ${id}::uuid`),
    );
    expect(noSource.constraint).toBe('service_requests_acceptance_source_check');

    // Источник у непринятой — след прошлой приёмки, переживший откат.
    const orphan = await refusal(
      ctx.db.execute(
        sql`UPDATE service_requests SET acceptance_source = 'human' WHERE id = ${id}::uuid`,
      ),
    );
    expect(orphan.constraint).toBe('service_requests_acceptance_source_check');

    // Автозакрытие с автором: за `auto` не отвечает ни один человек.
    const autoWithAuthor = await refusal(
      ctx.db.execute(sql`
        UPDATE service_requests SET status = 'accepted', accepted_at = now(),
               accepted_by = ${ctx.userId}, acceptance_source = 'auto'
         WHERE id = ${id}::uuid`),
    );
    expect(autoWithAuthor.constraint).toBe('service_requests_acceptance_source_check');

    // Обе законные формы проходят.
    await ctx.db.execute(sql`
      UPDATE service_requests SET status = 'accepted', accepted_at = now(),
             accepted_by = ${ctx.userId}, acceptance_source = 'human'
       WHERE id = ${id}::uuid`);
    const auto = await makeRequest('auto');
    await ctx.db.execute(sql`
      UPDATE service_requests SET status = 'accepted', accepted_at = now(),
             accepted_by = NULL, acceptance_source = 'auto'
       WHERE id = ${auto}::uuid`);
    const rows = await ctx.db.execute<{ acceptance_source: string }>(sql`
      SELECT acceptance_source FROM service_requests WHERE id IN (${id}::uuid, ${auto}::uuid)
       ORDER BY acceptance_source`);
    expect(rows.rows.map((r) => r.acceptance_source)).toEqual(['auto', 'human']);
  });

  // ── M10: четыре обхода ревизионной визы ──

  it('визу ИТ не поставить без ревизии, чужой ревизией и в одиночку', async () => {
    const id = await makeRequest('sig');

    // 1. Подпись без ревизии — «входная виза старого образца».
    const noRevision = await refusal(
      ctx.db.execute(sql`
        UPDATE service_requests SET it_approved_at = now(), it_approved_by = ${ctx.userId}
         WHERE id = ${id}::uuid`),
    );
    expect(noRevision.message).toContain('только вместе с ревизией сметы');

    // 2. Подпись на чужой ревизии: у заявки `estimate_revision = 0`, подписываем вторую.
    const foreign = await refusal(
      ctx.db.execute(sql`
        UPDATE service_requests SET it_approved_at = now(), it_approved_by = ${ctx.userId},
               it_approved_estimate_revision = 2
         WHERE id = ${id}::uuid`),
    );
    expect(foreign.message).toContain('на текущую ревизию');

    // 3. Законная подпись проходит — иначе следующая проверка ничего не значила бы.
    await ctx.db.execute(sql`
      UPDATE service_requests SET it_approved_at = now(), it_approved_by = ${ctx.userId},
             it_approved_estimate_revision = estimate_revision
       WHERE id = ${id}::uuid`);

    // 4. Ревизию нельзя подвинуть В ОДИНОЧКУ: иначе старую визу делают действующей, не тронув
    //    подписи. Самый неочевидный обход — его нашла сверка, а не тест.
    await ctx.db.execute(
      sql`UPDATE service_requests SET estimate_revision = 3 WHERE id = ${id}::uuid`,
    );
    const alone = await refusal(
      ctx.db.execute(sql`
        UPDATE service_requests SET it_approved_estimate_revision = 3 WHERE id = ${id}::uuid`),
    );
    expect(alone.message).toContain('только вместе с самой подписью');

    // 5. Снятие подписи чистит и ревизию: «ревизия без подписи» не означает ничего.
    const halfRemoved = await refusal(
      ctx.db.execute(
        sql`UPDATE service_requests SET it_approved_at = NULL, it_approved_by = NULL
             WHERE id = ${id}::uuid`,
      ),
    );
    expect(halfRemoved.message).toContain('остаётся без подписи');

    // А снятие целиком — проходит.
    await ctx.db.execute(sql`
      UPDATE service_requests SET it_approved_at = NULL, it_approved_by = NULL,
             it_approved_estimate_revision = NULL
       WHERE id = ${id}::uuid`);
    const row = await ctx.db.execute<{ it_approved_at: string | null }>(
      sql`SELECT it_approved_at FROM service_requests WHERE id = ${id}::uuid`,
    );
    expect(row.rows[0]!.it_approved_at).toBeNull();
  });

  // ── Инвариант исполнителя (M4, выпуск 1) — вторая половина теста 11 ──

  it('исполнителя не перевесить на другую заявку прямым UPDATE', async () => {
    const source = await makeRequest('exec-a');
    const target = await makeRequest('exec-b');
    await ctx.db.execute(sql`
      INSERT INTO service_request_executors (request_id, user_id, assigned_by)
      VALUES (${source}::uuid, ${ctx.userId}, ${ctx.userId})`);

    // Заявка-приёмник ведётся контрагентом, значит инвариант «в рабочем статусе есть исполнитель»
    // у неё выполнен и без строк. Проверяется поэтому не он, а то, что перевешивание строки
    // оставило бы БЕЗ исполнителя заявку-источник, будь она без контрагента.
    await ctx.db.execute(
      sql`UPDATE service_requests SET service_counterparty_id = NULL, status = 'new'
           WHERE id = ${source}::uuid`,
    );
    await ctx.db.execute(
      sql`UPDATE service_requests SET status = 'in_work' WHERE id = ${source}::uuid`,
    );

    const moved = await refusal(
      ctx.db.execute(sql`
        UPDATE service_request_executors SET request_id = ${target}::uuid
         WHERE request_id = ${source}::uuid`),
    );
    expect(moved.message).toContain('исполнител');
  });
});
