import { buildMigrationClient } from '../src/db/migration-client';

/**
 * Верификатор переноса на ездки и точки маршрута — объявленная проверка релиза `0136_route_trips`
 * (протокол выката `docs/schema-cutover-protocol.md`, §3 шаг 6; объявлен в
 * `apps/api/teardown/0136_route_trips.sql.verify`).
 *
 * Выполняется образом кандидата сразу после наката миграции и ДО записи границы floor: пока код
 * возвращает ненулевой код, сервисы остаются лежать, состояние `migrated`, откат ещё возможен.
 * Поэтому проверка обязана быть fail-closed и не зависеть ни от чего, кроме базы: ни конфига
 * приложения, ни секретов, ни поднятого сервера в этот момент нет. Отсюда и подключение —
 * `buildMigrationClient()`, тот же, которым ходят раннер миграций и `db:cutover-down`.
 *
 * ЧИТАЕТ И ТОЛЬКО ЧИТАЕТ. Единственный режим — `--check`, и он обязателен: переносит данные сама
 * миграция, в своей транзакции и со своими предохранителями, а «дозалить недостающее» после неё
 * значило бы чинить схему командой, у которой нет ни блокировок выката, ни границы. Флаг оставлен
 * в имени ради читаемости команды в `.verify` и одинаковости с `backfill:routes --check`.
 *
 * Проверяются инварианты, которых схема не выражает, — те самые, которые план оставил серверу
 * (`docs/route-trips-plan.md`, Р5, Р5а, Р6, Р7, Р13, Р13а, Р20, §5.3). Составные ключи, CHECK'и и
 * частичные индексы миграции здесь не перепроверяются: они держатся физически, и запрос к ним был
 * бы проверкой PostgreSQL, а не данных.
 *
 * Использование: pnpm --silent --filter @technic/api backfill:trips --check
 */

const EXIT_FAILURE = 1;
/** Сколько нарушений печатать по каждому пункту: список бывает длинным, а чинят их по одному. */
const SAMPLE_LIMIT = 10;

interface Invariant {
  /** Что нарушено — формулировкой, из которой понятно, куда идти. */
  title: string;
  /** Запрос обязан отдавать колонку `label`: одна строка — одно нарушение, готовым текстом. */
  sql: string;
}

const INVARIANTS: Invariant[] = [
  {
    title: 'Заявка на грузоперевозку без единой живой ездки — заявка без адресов и количества',
    sql: `
      SELECT 'ТС-' || r.num AS label
      FROM vehicle_requests r
      WHERE r.request_type = 'freight_transport'
        AND NOT EXISTS (
          SELECT 1 FROM vehicle_request_trips t
          WHERE t.request_id = r.id AND t.deleted_at IS NULL
        )
      ORDER BY r.num`,
  },
  {
    title: 'Ездка у заявки, которая не грузоперевозка: у заказа техники на объект ездок не бывает',
    sql: `
      SELECT 'ТС-' || r.num || '/' || t.num AS label
      FROM vehicle_request_trips t
      JOIN vehicle_requests r ON r.id = t.request_id
      WHERE r.request_type <> 'freight_transport'
      ORDER BY r.num, t.num`,
  },
  {
    /*
     * §5.3: соответствие роли виду строки состава база не держит — третий составной ключ смотрит
     * только на пару «маршрут + заявка», а копию `work_date` в связку мы отвергли (она разошлась
     * бы с составом при переносе рейса). Значит это ровно тот инвариант, который проверять здесь.
     */
    title:
      'Роль не того вида, что строка состава: `work` у грузовой строки либо `load`/`unload` у линейного дня',
    sql: `
      SELECT 'Р-' || v.num || ', ТС-' || r.num || ', роль ' || pt.role
        || CASE WHEN rr.work_date IS NULL THEN ' у грузовой строки' ELSE ' у дня ' || rr.work_date END AS label
      FROM vehicle_route_point_trips pt
      JOIN vehicle_route_requests rr
        ON rr.route_id = pt.route_id AND rr.request_id = pt.request_id
      JOIN vehicle_routes v ON v.id = pt.route_id
      JOIN vehicle_requests r ON r.id = pt.request_id
      WHERE (pt.role = 'work') <> (rr.work_date IS NOT NULL)
      ORDER BY v.num, r.num`,
  },
  {
    title: 'Ездка в маршруте без пары: погрузка есть, разгрузки нет (или наоборот) — Р5',
    sql: `
      SELECT 'Р-' || v.num || ', ТС-' || r.num || '/' || t.num
        || ': роли ' || string_agg(pt.role, ' + ' ORDER BY pt.role) AS label
      FROM vehicle_route_point_trips pt
      JOIN vehicle_request_trips t ON t.id = pt.trip_id
      JOIN vehicle_requests r ON r.id = t.request_id
      JOIN vehicle_routes v ON v.id = pt.route_id
      WHERE pt.trip_id IS NOT NULL
      GROUP BY v.num, r.num, t.num, pt.trip_id
      HAVING count(*) <> 2
      ORDER BY v.num, r.num, t.num`,
  },
  {
    /*
     * Р6: сравнение двух строк, CHECK'ом не выражается. Держит его сервер при каждой правке
     * порядка и состава точек — и именно поэтому проверяется здесь: правило, живущее в коде,
     * ломается тихо.
     */
    title: 'Ездка разгружается раньше, чем грузится — Р6',
    sql: `
      SELECT 'Р-' || v.num || ', ТС-' || r.num || '/' || t.num
        || ': погрузка на позиции ' || lp.position || ', разгрузка на ' || up.position AS label
      FROM vehicle_route_point_trips l
      JOIN vehicle_route_point_trips u ON u.trip_id = l.trip_id AND u.role = 'unload'
      JOIN vehicle_route_points lp ON lp.id = l.point_id
      JOIN vehicle_route_points up ON up.id = u.point_id
      JOIN vehicle_request_trips t ON t.id = l.trip_id
      JOIN vehicle_requests r ON r.id = t.request_id
      JOIN vehicle_routes v ON v.id = l.route_id
      WHERE l.role = 'load' AND lp.position >= up.position
      ORDER BY v.num, r.num, t.num`,
  },
  {
    title: 'Точка маршрута без единой роли: остановка без задания в бланк не идёт — Р13',
    sql: `
      SELECT 'Р-' || v.num || ', позиция ' || p.position || ': ' || p.location AS label
      FROM vehicle_route_points p
      JOIN vehicle_routes v ON v.id = p.route_id
      WHERE NOT EXISTS (
        SELECT 1 FROM vehicle_route_point_trips pt WHERE pt.point_id = p.id
      )
      ORDER BY v.num, p.position`,
  },
  {
    title:
      'Позиции точек маршрута не сплошные 1..N: после удаления точки порядок уплотняется — Р13',
    sql: `
      SELECT 'Р-' || v.num || ': точек ' || count(*) || ', позиции до ' || max(p.position) AS label
      FROM vehicle_route_points p
      JOIN vehicle_routes v ON v.id = p.route_id
      GROUP BY v.num, p.route_id
      HAVING max(p.position) <> count(*) OR min(p.position) <> 1
      ORDER BY v.num`,
  },
  {
    /*
     * Р7: грузовая заявка едет одним маршрутом ЦЕЛИКОМ — ни одной ездки или все. «Часть сегодня,
     * часть завтра» потребовало бы заявке двух маршрутов, а недовезённое оформляется новой
     * заявкой. Схема этого не выражает: она знает про строку состава, но не про число ездок.
     */
    title: 'Заявка в составе маршрута разложена не целиком: в рейсе не все её живые ездки — Р7',
    sql: `
      SELECT 'Р-' || v.num || ', ТС-' || r.num || ': разложено ' || (
          SELECT count(DISTINCT pt.trip_id) FROM vehicle_route_point_trips pt
          WHERE pt.route_id = rr.route_id AND pt.request_id = rr.request_id
        ) || ' из ' || (
          SELECT count(*) FROM vehicle_request_trips t
          WHERE t.request_id = rr.request_id AND t.deleted_at IS NULL
        ) || ' ездок' AS label
      FROM vehicle_route_requests rr
      JOIN vehicle_routes v ON v.id = rr.route_id
      JOIN vehicle_requests r ON r.id = rr.request_id
      WHERE rr.work_date IS NULL
        AND (
          SELECT count(DISTINCT pt.trip_id) FROM vehicle_route_point_trips pt
          WHERE pt.route_id = rr.route_id AND pt.request_id = rr.request_id
        ) <> (
          SELECT count(*) FROM vehicle_request_trips t
          WHERE t.request_id = rr.request_id AND t.deleted_at IS NULL
        )
      ORDER BY v.num, r.num`,
  },
  {
    /*
     * Р13а: удалённая ездка не участвует в раскладке, не печатается и не считается в ёмкость —
     * но остаётся видимой из журнала листов. Значит ролей у неё быть не должно, а строка
     * `waybill_trips` — должна и остаётся.
     */
    title: 'Мягко удалённая ездка всё ещё стоит в маршруте — Р13а',
    sql: `
      SELECT 'Р-' || v.num || ', ТС-' || r.num || '/' || t.num AS label
      FROM vehicle_route_point_trips pt
      JOIN vehicle_request_trips t ON t.id = pt.trip_id
      JOIN vehicle_requests r ON r.id = t.request_id
      JOIN vehicle_routes v ON v.id = pt.route_id
      WHERE t.deleted_at IS NOT NULL
      ORDER BY v.num, r.num, t.num`,
  },
  {
    title:
      'Ездка напечатана в листе, где её заявки нет: `waybill_trips` без строки `waybill_requests` — Р20',
    sql: `
      SELECT 'лист № ' || w.number || ', ТС-' || r.num || '/' || t.num AS label
      FROM waybill_trips wt
      JOIN waybills w ON w.id = wt.waybill_id
      JOIN vehicle_request_trips t ON t.id = wt.trip_id
      JOIN vehicle_requests r ON r.id = t.request_id
      WHERE NOT EXISTS (
        SELECT 1 FROM waybill_requests wr
        WHERE wr.waybill_id = wt.waybill_id AND wr.request_id = t.request_id
      )
      ORDER BY w.number, r.num, t.num`,
  },
  {
    title:
      'Талон грузовой заявки без единой напечатанной ездки: строка задания взялась ниоткуда — Р20',
    sql: `
      SELECT 'лист № ' || w.number || ', ТС-' || r.num AS label
      FROM waybill_requests wr
      JOIN waybills w ON w.id = wr.waybill_id
      JOIN vehicle_requests r ON r.id = wr.request_id
      WHERE r.request_type = 'freight_transport'
        AND NOT EXISTS (
          SELECT 1 FROM waybill_trips wt
          JOIN vehicle_request_trips t ON t.id = wt.trip_id
          WHERE wt.waybill_id = wr.waybill_id AND t.request_id = wr.request_id
        )
      ORDER BY w.number, r.num`,
  },
  {
    /*
     * Р20: `slot` в `waybill_requests` объявлен ПЕРВОЙ строкой задания заявки — на этом стоит
     * `waybill_requests_slot_unique`, который прежняя редакция плана снимала зря. Разъехавшись,
     * две связи назвали бы разные строки одного бланка.
     */
    title: '`slot` талона не совпадает с первой строкой задания заявки в этом листе — Р20',
    sql: `
      SELECT 'лист № ' || w.number || ', ТС-' || r.num || ': талон в строке ' || wr.slot
        || ', первая ездка в строке ' || min(wt.slot) AS label
      FROM waybill_requests wr
      JOIN waybills w ON w.id = wr.waybill_id
      JOIN vehicle_requests r ON r.id = wr.request_id
      JOIN vehicle_request_trips t ON t.request_id = wr.request_id
      JOIN waybill_trips wt ON wt.trip_id = t.id AND wt.waybill_id = wr.waybill_id
      GROUP BY w.number, r.num, wr.slot
      HAVING wr.slot <> min(wt.slot)
      ORDER BY w.number, r.num`,
  },
];

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== '--check') {
    throw new Error(
      'Единственный режим — read-only проверка: pnpm --filter @technic/api backfill:trips --check. ' +
        'Перенос данных делает сама миграция 0136_route_trips.sql, в своей транзакции.',
    );
  }

  const client = buildMigrationClient();
  await client.connect();
  let broken = 0;
  try {
    for (const invariant of INVARIANTS) {
      const { rows } = await client.query<{ label: string }>(invariant.sql);
      if (rows.length === 0) {
        console.log(`✓ ${invariant.title}`);
        continue;
      }
      broken += 1;
      console.error(`✗ ${invariant.title}: ${rows.length} шт.`);
      for (const row of rows.slice(0, SAMPLE_LIMIT)) {
        console.error(`    ${row.label}`);
      }
      if (rows.length > SAMPLE_LIMIT) {
        console.error(`    … и ещё ${rows.length - SAMPLE_LIMIT}`);
      }
    }
  } finally {
    await client.end();
  }

  if (broken > 0) {
    /*
     * Ненулевой код — не косметика: на шаге 6 протокола он оставляет сервисы лежащими, состояние
     * `migrated` и откат возможным. Молчаливое «ну почти» здесь стоило бы границы невозврата.
     */
    console.error(`\nНарушено инвариантов: ${broken} из ${INVARIANTS.length}.`);
    process.exit(EXIT_FAILURE);
  }
  console.log(`\nВсе инварианты соблюдены (${INVARIANTS.length} проверок).`);
}

main().catch((e) => {
  console.error('Ошибка проверки ездок:', e instanceof Error ? e.message : e);
  process.exit(EXIT_FAILURE);
});
