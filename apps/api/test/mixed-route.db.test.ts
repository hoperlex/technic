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
 * Смешанный день машины (план `docs/route-trips-plan.md`, §11; Р5, Р5а, Р7, Р11, Р18).
 *
 * Смешанный день — это день, в котором машина и возит груз по заявкам на перевозку, и отрабатывает
 * день линейного заказа ([ADR 0100](docs/adr/0100-linear-vehicle-days.md)). Две эти работы описаны
 * в базе **разными** способами — грузовая ездкой, линейная днём строки состава, — и всё, что их
 * считает, обязано считать обе. Файл существует затем, чтобы половина дня не пропадала молча:
 * пропажа не даёт ни ошибки, ни пустого экрана, она даёт **правдоподобный** маршрут, в котором
 * просто нет одной работы, и заметить её можно только у принтера.
 *
 * Почему db-тест, а не проверка чистых функций: смешанность существует ровно в схеме. Линейный
 * день и ездка сходятся в одной таблице `vehicle_route_point_trips` под тремя составными ключами,
 * ёмкость считается запросом по составу, а перенос рейса тянет день `ON UPDATE CASCADE` — то есть
 * работой базы, а не кода. На моках ни одно из этого не воспроизводится.
 *
 * Сервисный уровень, а не `app.inject`: сборка дня от того, чьими руками заявка попала в рейс, не
 * зависит, а дверь портала проверена своими тестами.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_gate2 \
 *     pnpm --filter @technic/api test mixed-route --no-file-parallelism
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

type Tx = Parameters<Parameters<typeof AppDb.transaction>[0]>[0];

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  placeRequestTrips: (typeof import('../src/services/route-points'))['placeRequestTrips'];
  placeLinearDay: (typeof import('../src/services/route-points'))['placeLinearDay'];
  loadRoutePoints: (typeof import('../src/services/route-points'))['loadRoutePoints'];
  routeTaskRefs: (typeof import('../src/services/route-points'))['routeTaskRefs'];
  assertRouteCapacity: (typeof import('../src/services/route-points'))['assertRouteCapacity'];
  moveRouteToDate: (typeof import('../src/services/vehicle-routes'))['moveRouteToDate'];
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
  const routes = await import('../src/services/vehicle-routes');
  ctx = {
    db,
    closeDb,
    placeRequestTrips: points.placeRequestTrips,
    placeLinearDay: points.placeLinearDay,
    loadRoutePoints: points.loadRoutePoints,
    routeTaskRefs: points.routeTaskRefs,
    assertRouteCapacity: points.assertRouteCapacity,
    moveRouteToDate: routes.moveRouteToDate,
  };
}, 120_000);

afterAll(async () => {
  await ctx?.closeDb();
});

/**
 * Телефоны концов ездок и площадки линейного заказа — **разные**: тождество точки считается по
 * адресу и набору ответственных (Р9), и общий на всех телефон склеил бы то, что тест как раз
 * различает.
 */
const TRIP_PHONE = '9990000777';
const SITE_PHONE = '9990000123';

/** Время подачи грузовой заявки и своё время первой ездки: за ними едет перенос рейса (Р18). */
const REQUEST_TIME = '08:30';
const TRIP_TIME = '09:15';

/** Далёкое будущее: рейсы сцены не должны попадаться на глаза отборам соседних файлов. */
const BASE_OFFSET = 700;

/** Что заведено в сцене смешанного дня. */
interface Scene {
  tx: Tx;
  /** Рейс дня, в котором сходятся грузовые ездки и линейный день. */
  routeId: string;
  routeDate: string;
  /** Грузовая заявка: её ездки заведены `addTrip`. */
  freightId: string;
  /** Линейный заказ: его срок покрывает день рейса и несколько следующих. */
  linearId: string;
  /** Площадка линейного заказа — тем же видом, каким её склеивает `placeLinearDay` («имя, адрес»). */
  siteLocation: string;
  /** Ездка грузовой заявки; `scheduledAt` — своё время суток, `null` — «как у заявки» (Р3). */
  addTrip: (from: string, to: string, time?: string | null) => Promise<string>;
  /** Ещё один рейс той же машины на другой день: ими проверяется линейный заказ в двух маршрутах. */
  addRoute: (offsetDays: number) => Promise<{ id: string; date: string }>;
  /** Строка состава с днём линейного заказа. Отдаёт `SQLSTATE` отказа либо `null`. */
  standDay: (routeId: string, workDate: string, position?: number) => Promise<string | null>;
  /** Строка состава грузовой заявки — без дня. Отдаёт `SQLSTATE` отказа либо `null`. */
  standFreight: (routeId: string, position?: number) => Promise<string | null>;
  /** Точки маршрута строкой: «адрес[роли]», роли — `↑` погрузка, `↓` разгрузка, `⚙` линейный день. */
  shapeOf: (routeId: string) => Promise<string>;
}

/**
 * Собирает смешанный день и отдаёт его сцену.
 *
 * Всё внутри одной транзакции, которая **всегда откатывается**: база у db-тестов общая, и
 * оставленный за собой рейс с заявками испортил бы соседние файлы, половина которых берёт из
 * справочников «первую попавшуюся» запись.
 */
async function inMixedDay<T>(run: (scene: Scene) => Promise<T>): Promise<T> {
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
      const vt = await one<{ id: string }>(sql`SELECT id FROM vehicle_types LIMIT 1`);
      // Объект с непустым именем: из «имя, адрес» и складывается адрес точки линейного дня, а
      // точка без адреса не заводится вовсе (CHECK `location_not_blank`).
      const obj = await one<{ id: string; name: string; address: string | null }>(
        sql`SELECT id, name, address FROM construction_objects WHERE btrim(name) <> '' LIMIT 1`,
      );

      const addRoute = async (offsetDays: number) => {
        const row = await one<{ id: string; route_date: string }>(sql`
          INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, created_by)
          VALUES (${veh.id}, CURRENT_DATE + (${BASE_OFFSET + offsetDays})::int, 'freight', ${user.id})
          RETURNING id, route_date::text AS route_date`);
        return { id: row.id, date: row.route_date };
      };

      const route = await addRoute(0);

      const freight = await one<{ id: string }>(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
        VALUES ('freight_transport', ${obj.id}, ${vt.id}, 'confirmed', ${user.id}) RETURNING id`);
      await tx.execute(sql`
        INSERT INTO freight_transport_request_details (request_id, scheduled_at)
        VALUES (${freight.id}, (${`${route.date}T${REQUEST_TIME}:00+03:00`})::timestamptz)`);

      const linear = await one<{ id: string }>(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
        VALUES ('special_equipment', ${obj.id}, ${vt.id}, 'confirmed', ${user.id}) RETURNING id`);
      // Срок заказа с запасом вперёд: перенос рейса на другую дату упирается в него первым
      // (`assertLinearDaysMovable`), и тесной рамкой мы проверяли бы срок, а не перенос.
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details
          (request_id, date_from, date_to, responsible_name, responsible_phone)
        VALUES (${linear.id}, ${route.date}::date, ${route.date}::date + 5,
                'Прораб площадки', ${SITE_PHONE})`);

      await tx.execute(sql`
        INSERT INTO vehicle_route_requests (route_id, request_id, position)
        VALUES (${route.id}, ${freight.id}, 1)`);

      let num = 0;
      const addTrip = async (from: string, to: string, time: string | null = null) => {
        num += 1;
        const row = await one<{ id: string }>(sql`
          INSERT INTO vehicle_request_trips (request_id, num, from_location, to_location,
            from_responsible_name, from_responsible_phone,
            to_responsible_name, to_responsible_phone, scheduled_at)
          VALUES (${freight.id}, ${num}, ${from}, ${to}, 'Отв', ${TRIP_PHONE}, 'Отв', ${TRIP_PHONE},
            ${time === null ? null : `${route.date}T${time}:00+03:00`}::timestamptz)
          RETURNING id`);
        return row.id;
      };

      let savepoint = 0;
      /**
       * Ответ базы на попытку поставить строку состава: код ошибки либо `null`, если строка встала.
       *
       * Каждая попытка идёт под своей точкой сохранения. Без неё первый же отказ обрывает
       * транзакцию целиком, и следующий запрос получает не свой код, а `25P02` «транзакция в
       * состоянии ошибки» — то есть тест проверял бы не тот индекс, который называет, а факт
       * предыдущего отказа.
       */
      const stand = async (query: Parameters<typeof tx.execute>[0]) => {
        const name = `stand_${(savepoint += 1)}`;
        await tx.execute(sql.raw(`SAVEPOINT ${name}`));
        try {
          await tx.execute(query);
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
          return null;
        } catch (e) {
          await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
          // Drizzle заворачивает ошибку драйвера: код `SQLSTATE` лежит в причине, а не на верхнем
          // уровне. Без разбора причины тест сравнивал бы с 'unknown' и проходил бы на любом
          // отказе — в том числе на «нет колонки», то есть проверял бы опечатку, а не индекс.
          const cause = (e as { cause?: { code?: string } }).cause;
          return cause?.code ?? (e as { code?: string }).code ?? 'unknown';
        }
      };
      const standDay = (routeId: string, workDate: string, position = 2) =>
        stand(sql`
          INSERT INTO vehicle_route_requests (route_id, request_id, position, work_date)
          VALUES (${routeId}, ${linear.id}, ${position}, ${workDate}::date)`);
      const standFreight = (routeId: string, position = 1) =>
        stand(sql`
          INSERT INTO vehicle_route_requests (route_id, request_id, position)
          VALUES (${routeId}, ${freight.id}, ${position})`);

      const shapeOf = async (routeId: string) => {
        const points = await ctx.loadRoutePoints(tx, routeId);
        return points
          .map(
            (point) =>
              `${point.location}[${point.actions
                .map((a) => (a.role === 'load' ? '↑' : a.role === 'unload' ? '↓' : '⚙'))
                .join('')}]`,
          )
          .join(' ');
      };

      out = await run({
        tx,
        routeId: route.id,
        routeDate: route.date,
        freightId: freight.id,
        linearId: linear.id,
        siteLocation: [obj.name, obj.address].filter(Boolean).join(', '),
        addTrip,
        addRoute,
        standDay,
        standFreight,
        shapeOf,
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

describe.skipIf(!DB_URL)('смешанный день: две ездки и линейный день', () => {
  /**
   * Главное утверждение Р5а: у дня линейного заказа нет «откуда — куда» — машина приезжает на
   * площадку и работает там, — поэтому он и есть **одна** точка, а не пара.
   *
   * И встаёт эта точка в **общий** порядок объезда, а не рядом с ним: водитель читает один список
   * остановок, и день, показанный отдельной строкой сбоку, означал бы, что порядок объезда
   * машины никто не задал.
   */
  it('линейный день занимает одну точку и встаёт в общий порядок объезда', async () => {
    const { shape, site } = await inMixedDay(async (s) => {
      await s.addTrip('Карьер Сычёво', 'Объект Заря');
      await s.addTrip('Карьер Сычёво', 'Объект Восток');
      await ctx.placeRequestTrips(s.tx, s.routeId, s.freightId);
      await s.standDay(s.routeId, s.routeDate);
      await ctx.placeLinearDay(s.tx, s.routeId, s.linearId, s.routeDate);
      return { shape: await s.shapeOf(s.routeId), site: s.siteLocation };
    });

    // Две погрузки на одной точке (Р8: «грузимся в карьере один раз для двух ездок»), две
    // разгрузки и одна работа — четвёртой остановкой того же объезда.
    expect(shape).toBe(`Карьер Сычёво[↑↑] Объект Заря[↓] Объект Восток[↓] ${site}[⚙]`);
  });

  /**
   * Строка задания и строка состава — разные вещи, и Р11 требует считать первые.
   *
   * У смешанного дня разница видна прямо: строк состава две (грузовая заявка и линейный заказ), а
   * задания — три (две ездки и день). Счёт по составу не заметил бы половину дня: заявка с тремя
   * ездками занимает в бланке три строки, а в составе одну.
   */
  it('строк задания три, а строк состава две', async () => {
    const { refs, composition } = await inMixedDay(async (s) => {
      await s.addTrip('Карьер Сычёво', 'Объект Заря');
      await s.addTrip('Карьер Сычёво', 'Объект Восток');
      await ctx.placeRequestTrips(s.tx, s.routeId, s.freightId);
      await s.standDay(s.routeId, s.routeDate);
      await ctx.placeLinearDay(s.tx, s.routeId, s.linearId, s.routeDate);

      const rows = await ctx.routeTaskRefs(s.tx, s.routeId);
      const [count] = (
        await s.tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM vehicle_route_requests WHERE route_id = ${s.routeId}`,
        )
      ).rows;
      return { refs: rows.map((r) => r.kind), composition: Number(count!.n) };
    });

    expect(refs).toEqual(['freight', 'freight', 'linear']);
    expect(composition).toBe(2);
  });

  /**
   * И считает их **ёмкость бланка** — то есть счёт не остаётся внутренним делом выборки.
   *
   * Проверяется границей: семь ездок в 4-П укладываются ровно (ADR 0068), а тот же рейс с
   * добавленным линейным днём — нет. Если бы ёмкость считала строки состава, отказа не случилось
   * бы никогда: их здесь две, а мест семь, — и в бланк уехало бы восемь работ на семь строк.
   */
  it('ёмкость 4-П считает строки задания: линейный день переполняет семь ездок', async () => {
    const { full, overflow } = await inMixedDay(async (s) => {
      for (let i = 0; i < 7; i += 1) await s.addTrip('Карьер Сычёво', 'Объект Заря');
      await ctx.placeRequestTrips(s.tx, s.routeId, s.freightId);
      const full = await capacityRefusal(s.tx, s.routeId, '4p');

      await s.standDay(s.routeId, s.routeDate);
      await ctx.placeLinearDay(s.tx, s.routeId, s.linearId, s.routeDate);
      return { full, overflow: await capacityRefusal(s.tx, s.routeId, '4p') };
    });

    expect(full).toBeNull();
    // Число в сообщении и есть ответ счётчика: восемь, а не две.
    expect(overflow).toContain('в маршруте их 8');
  });
});

describe.skipIf(!DB_URL)('линейный заказ в двух рейсах разных дней', () => {
  /**
   * Р7 у линейного заказа звучит иначе, чем у грузового: «заявка едет одним маршрутом» превращается
   * в «в один день — ровно один рейс». Держат это два **частичных** индекса
   * `vehicle_route_requests` (миграция 0127), и проверяются здесь оба разом — порознь каждый
   * пропускает то, что ловит второй.
   *
   * Без этого месячный заказ техники был бы неописуем: тридцать дней работы — это тридцать рейсов,
   * и запрет «заявка в одном маршруте» запер бы её в первом же дне.
   */
  it('два дня одной заявки стоят в двух рейсах, а второй рейс того же дня — отказ', async () => {
    const { today, tomorrow, sameDayTwice, freightTwice, shapes, site } = await inMixedDay(
      async (s) => {
        const next = await s.addRoute(1);
        // Второй рейс **того же дня**: день строки равен дню рейса физически (составной FK), и
        // столкнуться два дня одной заявки могут только здесь.
        const rival = await s.addRoute(1);

        const today = await s.standDay(s.routeId, s.routeDate);
        const tomorrow = await s.standDay(next.id, next.date);
        // `..._request_day_unique`: машина не отрабатывает один и тот же день заказа дважды.
        const sameDayTwice = await s.standDay(rival.id, rival.date);
        // Зеркало — `..._request_unique`: у грузовой заявки дня нет, и «в двух рейсах сразу» ей
        // по-прежнему запрещено. Линейный заказ этой двери не открывает: у него сузилась область
        // правила, а не отменилось само правило.
        const freightTwice = await s.standFreight(next.id, 3);

        await ctx.placeLinearDay(s.tx, s.routeId, s.linearId, s.routeDate);
        await ctx.placeLinearDay(s.tx, next.id, s.linearId, next.date);
        return {
          today,
          tomorrow,
          sameDayTwice,
          freightTwice,
          site: s.siteLocation,
          shapes: [await s.shapeOf(s.routeId), await s.shapeOf(next.id)],
        };
      },
    );

    expect(today).toBeNull();
    expect(tomorrow).toBeNull();
    expect(sameDayTwice).toBe('23505');
    expect(freightTwice).toBe('23505');
    // В каждом рейсе — своя точка своей работы: день заказа лежит в строке состава, а общей точки
    // на два дня не существует.
    expect(shapes).toEqual([`${site}[⚙]`, `${site}[⚙]`]);
  });
});

describe.skipIf(!DB_URL)('перенос рейса на другую дату', () => {
  /**
   * Дата рейса и день строки состава связаны **физически**: составной FK с `ON UPDATE CASCADE`
   * (миграция 0127) переписывает `work_date` вслед за `route_date`. Проверяется это здесь потому,
   * что каскад — единственное место переноса, где код не участвует вовсе: сломайся он, портал
   * показал бы рейс на новой дате с работой, приписанной старой, и никакой сервер об этом не
   * узнал бы.
   *
   * Точки при этом не двигаются, и это не мелочь: объезд собирал человек, а перенесли день, а не
   * маршрут (ADR 0082). Пересобранный на новой дате порядок означал бы, что диспетчер потерял свою
   * работу за одно нажатие.
   */
  it('work_date едет каскадом, а точки остаются на своих местах', async () => {
    const { before, after, dayBefore, dayAfter, routeDate } = await inMixedDay(async (s) => {
      await s.addTrip('Карьер Сычёво', 'Объект Заря');
      await s.addTrip('Карьер Сычёво', 'Объект Восток');
      await ctx.placeRequestTrips(s.tx, s.routeId, s.freightId);
      await s.standDay(s.routeId, s.routeDate);
      await ctx.placeLinearDay(s.tx, s.routeId, s.linearId, s.routeDate);

      const snapshot = async () =>
        (
          await s.tx.execute<{ id: string; position: number; location: string }>(sql`
            SELECT id::text, position, location FROM vehicle_route_points
            WHERE route_id = ${s.routeId} ORDER BY position`)
        ).rows.map((r) => `${r.position}:${r.location}`);
      const dayOf = async () =>
        (
          await s.tx.execute<{ work_date: string | null }>(sql`
            SELECT work_date::text AS work_date FROM vehicle_route_requests
            WHERE route_id = ${s.routeId} AND request_id = ${s.linearId}`)
        ).rows[0]?.work_date ?? null;

      const before = await snapshot();
      const dayBefore = await dayOf();
      const moveTo = (
        await s.tx.execute<{ d: string }>(sql`SELECT (${s.routeDate}::date + 1)::text AS d`)
      ).rows[0]!.d;
      await ctx.moveRouteToDate(s.tx, s.routeId, moveTo);

      const [row] = (
        await s.tx.execute<{ d: string }>(
          sql`SELECT route_date::text AS d FROM vehicle_routes WHERE id = ${s.routeId}`,
        )
      ).rows;
      return {
        before,
        after: await snapshot(),
        dayBefore,
        dayAfter: await dayOf(),
        routeDate: { moveTo, stored: row!.d },
      };
    });

    expect(routeDate.stored).toBe(routeDate.moveTo);
    expect(dayAfter).toBe(routeDate.moveTo);
    expect(dayAfter).not.toBe(dayBefore);
    expect(after).toEqual(before);
  });

  /**
   * Подача заявки едет вместе с рейсом, сохраняя **время суток** (ADR 0082): переносят день, а не
   * час подачи. Иначе рейс уехал бы на завтра, а бумага напечатала бы работу, которой в этот день
   * никто не заказывал.
   */
  it('подача грузовой заявки встаёт на новый день тем же часом', async () => {
    const { moveTo, scheduled } = await inMixedDay(async (s) => {
      await s.addTrip('Карьер Сычёво', 'Объект Заря');
      await ctx.placeRequestTrips(s.tx, s.routeId, s.freightId);
      await s.standDay(s.routeId, s.routeDate);
      await ctx.placeLinearDay(s.tx, s.routeId, s.linearId, s.routeDate);

      const moveTo = (
        await s.tx.execute<{ d: string }>(sql`SELECT (${s.routeDate}::date + 1)::text AS d`)
      ).rows[0]!.d;
      await ctx.moveRouteToDate(s.tx, s.routeId, moveTo);

      const [row] = (
        await s.tx.execute<{ at: string }>(sql`
          SELECT to_char(scheduled_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS at
          FROM freight_transport_request_details WHERE request_id = ${s.freightId}`)
      ).rows;
      return { moveTo, scheduled: row!.at };
    });

    expect(scheduled).toBe(`${moveTo} ${REQUEST_TIME}`);
  });

  /**
   * И **своё время ездки** (Р3) обязано ехать тем же сдвигом — Р18 говорит об этом прямо: «иначе
   * рейс переехал на 13-е, а ездка осталась „на 12-е, 08:30“, и портал показывал бы задание не того
   * дня». Правило там же: сдвиг один на заявку и все её ездки, а ездка без своего времени не
   * трогается вовсе — у неё время заявки. Тем же обещанием живёт и `tripsOutOfRequestDay`: её
   * доккомментарий называет перенос рейса (ADR 0082) одним из двух серверных мест, откуда её
   * зовут.
   *
   * **Этот случай сейчас красный, и подгонять его нельзя.** `moveRouteToDate`
   * (`src/services/vehicle-routes.ts`) переписывает `scheduled_at` только у
   * `freight_transport_request_details` — ездки он не трогает вовсе, и `tripsOutOfRequestDay` с
   * пути переноса не зовётся никем. Последствие не косметическое: календарный день ездки обязан
   * совпадать с днём заявки, и заявка, у которой ездка осталась во вчера, перестаёт
   * **сохраняться** — следующая же правка получит 422 на поле, которого человек не трогал, а
   * задание кабинета водителя покажет ездку не того дня.
   *
   * Ожидание здесь записано таким, каким его требует план: тест обязан гаснуть тогда, когда сдвиг
   * ездок появится в `moveRouteToDate`, а не тогда, когда его перепишут под нынешний код.
   */
  it('своё время ездки едет тем же сдвигом, а ездка без своего времени не трогается', async () => {
    const { moveTo, withTime, withoutTime } = await inMixedDay(async (s) => {
      const timed = await s.addTrip('Карьер Сычёво', 'Объект Заря', TRIP_TIME);
      const untimed = await s.addTrip('Карьер Сычёво', 'Объект Восток', null);
      await ctx.placeRequestTrips(s.tx, s.routeId, s.freightId);
      await s.standDay(s.routeId, s.routeDate);
      await ctx.placeLinearDay(s.tx, s.routeId, s.linearId, s.routeDate);

      const moveTo = (
        await s.tx.execute<{ d: string }>(sql`SELECT (${s.routeDate}::date + 1)::text AS d`)
      ).rows[0]!.d;
      await ctx.moveRouteToDate(s.tx, s.routeId, moveTo);

      const timeOf = async (tripId: string) =>
        (
          await s.tx.execute<{ at: string | null }>(sql`
            SELECT to_char(scheduled_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS at
            FROM vehicle_request_trips WHERE id = ${tripId}`)
        ).rows[0]?.at ?? null;
      return { moveTo, withTime: await timeOf(timed), withoutTime: await timeOf(untimed) };
    });

    expect(withTime).toBe(`${moveTo} ${TRIP_TIME}`);
    expect(withoutTime).toBeNull();
  });
});
