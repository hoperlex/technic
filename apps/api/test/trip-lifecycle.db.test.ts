import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WaybillFormCode } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';

/**
 * Жизненный цикл ездки (план `docs/route-trips-plan.md`, §11; Р13, Р13а, Р18).
 *
 * Ездка живёт дольше, чем маршрут, в который её положили: аннулирование листа размораживает день,
 * диспетчер вправе пересобрать его — убрать одну ездку и добавить другую, — а бумага, которая уже
 * напечатана, обязана помнить прежний состав. Отсюда мягкое удаление (`deleted_at`) вместо
 * настоящего: жёсткое упёрлось бы в `waybill_trips` с `RESTRICT` навсегда.
 *
 * Мягкое удаление платит за это тем, что **каскада у него нет и быть не может**: `deleted_at` для
 * базы обычная колонка, и связки `vehicle_route_point_trips` умершей ездки остаются лежать в
 * маршруте сами по себе. Прибирает их `syncRequestTripPlacement` — и здесь проверяется, что оно
 * действительно прибрано во всех четырёх местах, где мёртвая ездка ещё может себя показать:
 * раскладка, ёмкость бланка, журнал листов и место для новой ездки.
 *
 * Чего здесь нет намеренно: жёсткое удаление под `RESTRICT`, сама возможность мягкого удаления и
 * непереиспользование номера покрыты в `route-points-schema.db.test.ts` — они утверждения о
 * схеме, а не о раскладке, и повторять их значило бы получить два ответа на один вопрос.
 *
 * Сервисный уровень, а не `app.inject`: сводит раскладку с правленым составом сервис, и дверь
 * портала лишь зовёт его под уже взятой блокировкой рейса (Р17).
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_gate2 \
 *     pnpm --filter @technic/api test trip-lifecycle --no-file-parallelism
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

type Tx = Parameters<Parameters<typeof AppDb.transaction>[0]>[0];

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  placeRequestTrips: (typeof import('../src/services/route-points'))['placeRequestTrips'];
  syncRequestTripPlacement: (typeof import('../src/services/route-points'))['syncRequestTripPlacement'];
  loadRoutePoints: (typeof import('../src/services/route-points'))['loadRoutePoints'];
  routeTaskRefs: (typeof import('../src/services/route-points'))['routeTaskRefs'];
  assertRouteCapacity: (typeof import('../src/services/route-points'))['assertRouteCapacity'];
}

let ctx: Ctx;

beforeAll(async () => {
  if (!DB_URL) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  // Ключи подписи конфиг требует при импорте — читает их даже тот модуль, которому они не нужны
  // (`db/client` тянет `config`). Генерируем прогонными: настоящие тут ни к чему.
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
  const points = await import('../src/services/route-points');
  ctx = {
    db,
    closeDb,
    placeRequestTrips: points.placeRequestTrips,
    syncRequestTripPlacement: points.syncRequestTripPlacement,
    loadRoutePoints: points.loadRoutePoints,
    routeTaskRefs: points.routeTaskRefs,
    assertRouteCapacity: points.assertRouteCapacity,
  };
}, 120_000);

afterAll(async () => {
  await ctx?.closeDb();
});

/** Один ответственный на все концы: тождество точки решает адрес, а телефон здесь общий (Р9). */
const PHONE = '9990000555';

/** Далёкое будущее: рейс сцены не должен попадаться на глаза отборам соседних файлов. */
const ROUTE_OFFSET = 800;

/** Что заведено в сцене одной заявки в одном рейсе. */
interface Scene {
  tx: Tx;
  routeId: string;
  requestId: string;
  /** Ездка заявки; номер выдаётся по порядку заведения, как это делает правка списком. */
  addTrip: (from: string, to: string) => Promise<string>;
  /** Мягкое удаление (Р13а): ездка остаётся строкой, но уходит из работы. */
  softDelete: (tripId: string) => Promise<void>;
  /** Точки маршрута строкой: «адрес[роли]», `↑` погрузка, `↓` разгрузка. */
  shapeOf: () => Promise<string>;
  /** Позиции точек по порядку объезда: ими видно уплотнение (Р13). */
  positionsOf: () => Promise<number[]>;
  /** Роли одной ездки на точках: «адрес↑», «адрес↓». Пусто — ездка не разложена. */
  rolesOf: (tripId: string) => Promise<string[]>;
  /** Выписывает лист и записывает в него ездки строками задания (`waybill_trips`, Р20). */
  issueWaybill: (tripIds: string[]) => Promise<string>;
}

/**
 * Собирает рейс с одной грузовой заявкой и отдаёт его сцену.
 *
 * Всё внутри одной транзакции, которая **всегда откатывается**: база у db-тестов общая, и
 * оставленный за собой рейс с листом испортил бы соседние файлы, половина которых берёт из
 * справочников «первую попавшуюся» запись, а журнал листов читает первую страницу.
 */
async function inRoute<T>(run: (scene: Scene) => Promise<T>): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      // `tx.execute` отдаёт результат запроса целиком, а не массив строк, — строки лежат в `rows`.
      const one = async <R extends Record<string, unknown>>(
        query: Parameters<typeof tx.execute>[0],
      ): Promise<R> => {
        const [row] = (await tx.execute<R>(query)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };

      const user = await one<{ id: string }>(sql`SELECT id FROM users LIMIT 1`);
      const veh = await one<{ id: string }>(sql`SELECT id FROM vehicles LIMIT 1`);
      const obj = await one<{ id: string }>(sql`SELECT id FROM construction_objects LIMIT 1`);
      const vt = await one<{ id: string }>(sql`SELECT id FROM vehicle_types LIMIT 1`);

      const route = await one<{ id: string }>(sql`
        INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, created_by)
        VALUES (${veh.id}, CURRENT_DATE + (${ROUTE_OFFSET})::int, 'freight', ${user.id})
        RETURNING id`);
      const request = await one<{ id: string }>(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
        VALUES ('freight_transport', ${obj.id}, ${vt.id}, 'confirmed', ${user.id}) RETURNING id`);
      await tx.execute(sql`
        INSERT INTO freight_transport_request_details (request_id, scheduled_at)
        VALUES (${request.id}, now())`);
      await tx.execute(sql`
        INSERT INTO vehicle_route_requests (route_id, request_id, position)
        VALUES (${route.id}, ${request.id}, 1)`);

      let num = 0;
      const addTrip = async (from: string, to: string) => {
        num += 1;
        const row = await one<{ id: string }>(sql`
          INSERT INTO vehicle_request_trips (request_id, num, from_location, to_location,
            from_responsible_name, from_responsible_phone,
            to_responsible_name, to_responsible_phone)
          VALUES (${request.id}, ${num}, ${from}, ${to}, 'Отв', ${PHONE}, 'Отв', ${PHONE})
          RETURNING id`);
        return row.id;
      };

      const softDelete = async (tripId: string) => {
        await tx.execute(
          sql`UPDATE vehicle_request_trips SET deleted_at = now() WHERE id = ${tripId}`,
        );
      };

      const points = () => ctx.loadRoutePoints(tx, route.id);
      const shapeOf = async () =>
        (await points())
          .map(
            (point) =>
              `${point.location}[${point.actions
                .map((a) => (a.role === 'load' ? '↑' : a.role === 'unload' ? '↓' : '⚙'))
                .join('')}]`,
          )
          .join(' ');
      const positionsOf = async () => (await points()).map((point) => point.position);
      const rolesOf = async (tripId: string) =>
        (await points()).flatMap((point) =>
          point.actions
            .filter((a) => a.ref.kind === 'freight' && a.ref.tripId === tripId)
            .map((a) => `${point.location}${a.role === 'load' ? '↑' : '↓'}`),
        );

      const issueWaybill = async (tripIds: string[]) => {
        const series = await one<{ id: string }>(sql`SELECT id FROM waybill_series LIMIT 1`);
        const waybill = await one<{ id: string }>(sql`
          INSERT INTO waybills (series_id, number, form_code, route_id, status, issued_for_date,
                                organization_id, vehicle_id, driver_person_id, issued_by, data)
          SELECT ${series.id}, 999998, '4p', ${route.id}, 'issued',
                 CURRENT_DATE + (${ROUTE_OFFSET})::int,
                 (SELECT id FROM organizations LIMIT 1), ${veh.id},
                 (SELECT id FROM persons LIMIT 1), ${user.id}, '{}'::jsonb
          RETURNING id`);
        for (const [index, tripId] of tripIds.entries()) {
          await tx.execute(sql`INSERT INTO waybill_trips (waybill_id, trip_id, slot)
                               VALUES (${waybill.id}, ${tripId}, ${index + 1})`);
        }
        return waybill.id;
      };

      out = await run({
        tx,
        routeId: route.id,
        requestId: request.id,
        addTrip,
        softDelete,
        shapeOf,
        positionsOf,
        rolesOf,
        issueWaybill,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

/** Сообщение отказа по ёмкости бланка либо `null`, если маршрут в бланк укладывается. */
async function capacityRefusal(
  tx: Tx,
  routeId: string,
  formCode: WaybillFormCode,
): Promise<string | null> {
  try {
    await ctx.assertRouteCapacity(tx, routeId, formCode);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe.skipIf(!DB_URL)('мягко удалённая ездка уходит из работы', () => {
  /**
   * Р13: снятая ездка обязана унести за собой свои точки, а не оставить их пустыми в объезде.
   *
   * Проверяется вместе с промежуточным состоянием, и это здесь главное. Само мягкое удаление
   * раскладку **не** трогает: `deleted_at` для базы обычная колонка, связки остаются лежать, и
   * маршрут какое-то время показывает остановки, на которых делать нечего. Уборщик — не база и не
   * триггер, а `syncRequestTripPlacement`, и если правка заявки забудет его позвать, водитель
   * получит объезд с заездом в никуда. Тест показывает обе картинки подряд, чтобы разница между
   * «убралось само» и «убрал сервис» была видна глазом.
   *
   * Позиции после уборки уплотняются: их читает человек («первой едем на карьер»), и счёт с
   * пропуском читается как потерянная работа.
   */
  it('её роли снимаются, опустевшие точки исчезают, позиции уплотняются', async () => {
    const { placed, afterDelete, afterSync, positions, roles } = await inRoute(async (s) => {
      const first = await s.addTrip('Карьер Сычёво', 'Объект Заря');
      await s.addTrip('Склад Южный', 'Объект Восток');
      await ctx.placeRequestTrips(s.tx, s.routeId, s.requestId);
      const placed = await s.shapeOf();

      await s.softDelete(first);
      const afterDelete = await s.shapeOf();

      await ctx.syncRequestTripPlacement(s.tx, s.routeId, s.requestId);
      return {
        placed,
        afterDelete,
        afterSync: await s.shapeOf(),
        positions: await s.positionsOf(),
        roles: await s.rolesOf(first),
      };
    });

    expect(placed).toBe('Карьер Сычёво[↑] Объект Заря[↓] Склад Южный[↑] Объект Восток[↓]');
    // Мягкое удаление само по себе оставляет две пустые остановки в середине объезда.
    expect(afterDelete).toBe('Карьер Сычёво[] Объект Заря[] Склад Южный[↑] Объект Восток[↓]');
    expect(afterSync).toBe('Склад Южный[↑] Объект Восток[↓]');
    // Оставшиеся точки перенумерованы с единицы, а не остались третьей и четвёртой.
    expect(positions).toEqual([1, 2]);
    expect(roles).toEqual([]);
  });

  /**
   * И она не занимает строку бланка (Р13а): бумага печатает то, что поедет, а не то, что когда-то
   * заказывали.
   *
   * Проверяется границей 4-П: восемь ездок в семь строк не влезают (ADR 0068), а те же восемь с
   * одной снятой — влезают ровно. Счёт по всем строкам заявки запер бы диспетчера в переполнении,
   * из которого нет выхода: снять ездку он уже снял, а бланк по-прежнему «полон».
   */
  it('она не считается в ёмкость бланка', async () => {
    const { before, after, rows } = await inRoute(async (s) => {
      const ids: string[] = [];
      for (let i = 0; i < 8; i += 1) ids.push(await s.addTrip('Карьер Сычёво', 'Объект Заря'));
      await ctx.placeRequestTrips(s.tx, s.routeId, s.requestId);
      const before = await capacityRefusal(s.tx, s.routeId, '4p');

      await s.softDelete(ids[0]!);
      await ctx.syncRequestTripPlacement(s.tx, s.routeId, s.requestId);
      return {
        before,
        after: await capacityRefusal(s.tx, s.routeId, '4p'),
        rows: (await ctx.routeTaskRefs(s.tx, s.routeId)).length,
      };
    });

    expect(before).toContain('в маршруте их 8');
    expect(after).toBeNull();
    expect(rows).toBe(7);
  });

  /**
   * А из журнала листов она не исчезает — ради этого удаление и сделано мягким.
   *
   * `waybill_trips` отвечает на «какая ездка какой строкой напечатана», и ответ обязан пережить
   * пересборку маршрута: бланк строгой отчётности уже выдан на руки, номер израсходован, и
   * утверждение «в листе № такой-то была ездка ТС-N/2» после снятия ездки не перестаёт быть
   * правдой. Проверяется здесь, а не в схеме: `RESTRICT` держит только жёсткое удаление, а
   * видимость после **мягкого** держит то, что снимающий её `syncRequestTripPlacement` трогает
   * связки точек и не трогает журнал.
   */
  it('она остаётся видимой из журнала листов', async () => {
    const printed = await inRoute(async (s) => {
      const first = await s.addTrip('Карьер Сычёво', 'Объект Заря');
      const second = await s.addTrip('Склад Южный', 'Объект Восток');
      await ctx.placeRequestTrips(s.tx, s.routeId, s.requestId);
      const waybillId = await s.issueWaybill([first, second]);

      await s.softDelete(second);
      await ctx.syncRequestTripPlacement(s.tx, s.routeId, s.requestId);

      const rows = (
        await s.tx.execute<{ slot: number; num: number; gone: boolean }>(sql`
          SELECT wt.slot, t.num, (t.deleted_at IS NOT NULL) AS gone
          FROM waybill_trips wt
          JOIN vehicle_request_trips t ON t.id = wt.trip_id
          WHERE wt.waybill_id = ${waybillId}
          ORDER BY wt.slot`)
      ).rows;
      return {
        journal: rows.map((r) => `${r.slot}:ТС/${r.num}${r.gone ? ' (снята)' : ''}`),
        shape: await s.shapeOf(),
      };
    });

    // Лист помнит обе строки — и ту, которой в маршруте уже нет.
    expect(printed.journal).toEqual(['1:ТС/1', '2:ТС/2 (снята)']);
    // А маршрут её не показывает: журнал и задание отвечают на разные вопросы.
    expect(printed.shape).toBe('Карьер Сычёво[↑] Объект Заря[↓]');
  });
});

describe.skipIf(!DB_URL)('добавленная правкой ездка', () => {
  /**
   * Вторая половина того же долга (Р18, закрыт этапом 3): правка заявки полным списком не только
   * убивает ездки, но и заводит новые, и новая появляется **неразложенной** — её никто не клал в
   * маршрут, потому что в момент её появления речь шла о заявке, а не о рейсе.
   *
   * Неразложенная ездка не молчит: выписка отвечает `rows_unplaced`, — но сама по себе она делает
   * бесполезной всю правку. Диспетчер добавил ездку, а в задании её нет; чинить руками пришлось бы
   * ту же раскладку, которую автосборка делает по правилу (Р8).
   *
   * Проверяются обе картинки: до сведения ролей нет вовсе, после — погрузка и разгрузка своими
   * точками, а прежний объезд не переставлен.
   */
  it('после сведения получает погрузку и разгрузку, не трогая прежний объезд', async () => {
    const { before, after, added, shape } = await inRoute(async (s) => {
      await s.addTrip('Карьер Сычёво', 'Объект Заря');
      await ctx.placeRequestTrips(s.tx, s.routeId, s.requestId);

      const fresh = await s.addTrip('Склад Южный', 'Объект Восток');
      const before = await s.rolesOf(fresh);

      await ctx.syncRequestTripPlacement(s.tx, s.routeId, s.requestId);
      return {
        before,
        after: await s.rolesOf(fresh),
        added: (await ctx.routeTaskRefs(s.tx, s.routeId)).length,
        shape: await s.shapeOf(),
      };
    });

    expect(before).toEqual([]);
    expect(after).toEqual(['Склад Южный↑', 'Объект Восток↓']);
    expect(added).toBe(2);
    // Прежние точки остались первой и второй: новая работа встаёт в конец объезда, а собранное
    // человеком автосборка не двигает.
    expect(shape).toBe('Карьер Сычёво[↑] Объект Заря[↓] Склад Южный[↑] Объект Восток[↓]');
  });
});
