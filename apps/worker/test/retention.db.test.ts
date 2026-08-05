import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredRegistrations } from '../src/retention';

/**
 * Уборка отклонённых заявок по сроку (ADR 0063 решение 7) — на живой схеме.
 *
 * Условие отбора здесь и есть всё решение: ошибка в нём сносит не то, что нужно, и делает это
 * молча. Проверять его без базы нечем — это SQL, а не правило.
 *
 * Схему тест не накатывает: миграции живут в `@technic/api`, и база должна быть уже промигрирована
 * (тот же прогон, что и у db-тестов API).
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5432/technic_test pnpm --filter @technic/worker test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const TTL_DAYS = 7;

let client: pg.Client;

/** Заявка на регистрацию: без роли и неактивна — ровно то, что заводит саморегистрация. */
async function insertUser(opts: {
  email: string;
  deletedDaysAgo: number | null;
  role?: string | null;
  isActive?: boolean;
}): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active,
                        deleted_at)
     VALUES ($1, 'Заявкин', 'Пётр', '', 'x', $2, $3,
             CASE WHEN $4::numeric IS NULL THEN NULL ELSE now() - ($4 || ' days')::interval END)
     RETURNING id`,
    [
      opts.email,
      opts.role ?? null,
      opts.isActive ?? false,
      opts.deletedDaysAgo === null ? null : String(opts.deletedDaysAgo),
    ],
  );
  return res.rows[0]!.id;
}

async function exists(id: string): Promise<boolean> {
  const res = await client.query(`SELECT 1 FROM users WHERE id = $1`, [id]);
  return res.rowCount === 1;
}

describe.skipIf(!DB_URL)('уборка отклонённых заявок по сроку (живая схема)', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('сносит отказ старше срока и оставляет запись в журнале', async () => {
    const email = `retention-old-${Date.now()}@example.invalid`;
    const id = await insertUser({ email, deletedDaysAgo: TTL_DAYS + 1 });

    const { purged, skipped } = await purgeExpiredRegistrations(client, { ttlDays: TTL_DAYS });

    expect(purged.map((r) => r.id)).toContain(id);
    expect(skipped).toHaveLength(0);
    expect(await exists(id)).toBe(false);
    // Адрес обязан остаться в журнале: строки больше нет, и по entityId искать нечего.
    const audit = await client.query<{ metadata: { email?: string } }>(
      `SELECT metadata FROM audit_log WHERE action = 'user.purge_expired' AND entity_id = $1`,
      [id],
    );
    expect(audit.rows[0]?.metadata.email).toBe(email);
  });

  it('не трогает свежий отказ, действующую заявку и учётку с ролью', async () => {
    const stamp = Date.now();
    // Отказ в архиве, но срок ещё не вышел: неделя на исправление ошибки — часть решения.
    const fresh = await insertUser({
      email: `retention-fresh-${stamp}@example.invalid`,
      deletedDaysAgo: TTL_DAYS - 1,
    });
    // Живая заявка в очереди: её уборка не видит вовсе — иначе очередь исчезала бы сама собой.
    const queued = await insertUser({
      email: `retention-queued-${stamp}@example.invalid`,
      deletedDaysAgo: null,
    });
    // Архивная учётка сотрудника: у неё есть роль, и срока хранения у неё нет.
    const employee = await insertUser({
      email: `retention-employee-${stamp}@example.invalid`,
      deletedDaysAgo: TTL_DAYS + 30,
      role: 'manager',
    });

    const { purged } = await purgeExpiredRegistrations(client, { ttlDays: TTL_DAYS });

    const purgedIds = purged.map((r) => r.id);
    expect(purgedIds).not.toContain(fresh);
    expect(purgedIds).not.toContain(queued);
    expect(purgedIds).not.toContain(employee);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(queued)).toBe(true);
    expect(await exists(employee)).toBe(true);

    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [fresh, queued, employee],
    ]);
  });

  it('строку, на которую ссылаются данные, пропускает, а не роняет всю порцию', async () => {
    const stamp = Date.now();
    const held = await insertUser({
      email: `retention-held-${stamp}@example.invalid`,
      deletedDaysAgo: TTL_DAYS + 2,
    });
    const clean = await insertUser({
      email: `retention-clean-${stamp}@example.invalid`,
      deletedDaysAgo: TTL_DAYS + 2,
    });
    const object = await client.query<{ id: string }>(
      `SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    // Заявка вывоза держит автора внешним ключом (RESTRICT) — у отказа такой ссылки не бывает,
    // но случись она, вся порция иначе падала бы каждый час.
    await client.query(
      `INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by)
       VALUES ($1, 'container_removal', now(), $2)`,
      [object.rows[0]!.id, held],
    );

    const { purged, skipped } = await purgeExpiredRegistrations(client, { ttlDays: TTL_DAYS });

    expect(skipped.map((r) => r.id)).toEqual([held]);
    expect(purged.map((r) => r.id)).toContain(clean);
    expect(await exists(held)).toBe(true);
    expect(await exists(clean)).toBe(false);

    await client.query(`DELETE FROM waste_requests WHERE created_by = $1`, [held]);
    await client.query(`DELETE FROM users WHERE id = $1`, [held]);
  });
});
