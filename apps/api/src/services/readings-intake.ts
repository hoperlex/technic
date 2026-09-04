import { asc, inArray, sql } from 'drizzle-orm';
import {
  ENGINE_HOURS_JUMP_PER_DAY,
  formatVehicleRouteNumber,
  type DriverReportState,
  type IntakeIssue,
  intakeLevel,
  jumpLimit,
  moscowDateKeyOf,
  ODOMETER_JUMP_PER_DAY_KM,
  READING_OVERDUE_DAYS,
  type ReadingAnomaly,
  type ReadingAnomalyDto,
  type ReadingIntakeDto,
  type ReadingIntakeReport,
  type ReadingIntakeRow,
  type ReadingSourceKind,
  type ReportDiscrepancyDto,
  vehicleLabel,
  type VehicleOwnership,
  type VehicleReadingDto,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import { vehicleReadingFiles } from '../db/schema';
import { daysBetween } from './readings-chain';
import { expectedRelationCte } from './readings-aggregate';
import { loadReportById } from './readings';

/**
 * Реестр приёма показаний (план «Показания техники», §5, §6; решения Р5—Р9а, Р22—Р26, Р32).
 *
 * Экран приёма отвечает на один вопрос: **с кого сегодня ждут показания и что с ними не так**.
 * Отсюда четыре свойства, каждое — принятое решение, а не удобство реализации.
 *
 * 1. **Реестр строится от ожидаемых смен, а не от строк ожидания** (Р26). Строка ожидания
 *    появляется только после `openReport`, поэтому у дня, который никто не открывал, строк нет
 *    вовсе — а показания с него ждут, и ровно ради таких дней экран и нужен. Набор берётся общим
 *    фрагментом `expectedRelationCte` (`readings-aggregate.ts`): второго правила «что такое
 *    ожидаемая смена» в проекте быть не должно, иначе приём требовал бы показаний по сменам,
 *    которых не ждёт ни статистика, ни кабинет водителя (Р26а).
 * 2. **Пометки собирает сервер, с готовыми текстами** (Р5, Р7), а уровень строки считает одна
 *    функция контрактов `intakeLevel` — ни здесь, ни в SQL, ни на портале второй формулы нет.
 * 3. **«Сегодня» и «сколько дней ждём» тоже считает сервер** (Р23), по московскому дню: красная
 *    строка не должна зависеть от часов телефона в кабине.
 * 4. **Пригодность к пакетному приёму считается по ВСЕМ строкам отчёта** (Р9а), а не по видимым:
 *    пагинация делит отчёт между страницами, и кнопка, считающая по странице, предложила бы
 *    принять отчёт с невидимой жёлтой строкой. Поэтому рядом со страницей строк идёт список
 *    отчётов периода со своими счётчиками.
 *
 * Цена четвёртого свойства названа прямо: набор периода собирается в память целиком, а страницу из
 * него режет уже сервис. Считать счётчики в SQL было бы дешевле, но это и есть та самая вторая
 * формула уровня, которой быть не должно; период же реестра — день или неделя (Р29), и потолок
 * ручки его ограничивает.
 */

// ── Строка набора ──

/**
 * Строка ответа SQL: обе координаты смены (Р32), показание с предшественниками и всё, из чего
 * собираются подписи. Псевдоним, а не `interface`: `db.execute` требует индексную сигнатуру.
 */
type IntakeSqlRow = {
  source_id: string;
  source_kind: ReadingSourceKind;
  /** Живая координата: машина, день и работник источника **сегодня**. */
  exp_vehicle: string | null;
  exp_date: string | null;
  exp_person: string | null;
  exp_report_id: string | null;
  exp_state: DriverReportState | null;
  exp_report_version: number | null;
  /** Снимочная координата: то, к чему привязано показание. */
  item_id: string | null;
  obs_vehicle: string | null;
  obs_date: string | null;
  obs_shift_order: number | null;
  obs_report_id: string | null;
  obs_state: DriverReportState | null;
  obs_report_version: number | null;
  aligned: boolean;
  row_date: string;
  row_vehicle: string;
  row_person: string | null;
  person_name: string | null;
  route_num: number | null;
  waybill_number: number | null;
  waybill_prefix: string | null;
  waybill_number_width: number | null;
  ownership: VehicleOwnership;
  description: string;
  registration_number: string | null;
  category_name: string | null;
  type_name: string;
  model_name: string | null;
  reading_id: string | null;
  reading_kind: 'values' | 'no_data' | null;
  odometer_km: number | null;
  engine_hours: string | null;
  /* Три числа топлива идут порядком смены: остаток на начало, заправлено, остаток на конец. */
  fuel_start_liters: string | null;
  fuel_filled_liters: string | null;
  fuel_end_liters: string | null;
  no_data_reason: string | null;
  comment: string | null;
  reading_source: 'driver' | 'staff' | null;
  /** Уже готовая ISO-строка: приведение живёт в запросе, а не в разборе. */
  recorded_at: string | null;
  odometer_anomaly: ReadingAnomaly | null;
  odometer_anomaly_confirmed: boolean;
  engine_hours_anomaly: ReadingAnomaly | null;
  engine_hours_anomaly_confirmed: boolean;
  previous_odometer_km: number | null;
  previous_odometer_date: string | null;
  previous_engine_hours: string | null;
  previous_engine_hours_date: string | null;
};

async function loadIntakeRows(from: string, to: string): Promise<IntakeSqlRow[]> {
  return db.transaction(async (tx) => {
    // Тот же приём и по той же причине, что в агрегате (Р35): у CTE статистики нет, планировщик
    // оценивает полное объединение на порядки мимо, и пороги JIT оказываются перекрыты. `SET LOCAL`
    // живёт до конца транзакции и в пул не утекает.
    await tx.execute(sql`SET LOCAL jit = off`);
    const result = await tx.execute<IntakeSqlRow>(sql`
WITH ${expectedRelationCte(from, to)}
SELECT r.source_id,
       r.source_kind,
       r.exp_vehicle,
       r.exp_date::text          AS exp_date,
       r.exp_person,
       r.exp_report_id,
       r.exp_state,
       r.exp_report_version,
       r.item_id,
       r.obs_vehicle,
       r.obs_date::text          AS obs_date,
       r.obs_shift_order,
       r.obs_report_id,
       r.obs_state,
       r.obs_report_version,
       r.aligned,
       /*
        * Координаты строки реестра — ЖИВЫЕ (Р32): день и машина источника сегодня. Осиротевшая
        * строка (источник переназначили, лист аннулировали) живой координаты не имеет вовсе, и
        * тогда — и только тогда — берётся снимочная: терять уже собранное показание нельзя.
        */
       coalesce(r.exp_date, r.obs_date)::text AS row_date,
       coalesce(r.exp_vehicle, r.obs_vehicle) AS row_vehicle,
       coalesce(r.exp_person, r.obs_person)   AS row_person,
       p.full_name               AS person_name,
       rt.num                    AS route_num,
       wb.number                 AS waybill_number,
       ws.prefix                 AS waybill_prefix,
       ws.number_width           AS waybill_number_width,
       v.ownership::text         AS ownership,
       v.description,
       v.registration_number,
       c.name                    AS category_name,
       vt.name                   AS type_name,
       m.name                    AS model_name,
       vr.id                     AS reading_id,
       vr.kind::text             AS reading_kind,
       vr.odometer_km,
       vr.engine_hours,
       vr.fuel_start_liters,
       vr.fuel_filled_liters,
       vr.fuel_end_liters,
       vr.no_data_reason,
       vr.comment,
       vr.source::text           AS reading_source,
       /*
        * Момент передачи — сразу строкой ISO-8601 в UTC, тем же видом, каким его отдаёт
        * Date.toISOString() в остальных DTO. Сырой запрос идёт мимо разбора типов drizzle, и
        * метка вернулась бы из драйвера собственным написанием PostgreSQL.
        */
       to_char(vr.recorded_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
       vr.odometer_anomaly::text AS odometer_anomaly,
       (vr.odometer_anomaly_confirmed_at IS NOT NULL)     AS odometer_anomaly_confirmed,
       vr.engine_hours_anomaly::text AS engine_hours_anomaly,
       (vr.engine_hours_anomaly_confirmed_at IS NOT NULL) AS engine_hours_anomaly_confirmed,
       po.odometer_km            AS previous_odometer_km,
       po.report_date::text      AS previous_odometer_date,
       pe.engine_hours           AS previous_engine_hours,
       pe.report_date::text      AS previous_engine_hours_date
  FROM relation r
  /*
   * Показание строки и его предшественники. Предшественник берётся ИЗ ТАБЛИЦЫ, а не из набора
   * периода: прирост — свойство самого показания (его показывает и журнал), а правило «обе точки
   * пары внутри периода» (Р4, Р32г) принадлежит суммам агрегата, а не карточке строки.
   */
  LEFT JOIN vehicle_readings vr ON vr.item_id = r.item_id
  LEFT JOIN vehicle_readings po ON po.id = vr.previous_odometer_id
  LEFT JOIN vehicle_readings pe ON pe.id = vr.previous_engine_hours_id
  /* Работник осиротевшей строки — у её отчёта: живого источника, чтобы спросить, уже нет. */
  LEFT JOIN persons p ON p.id = coalesce(r.exp_person, r.obs_person)
  /* Подпись источника — тем же правилом, каким его зовут в кабинете и в карточке отчёта. */
  LEFT JOIN vehicle_routes rt ON r.source_kind = 'route' AND rt.id = r.source_id
  LEFT JOIN waybills wb        ON r.source_kind = 'esm2'  AND wb.id = r.source_id
  LEFT JOIN waybill_series ws  ON ws.id = wb.series_id
  JOIN vehicles v        ON v.id = coalesce(r.exp_vehicle, r.obs_vehicle)
  JOIN vehicle_types vt  ON vt.id = v.vehicle_type_id
  LEFT JOIN vehicle_categories c ON c.id = v.vehicle_category_id
  LEFT JOIN vehicle_models m     ON m.id = v.vehicle_model_id
 /*
  * Порядок строгий и полный: страницу режет сервис, и двум запросам одного периода нельзя
  * разложить строки по-разному. Свежее сверху — как в журнале; внутри дня строки идут работником,
  * машиной и позицией смены, а идентификатор источника замыкает порядок там, где всё совпало.
  */
 ORDER BY coalesce(r.exp_date, r.obs_date) DESC,
          p.full_name ASC NULLS LAST,
          v.registration_number_normalized ASC NULLS LAST,
          r.obs_shift_order ASC NULLS FIRST,
          r.source_id`);
    return [...result.rows];
  });
}

// ── Разбор показания ──

function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function anomalyOf(
  kind: ReadingAnomaly | null,
  confirmed: boolean,
  previousValue: number | null,
  previousDate: string | null,
): ReadingAnomalyDto | null {
  return kind === null ? null : { kind, confirmed, previousValue, previousDate };
}

/**
 * Показание строки — тем же составом, каким его отдают карточка отчёта и журнал: числа, аномалии с
 * предшественником и приросты. Разности считает сервер: вычитание на стороне портала — это ошибки,
 * которых потом не восстановить.
 */
function readingOf(row: IntakeSqlRow): VehicleReadingDto | null {
  if (row.reading_id === null || row.reading_kind === null || row.item_id === null) return null;
  const engineHours = num(row.engine_hours);
  const previousEngineHours = num(row.previous_engine_hours);
  return {
    id: row.reading_id,
    itemId: row.item_id,
    kind: row.reading_kind,
    odometerKm: row.odometer_km,
    engineHours,
    fuelStartLiters: num(row.fuel_start_liters),
    fuelFilledLiters: num(row.fuel_filled_liters),
    fuelEndLiters: num(row.fuel_end_liters),
    noDataReason: row.no_data_reason ?? '',
    comment: row.comment ?? '',
    source: row.reading_source ?? 'staff',
    recordedAt: row.recorded_at ?? '',
    odometerAnomaly: anomalyOf(
      row.odometer_anomaly,
      row.odometer_anomaly_confirmed,
      row.previous_odometer_km,
      row.previous_odometer_date,
    ),
    engineHoursAnomaly: anomalyOf(
      row.engine_hours_anomaly,
      row.engine_hours_anomaly_confirmed,
      previousEngineHours,
      row.previous_engine_hours_date,
    ),
    // Прирост к предшественнику: у начала ряда его нет — это состояние, а не ноль.
    odometerDelta:
      row.odometer_km !== null && row.previous_odometer_km !== null
        ? row.odometer_km - row.previous_odometer_km
        : null,
    engineHoursDelta:
      engineHours !== null && previousEngineHours !== null
        ? Number((engineHours - previousEngineHours).toFixed(1))
        : null,
    fileIds: [],
  };
}

function sourceLabelOf(row: IntakeSqlRow): string {
  if (row.source_kind === 'route') {
    return row.route_num === null ? 'Рейс удалён' : formatVehicleRouteNumber(row.route_num);
  }
  if (row.waybill_number === null) return 'Лист удалён';
  return `ЭСМ-2 № ${waybillDisplayNumber(row.waybill_prefix ?? '', row.waybill_number, row.waybill_number_width ?? 0)}`;
}

/**
 * Ключ строки. У строки ожидания это её идентификатор, у виртуальной — источник (Р26).
 *
 * У недельного листа в ключ входит ещё и день, и это не украшение: ЭСМ-2 действует неделю, и
 * ожидаемых смен по нему семь — ключ `esm2:<id>` был бы у всех семи одинаковым, а ключ строки
 * ответа обязан быть уникальным. У рейса дня в ключе нет: день у него один и определён им самим.
 */
function keyOf(row: IntakeSqlRow): string {
  if (row.item_id !== null) return row.item_id;
  return row.source_kind === 'route'
    ? `route:${row.source_id}`
    : `esm2:${row.source_id}:${row.row_date}`;
}

// ── Пометки (Р5, Р6, Р7) ──

function days(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return `${count} дней`;
  if (ones === 1) return `${count} день`;
  if (ones >= 2 && ones <= 4) return `${count} дня`;
  return `${count} дней`;
}

function ru(value: number): string {
  return value.toLocaleString('ru-RU');
}

/**
 * Пометка о неподтверждённой аномалии — с числами (Р7): «прирост 3 400 км за 1 день при пороге
 * 1 500 км». Из одного вида аномалии такой текст не собирается, поэтому его и собирает сервер:
 * нужны значение, значение предшественника, расстояние между их днями и сам порог.
 *
 * Порог берётся той же функцией контрактов (`jumpLimit`), какой его считал модуль показаний, когда
 * ставил аномалию: назови пометка другое число — и подтверждать пришлось бы то, чего не было.
 */
function anomalyIssue(
  counter: 'одометр' | 'моточасы',
  code: string,
  anomaly: ReadingAnomalyDto,
  value: number | null,
  date: string,
  perDay: number,
  unit: string,
): IntakeIssue | null {
  if (anomaly.confirmed) return null;
  if (anomaly.kind === 'counter_reset') {
    const was = anomaly.previousValue === null ? '' : `: было ${ru(anomaly.previousValue)} ${unit}`;
    const now = value === null ? '' : `, стало ${ru(value)} ${unit}`;
    return {
      code,
      level: 'yellow',
      message: `${counter} — счётчик сброшен или заменён${was}${now}`,
    };
  }
  if (value === null || anomaly.previousValue === null || anomaly.previousDate === null) {
    return { code, level: 'yellow', message: `${counter} — невероятный прирост` };
  }
  const between = daysBetween(anomaly.previousDate, date);
  const limit = jumpLimit(perDay, between);
  const grown = ru(Number((value - anomaly.previousValue).toFixed(1)));
  return {
    code,
    level: 'yellow',
    message: `${counter} — прирост ${grown} ${unit} за ${days(Math.max(1, between))} при пороге ${ru(limit)} ${unit}`,
  };
}

interface IssueContext {
  today: string;
  /** Неразобранные расхождения отчётов периода — по строке ожидания и по источнику дня. */
  byItem: Map<string, ReportDiscrepancyDto[]>;
  bySource: Map<string, ReportDiscrepancyDto[]>;
}

/**
 * Пометки строки. Зелёная строка — **пустой список** (Р6): числа есть, координаты сошлись,
 * аномалий и расхождений нет. Всё остальное называется вслух и с готовым текстом.
 *
 * Красных поводов ровно два (Р6): просрочка ожидания от `READING_OVERDUE_DAYS` дней и
 * `missing_source` — источник дня, которого нет в отправленном отчёте. Прочее жёлтое.
 */
function issuesOf(row: IntakeSqlRow, reading: VehicleReadingDto | null, ctx: IssueContext) {
  const issues: IntakeIssue[] = [];

  // Расхождения приходят готовыми от модуля показаний (Р7): и текст, и «разобрано ли» считает он.
  const discrepancies = [
    ...(row.exp_report_id === null
      ? []
      : (ctx.bySource.get(`${row.exp_report_id}|${row.source_kind}:${row.source_id}`) ?? [])),
    ...(row.item_id === null ? [] : (ctx.byItem.get(row.item_id) ?? [])),
  ];
  for (const d of discrepancies) {
    issues.push({
      code: d.kind,
      level: d.kind === 'missing_source' ? 'red' : 'yellow',
      message: d.message,
    });
  }

  /*
   * Ждут ли показание по этой смене. Признак тот же, каким его считает качество данных агрегата
   * (Р32а): показание закрывает ожидание, только если координаты сошлись. У рейса, перенесённого на
   * другой день, строка ожидания есть, а числа на новой дате нет — и без признака соответствия
   * старое показание подавило бы требование сдать показание.
   */
  const expected = row.exp_date !== null;
  const missing = reading === null || (expected && !row.aligned);
  if (missing) {
    // Дни считает сервер и считает по московскому дню (Р23), а не по часам телефона в кабине.
    const waiting = daysBetween(row.row_date, ctx.today);
    issues.push(
      waiting >= READING_OVERDUE_DAYS
        ? { code: 'overdue', level: 'red', message: `нет показания ${days(waiting)}` }
        : { code: 'waiting', level: 'yellow', message: 'ждём показание' },
    );
  } else if (reading.kind === 'no_data') {
    // `no_data` — закрытие строки с причиной, а не пропуск: жёлтая с этой причиной, а не красная.
    issues.push({
      code: 'no_data',
      level: 'yellow',
      message: `нет возможности снять показания: ${reading.noDataReason}`,
    });
  } else if (
    reading.kind === 'values' &&
    reading.odometerKm === null &&
    reading.engineHours === null &&
    reading.fuelEndLiters === null &&
    (reading.fuelStartLiters !== null || reading.fuelFilledLiters !== null)
  ) {
    /*
     * Утро передано, вечер — нет (Р4). Состояние дня такую смену всё равно зовёт сданной: оно
     * считает по наличию строки показания, а не по её полноте (Р3), — и дыру закрывает пометка, а
     * не новое состояние и не блокер приёма (Р5). Ужесточить блокер нельзя: у техники без одометра
     * и без указателя уровня вечерних чисел не бывает вовсе, и день, честно сданный водителем, стал
     * бы непринимаемым.
     *
     * Отсюда жёлтый, а не красный, и отсюда же всё, чего пометка стоит: жёлтая строка выбивает
     * отчёт из ПАКЕТНОГО приёма (`batchEligible` требует всех зелёных), а одиночный приём остаётся
     * одним нажатием — диспетчер, знающий, что вечерних чисел у этой машины не будет, принимает
     * день осознанно. Ни запрета, ни второй формулы уровня здесь не появляется: цвет строки
     * по-прежнему считает `intakeLevel` по этому же списку.
     *
     * Вторая половина условия следует из `vehicle_readings_values_check` — строки `values` без
     * единого числа не бывает, — но написана явно, чтобы условие читалось без обращения к схеме.
     */
    issues.push({
      code: 'shift_tail_missing',
      level: 'yellow',
      message: 'вечерние показания не переданы',
    });
  }

  if (reading?.odometerAnomaly) {
    const issue = anomalyIssue(
      'одометр',
      'anomaly_odometer',
      reading.odometerAnomaly,
      reading.odometerKm,
      row.obs_date ?? row.row_date,
      ODOMETER_JUMP_PER_DAY_KM,
      'км',
    );
    if (issue) issues.push(issue);
  }
  if (reading?.engineHoursAnomaly) {
    const issue = anomalyIssue(
      'моточасы',
      'anomaly_engine_hours',
      reading.engineHoursAnomaly,
      reading.engineHours,
      row.obs_date ?? row.row_date,
      ENGINE_HOURS_JUMP_PER_DAY,
      'ч',
    );
    if (issue) issues.push(issue);
  }

  return issues;
}

// ── Расхождения отчётов ──

/**
 * Сколько отчётов спрашивается разом. Каждый `loadReportById` держит своё соединение (внутри
 * транзакция), и день массового переназначения не должен выбирать пул целиком: очередь из десятка
 * дешевле, чем стоящие соседние запросы.
 */
const DISCREPANCY_BATCH = 8;

/**
 * Отчёты, у которых расхождение вообще возможно, — по самому набору, а не запросом на строку.
 *
 * Всякое расхождение модуля показаний (`source_state`, `driver`, `vehicle`, `date`,
 * `missing_source`) означает одно и то же на языке этого набора: снимок строки и живой источник
 * разошлись, то есть `aligned` ложно. Обратное неверно — разошедшихся координат бывает больше, чем
 * расхождений (аннулированный лист выводит рейс из ожидаемых, а расхождением модуль это не зовёт), —
 * и это ровно та сторона ошибки, которая безопасна: лишний отчёт спросят и не найдут в нём ничего.
 *
 * Отчёт без единой разошедшейся строки поэтому не спрашивается вовсе, и в обычный день таких
 * запросов нет ни одного. Спрашивается же именно `loadReportById` — единственное место, где
 * расхождения считаются: и отпечаток, и текст, и «разобрано ли» принадлежат модулю показаний
 * (Р7), а вторая их реализация здесь разошлась бы с первой на первой же правке.
 */
async function loadDiscrepancies(
  rows: readonly IntakeSqlRow[],
): Promise<Pick<IssueContext, 'byItem' | 'bySource'>> {
  const suspect = new Set<string>();
  for (const row of rows) {
    if (row.aligned) continue;
    if (row.exp_report_id !== null) suspect.add(row.exp_report_id);
    if (row.obs_report_id !== null) suspect.add(row.obs_report_id);
  }

  const byItem = new Map<string, ReportDiscrepancyDto[]>();
  const bySource = new Map<string, ReportDiscrepancyDto[]>();
  const push = (map: Map<string, ReportDiscrepancyDto[]>, key: string, d: ReportDiscrepancyDto) => {
    map.set(key, [...(map.get(key) ?? []), d]);
  };
  const ids = [...suspect];
  for (let at = 0; at < ids.length; at += DISCREPANCY_BATCH) {
    const batch = await Promise.all(
      ids.slice(at, at + DISCREPANCY_BATCH).map((id) => loadReportById(id)),
    );
    for (const report of batch) {
      for (const d of report.discrepancies) {
        if (d.resolved) continue;
        // Предмет расхождения уровня отчёта — сам источник: его виртуальная строка (Р26).
        if (d.kind === 'missing_source')
          push(bySource, `${report.id}|${d.sourceKind}:${d.sourceId}`, d);
        else if (d.itemId !== null) push(byItem, d.itemId, d);
      }
    }
  }
  return { byItem, bySource };
}

// ── Отчёты дня (Р9а) ──

/** Состояния, из которых отчёт вообще принимают: `acceptReport` перепроверит их под блокировками. */
const ACCEPTABLE_STATES: readonly DriverReportState[] = ['submitted', 'needs_reacceptance'];

/**
 * Счётчики отчётов — по ВСЕМ строкам периода (Р9а).
 *
 * Строка засчитывается отчёту, стоящему на **любой** её стороне: и тому, чей день ждёт показания
 * (живая координата), и тому, в чьём составе лежит её строка ожидания (снимочная). После
 * переназначения рейса это два разных отчёта, и оба обязаны увидеть проблему: у нового водителя
 * смена не закрыта, у прежнего — расхождение. Засчитай строку одному из них, и второй показал бы
 * себя пригодным к пакету, а пакетный приём упёрся бы в отказ `acceptReport`.
 */
function reportsOf(
  rows: readonly IntakeSqlRow[],
  levels: Map<string, 'green' | 'yellow' | 'red'>,
): ReadingIntakeReport[] {
  /** Порядок отчётов в ответе — тот же, что у строк: свежий день сверху, внутри дня по работнику. */
  interface Draft {
    report: ReadingIntakeReport;
    date: string;
  }
  const drafts = new Map<string, Draft>();

  const touch = (
    id: string | null,
    state: DriverReportState | null,
    version: number | null,
    row: IntakeSqlRow,
  ): void => {
    if (id === null || state === null || version === null) return;
    const draft = drafts.get(id) ?? {
      date: row.row_date,
      report: {
        reportId: id,
        personName: row.person_name ?? '',
        state,
        version,
        batchEligible: false,
        itemCount: 0,
        greenCount: 0,
      },
    };
    draft.report.itemCount += 1;
    if (levels.get(keyOf(row)) === 'green') draft.report.greenCount += 1;
    drafts.set(id, draft);
  };

  for (const row of rows) {
    touch(row.exp_report_id, row.exp_state, row.exp_report_version, row);
    // Второй раз одна строка одному отчёту не засчитывается: у сошедшихся координат это тот же id.
    if (row.obs_report_id !== row.exp_report_id) {
      touch(row.obs_report_id, row.obs_state, row.obs_report_version, row);
    }
  }

  return [...drafts.values()]
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        a.report.personName.localeCompare(b.report.personName) ||
        a.report.reportId.localeCompare(b.report.reportId),
    )
    .map(({ report }) => ({
      ...report,
      // Пакет берёт отчёты, где ВСЕ строки зелёные (Р8), и только те, которые вообще принимают.
      batchEligible:
        report.itemCount > 0 &&
        report.greenCount === report.itemCount &&
        ACCEPTABLE_STATES.includes(report.state),
    }));
}

// ── Наружу ──

/**
 * Реестр приёма за период: страница строк, отчёты периода целиком и серверное «сегодня».
 *
 * `now` приходит параметром, а не берётся внутри: тест обязан уметь спросить реестр «глазами
 * другого дня», не двигая часы процесса, — а Р23 требует лишь того, чтобы день считал сервер, а не
 * портал.
 */
export async function loadReadingIntake(
  period: { from: string; to: string; page: number; pageSize: number },
  now: Date = new Date(),
): Promise<ReadingIntakeDto> {
  const today = moscowDateKeyOf(now);
  const rows = await loadIntakeRows(period.from, period.to);
  const ctx: IssueContext = { today, ...(await loadDiscrepancies(rows)) };

  const built = rows.map((row) => {
    const reading = readingOf(row);
    const item: ReadingIntakeRow = {
      key: keyOf(row),
      itemId: row.item_id,
      // Отчёт строки — тот, чей день ждёт показания; у осиротевшей строки — тот, в чьём она составе.
      reportId: row.exp_report_id ?? row.obs_report_id,
      reportDate: row.row_date,
      vehicleId: row.row_vehicle,
      vehicleLabel: vehicleLabel({
        ownership: row.ownership,
        description: row.description,
        registrationNumber: row.registration_number,
        categoryName: row.category_name,
        typeName: row.type_name,
        modelName: row.model_name,
      }),
      personId: row.row_person,
      personName: row.person_name ?? '',
      sourceKind: row.source_kind,
      sourceLabel: sourceLabelOf(row),
      reading,
      issues: issuesOf(row, reading, ctx),
    };
    return item;
  });

  const levels = new Map(built.map((row) => [row.key, intakeLevel(row.issues)]));
  const reports = reportsOf(rows, levels);

  const offset = (period.page - 1) * period.pageSize;
  const items = built.slice(offset, offset + period.pageSize);
  await attachFileIds(items);

  return {
    items,
    total: built.length,
    page: period.page,
    pageSize: period.pageSize,
    from: period.from,
    to: period.to,
    today,
    reports,
  };
}

/**
 * Фотографии приборной панели — только у строк страницы: снимок открывают из строки, а не из
 * счётчика, и тянуть связи по всему периоду ради невидимых строк незачем.
 */
async function attachFileIds(items: readonly ReadingIntakeRow[]): Promise<void> {
  const ids = items.flatMap((row) => (row.reading === null ? [] : [row.reading.id]));
  if (ids.length === 0) return;
  const rows = await db
    .select({ readingId: vehicleReadingFiles.readingId, fileId: vehicleReadingFiles.fileId })
    .from(vehicleReadingFiles)
    .where(inArray(vehicleReadingFiles.readingId, ids))
    .orderBy(asc(vehicleReadingFiles.addedAt));
  const byReading = new Map<string, string[]>();
  for (const row of rows) {
    byReading.set(row.readingId, [...(byReading.get(row.readingId) ?? []), row.fileId]);
  }
  for (const item of items) {
    if (item.reading !== null) item.reading.fileIds = byReading.get(item.reading.id) ?? [];
  }
}
