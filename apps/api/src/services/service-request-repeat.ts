import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  SERVICE_REQUEST_REPEAT_KIND,
  SERVICE_REQUEST_REPEAT_TERMINAL_STATUSES,
  SERVICE_REQUEST_REPEAT_WINDOW_DISABLED,
  serviceRequestRepeatApplies,
  type ServiceRequestKind,
  type ServiceRequestRepeatDto,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import { serviceRequests } from '../db/schema';
import type { Principal } from '../auth/principal';
import { serviceRequestVisibilityWhere } from '../lib/access';

// ── Признак повторного обращения по аппарату (план `docs/office-equipment-repeat-request-plan.md`)
//
// ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ЖИВЁТ SQL-СЕМАНТИКА ПРАВИЛА Р1, и потребителей у неё четыре: строка
// списка (пакетный счёт на страницу), карточка заявки (тот же счёт по одной строке), отбор «только
// повторные» (`repeat=true` — условие в `WHERE`) и ссылка «предыдущие» (`repeatFor` — выборка тех
// же самых `P`). Разложи это правило по четырём местам — и метка обещала бы одно, а ссылка
// показывала бы другое: расхождение, которое §11 плана считает провалом приёмки (К3).
//
// СЕМАНТИКА — В КОНТРАКТАХ, SQL — ЗДЕСЬ (Р4): перечень терминальных статусов, вид заявки и смысл
// нулевого окна объявлены в `packages/contracts/src/service-requests.ts`, потому что о них
// спрашивают и портал, и тесты; drizzle со схемой БД в общий пакет за ними не тянется.
//
// ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: сравнения описаний. Первая версия отвечает не на «то же ли сломалось»,
// а на «по этому аппарату недавно уже была закрытая заявка» — и подписи в портале обязаны говорить
// именно это (§12). Никаких действий признак не запускает (Р9): ни срочности, ни писем, ни
// эскалации — ошибочная метка не вправе менять чужую работу.

/**
 * Псевдоним предыдущей заявки. Заявка соединяется сама с собой, и без него условие «тот же аппарат»
 * сравнивало бы колонку с самой собой.
 *
 * Имя длинное и с приставкой признака намеренно: этот псевдоним попадает в чужой запрос —
 * коррелированный `EXISTS` встраивается в выборку списка, где рядом живут `office_equipment` и
 * соединения справочников. Короткое `p` или `r` однажды столкнулось бы с соседним.
 */
const PREV = alias(serviceRequests, 'sr_repeat_prev');

/**
 * Сама заявка `R` в пакетном счёте. Нужна затем, чтобы аппарат и дату заведения брать колонками
 * базы, а не значениями, проехавшими через JS: там `timestamptz` теряет микросекунды (см. сборку
 * запроса ниже), и метка расходилась бы с отбором на границе окна.
 */
const CUR = alias(serviceRequests, 'sr_repeat_cur');

/** Таблица предыдущей заявки: либо псевдоним (список, карточка), либо сама таблица (`repeatFor`). */
type RepeatPrevTable = typeof serviceRequests | typeof PREV;

/**
 * Заявка `R`, для которой ищут предшественников, — в объёме правила Р1 и не больше.
 *
 * Ровно три реквизита, и каждый обязателен: вид (Р3), аппарат (условие 1) и `created_at`, от
 * которого отсчитывается окно (условие 4). Всё остальное — статус самой `R`, её область, её
 * содержание — правилу безразлично: повтором бывает и новая заявка, и давно закрытая.
 */
export interface ServiceRequestRepeatSubject {
  id: string;
  officeEquipmentId: string | null;
  kind: ServiceRequestKind;
  createdAt: Date;
}

/**
 * Стороны сравнения в SQL: три выражения заявки `R`. Выражениями, а не значениями, потому что `R`
 * приходит из трёх разных мест — из строки `VALUES` (пакетный счёт), из колонок внешнего запроса
 * (отбор `repeat=true`) и параметрами (`repeatFor`), — а условие обязано остаться одним.
 */
interface RepeatSubjectSql {
  id: SQL;
  equipmentId: SQL;
  createdAt: SQL;
}

/** Окно из настройки, если вызывающий не назвал своё (тесты называют — им нужны границы). */
function windowOrConfig(windowDays: number | undefined): number {
  return windowDays ?? config.serviceRequests.repeatWindowDays;
}

/**
 * ПРАВИЛО Р1 ЦЕЛИКОМ — шесть условий и ни одного текста:
 *
 * 1. тот же аппарат;
 * 2. предыдущая — ремонт (вид самой `R` проверяет `serviceRequestRepeatApplies` снаружи);
 * 3. предыдущая закрыта либо отменена;
 * 4. её `status_changed_at` — в окне `[R.created_at − W; R.created_at]`;
 * 5. она не в архиве и ВИДИМА СМОТРЯЩЕМУ;
 * 6. это не сама `R`.
 *
 * ДАТА ОКНА — `status_changed_at`, А НЕ `completed_at` И НЕ `accepted_at` (Р2, находка Н2). У
 * отменённой заявки первых двух нет вовсе, а `status_changed_at` есть всегда и означает ровно
 * «когда заявка встала в тот статус, в котором она сейчас»; у терминальной это и есть момент
 * закрытия. Цена решения названа планом: закрыли, откатили, закрыли снова — считается второе
 * закрытие (развилка В2).
 *
 * ОБЕ ГРАНИЦЫ ОКНА ВКЛЮЧЕНЫ, И ИНТЕРВАЛ — ПО TIMESTAMP, А НЕ ПО КАЛЕНДАРНЫМ ДАТАМ. `W days` здесь
 * — SQL-интервал от `R.created_at`, поэтому «ровно W дней назад» попадает, а на микросекунду
 * раньше — нет (§10.1, тест 1). Сравнение по датам сдвинуло бы границу на часовой пояс сервера и
 * растянуло бы окно на неполные сутки в одну сторону.
 *
 * ОКНО НЕ СКОЛЬЗИТ: оно привязано к `created_at` самой `R`, а не к сегодняшнему дню, — прошедший
 * месяц без единой правки ничего не меняет (§10.1, тест 11). Ночного «истечения метки» нет.
 *
 * ОБЛАСТЬ ЧИТАТЕЛЯ — ЧАСТЬ ПРАВИЛА, А НЕ ПРИПИСКА К НЕМУ (Р8, находка Н4). Число, посчитанное вне
 * области смотрящего, само по себе оракул: заявитель узнал бы, что по «его» аппарату есть заявки
 * соседнего отдела. Отсюда и главное свойство признака — число совпадает с тем, что человек
 * увидит по ссылке. `undefined` от предиката означает «сужать нечем» (администратор, сквозная
 * область набора), и `and` его законно проглатывает.
 */
function repeatMatchWhere(
  p: Principal,
  prev: RepeatPrevTable,
  r: RepeatSubjectSql,
  windowDays: number,
): SQL {
  return and(
    eq(prev.officeEquipmentId, r.equipmentId),
    eq(prev.kind, SERVICE_REQUEST_REPEAT_KIND),
    inArray(prev.status, [...SERVICE_REQUEST_REPEAT_TERMINAL_STATUSES]),
    isNull(prev.deletedAt),
    ne(prev.id, r.id),
    // Нижняя граница — тем же выражением, что в плане (§Р6): `W` умножается на суточный интервал,
    // а не вычитается днями из даты. Параметром, а не подстановкой в текст: значение приходит из
    // настройки, и текстовая склейка однажды приняла бы из окружения не число.
    gte(prev.statusChangedAt, sql`${r.createdAt} - (${windowDays}::integer * interval '1 day')`),
    lte(prev.statusChangedAt, r.createdAt),
    serviceRequestVisibilityWhere(p, {
      id: prev.id,
      objectId: prev.equipmentObjectId,
      customerDepartmentId: prev.customerDepartmentId,
      equipmentDepartmentId: prev.equipmentDepartmentId,
      serviceCounterpartyId: prev.serviceCounterpartyId,
    }),
  )!;
}

/** Строка агрегата: drizzle требует от типа результата индексной сигнатуры. */
interface RepeatCountRow extends Record<string, unknown> {
  id: string;
  cnt: number;
  last_at: Date | string | null;
}

/** `max(status_changed_at)` приходит от драйвера датой; строка бывает у нестандартных парсеров. */
function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * ПРИЗНАК ДЛЯ ЦЕЛОЙ СТРАНИЦЫ — ОДНИМ ЗАПРОСОМ, СКОЛЬКО БЫ СТРОК В НЕЙ НИ БЫЛО (Р6, К5).
 *
 * НЕ ГРУППИРОВКОЙ ПО АППАРАТУ, А БОКОВЫМ СОЕДИНЕНИЕМ, и это не вкусовщина. Условие 4 правила
 * сравнивает закрытие предыдущей заявки с `created_at` ТЕКУЩЕЙ, а у полусотни строк страницы
 * полсотни разных `created_at`. Сгруппировав по аппарату, мы посчитали бы одно число на аппарат и
 * приписали бы его заявке, заведённой год назад (§10.1, тест 9). Поэтому запрос принимает страницу
 * списком троек «заявка + её аппарат + её `created_at`» и считает каждую в СВОЁМ окне.
 *
 * НЕ КОРРЕЛИРОВАННЫМ ПОЛЕМ В СПИСКЕ `SELECT` ВЫБОРКИ СПИСКА (находка Н6): в односоставном запросе
 * drizzle такой подзапрос молча возвращает не то, что написано, — известная ловушка проекта
 * (`office-equipment-sql-correlation.test.ts`). Пакетный запрос по идентификаторам страницы — тот
 * же путь, которым в модуле уже ходят исполнители, гарантии и аудитории.
 *
 * `LEFT JOIN LATERAL (VALUES …) … ON true` — приём из аудита распознавания талонов
 * (`services/ticket-audit.ts`), а не изобретение ради одного признака. Соединение ЛЕВОЕ, поэтому
 * строка без единого совпадения не исчезает, а получает честный `count = 0`.
 *
 * ПРИ ВЫКЛЮЧЕННОМ ОКНЕ В БАЗУ НЕ ХОДИМ ВОВСЕ (Р5): пустая карта означает «признака нет ни у одной
 * строки», и поля `repeat` в DTO не появляется. То же самое возвращается, если на странице не
 * оказалось ни одной подходящей заявки — все расходники либо все без аппарата.
 */
export async function serviceRequestRepeatByRequest(
  p: Principal,
  rows: readonly ServiceRequestRepeatSubject[],
  windowDays?: number,
): Promise<Map<string, ServiceRequestRepeatDto>> {
  const window = windowOrConfig(windowDays);
  const result = new Map<string, ServiceRequestRepeatDto>();
  if (window <= SERVICE_REQUEST_REPEAT_WINDOW_DISABLED) return result;

  // Заявки, к которым признак применим вовсе (вид и аппарат) — тем же правилом, каким его читает
  // портал. Остальные не занимают места в `VALUES`: условие 1 на пустом аппарате и так ложно
  // (`NULL = NULL`), но строка-пустышка стоила бы бокового соединения, а правило должно читаться
  // словами, а не выводиться из свойств `NULL`.
  const subjects = rows.filter((row) => serviceRequestRepeatApplies(row, window));
  if (subjects.length === 0) return result;

  /*
   * В `VALUES` уезжают ТОЛЬКО идентификаторы, а аппарат и дату заведения запрос берёт колонками
   * самой заявки — соединением по этому идентификатору.
   *
   * ПОЧЕМУ НЕ ЗНАЧЕНИЯМИ ИЗ JS, КАК БЫЛО. `timestamptz` в базе хранит микросекунды, а `Date` в JS
   * заканчивается миллисекундой: отданная строкой ISO дата заведения теряла хвост, и обе границы
   * окна уезжали вниз на эту долю. Отбор «только повторные» при этом сравнивал ту же дату
   * колонкой, с полной точностью, — и заявка, заведённая внутри той же миллисекунды, в которую
   * закрыли предшественницу, получала в метке ноль и одновременно попадала в список. Ровно то
   * расхождение, против которого правило и сведено в один builder (К3 плана): совпасть числа
   * обязаны не «почти», а в точности, и добиваться этого округлением обеих сторон значило бы
   * держать в двух местах ещё и одинаковое правило округления.
   *
   * Приведение типа задаётся в КАЖДОЙ строке, а не в первой: параметр без приведения приехал бы
   * `unknown`, и сравнение `uuid = unknown` решалось бы правилами неявного приведения, а не нашим
   * намерением.
   */
  const values = sql.join(
    subjects.map((row) => sql`(${row.id}::uuid)`),
    sql`, `,
  );
  const match = repeatMatchWhere(
    p,
    PREV,
    {
      id: sql`${CUR.id}`,
      equipmentId: sql`${CUR.officeEquipmentId}`,
      createdAt: sql`${CUR.createdAt}`,
    },
    window,
  );

  const counted = await db.execute<RepeatCountRow>(sql`
    SELECT v.id::text AS id,
           count(m.id)::int AS cnt,
           max(m.status_changed_at) AS last_at
      FROM (VALUES ${values}) AS v(id)
      JOIN ${serviceRequests} ${CUR} ON ${CUR.id} = v.id
      LEFT JOIN LATERAL (
        SELECT ${PREV.id} AS id, ${PREV.statusChangedAt} AS status_changed_at
          FROM ${serviceRequests} ${PREV}
         WHERE ${match}
      ) m ON true
     GROUP BY v.id
  `);

  for (const row of counted.rows) {
    result.set(row.id, {
      count: Number(row.cnt),
      windowDays: window,
      lastAt: isoOrNull(row.last_at),
    });
  }
  /*
   * Строка, по которой агрегат почему-либо не вернулся, получает честный ноль, а не остаётся без
   * признака: «считали, повторов нет» и «признак к строке не применяется» — разные ответы (§6), и
   * подменять первый вторым значило бы гасить порталу отбор «только повторные» на ровном месте.
   * `GROUP BY` по `VALUES` таких строк не оставляет — эта ветка не подстраховка на случай ошибки,
   * а утверждение о форме ответа: у каждой применимой строки признак есть.
   */
  for (const row of subjects) {
    if (!result.has(row.id)) {
      result.set(row.id, { count: 0, windowDays: window, lastAt: null });
    }
  }
  return result;
}

/**
 * Признак одной заявки — карточка (Р10). Тем же запросом с одной тройкой в `VALUES`, а не вторым
 * правилом «для одной строки»: разойдись они, карточка и строка списка показывали бы разные числа
 * об одной заявке.
 *
 * `undefined` означает «признака нет»: окно выключено, заявка на расходники либо без аппарата.
 */
export async function serviceRequestRepeatOf(
  p: Principal,
  row: ServiceRequestRepeatSubject,
  windowDays?: number,
): Promise<ServiceRequestRepeatDto | undefined> {
  const map = await serviceRequestRepeatByRequest(p, [row], windowDays);
  return map.get(row.id);
}

/**
 * ОТБОР «ТОЛЬКО ПОВТОРНЫЕ» — условие для `WHERE` выборки списка (`repeat=true`).
 *
 * `EXISTS`, А НЕ СЧЁТ: фильтру нужен факт, а не число, и `EXISTS` останавливается на первом
 * совпадении. Стоит он в `WHERE`, а не в списке столбцов, — там коррелированный подзапрос
 * безопасен (Н6) и даёт обычный план запроса, покрываемый частичным индексом
 * `service_requests_repeat_idx` (Р7, миграция `0276`).
 *
 * ДВА УСЛОВИЯ ПРО САМУ `R` СТОЯТ СНАРУЖИ `EXISTS`: она обязана быть ремонтом (Р3) и иметь аппарат.
 * Второе формально следует из `NULL = NULL` внутри, но записано словами — и заявки без аппарата
 * отсекаются до бокового соединения, а не внутри него.
 *
 * ВЫКЛЮЧЕННОЕ ОКНО ДАЁТ ПУСТУЮ ВЫДАЧУ, А НЕ ОШИБКУ (§10.1, тест 8): `false` в `WHERE` — честный
 * ответ «повторных нет», а 422 на параметр, который портал помнит с прошлого сеанса (ADR 0139),
 * означал бы сломанный список у человека, ничего сегодня не нажимавшего.
 *
 * СЧЁТЧИК СТРАНИЦЫ И «ОТМЕТИТЬ ВСЕ ПРОЧИТАННЫМИ» ЗОВУТ ЭТО ЖЕ УСЛОВИЕ. Оно не зависит от формы
 * вмещающего запроса — ни одного соединения ему не нужно, — поэтому годится всем трём запросам
 * списка, как `hasClosingDocument` и отбор по состоянию кандидата рядом.
 */
export function serviceRequestRepeatWhere(p: Principal, windowDays?: number): SQL {
  const window = windowOrConfig(windowDays);
  if (window <= SERVICE_REQUEST_REPEAT_WINDOW_DISABLED) return sql`false`;
  const match = repeatMatchWhere(
    p,
    PREV,
    {
      id: sql`${serviceRequests.id}`,
      equipmentId: sql`${serviceRequests.officeEquipmentId}`,
      createdAt: sql`${serviceRequests.createdAt}`,
    },
    window,
  );
  return and(
    eq(serviceRequests.kind, SERVICE_REQUEST_REPEAT_KIND),
    isNotNull(serviceRequests.officeEquipmentId),
    sql`EXISTS (SELECT 1 FROM ${serviceRequests} ${PREV} WHERE ${match})`,
  )!;
}

/**
 * ССЫЛКА «ПРЕДЫДУЩИЕ» — условие выборки самих `P` по известной `R` (`repeatFor`, Р10).
 *
 * Здесь `P` — это ОСНОВНАЯ таблица запроса, а не псевдоним: список показывает предыдущие заявки
 * своими обычными строками, со своими соединениями и сортировкой. Правило при этом то же самое, и
 * в этом весь смысл ссылки: длина всех страниц обязана совпасть с `repeat.count`, посчитанным
 * меткой (К3), — а совпадёт она только тогда, когда условий не шесть похожих, а те же шесть.
 *
 * Текущая `R` в выдачу не входит (условие 6), поэтому вычитать её из счётчика не нужно.
 *
 * `false` — когда признак к `R` неприменим: окно выключено, заявка на расходники либо без
 * аппарата. Пустой список, а не ошибка: `404` на невидимую `R` отвечает маршрут до этого места, и
 * это другой вопрос — «есть ли такая заявка у этого читателя», а не «что у неё в предшественниках».
 */
export function serviceRequestRepeatPreviousWhere(
  p: Principal,
  subject: ServiceRequestRepeatSubject,
  windowDays?: number,
): SQL {
  const window = windowOrConfig(windowDays);
  if (!serviceRequestRepeatApplies(subject, window)) return sql`false`;
  return repeatMatchWhere(
    p,
    serviceRequests,
    {
      id: sql`${subject.id}::uuid`,
      equipmentId: sql`${subject.officeEquipmentId}::uuid`,
      createdAt: sql`${subject.createdAt.toISOString()}::timestamptz`,
    },
    window,
  );
}
