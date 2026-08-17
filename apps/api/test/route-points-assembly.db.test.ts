import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения модуля берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';

/**
 * Автосборка точек маршрута (план `docs/route-trips-plan.md`, Р8) — на живой схеме.
 *
 * Здесь проверяется приёмочный критерий всей переработки: заказчик просил, чтобы день машины
 * собирался **адресами и их порядком**, а не связками «ездка целиком». Три его примера (§2) — не
 * иллюстрация, а требование, и разбираются они ровно тем алгоритмом переиспользования, который
 * выписан в Р8 псевдокодом.
 *
 * Почему db-тест, а не чистая функция: алгоритм принимает решения по **тождеству уже стоящих**
 * точек, а тождество считается из ролей, которые лежат в трёх связанных таблицах под составными
 * ключами. Ошибка здесь — не «функция вернула не то», а «код и база разошлись»: точка нашлась,
 * но чужого маршрута; роль встала, но у заявки вне состава. На моках такое не воспроизводится.
 *
 * Данные заводятся прямым `INSERT` и откатываются вместе с транзакцией: дверь со стороны портала
 * ведёт себя одинаково, а сборка от того, чьими руками заявка попала в рейс, не зависит.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
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
  placeRequestTrips: (typeof import('../src/services/route-points'))['placeRequestTrips'];
  loadRoutePoints: (typeof import('../src/services/route-points'))['loadRoutePoints'];
  pointOrderByComposition: (typeof import('../src/services/route-points'))['pointOrderByComposition'];
}

let ctx: Ctx;

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

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

  await migrate(DB_URL);
  const { db, closeDb } = await import('../src/db/client');
  const points = await import('../src/services/route-points');
  ctx = {
    db,
    closeDb,
    placeRequestTrips: points.placeRequestTrips,
    loadRoutePoints: points.loadRoutePoints,
    pointOrderByComposition: points.pointOrderByComposition,
  };
}, 120_000);

afterAll(async () => {
  await ctx?.closeDb();
});

/** Один ответственный на все концы: тождество точки решает адрес, а телефон здесь общий (Р9). */
const PHONE = '9990000777';

interface RequestPlan {
  /** Ездки парами «откуда → куда»: буквы — те же, что в примерах §2. */
  trips: [string, string][];
}

/**
 * Собирает день и отдаёт его порядок объезда.
 *
 * Всё внутри одной транзакции, которая **всегда откатывается**: база у db-тестов общая, и
 * оставленный за собой рейс с заявками испортил бы соседние файлы, половина которых берёт из
 * справочников «первую попавшуюся» запись.
 */
async function assemble(
  plan: RequestPlan[],
  /** Что сделать с собранным днём до отката: сюда передаётся мост «состав → точки». */
  probe?: (ctx: {
    tx: Parameters<Parameters<typeof AppDb.transaction>[0]>[0];
    routeId: string;
    requestIds: string[];
  }) => Promise<string>,
): Promise<{ shape: string; roles: string; probed: string }> {
  let result = { shape: '', roles: '', probed: '' };
  await ctx.db
    .transaction(async (tx) => {
      // `tx.execute` отдаёт результат запроса целиком, а не массив строк, — строки лежат в `rows`.
      const one = async (query: Parameters<typeof tx.execute>[0]): Promise<{ id: string }> => {
        const result = await tx.execute<{ id: string }>(query);
        const [row] = result.rows;
        if (!row) throw new Error('в справочнике пусто: тесту не на чем собрать день');
        return row;
      };

      const user = await one(sql`SELECT id FROM users LIMIT 1`);
      const veh = await one(sql`SELECT id FROM vehicles LIMIT 1`);
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const vt = await one(sql`SELECT id FROM vehicle_types LIMIT 1`);
      const route = await one(sql`
        INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, created_by)
        VALUES (${veh.id}, CURRENT_DATE + 400, 'freight', ${user.id}) RETURNING id`);

      const requestIds: string[] = [];
      for (const [index, { trips }] of plan.entries()) {
        const request = await one(sql`
          INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
          VALUES ('freight_transport', ${obj.id}, ${vt.id}, 'confirmed', ${user.id})
          RETURNING id`);
        await tx.execute(sql`
          INSERT INTO freight_transport_request_details (request_id, scheduled_at)
          VALUES (${request.id}, now())`);
        for (const [num, [from, to]] of trips.entries()) {
          await tx.execute(sql`
            INSERT INTO vehicle_request_trips (request_id, num, from_location, to_location,
              from_responsible_name, from_responsible_phone,
              to_responsible_name, to_responsible_phone)
            VALUES (${request.id}, ${num + 1}, ${from}, ${to},
              'Отв', ${PHONE}, 'Отв', ${PHONE})`);
        }
        await tx.execute(sql`
          INSERT INTO vehicle_route_requests (route_id, request_id, position)
          VALUES (${route.id}, ${request.id}, ${index + 1})`);
        requestIds.push(request.id);
        await ctx.placeRequestTrips(tx, route.id, request.id);
      }

      const points = await ctx.loadRoutePoints(tx, route.id);
      const probed = probe ? await probe({ tx, routeId: route.id, requestIds }) : '';
      result = {
        probed,
        shape: points.map((p) => p.location).join(' '),
        roles: points
          .map(
            (p) =>
              `${p.location}[${p.actions
                .map((a) => (a.role === 'load' ? '↑' : a.role === 'unload' ? '↓' : '⚙'))
                .join('')}]`,
          )
          .join(' '),
      };
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return result;
}

describe.skipIf(!DB_URL)('автосборка точек: примеры заказчика', () => {
  /**
   * Главный случай Р8. «Склеивать подряд идущие» здесь не годится: последовательное добавление
   * дало бы `A B A C`, где две `A` **не соседние**, — и обещанная одна погрузка сама собой не
   * получилась бы. Переиспользование даёт три точки и одну погрузку на обе ездки.
   */
  it('ездки A→B и A→C одной заявки дают три точки, а не четыре', async () => {
    const { shape, roles } = await assemble([
      {
        trips: [
          ['A', 'B'],
          ['A', 'C'],
        ],
      },
    ]);

    expect(shape).toBe('A B C');
    expect(roles).toBe('A[↑↑] B[↓] C[↓]');
  });

  /**
   * Область поиска — **весь** маршрут, а не точки своей заявки: ради этого всё и затевалось. Ездка
   * `B→D` чужой заявки садится погрузкой на уже стоящую `B`, а не заводит второй заезд туда же.
   */
  it('чужая заявка садится на уже стоящие точки, а не заводит свои', async () => {
    const { shape, roles } = await assemble([
      {
        trips: [
          ['A', 'B'],
          ['A', 'C'],
        ],
      },
      { trips: [['B', 'D']] },
    ]);

    expect(shape).toBe('A B C D');
    expect(roles).toBe('A[↑↑] B[↓↑] C[↓] D[↓]');
  });

  /**
   * Порядок укладки значим, и это правильно: точки прежних заявок автосборка не двигает, а новые
   * ставит в конец. Здесь же виден предел переиспользования — и он не изъян, а инвариант Р6.
   *
   * Ездка `A→B` кладётся после того, как `B` уже стоит **первой**. Сесть разгрузкой на неё нельзя:
   * позиция погрузки (`A`, третья) обязана быть строго меньше позиции разгрузки, иначе выйдет
   * «выгрузили раньше, чем погрузили». Поэтому заводится второй заезд в `B`, и день выходит
   * `B D A B C`, а не `B D A C`.
   *
   * Пример §2 `B D A C B` получается из этого дня **перестановкой** — работой человека, а не
   * автосборки: портал хранит порядок, который задал диспетчер, и лучшего не предлагает (§13).
   */
  it('разгрузка не садится на точку, стоящую раньше своей погрузки', async () => {
    const { shape, roles } = await assemble([
      { trips: [['B', 'D']] },
      {
        trips: [
          ['A', 'B'],
          ['A', 'C'],
        ],
      },
    ]);

    expect(shape).toBe('B D A B C');
    expect(roles).toBe('B[↑] D[↓] A[↑↑] B[↓] C[↓]');
  });

  /**
   * Инвариант Р6 цел **по построению**: разгрузка либо находится позже своей погрузки, либо
   * заводится последней. Повторные ездки в одно и то же место — тот случай, где это легче всего
   * нарушить: вторая `A→B` не имеет права сесть разгрузкой на `B`, стоящую раньше её погрузки.
   */
  it('повторные ездки не нарушают «погрузка раньше разгрузки»', async () => {
    const { shape, roles } = await assemble([
      {
        trips: [
          ['A', 'B'],
          ['A', 'B'],
          ['A', 'B'],
        ],
      },
    ]);

    expect(shape).toBe('A B');
    expect(roles).toBe('A[↑↑↑] B[↓↓↓]');
  });

  /** Ездка «туда и обратно»: разгрузка ищется строго **после** погрузки, а не с начала списка. */
  it('ездка обратно заводит второй заезд, а не садится на точку до погрузки', async () => {
    const { shape, roles } = await assemble([
      {
        trips: [
          ['A', 'B'],
          ['B', 'A'],
        ],
      },
    ]);

    expect(shape).toBe('A B A');
    expect(roles).toBe('A[↑] B[↓↑] A[↓]');
  });
});

describe.skipIf(!DB_URL)('мост «порядок состава → порядок точек»', () => {
  /**
   * Регресс, найденный ревью уже после выката. До перехода на точки порядок печати задавала
   * позиция строки состава, и стрелки в карточке рейса переставляли именно её. После перехода
   * задание печатается по позициям **точек**, а стрелки как переписывали состав, так и
   * переписывают — то есть перестали влиять на документ. Молча: экран показывает новый порядок,
   * лист печатается в старом, и это касается даже старых одноездочных заявок.
   *
   * Мост восстанавливает обещание двери: точки раскладываются группами в порядке заявок.
   */
  it('перестановка заявок задаёт и порядок точек', async () => {
    const { shape, probed } = await assemble(
      [{ trips: [['A', 'B']] }, { trips: [['C', 'D']] }],
      async ({ tx, routeId, requestIds }) => {
        const order = await ctx.pointOrderByComposition(tx, routeId, [
          requestIds[1]!,
          requestIds[0]!,
        ]);
        if (!order) return 'отказ';
        const points = await ctx.loadRoutePoints(tx, routeId);
        const byId = new Map(points.map((p) => [p.id, p.location]));
        return order.map((id) => byId.get(id)).join(' ');
      },
    );

    expect(shape).toBe('A B C D');
    // Вторая заявка встала первой — её точки идут первыми, внутри группы порядок сохранён.
    expect(probed).toBe('C D A B');
  });

  /**
   * А вот здесь ответа не существует, и это главное в мосте. Автосборка посадила обе заявки на
   * одну погрузку `A` (Р8: «ехать дважды незачем»), и общая остановка не может стоять
   * одновременно там, где велит первая заявка, и там, где вторая. Догадка означала бы, что машина
   * поедет не тем порядком, о котором просили, и никто не заметит, — поэтому отказ.
   */
  it('общая остановка двух заявок ответа не имеет — отказ, а не догадка', async () => {
    const { probed } = await assemble(
      [{ trips: [['A', 'B']] }, { trips: [['A', 'C']] }],
      async ({ tx, routeId, requestIds }) => {
        const order = await ctx.pointOrderByComposition(tx, routeId, [
          requestIds[1]!,
          requestIds[0]!,
        ]);
        return order ? order.join(' ') : 'отказ';
      },
    );

    expect(probed).toBe('отказ');
  });
});
