import { sql, type SQL } from 'drizzle-orm';
import {
  analyticsCountsAsFact,
  formatVehicleRequestNumber,
  REQUEST_STATUSES,
  shiftDaysOf,
  vehicleOptionLabel,
  type AnalyticsCustomerKind,
  type AnalyticsQualityEntry,
  type RequestStatus,
  type VehicleOwnership,
} from '@technic/contracts';
import { db } from '../../db/client';
import { requestDayVehicleSql } from '../assignment-read';
import {
  NO_VEHICLE_POSITION_KEY,
  type AnalyticsAtom,
  type AnalyticsFacts,
  type AnalyticsRange,
} from './types';

/**
 * Атомы заказа техники: перевозки (`freight`) и работа на площадке (`onsite`) — план
 * `docs/analytics-summary-export-plan.md`, Р6–Р11, Р13, Р15, Р27, Р28, Р29.
 *
 * ОДИН МОДУЛЬ НА ДВА РАЗРЯДА, И ЭТО НЕ ЭКОНОМИЯ ФАЙЛА. Заказ техники — одна таблица заявок с одним
 * правилом заказчика, одним назначением и одним закрытием; разрежь его на два загрузчика, и правило
 * денег («у заявки одна сумма, а атомов много») пришлось бы написать дважды. Разряда при этом два,
 * потому что меряются они разным: перевозка — днём рейса и ездками, площадка — строкой смены и
 * моточасами (`ANALYTICS_MODULES`, контракты).
 *
 * ЧТО ЗДЕСЬ ПЕРЕИСПОЛЬЗОВАНО, А НЕ НАПИСАНО ЗАНОВО:
 *
 * - «какая машина стояла на заявке в этот день» — `requestDayVehicleSql` (Р8). Текущая строка
 *   назначения врёт про прошлое: у заказа, где технику меняли внутри срока, в ней стоит последняя
 *   машина, и январская смена уехала бы в мартовскую позицию;
 * - «дни срока заказа» — `shiftDaysOf` контрактов (Р7, Р29): второй ответ на «сколько дней в
 *   заказе» разошёлся бы с таблицей смен карточки на первом же однодневном заказе (пустая
 *   `date_to`). SQL при этом тоже разворачивает срок в дни (`generate_series`), но отвечает он на
 *   другой вопрос — «какая машина стояла в этот день», — а СОСТАВ дней берётся только у контрактов:
 *   день, которого нет в `shiftDaysOf`, атомом не становится;
 * - «чьи деньги считаются фактом» — `analyticsCountsAsFact` (Р10);
 * - подпись машины — `vehicleOptionLabel` («А123БВ797 — КамАЗ 65115», ADR 0098);
 * - позиция «техника не назначена» — `NO_VEHICLE_POSITION_KEY`: счётчик единиц техники обязан
 *   уметь её исключать, а свой литерал в каждом загрузчике исключался бы только в одном из них.
 *
 * ЗАПРОСОВ ДВА, ПО ОДНОМУ НА РАЗРЯД (Р15). Всё остальное — разбор строк и раскладка денег — идёт
 * в памяти: запрос в цикле по объектам или заявкам здесь недопустим, книга сводит год работы трёх
 * модулей сразу. Стиль запросов — сырой текст с CTE через `db.execute`, как в `readings-aggregate.ts`
 * и `readings-intake.ts`; цена приёма та же: `numeric` приходит строками, и разбирает их `num`.
 *
 * ОБА ЗАПРОСА ЧИТАЮТ ШИРЕ ПЕРИОДА, И ЭТО НЕ ЛИШНЯЯ РАБОТА, А ЗНАМЕНАТЕЛЬ (Р28). Сумма заявки
 * делится между ВСЕМИ днями её работы, а период забирает свою долю; знай запрос только дни внутри
 * периода, заказ, начатый в июле и закрытый в августе, отдал бы полную сумму обоим запросам — и два
 * соседних отчёта в сумме оказались бы больше годового. Поэтому дни отбираются по заявкам, попавшим
 * в период, а не по датам, и каждая строка помечена `in_period`: атомы рождают только помеченные.
 *
 * ЗНАМЕНАТЕЛЬ ЖИВОЙ ТОЛЬКО У ПЛОЩАДКИ, И ЭТО НАДО ЗНАТЬ, ЧИТАЯ ПЕРЕВОЗКИ. У грузовой заявки дней
 * работы сегодня ровно один: `vehicle_route_requests_request_unique` (частичный уникальный индекс
 * `WHERE work_date IS NULL`, миграция 0127) держит её ровно в одном рейсе, а заявка без рейса
 * отвечает единственным днём подачи. Значит раскладка перевозки — не защита, а заготовка: сумма
 * делится на один день и приходит целиком. Туда же, на единственный атом периода, ложатся ездки,
 * объём и масса — знаменателя у них нет вовсе. Заготовка оживёт, если тот самый UNIQUE ослабят
 * (линейные дни уже стоят в стольких рейсах, сколько дней распланировано), и тогда деньги
 * разделятся сами, а вот ездки придётся делить руками: молча удвоить объём они умеют уже сейчас.
 */

/** Московские сутки: сервер живёт в UTC, а календарный день портала — МСК (`moscowDateKeyOf`). */
const MOSCOW = 'Europe/Moscow';

/**
 * Дошла ли заявка до РАБОТЫ. «Новая» — ещё не заказ: её подтверждают, переносят и отменяют, и срок
 * у неё намерение, а не план работ (Р7 говорит «дни срока ЗАКАЗА»). Считать её днями план значило
 * бы завести строку свода площадке, где работы не было (Р25), и занизить долю заполненных смен на
 * листе «Качество» заявками, которых никто не подтверждал.
 *
 * Словарь ПОЛНЫЙ, а не `filter` по паре исключений: добавь цикл заявки новый статус — и запись
 * здесь потребуется прежде, чем файл соберётся. Умолчание же отнесло бы незнакомый статус к работе
 * (или к её отсутствию) молча, и узнали бы об этом по цифре в книге.
 */
const STATUS_IS_WORK: Record<RequestStatus, boolean> = {
  new: false,
  confirmed: true,
  done: true,
  completed: true,
  cancelled: false,
};

const WORK_STATUSES = REQUEST_STATUSES.filter((status) => STATUS_IS_WORK[status]);

// ── Разбор строк ──

/** Число из `numeric`: драйвер отдаёт его строкой, и `null` обязан остаться `null`. */
function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** Деньги округляются до копейки: иначе раскладка по дням даёт хвост в пятнадцатом знаке. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ── Общие куски запросов ──

/**
 * Заказчик заявки: объект **или** отдел, ровно один (CHECK `vehicle_requests_customer_check`).
 * `coalesce` здесь безопасен именно поэтому — второго непустого значения не бывает по схеме.
 */
const CUSTOMER_COLUMNS = sql`
       CASE WHEN q.object_id IS NOT NULL THEN 'object' ELSE 'department' END AS customer_kind,
       coalesce(q.object_id, q.department_id)                                AS customer_id,
       coalesce(o.code, d.code)                                              AS customer_code,
       coalesce(o.name, d.name)                                              AS customer_name,
       coalesce(o.is_active, d.is_active)                                    AS customer_is_active`;

const CUSTOMER_JOINS = sql`
  LEFT JOIN construction_objects o ON o.id = q.object_id
  LEFT JOIN departments d          ON d.id = q.department_id`;

/** Реквизиты позиции-машины: ровно те, из которых `vehicleOptionLabel` собирает подпись. */
const VEHICLE_COLUMNS = sql`
       v.id                    AS vehicle_id,
       v.ownership::text       AS ownership,
       v.description           AS description,
       v.registration_number   AS registration_number,
       vt.name                 AS type_name,
       vc.name                 AS category_name,
       vm.name                 AS model_name,
       cp.name                 AS lessor_name`;

function vehicleJoins(vehicleId: SQL): SQL {
  return sql`
  LEFT JOIN vehicles v            ON v.id = ${vehicleId}
  LEFT JOIN vehicle_types vt      ON vt.id = v.vehicle_type_id
  LEFT JOIN vehicle_categories vc ON vc.id = v.vehicle_category_id
  LEFT JOIN vehicle_models vm     ON vm.id = v.vehicle_model_id
  LEFT JOIN counterparties cp     ON cp.id = v.lessor_id`;
}

/**
 * Цена назначения и факт закрытия — на каждой строке разряда. Заявка отдаёт их атому целиком, а
 * делит между днями уже разбор (Р28): в SQL деление потребовало бы второго прохода по тем же
 * строкам ради знаменателя.
 */
const MONEY_COLUMNS = sql`
       asg.price_per_shift AS price_per_shift,
       asg.price_per_hour  AS price_per_hour,
       asg.shift_hours     AS shift_hours,
       comp.total_cost     AS total_cost`;

const MONEY_JOINS = sql`
  LEFT JOIN vehicle_request_assignments asg  ON asg.request_id = q.id
  LEFT JOIN vehicle_request_completions comp ON comp.request_id = q.id`;

/** Заявка не отменена и не удалена — условие всех выборок разом (Р10). */
const LIVE_REQUEST = sql`q.deleted_at IS NULL AND q.status <> 'cancelled'`;

// ── Строки ответа ──

type CustomerColumns = {
  customer_kind: AnalyticsCustomerKind;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  customer_is_active: boolean;
};

type VehicleColumns = {
  vehicle_id: string | null;
  ownership: VehicleOwnership | null;
  description: string | null;
  registration_number: string | null;
  type_name: string | null;
  category_name: string | null;
  model_name: string | null;
  lessor_name: string | null;
};

type MoneyColumns = {
  price_per_shift: string | null;
  price_per_hour: string | null;
  shift_hours: number | null;
  total_cost: string | null;
};

type RequestColumns = {
  request_id: string;
  num: number;
  status: RequestStatus;
};

type FreightRow = CustomerColumns &
  VehicleColumns &
  MoneyColumns &
  RequestColumns & {
    date: string;
    in_period: boolean;
    /** День взят у рейса. Ложь — рейса нет вовсе, и день пришёл от подачи: смены у такого дня нет. */
    on_route: boolean;
    trips: number;
    volume_m3: string | null;
    weight_tons: string | null;
  };

type OnsiteRow = CustomerColumns &
  VehicleColumns &
  MoneyColumns &
  RequestColumns & {
    kind: 'shift' | 'relocation' | 'term';
    date: string;
    in_period: boolean;
    machine_hours: string | null;
    approved: boolean | null;
    date_from: string | null;
    date_to: string | null;
  };

// ── Деньги заявки (Р9, Р28, Р29) ──

interface RequestMoney {
  status: RequestStatus;
  pricePerShift: number | null;
  pricePerHour: number | null;
  shiftHours: number | null;
  totalCost: number | null;
}

function moneyOf(row: MoneyColumns & RequestColumns): RequestMoney {
  return {
    status: row.status,
    pricePerShift: num(row.price_per_shift),
    pricePerHour: num(row.price_per_hour),
    shiftHours: row.shift_hours,
    totalCost: num(row.total_cost),
  };
}

/** Закрытая заявка отвечает фактом, незакрытая — оценкой. Третьего не бывает (Р9, Р10). */
function isClosed(m: RequestMoney): boolean {
  return analyticsCountsAsFact(m.status);
}

/**
 * Цена ДНЯ работы. Смена в назначении — прямая цена дня; час — цена дня только вместе с длиной
 * смены, и без неё оценка не считается вовсе: домножать часовую ставку на дни, не зная часов в дне,
 * значит выдумать число (Р29).
 */
function dayPrice(m: RequestMoney): number | null {
  if (m.pricePerShift !== null) return m.pricePerShift;
  if (m.pricePerHour !== null && m.shiftHours !== null) return m.pricePerHour * m.shiftHours;
  return null;
}

/**
 * Удалось ли получить по заявке хоть одно число (Р9, Р29).
 *
 * У закрытой это сумма закрытия, у незакрытой — цена дня; ничего третьего в книгу не попадает, и
 * флаг считается ровно по тому, чем заявка отвечает. Закрытие без суммы поэтому «без цены», а не
 * «ноль»: **ноль в денежной клетке обязан означать бесплатную работу и ничего больше** (Р29), а
 * счётчик неоценённых и заведён затем, чтобы отличить одно от другого.
 *
 * Считается по ЗАЯВКЕ и кладётся на каждый её атом одинаковым: счётчик берёт
 * `count(DISTINCT request_id) FILTER (WHERE NOT priced)`, и атом, не согласный с соседом по той же
 * заявке, сделал бы этот счётчик недетерминированным.
 */
function pricedOf(m: RequestMoney): boolean {
  return isClosed(m) ? m.totalCost !== null : dayPrice(m) !== null;
}

/**
 * Нижняя оценка ОДНОГО дня площадки: цена смены за заполненный день, а при часовой ставке — цена
 * часа на моточасы именно этого дня. День срока без смены даёт по ней честный ноль: нижняя оценка
 * и заведена затем, чтобы показать, сколько работы подтверждено фактом.
 */
function lowOfShiftDay(money: RequestMoney, atom: AnalyticsAtom): number {
  if (atom.shifts !== 1) return 0;
  if (money.pricePerShift !== null) return money.pricePerShift;
  if (money.pricePerHour !== null) return round2(money.pricePerHour * atom.engineHours);
  return 0;
}

/**
 * Раскладка суммы заявки по ВСЕМ дням её работы (Р28). Период забирает свою долю: доли дней за его
 * границей никому не достаются, и заказ, начатый в июле и закрытый в августе, не отдаёт полную
 * сумму обоим отчётам.
 *
 * Остаток от округления кладётся на последний весомый день: раскладка обязана сходиться к исходной
 * сумме, а не к ней «примерно».
 */
function spread(total: number, weights: readonly number[]): number[] {
  const shares = weights.map(() => 0);
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (sum <= 0 || total === 0) return shares;
  const last = weights.reduce((found, w, index) => (w > 0 ? index : found), -1);
  let rest = round2(total);
  for (let i = 0; i < weights.length; i += 1) {
    const weight = weights[i] ?? 0;
    if (weight <= 0) continue;
    const share = i === last ? rest : round2((total * weight) / sum);
    shares[i] = share;
    rest = round2(rest - share);
  }
  return shares;
}

// ── Позиция и заказчик атома ──

function positionOf(
  row: VehicleColumns,
): Pick<AnalyticsAtom, 'positionKey' | 'positionLabel' | 'registrationNumber'> {
  if (!row.vehicle_id) {
    // Машины нет ни в назначении, ни в истории: день работы записан, а чем работали — неизвестно.
    return {
      positionKey: NO_VEHICLE_POSITION_KEY,
      positionLabel: 'Техника не назначена',
      registrationNumber: null,
    };
  }
  return {
    positionKey: row.vehicle_id,
    positionLabel: vehicleOptionLabel({
      ownership: row.ownership ?? 'own',
      description: row.description ?? '',
      categoryName: row.category_name,
      typeName: row.type_name ?? '',
      registrationNumber: row.registration_number,
      modelName: row.model_name,
      lessorName: row.lessor_name,
    }),
    registrationNumber: row.registration_number,
  };
}

function customerOf(
  row: CustomerColumns,
): Pick<
  AnalyticsAtom,
  | 'customerKind'
  | 'customerId'
  | 'customerCode'
  | 'customerName'
  | 'customerIsActive'
  | 'payerDepartmentId'
  | 'payerDepartmentName'
> {
  return {
    customerKind: row.customer_kind,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerName: row.customer_name,
    customerIsActive: row.customer_is_active,
    // Отдел-плательщик бывает только у механизации (Р22): здесь отдел — сам заказчик и уже стоит
    // в `customer*`, и повторить его вторым полем значило бы разнести одни деньги по двум осям.
    payerDepartmentId: null,
    payerDepartmentName: null,
  };
}

/** Заготовка атома: счётчики по нулям, деньги по нулям — заполняет их разряд. */
function emptyAtom(
  module: AnalyticsAtom['module'],
  row: CustomerColumns & VehicleColumns & RequestColumns,
  date: string,
  priced: boolean,
): AnalyticsAtom {
  return {
    module,
    ...customerOf(row),
    date,
    ...positionOf(row),
    requestId: row.request_id,
    requestLabel: formatVehicleRequestNumber(row.num),
    requestStatus: row.status,
    shifts: 0,
    planShifts: 0,
    trips: 0,
    volumeM3: 0,
    weightTons: 0,
    engineHours: 0,
    mechHours: 0,
    mechDays: 0,
    removals: 0,
    containerOps: 0,
    relocations: 0,
    moneyFact: 0,
    moneyLow: 0,
    moneyHigh: 0,
    priced,
  };
}

// ── Разряд «Перевозки» ──

/** Атомы перевозок и то, что о них знает только этот запрос: потеря, найденная по дню подачи. */
interface FreightFacts {
  atoms: AnalyticsAtom[];
  /** Закрытые перевозки без единого рейса — числитель своей строки «Качества». */
  closedWithoutRoute: number;
  /** Все закрытые перевозки периода — её же знаменатель. */
  closed: number;
}

/**
 * День перевозки — день рейса (Р11), состав — `vehicle_route_requests`.
 *
 * Тип заявки проверяется, и это не перестраховка: в грузовом рейсе стоят и дни ЛИНЕЙНОГО заказа
 * спецтехники (миграция 0127, `work_date`), а они перевозками не считаются вовсе — техника едет
 * работать, а не везти (Р7). Без этого условия линейный заказ попал бы в оба разряда сразу.
 *
 * ЗАКРЫТАЯ ЗАЯВКА БЕЗ РЕЙСА — ВТОРОЙ ИСТОЧНИК ДНЯ, И ЗАВЕДЁН ОН НЕ РАДИ ПОЛНОТЫ. Закрытие рейса не
 * требует (`services/vehicle-request-completion.ts`), а «в работе и без маршрута» схема прямо
 * называет законным состоянием (`vehicle_route_requests`). Читай книга одни рейсы — перевозка,
 * закрытая с суммой, но не поставленная в рейс (или чей рейс снесли вместе с путевым листом), не
 * дала бы ни денег, ни ездок, ни объёма, и «Качество» смолчало бы: его счётчики считаются по уже
 * собранным атомам, а пропавшего атома там нет. Поэтому такая заявка приходит по дню ПОДАЧИ
 * (`freight_transport_request_details.scheduled_at`, московские сутки — как `delivery_at` у
 * вывоза), а строка «Закрытых перевозок без рейса» говорит, что находка состоялась. Незакрытая
 * сюда не попадает вовсе — ни «Новая», ни «в работе»: у неё работа ещё не началась, и день рейса у
 * неё будет.
 *
 * СМЕНЫ У ТАКОГО ДНЯ НЕТ. Машино-смена перевозки — это пара «машина и день РЕЙСА» (Р6); выдай её
 * заявке, которая никуда не поехала, и колонка «смен» начала бы считать намерения. Деньги, ездки,
 * объём и масса при этом сохраняются: они привязаны к заявке, а не к рейсу.
 *
 * РЕЙС ЗА ГРАНИЦЕЙ ПЕРИОДА — ЭТО НЕ «БЕЗ РЕЙСА». Отбор требует, чтобы рейса не было ВООБЩЕ, а не
 * «не было в периоде»: заявка с майским рейсом свои деньги уже отдала маю, и второй атом по
 * июньской подаче отдал бы ту же сумму ещё и июню — ровно то удвоение, от которого сторожит Р28.
 */
async function loadFreight(range: AnalyticsRange): Promise<FreightFacts> {
  const result = await db.execute<FreightRow>(sql`
WITH scope AS (
    /* Заявки, чей рейс попал в период. Дни им дальше считаются ВСЕ — это знаменатель денег (Р28). */
    SELECT DISTINCT rr.request_id
      FROM vehicle_routes r
      JOIN vehicle_route_requests rr ON rr.route_id = r.id
      JOIN vehicle_requests q        ON q.id = rr.request_id
     WHERE r.purpose = 'freight'
       AND r.route_date BETWEEN ${range.from}::date AND ${range.to}::date
       AND q.request_type = 'freight_transport'
       AND ${LIVE_REQUEST}
),
orphan AS (
    /*
     * Перевозка, не доехавшая до рейса: день ей даёт подача. AT TIME ZONE обязателен и не
     * украшение — сессии живут в UTC, и подача с 00:00 до 03:00 МСК уехала бы во вчерашний день,
     * то есть заявка первого числа выпала бы из месяца целиком.
     *
     * ТОЛЬКО ЗАКРЫТАЯ, и это узко намеренно. Терялись деньги ЗАКРЫТЫХ заявок: сумму ввели, а рейса
     * нет, и в книге её не было вовсе. «В работе, но ещё не в рейсе» — не потерянная работа, а
     * работа, которая ещё не началась: заявка получит рейс и придёт своим днём. Возьми и её — и
     * самый частый случай («завели, машину назначили, рейс не собрали») создавал бы площадке строку
     * свода днём подачи с оценкой по цене назначения, ровно вопреки Р25: строку свода создаёт работа.
     *
     * Машина берётся из назначения: истории тут спрашивать не о чем — дня работы, на который она
     * отвечает, у заявки нет.
     */
    SELECT q.id AS request_id,
           (fd.scheduled_at AT TIME ZONE ${MOSCOW})::date AS day,
           asg.vehicle_id AS vehicle_id
      FROM vehicle_requests q
      JOIN freight_transport_request_details fd ON fd.request_id = q.id
      JOIN vehicle_request_completions comp      ON comp.request_id = q.id
      LEFT JOIN vehicle_request_assignments asg  ON asg.request_id = q.id
     WHERE q.request_type = 'freight_transport'
       AND ${LIVE_REQUEST}
       AND (fd.scheduled_at AT TIME ZONE ${MOSCOW})::date
             BETWEEN ${range.from}::date AND ${range.to}::date
       /*
        * Рейса нет ВООБЩЕ, а не «нет в периоде»: заявка с майским рейсом свои деньги уже отдала
        * маю, и атом по июньской подаче отдал бы ту же сумму ещё и июню — два соседних отчёта в
        * сумме оказались бы больше годового (Р28).
        */
       AND NOT EXISTS (SELECT 1
                         FROM vehicle_route_requests rr
                         JOIN vehicle_routes r ON r.id = rr.route_id
                        WHERE rr.request_id = q.id
                          AND r.purpose = 'freight')
),
atom AS (
    SELECT rr.request_id, r.route_date AS day, r.vehicle_id, true AS on_route,
           (r.route_date BETWEEN ${range.from}::date AND ${range.to}::date) AS in_period
      FROM vehicle_routes r
      JOIN vehicle_route_requests rr ON rr.route_id = r.id
     WHERE r.purpose = 'freight'
       AND rr.request_id IN (SELECT request_id FROM scope)
    UNION ALL
    SELECT o.request_id, o.day, o.vehicle_id, false, true
      FROM orphan o
),
trip AS (
    /*
     * Ездки берутся ПО ЗАЯВКЕ, а не по рейсу: у ездки своя таблица и свой номер («ТС-40/2»), и
     * связи с маршрутом у неё нет вовсе. Удалённая ездка не считается — она не ехала. Заявке без
     * рейса ездки достаются на тех же правах: они её работа, а не работа маршрута.
     */
    SELECT t.request_id,
           count(*)::int      AS trips,
           sum(t.volume_m3)   AS volume_m3,
           sum(t.weight_tons) AS weight_tons
      FROM vehicle_request_trips t
     WHERE t.deleted_at IS NULL
       AND (t.request_id IN (SELECT request_id FROM scope)
            OR t.request_id IN (SELECT request_id FROM orphan))
     GROUP BY t.request_id
)
SELECT a.request_id                AS request_id,
       q.num                       AS num,
       q.status::text              AS status,
       a.day::text                 AS date,
       a.in_period                 AS in_period,
       a.on_route                  AS on_route,
       coalesce(tr.trips, 0)       AS trips,
       tr.volume_m3                AS volume_m3,
       tr.weight_tons              AS weight_tons,
       ${CUSTOMER_COLUMNS},
       ${VEHICLE_COLUMNS},
       ${MONEY_COLUMNS}
  FROM atom a
  JOIN vehicle_requests q ON q.id = a.request_id
  LEFT JOIN trip tr       ON tr.request_id = a.request_id
  ${CUSTOMER_JOINS}
  ${vehicleJoins(sql`a.vehicle_id`)}
  ${MONEY_JOINS}
 ORDER BY customer_id, a.vehicle_id, a.day, q.num`);

  const atoms: AnalyticsAtom[] = [];
  /**
   * Машино-смена пары «машина + день» у одного заказчика ОДНА (Р6). Три заявки одного объекта в
   * одном рейсе — это один выезд одной машины, и посчитать их тремя сменами значило бы утроить
   * работу площадки; делить смену на доли («1/3») нельзя тем более — такую цифру не объяснить ни
   * водителю, ни бухгалтеру. Между ДВУМЯ заказчиками смена при этом не делится, а достаётся каждому
   * целиком: сумма по строкам свода больше числа машино-смен парка, и это сказано вслух в подписи
   * колонки.
   *
   * Смена кладётся на первый атом пары, остальным достаётся ноль, а не сворачивание заявок в один
   * атом: у атома есть номер и статус заявки, и склеенная пара не смогла бы ответить ни «чья это
   * работа», ни «сколько заявок без цены».
   */
  const shiftSeen = new Set<string>();
  /** Ездки заявки — на первый её атом периода: две строки заявки удвоили бы объём. */
  const tripsSeen = new Set<string>();
  /** Все дни заявки (и за границей периода) — знаменатель факта; атом есть только у дней периода. */
  const daysOf = new Map<
    string,
    { money: RequestMoney; days: string[]; atoms: Map<string, AnalyticsAtom> }
  >();

  /** Закрытые перевозки периода и те из них, у кого рейса нет вовсе: строка «Качества» (Д1). */
  const closed = new Set<string>();
  const closedWithoutRoute = new Set<string>();

  for (const row of result.rows) {
    const request = daysOf.get(row.request_id) ?? {
      money: moneyOf(row),
      days: [],
      atoms: new Map<string, AnalyticsAtom>(),
    };
    daysOf.set(row.request_id, request);
    request.days.push(row.date);
    if (!row.in_period) continue;

    if (isClosed(request.money)) {
      closed.add(row.request_id);
      if (!row.on_route) closedWithoutRoute.add(row.request_id);
    }

    const atom = emptyAtom('freight', row, row.date, pricedOf(request.money));
    // Смена перевозки — пара «машина и день РЕЙСА» (Р6). У дня подачи рейса нет, и смены у него нет
    // тоже: иначе колонка «смен» считала бы намерения наравне с выездами.
    const pair = `${row.customer_id}|${row.vehicle_id ?? NO_VEHICLE_POSITION_KEY}|${row.date}`;
    if (row.on_route && !shiftSeen.has(pair)) {
      shiftSeen.add(pair);
      atom.shifts = 1;
    }
    if (!tripsSeen.has(row.request_id)) {
      tripsSeen.add(row.request_id);
      atom.trips = row.trips;
      atom.volumeM3 = num(row.volume_m3) ?? 0;
      atom.weightTons = num(row.weight_tons) ?? 0;
    }
    request.atoms.set(row.date, atom);
    atoms.push(atom);
  }

  for (const request of daysOf.values()) {
    const { money } = request;
    const days = [...request.days].sort();
    if (isClosed(money)) {
      // Факт закрытия делится между всеми днями заявки; период берёт свою долю (Р28). День у
      // грузовой заявки сегодня один — рейса или подачи (см. шапку модуля), и сумма приходит
      // целиком; раскладка стоит здесь ради того дня, когда рейсов у неё станет несколько.
      const shares = spread(
        money.totalCost ?? 0,
        days.map(() => 1),
      );
      days.forEach((day, i) => {
        const atom = request.atoms.get(day);
        if (atom) atom.moneyFact = shares[i]!;
      });
      continue;
    }
    /*
     * У перевозки срока нет — есть день подачи, — поэтому «оценка по сроку» совпадает с «оценкой по
     * факту»: оценивать нечем, кроме состоявшихся дней рейса. В книге обе колонки у таких заявок
     * показывают одно число, и это честнее выдуманной вилки. Оценка считается ПОДНЕВНО, поэтому
     * знаменателя ей не нужно вовсе: день за границей периода свою цену просто не отдаёт.
     */
    const price = dayPrice(money);
    if (price === null) continue;
    for (const atom of request.atoms.values()) {
      atom.moneyLow = price;
      atom.moneyHigh = price;
    }
  }

  return { atoms, closedWithoutRoute: closedWithoutRoute.size, closed: closed.size };
}

// ── Разряд «Техника на объекте» ──

interface OnsiteFacts {
  atoms: AnalyticsAtom[];
  shifts: number;
  shiftsUnapproved: number;
  plannedDays: number;
}

/** Всё, что известно о заявке площадки: строки смен, дни срока внутри периода и перегоны. */
interface OnsiteRequest {
  money: RequestMoney;
  /** Любая строка заявки: из неё берутся заказчик и номер там, где своей строки у дня нет. */
  any: OnsiteRow;
  /** Все смены заявки, включая лежащие за границей периода: они и есть знаменатель факта (Р28). */
  shiftRows: OnsiteRow[];
  /** День срока внутри периода → строка с машиной ЭТОГО дня (Р8). */
  termRows: Map<string, OnsiteRow>;
  dateFrom: string | null;
  dateTo: string | null;
}

/**
 * Смена на объекте — строка `vehicle_request_shifts` (Р7): факт с моточасами и визой площадки.
 *
 * Запрос отдаёт три вида строк одним набором:
 *
 * - `shift` — смены заявки. ВСЕ, а не только попавшие в период: атом рождает лишь помеченная
 *   `in_period`, но знаменатель факта — вся работа заявки (Р28);
 * - `relocation` — перегон техники к своему заказу и обратно (Р27): не смена и не деньги, только
 *   счётчик. Машина берётся у самого рейса — перегон заводится ровно на ту машину, что стоит в
 *   назначении («перегнать одной, а работать другой» не состояние, а расхождение);
 * - `term` — день срока заказа внутри периода. Он нужен двум числам сразу: ПЛАНУ смен
 *   (`planShifts`, Р7 — «смен 52 (план 56)» на листе детализации) и верхней оценке денег (Р29):
 *   заказ, простоявший месяц без единой заполненной смены, в нижней оценке честно даёт ноль, а в
 *   верхней обязан дать цену срока. Разворачивает срок в дни SQL, но СОСТАВ дней решает
 *   `shiftDaysOf`: SQL отвечает только на «какая машина стояла в этот день».
 */
async function loadOnsite(range: AnalyticsRange): Promise<OnsiteFacts> {
  const result = await db.execute<OnsiteRow>(sql`
WITH period_shift AS (
    SELECT s.request_id
      FROM vehicle_request_shifts s
      JOIN vehicle_requests q ON q.id = s.request_id
     WHERE s.shift_date BETWEEN ${range.from}::date AND ${range.to}::date
       AND q.request_type = 'special_equipment'
       AND ${LIVE_REQUEST}
),
relocation AS (
    SELECT r.source_request_id AS request_id, r.route_date AS d, r.vehicle_id
      FROM vehicle_routes r
      JOIN vehicle_requests q ON q.id = r.source_request_id
     WHERE r.purpose IN ('delivery', 'pickup')
       AND r.route_date BETWEEN ${range.from}::date AND ${range.to}::date
       AND q.request_type = 'special_equipment'
       AND ${LIVE_REQUEST}
),
term AS (
    /*
     * Пустая date_to — однодневный срок: так её читает весь модуль смен (shiftDaysOf).
     *
     * Срок даёт план только у заявки, ДОШЕДШЕЙ ДО РАБОТЫ (WORK_STATUSES). «Новая» — ещё не заказ:
     * её срок это намерение, и посчитай его планом — у площадки, где работы не было, появилась бы
     * строка свода вопреки Р25, а знаменатель «смен заполнено из дней срока» раздулся бы днями
     * неподтверждённых заявок, и качество данных выглядело бы хуже, чем оно есть.
     *
     * На смены, деньги и перегоны это не распространяется: строка смены — факт независимо от
     * статуса, и появись она у «Новой» (коррекция задним числом, ADR 0101), фактом она и останется.
     */
    SELECT q.id AS request_id, sed.date_from, sed.date_to, gs.day::date AS d
      FROM vehicle_requests q
      JOIN special_equipment_request_details sed ON sed.request_id = q.id
      CROSS JOIN LATERAL generate_series(
             greatest(sed.date_from, ${range.from}::date),
             least(coalesce(sed.date_to, sed.date_from), ${range.to}::date),
             interval '1 day') AS gs(day)
     WHERE q.request_type = 'special_equipment'
       AND ${LIVE_REQUEST}
       AND q.status::text = ANY(${sql.param(WORK_STATUSES)}::text[])
       AND sed.date_from <= ${range.to}::date
       AND coalesce(sed.date_to, sed.date_from) >= ${range.from}::date
),
scope AS (
    SELECT request_id FROM period_shift
    UNION SELECT request_id FROM relocation
    UNION SELECT request_id FROM term
),
line AS (
    SELECT 'shift'::text AS kind, s.request_id, s.shift_date AS d, s.machine_hours,
           (s.approved_at IS NOT NULL) AS approved,
           (s.shift_date BETWEEN ${range.from}::date AND ${range.to}::date) AS in_period,
           NULL::uuid AS route_vehicle_id, NULL::date AS date_from, NULL::date AS date_to
      FROM vehicle_request_shifts s
     WHERE s.request_id IN (SELECT request_id FROM scope)
    UNION ALL
    SELECT 'relocation', request_id, d, NULL::numeric, NULL::boolean, true,
           vehicle_id, NULL::date, NULL::date
      FROM relocation
    UNION ALL
    SELECT 'term', request_id, d, NULL::numeric, NULL::boolean, true,
           NULL::uuid, date_from, date_to
      FROM term
),
resolved AS (
    /*
     * Машина дня — по ИСТОРИИ назначения (Р8). Текущая строка назначения отвечает про сегодня: у
     * заказа, где технику меняли внутри срока, январские моточасы уехали бы в позицию мартовской
     * машины, и «ед. техники» стало бы на единицу меньше правды.
     */
    SELECT l.*,
           CASE
             WHEN l.kind = 'relocation' THEN l.route_vehicle_id
             ELSE ${requestDayVehicleSql(sql`q.id`, sql`asg.vehicle_id`, sql`l.d`)}
           END AS vehicle_id
      FROM line l
      JOIN vehicle_requests q                   ON q.id = l.request_id
      LEFT JOIN vehicle_request_assignments asg ON asg.request_id = l.request_id
)
SELECT rz.kind              AS kind,
       rz.request_id        AS request_id,
       q.num                AS num,
       q.status::text       AS status,
       rz.d::text           AS date,
       rz.in_period         AS in_period,
       rz.machine_hours     AS machine_hours,
       rz.approved          AS approved,
       rz.date_from::text   AS date_from,
       rz.date_to::text     AS date_to,
       ${CUSTOMER_COLUMNS},
       ${VEHICLE_COLUMNS},
       ${MONEY_COLUMNS}
  FROM resolved rz
  JOIN vehicle_requests q ON q.id = rz.request_id
  ${CUSTOMER_JOINS}
  ${vehicleJoins(sql`rz.vehicle_id`)}
  ${MONEY_JOINS}
 ORDER BY customer_id, rz.request_id, rz.d, rz.kind`);

  const requests = new Map<string, OnsiteRequest>();
  const relocations: OnsiteRow[] = [];
  for (const row of result.rows) {
    const request = requests.get(row.request_id) ?? {
      money: moneyOf(row),
      any: row,
      shiftRows: [],
      termRows: new Map<string, OnsiteRow>(),
      dateFrom: null,
      dateTo: null,
    };
    requests.set(row.request_id, request);
    if (row.kind === 'relocation') relocations.push(row);
    else if (row.kind === 'shift') request.shiftRows.push(row);
    else {
      request.termRows.set(row.date, row);
      request.dateFrom = row.date_from;
      request.dateTo = row.date_to;
    }
  }

  const atoms: AnalyticsAtom[] = [];
  let shifts = 0;
  let shiftsUnapproved = 0;
  let plannedDays = 0;

  for (const request of requests.values()) {
    const { money } = request;
    const priced = pricedOf(money);
    const closed = isClosed(money);
    const price = dayPrice(money);

    // Дни срока считает контрактный `shiftDaysOf` — тот же, которым карточка рисует таблицу смен.
    // Пересечение с периодом — обычный отбор по ключам дат: они лексикографически сравнимы, и
    // календарная арифметика здесь не нужна.
    const termDays = shiftDaysOf({
      dateFrom: request.dateFrom ?? undefined,
      dateTo: request.dateTo,
    });
    const termInPeriod = termDays.filter((day) => day >= range.from && day <= range.to);
    plannedDays += termInPeriod.length;

    /** День периода → его атом. Один день — один атом: второй удвоил бы верхнюю оценку (Р29). */
    const dayAtoms = new Map<string, AnalyticsAtom>();
    const shiftDates = new Set(request.shiftRows.map((row) => row.date));

    for (const row of request.shiftRows) {
      if (!row.in_period) continue;
      const atom = emptyAtom('onsite', row, row.date, priced);
      atom.shifts = 1;
      atom.engineHours = num(row.machine_hours) ?? 0;
      shifts += 1;
      if (row.approved !== true) shiftsUnapproved += 1;
      dayAtoms.set(row.date, atom);
      atoms.push(atom);
    }

    /*
     * ДЕНЬ СРОКА ПОРОЖДАЕТ АТОМ ВСЕГДА — даже когда нести ему больше нечего: ни смены, ни денег.
     * План обязан отвечать про СРОК, а не про заполненность: заводись голый день «лишь когда есть
     * что нести», план заявки, которую забыли заполнять, оказался бы ниже плана соседней, и
     * колонка «смен 52 (план 56)» сравнивала бы площадки по старательности учётчика.
     *
     * У дня со сменой второго атома не заводится: план ложится на тот же атом, что и факт, —
     * иначе верхняя оценка этого дня удвоилась бы (Р29).
     */
    for (const day of termInPeriod) {
      if (shiftDates.has(day)) continue;
      const row = request.termRows.get(day) ?? request.any;
      const atom = emptyAtom('onsite', row, day, priced);
      dayAtoms.set(day, atom);
      atoms.push(atom);
    }
    for (const day of termInPeriod) {
      const atom = dayAtoms.get(day);
      if (atom) atom.planShifts = 1;
    }

    if (closed) {
      /*
       * Факт закрытия делится между ВСЕМИ днями работы заявки, а период берёт свою долю (Р28).
       * Дни работы — заполненные смены; если их нет вовсе, носителем становится срок заказа:
       * иначе сумма закрытия просто исчезла бы из книги.
       */
      const carriers =
        request.shiftRows.length > 0 ? request.shiftRows.map((row) => row.date).sort() : termDays;
      const shares = spread(
        money.totalCost ?? 0,
        carriers.map(() => 1),
      );
      carriers.forEach((day, i) => {
        const atom = dayAtoms.get(day);
        if (atom) atom.moneyFact = shares[i]!;
      });
    } else if (price !== null) {
      const termSet = new Set(termInPeriod);
      for (const [day, atom] of dayAtoms) {
        /*
         * Нижняя — по ФАКТУ смен: цена смены на каждый заполненный день, а при часовой ставке —
         * цена часа на моточасы этого дня. Она занижает там, где смены не заполнили; день срока
         * без смены даёт по ней честный ноль.
         */
        const low = lowOfShiftDay(money, atom);
        /*
         * Верхняя — по СРОКУ заказа: цена дня на каждый день срока внутри периода, и день со
         * сменой получает её ровно один раз. Смена за пределами срока (закрыли раньше, а
         * коррекция задним числом день оставила — ADR 0101) верхней границы не имеет и отвечает
         * своей нижней: инвариант «низ не больше верха» держится поатомно, а не поправкой в итоге.
         */
        const high = termSet.has(day) ? price : low;
        atom.moneyLow = low;
        atom.moneyHigh = Math.max(high, low);
      }
    }
  }

  for (const row of relocations) {
    // Перегон — счётчик, и только (Р27). Сменой он не считается: в перевозках удвоил бы работу,
    // а спрятанный целиком скрыл бы стоимость доставки техники на площадку.
    const request = requests.get(row.request_id)!;
    const atom = emptyAtom('onsite', row, row.date, pricedOf(request.money));
    atom.relocations = 1;
    atoms.push(atom);
  }

  return { atoms, shifts, shiftsUnapproved, plannedDays };
}

// ── Качество данных (Р20) ──

/**
 * Пять строк листа «Качество данных» — ровно те, на которые заказ техники отвечает сам.
 *
 * Считаются они здесь, а не поверх атомов свода, по причине из `AnalyticsFacts`: «смена без визы»
 * из счётчиков не выводится вовсе, а выведенная давала бы второе определение там, где уже есть
 * первое. «Без цены» и «в работе» считаются по заявкам (`DISTINCT request_id`), а не по атомам:
 * заявка с десятью сменами иначе дала бы десять строк без цены.
 *
 * «Перевозок без рейса» приходит из самого загрузчика по той же причине, что и «смены без визы»:
 * атом такой заявки ничем не отличается от прочих — это и есть смысл починки, — и по собранным
 * атомам потерю уже не восстановить.
 */
function qualityOf(
  atoms: readonly AnalyticsAtom[],
  freight: FreightFacts,
  onsite: OnsiteFacts,
): AnalyticsQualityEntry[] {
  const unpriced = new Set<string>();
  const open = new Set<string>();
  for (const atom of atoms) {
    if (!atom.priced) unpriced.add(atom.requestId);
    if (!analyticsCountsAsFact(atom.requestStatus)) open.add(atom.requestId);
  }
  return [
    {
      key: 'onsite.shifts-unapproved',
      label: 'Смен на объекте без визы площадки',
      value: onsite.shiftsUnapproved,
      outOf: onsite.shifts,
      note: 'Часть работы не подтверждена заказчиком: моточасы и деньги по ней считаны со слов исполнителя',
    },
    {
      key: 'freight.closed-without-route',
      label: 'Закрытых перевозок без рейса',
      value: freight.closedWithoutRoute,
      outOf: freight.closed,
      note: 'Рейса у них нет вовсе: деньги и ездки книга отнесла ко дню подачи, а машино-смены у них не посчитано',
    },
    {
      key: 'vehicle.requests-unpriced',
      label: 'Заявок на технику без цены назначения',
      value: unpriced.size,
      outOf: null,
      note: 'В деньги не вошли ни фактом, ни оценкой: расходы по ним занижены',
    },
    {
      /*
       * ПОДПИСЬ ОТВЕЧАЕТ ПРО МОМЕНТ ВЫГРУЗКИ, А НЕ ПРО КОНЕЦ ПЕРИОДА, и это выбор, а не небрежность.
       * Статус на атоме — сегодняшний, и по сегодняшнему же статусу деньги заявки разложены на факт
       * и оценку (Р9). Считай этот счётчик состоянием на конец периода — он отвечал бы про одну
       * книгу, а денежные колонки рядом про другую: заявка, закрытая после конца периода, стояла бы
       * в «Факте» и в «незакрытых» одновременно. Честная подпись дешевле такой пары.
       */
      key: 'vehicle.requests-open',
      label: 'Заявок на технику, не закрытых на момент выгрузки',
      value: open.size,
      outOf: null,
      note: 'Их деньги — оценка, а не факт: после закрытия изменится и книга за уже прошедший период',
    },
    {
      key: 'onsite.shifts-plan-fact',
      label: 'Смен на объекте заполнено из дней срока заказов',
      value: onsite.shifts,
      outOf: onsite.plannedDays,
      note: 'Разница — дни срока, за которые смену не завели: работа площадки подтверждена не вся',
    },
  ];
}

/**
 * Атомы обоих разрядов заказа техники за период.
 *
 * Оба запроса уходят разом: они независимы, а книга ждёт их вместе. Порядок атомов — перевозки,
 * затем площадка; группировкам он безразличен, но делает выгрузку `Данные` читаемой глазом.
 */
export async function loadVehicleFacts(range: AnalyticsRange): Promise<AnalyticsFacts> {
  const [freight, onsite] = await Promise.all([loadFreight(range), loadOnsite(range)]);
  const atoms = [...freight.atoms, ...onsite.atoms];
  return { atoms, quality: qualityOf(atoms, freight, onsite) };
}
