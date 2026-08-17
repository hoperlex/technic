import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';

/**
 * Физические инварианты точек маршрута (план `docs/route-trips-plan.md`, §5.3, Р5, Р5а, Р13а).
 *
 * Проверяется не поведение сервера, а то, что **база не примет** невозможного. Разница
 * принципиальная: серверное правило можно обойти новой ручкой, забытой веткой или прямым запросом
 * из скрипта, а ограничение схемы обойти нечем. Три составных ключа связки заведены ровно затем,
 * чтобы «точка чужого маршрута», «ездка чужой заявки» и «заявка вне состава рейса» были не
 * ошибками кода, а состояниями, которых не существует.
 *
 * Отдельно проверяются **обратные** сочетания роли и вида строки: `CHECK` ловит `work` с ездкой и
 * `load` без неё, но не ловит `work` у грузовой заявки — третий ключ смотрит только на пару
 * «маршрут + заявка». Это записано в §5.3 как известная граница, и держит её сервер; тест
 * фиксирует саму границу, чтобы её не приняли за недосмотр.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!DB_URL) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
  const { db, closeDb } = await import('../src/db/client');
  ctx = { db, closeDb };
}, 120_000);

afterAll(async () => {
  await ctx?.closeDb();
});

/** Что заведено в транзакции сценария: всё, на что ссылаются связки. */
interface Scene {
  routeId: string;
  otherRouteId: string;
  requestId: string;
  otherRequestId: string;
  tripId: string;
  otherTripId: string;
  pointId: string;
  otherPointId: string;
}

/**
 * Собирает два рейса с заявкой и ездкой в каждом и отдаёт их идентификаторы.
 *
 * Транзакция **всегда откатывается**: база у db-тестов общая, и оставленный за собой рейс испортил
 * бы соседние файлы, половина которых берёт из справочников «первую попавшуюся» запись.
 */
async function inScene<T>(run: (tx: never, scene: Scene) => Promise<T>): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<{ id: string }> => {
        const [row] = (await tx.execute<{ id: string }>(q)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };
      const user = await one(sql`SELECT id FROM users LIMIT 1`);
      const veh = await one(sql`SELECT id FROM vehicles LIMIT 1`);
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const vt = await one(sql`SELECT id FROM vehicle_types LIMIT 1`);

      const route = async (offset: number) =>
        one(sql`INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, created_by)
                VALUES (${veh.id}, CURRENT_DATE + (${500 + offset})::int, 'freight', ${user.id})
                RETURNING id`);
      const request = async () => {
        const r = await one(sql`
          INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
          VALUES ('freight_transport', ${obj.id}, ${vt.id}, 'confirmed', ${user.id}) RETURNING id`);
        await tx.execute(sql`INSERT INTO freight_transport_request_details (request_id, scheduled_at)
                             VALUES (${r.id}, now())`);
        return r;
      };
      const trip = async (requestId: string, num: number) =>
        one(sql`INSERT INTO vehicle_request_trips (request_id, num, from_location, to_location,
                  from_responsible_name, from_responsible_phone,
                  to_responsible_name, to_responsible_phone)
                VALUES (${requestId}, ${num}, 'A', 'B', 'Отв', '9990000001', 'Отв', '9990000001')
                RETURNING id`);
      const point = async (routeId: string, position: number) =>
        one(sql`INSERT INTO vehicle_route_points (route_id, position, location)
                VALUES (${routeId}, ${position}, 'A') RETURNING id`);

      const r1 = await route(0);
      const r2 = await route(1);
      const q1 = await request();
      const q2 = await request();
      const t1 = await trip(q1.id, 1);
      const t2 = await trip(q2.id, 1);
      await tx.execute(sql`INSERT INTO vehicle_route_requests (route_id, request_id, position)
                           VALUES (${r1.id}, ${q1.id}, 1)`);
      await tx.execute(sql`INSERT INTO vehicle_route_requests (route_id, request_id, position)
                           VALUES (${r2.id}, ${q2.id}, 1)`);
      const p1 = await point(r1.id, 1);
      const p2 = await point(r2.id, 1);

      out = await run(tx as never, {
        routeId: r1.id,
        otherRouteId: r2.id,
        requestId: q1.id,
        otherRequestId: q2.id,
        tripId: t1.id,
        otherTripId: t2.id,
        pointId: p1.id,
        otherPointId: p2.id,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

/**
 * Ответ базы на попытку записи: код ошибки либо `null`, если запись прошла.
 *
 * Каждая попытка идёт под своей точкой сохранения. Без неё первый же отказ обрывает транзакцию
 * целиком, и следующий запрос получает не свой код, а `25P02` «транзакция в состоянии ошибки» —
 * то есть тест проверял бы не то ограничение, которое называет, а факт предыдущего отказа.
 */
let savepoint = 0;
async function refusal(
  tx: never,
  query: Parameters<(typeof AppDb)['execute']>[0],
): Promise<string | null> {
  const runner = tx as unknown as { execute: (typeof AppDb)['execute'] };
  const name = `probe_${(savepoint += 1)}`;
  await runner.execute(sql.raw(`SAVEPOINT ${name}`));
  try {
    await runner.execute(query);
    await runner.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return null;
  } catch (e) {
    await runner.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    // Drizzle заворачивает ошибку драйвера: код `SQLSTATE` лежит в причине, а не на верхнем
    // уровне. Без разбора причины тест сравнивал бы с 'unknown' и проходил бы на любом отказе —
    // в том числе на «не та таблица» и «нет колонки», то есть проверял бы опечатку, а не ключ.
    const cause = (e as { cause?: { code?: string } }).cause;
    return cause?.code ?? (e as { code?: string }).code ?? 'unknown';
  }
}

const ROLE = (
  pointId: string,
  routeId: string,
  requestId: string,
  tripId: string | null,
  role: string,
  position = 1,
) => sql`
  INSERT INTO vehicle_route_point_trips (point_id, route_id, request_id, trip_id, role, position)
  VALUES (${pointId}, ${routeId}, ${requestId}, ${tripId}, ${role}, ${position})`;

describe.skipIf(!DB_URL)('составные ключи связки: чего база не примет', () => {
  it('обычная роль ложится', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.tripId, 'load')),
    );

    expect(code).toBeNull();
  });

  /**
   * Первый ключ: точка обязана быть **своего** маршрута. Иначе машина одного дня встала бы на
   * остановку другого — и порядок объезда, по которому печатается задание, перестал бы что-либо
   * означать.
   */
  it('точка чужого маршрута — отказ целостности', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(tx, ROLE(s.otherPointId, s.routeId, s.requestId, s.tripId, 'load')),
    );

    expect(code).toBe('23503');
  });

  /** Второй ключ: ездка обязана принадлежать **своей** заявке (Р1) — у неё она ровно одна. */
  it('ездка чужой заявки — отказ целостности', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.otherTripId, 'load')),
    );

    expect(code).toBe('23503');
  });

  /**
   * Третий ключ: работа делается только по заявке, которая **стоит в составе** этого рейса. Без
   * него в задание попала бы работа, которую в этот день никто не заказывал.
   */
  it('заявка вне состава рейса — отказ целостности', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(tx, ROLE(s.pointId, s.routeId, s.otherRequestId, s.otherTripId, 'load')),
    );

    expect(code).toBe('23503');
  });
});

describe.skipIf(!DB_URL)('согласованность роли и вида строки', () => {
  /** `CHECK`: у линейного дня ездки нет вовсе (Р5а) — `work` с ездкой невозможен. */
  it('работа с ездкой — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.tripId, 'work')),
    );

    expect(code).toBe('23514');
  });

  /** Обратное: погрузка без ездки — тоже невозможна, грузить нечего. */
  it('погрузка без ездки — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, null, 'load')),
    );

    expect(code).toBe('23514');
  });

  /**
   * А вот эту границу база **не держит**, и это записано в §5.3 как решение, а не недосмотр:
   * `work` у грузовой заявки схема примет — третий ключ смотрит только на пару «маршрут + заявка»,
   * а `work_date` строки состава в связку не скопирован намеренно (копия разошлась бы с составом
   * при переносе рейса на другую дату, ADR 0082).
   *
   * Тест фиксирует именно это: правило серверное, и знать о нём надо, чтобы не принять отсутствие
   * отказа за дыру в схеме.
   */
  it('работа у грузовой заявки схемой не ловится — правило серверное', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, null, 'work')),
    );

    expect(code).toBeNull();
  });
});

describe.skipIf(!DB_URL)('частичные уникальности', () => {
  /** У ездки ровно одна погрузка и одна разгрузка (Р5): вторая погрузка той же ездки невозможна. */
  it('вторая погрузка одной ездки — отказ уникальности', async () => {
    const code = await inScene(async (tx, s) => {
      await refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.tripId, 'load', 1));
      return refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.tripId, 'load', 2));
    });

    expect(code).toBe('23505');
  });

  /** Погрузка и разгрузка одной ездки на одной точке схемой допустимы — Р6 держит сервер. */
  it('погрузка и разгрузка одной ездки на одной точке схемой проходят', async () => {
    const code = await inScene(async (tx, s) => {
      await refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.tripId, 'load', 1));
      return refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.tripId, 'unload', 2));
    });

    expect(code).toBeNull();
  });

  /** Позиция роли внутри точки различна (миграция `0146`): ею задан порядок строк задания. */
  it('две роли одной точки не встают на одну позицию', async () => {
    const code = await inScene(async (tx, s) => {
      await refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.tripId, 'load', 1));
      return refusal(tx, ROLE(s.pointId, s.routeId, s.requestId, s.tripId, 'unload', 1));
    });

    expect(code).toBe('23505');
  });
});

describe.skipIf(!DB_URL)('жизненный цикл ездки (Р13а)', () => {
  /**
   * Ездку, побывавшую в выданном листе, снести нельзя: на неё ссылается `waybill_trips` с
   * `RESTRICT`. Журнал бланков строгой отчётности обязан помнить, что именно печаталось.
   */
  it('ездку из выданного листа жёстко не удалить', async () => {
    const code = await inScene(async (tx, s) => {
      const runner = tx as unknown as { execute: (typeof AppDb)['execute'] };
      const [series] = (
        await runner.execute<{ id: string }>(sql`SELECT id FROM waybill_series LIMIT 1`)
      ).rows;
      if (!series) return 'нет серии бланков';
      const [waybill] = (
        await runner.execute<{ id: string }>(sql`
          INSERT INTO waybills (series_id, number, form_code, route_id, status, issued_for_date,
                                organization_id, vehicle_id, driver_person_id, issued_by, data)
          SELECT ${series.id}, 999999, '4p', ${s.routeId}, 'issued', CURRENT_DATE,
                 (SELECT id FROM organizations LIMIT 1),
                 (SELECT vehicle_id FROM vehicle_routes WHERE id = ${s.routeId}),
                 (SELECT id FROM persons LIMIT 1),
                 (SELECT id FROM users LIMIT 1), '{}'::jsonb
          RETURNING id`)
      ).rows;
      if (!waybill) return 'лист не завёлся';
      await runner.execute(sql`INSERT INTO waybill_trips (waybill_id, trip_id, slot)
                               VALUES (${waybill.id}, ${s.tripId}, 1)`);
      return refusal(tx, sql`DELETE FROM vehicle_request_trips WHERE id = ${s.tripId}`);
    });

    expect(code).toBe('23503');
  });

  /**
   * Мягкое удаление при этом проходит — и в этом весь смысл Р13а: аннулирование листа размораживает
   * маршрут, диспетчер вправе пересобрать день, а жёсткое удаление упёрлось бы в ссылку навсегда.
   */
  it('мягкое удаление проходит, а номер не переиспользуется', async () => {
    const nums = await inScene(async (tx, s) => {
      const runner = tx as unknown as { execute: (typeof AppDb)['execute'] };
      await runner.execute(
        sql`UPDATE vehicle_request_trips SET deleted_at = now() WHERE id = ${s.tripId}`,
      );
      // Номер следующей ездки — за максимумом по **всем** строкам, включая мягко удалённые:
      // «ТС-40/1» в старом листе и «ТС-40/1» в новом означали бы разное.
      await runner.execute(sql`
        INSERT INTO vehicle_request_trips (request_id, num, from_location, to_location,
          from_responsible_name, from_responsible_phone, to_responsible_name, to_responsible_phone)
        SELECT ${s.requestId}, coalesce(max(num), 0) + 1, 'A', 'C', 'Отв', '9990000001',
               'Отв', '9990000001'
        FROM vehicle_request_trips WHERE request_id = ${s.requestId}`);
      return (
        await runner.execute<{ num: number }>(sql`
          SELECT num FROM vehicle_request_trips WHERE request_id = ${s.requestId} ORDER BY num`)
      ).rows.map((r) => Number(r.num));
    });

    expect(nums).toEqual([1, 2]);
  });
});
