import { z } from 'zod';
import { requestStatusLabels, type RequestStatus, type VehicleRequestType } from './enums';
import {
  contactNameSchema,
  contactPhoneSchema,
  dateOnlySchema,
  PHONE_FORMAT_MESSAGE,
  uuidSchema,
} from './common';
import { dateKeySpan, shiftDateKey, weekStartKey } from './time';
import type { VehicleOwnership } from './vehicles';

// ── Недельная заявка на технику ──
//
// Документ-основание **над** заказами ТС, а не третий их тип: заявка ТС физически одномашинная
// (одно назначение на заявку, один лист ЭСМ-2 на пару «заявка + неделя», одно досрочное
// завершение), а неделя площадки — это семь единиц с разными сроками и одной визой. Согласование
// недельной заявки порождает и продлевает обычные заказы, и дальше всё работает как раньше.
//
// Модуль живёт в контрактах целиком, потому что каждое правило здесь спрашивают двое: форма
// сборки на портале («что предложить и чего не дать выбрать») и сервер («что принять и что
// применить»). Разъедься они — площадка увидела бы кнопку, которая всегда отказывает, либо
// получила бы отказ без причины.

/** Префикс отображаемого номера: «НЗ-12» (Р20 плана). */
export const WEEKLY_REQUEST_NUMBER_PREFIX = 'НЗ';

/**
 * Отображаемый номер недельной заявки: «НЗ-12». В БД хранится только число (identity-колонка) —
 * префикс живёт здесь по той же причине, что и у заявок ТС: на пакет ссылаются словами
 * («продлено по НЗ-12» в истории заказа), и вид ссылки должен быть один на портал и письма.
 */
export function formatWeeklyRequestNumber(num: number): string {
  return `${WEEKLY_REQUEST_NUMBER_PREFIX}-${num}`;
}

/** Разбор пользовательского ввода поиска: «12» / «НЗ-12» / «НЗ-000012» → 12. */
export function parseWeeklyRequestNumberSearch(input: string): number | undefined {
  const digits = input.replace(/\D/g, '');
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// ── Неделя ──
//
// Единица заявки — календарная неделя пн–вс (Р2). Понятие недели берётся существующим
// `weekStartKey`, которым режет свои периоды ЭСМ-2: второй реализации недели в портале быть не
// должно — иначе недельная заявка обещала бы не те листы, которые появятся.

/** Сколько ближайших недель предлагается в форме и принимается сервером (Р2). */
export const WEEKLY_SELECTABLE_WEEKS = 4;

/**
 * Границы недели: понедельник и воскресенье. Конец вычисляется, а не хранится — две колонки на
 * одно значение рано или поздно разойдутся (§6).
 *
 * Вход нормализуется `weekStartKey`: передали середину недели — вернутся границы её недели, а не
 * мусор. Так функция годится и там, где неделю выводят из произвольного дня (срез «На объекте»).
 */
export function weeklyWeekBounds(weekStart: string): { from: string; to: string } {
  const from = weekStartKey(weekStart);
  return { from, to: shiftDateKey(from, 6) };
}

/**
 * Месяцы в родительном падеже — «10–16 августа». Списком, а не `Intl`: подпись недели уходит и в
 * ответ API, и в письмо, и в заголовок страницы, и совпадать она обязана до буквы, тогда как
 * `toLocaleDateString` зависит от сборки среды (ICU) и от локали получателя.
 */
const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** Разбор календарного ключа на числа; `null` — ключ не разбирается. */
function splitDateKey(dateKey: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month, day: Number(m[3]) };
}

/** «11.08» — день и месяц для причин отказа и предупреждений: их читают, а не сортируют. */
function dayMonth(dateKey: string): string {
  const parts = splitDateKey(dateKey);
  if (!parts) return dateKey;
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}`;
}

/**
 * Неделя по-человечески: «10–16 августа 2026». Так её называют вслух, и именно так подписан выбор
 * в форме — «неделя с 2026-08-10» не читается никем.
 *
 * Три вида подписи, а не один: неделя переходит и через месяц («31 августа – 6 сентября 2026»), и
 * через год («29 декабря 2025 – 4 января 2026»). Повторять месяц и год там, где они совпадают,
 * значит удлинять подпись ради симметрии, которую никто не разглядывает.
 */
export function weeklyWeekLabel(weekStart: string): string {
  const { from, to } = weeklyWeekBounds(weekStart);
  const a = splitDateKey(from);
  const b = splitDateKey(to);
  // Неразобранный ключ показывается как есть: выдумывать за него дату нельзя — подпись стоит в
  // документе, и «сегодня» вместо мусора прочитали бы как согласованную неделю.
  if (!a || !b) return `${from} – ${to}`;
  const monthA = MONTHS_GENITIVE[a.month - 1];
  const monthB = MONTHS_GENITIVE[b.month - 1];
  if (a.year === b.year && a.month === b.month) {
    return `${a.day}–${b.day} ${monthA} ${a.year}`;
  }
  if (a.year === b.year) {
    return `${a.day} ${monthA} – ${b.day} ${monthB} ${a.year}`;
  }
  return `${a.day} ${monthA} ${a.year} – ${b.day} ${monthB} ${b.year}`;
}

/**
 * Недели, на которые заводят заявку: ближайшие `count` **будущих**, текущая исключена (Р2).
 *
 * Текущая неделя закрыта не из строгости: то, что нужно на этой неделе, заказывают обычной
 * заявкой, а продление задним числом относительно понедельника означало бы согласовать уже
 * отработанные дни. Отсчёт ведётся от понедельника недели `today`, поэтому и в понедельник, и в
 * воскресенье список один и тот же — «сегодня» внутри недели на выбор не влияет.
 */
export function selectableWeeks(today: string, count = WEEKLY_SELECTABLE_WEEKS): string[] {
  const current = weekStartKey(today);
  const weeks: string[] = [];
  for (let i = 1; i <= Math.max(0, Math.trunc(count)); i += 1) {
    weeks.push(shiftDateKey(current, 7 * i));
  }
  return weeks;
}

/**
 * Почему на эту неделю заявки не бывает — текстом, либо `null`, если неделя годится: понедельник,
 * будущая, в пределах предлагаемых.
 *
 * Отдельно от `selectableWeeks` потому, что тот защищает только экран, а тело запроса приходит и
 * мимо него. Сервер прогоняет проверку в пяти точках — предложение, создание, правка состава,
 * подача и применение под блокировкой (§8): черновик, заведённый в четверг на следующую неделю,
 * спокойно доживает до её понедельника, и без проверки на визе портал продлил бы сроки задним
 * числом относительно собственного правила.
 */
export function weeklyWeekBlocker(
  weekStart: string,
  today: string,
  count = WEEKLY_SELECTABLE_WEEKS,
): string | null {
  if (!splitDateKey(weekStart) || Number.isNaN(Date.parse(`${weekStart}T00:00:00Z`))) {
    return 'Неделя задаётся календарной датой понедельника (YYYY-MM-DD)';
  }
  // Не «выровняем к понедельнику», а откажем: пришедший вторник означает, что клиент считает
  // неделю по-своему, и молчаливое выравнивание согласовало бы не то, что он показывал человеку.
  if (weekStartKey(weekStart) !== weekStart) {
    return 'Неделя начинается с понедельника';
  }
  const weeks = selectableWeeks(today, count);
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  if (!first || !last) return 'Недельные заявки сейчас не заводятся';
  if (weekStart < first) {
    return weekStart < weekStartKey(today)
      ? `Неделя ${weeklyWeekLabel(weekStart)} уже прошла`
      : `Неделя ${weeklyWeekLabel(weekStart)} уже началась — на неё заявку подать нельзя, ` +
          'то, что нужно на этой неделе, заказывают обычной заявкой';
  }
  if (weekStart > last) {
    return `Неделя ${weeklyWeekLabel(weekStart)} слишком далеко: заявку заводят не дальше недели ${weeklyWeekLabel(last)}`;
  }
  return null;
}

// ── Статусы, виды строк и результаты применения ──

/**
 * Жизненный цикл документа: собирается → ждёт визы → завизирована и применена. Отдельного
 * «применить» нет: виза применяет заявку той же транзакцией (Р6), поэтому `applied` — это ровно
 * «завизирована», а состояния «виза есть, а сроки не сдвинулись» не существует.
 */
export const WEEKLY_REQUEST_STATUSES = ['draft', 'pending', 'applied', 'cancelled'] as const;
export type WeeklyRequestStatus = (typeof WEEKLY_REQUEST_STATUSES)[number];

/**
 * Значение статуса — фильтром списка и в DTO. Не путать с `weeklyRequestStatusSchema`: та —
 * тело перехода, и переходов человеку доступно всего два.
 */
export const weeklyRequestStatusValueSchema = z.enum(WEEKLY_REQUEST_STATUSES);

export const weeklyRequestStatusLabels: Record<WeeklyRequestStatus, string> = {
  draft: 'Черновик',
  pending: 'Ждёт визы',
  // Не «Завизирована»: подпись отвечает на вопрос площадки «сроки уже сдвинулись?» — а они
  // сдвигаются ровно визой.
  applied: 'Применена',
  cancelled: 'Снята',
};

/** Цвета те же, что у визы заявки ТС: ожидание — оранжевое, состоявшееся — зелёное. */
export const weeklyRequestStatusColors: Record<WeeklyRequestStatus, string> = {
  draft: 'default',
  pending: 'orange',
  applied: 'green',
  cancelled: 'red',
};

/**
 * Правится ли состав. До визы — да, любым, у кого есть право в своей области; после — заявка
 * становится историей (Р13): отменить применённую неделю значит сокращать сроки досрочным
 * завершением по каждой машине, и одной кнопкой этого не делается.
 */
export function isWeeklyRequestEditable(status: WeeklyRequestStatus): boolean {
  return status === 'draft' || status === 'pending';
}

/**
 * Вид строки состава (Р5, Р10). «Уезжает» — третий вид, а не отсутствие строки: недельный
 * документ отвечает на вопрос «что с каждой единицей», и пустой состав из-за снятых галок не
 * должен читаться как «решения не было».
 */
export const WEEKLY_ITEM_KINDS = ['extend', 'new', 'leave'] as const;
export type WeeklyRequestItemKind = (typeof WEEKLY_ITEM_KINDS)[number];

export const weeklyItemKindLabels: Record<WeeklyRequestItemKind, string> = {
  extend: 'Остаётся',
  new: 'Нужна дополнительно',
  leave: 'Уезжает',
};

/**
 * Результат строки после применения (Р9). `pending` — заявка ещё не применялась: хранимый
 * результат бывает только у применённой, а у оставшейся на визе объяснять нечего.
 */
export const WEEKLY_ITEM_RESULTS = ['pending', 'extended', 'created', 'left', 'skipped'] as const;
export type WeeklyRequestItemResult = (typeof WEEKLY_ITEM_RESULTS)[number];

export const weeklyItemResultLabels: Record<WeeklyRequestItemResult, string> = {
  pending: 'Не применялась',
  extended: 'Срок продлён',
  created: 'Заказ создан',
  left: 'Уезжает',
  skipped: 'Пропущена',
};

export const weeklyItemResultColors: Record<WeeklyRequestItemResult, string> = {
  pending: 'default',
  extended: 'green',
  created: 'blue',
  left: 'orange',
  // Красный: пропущенная строка — это то, что площадка просила и не получила, и увидеть её надо
  // раньше остальных.
  skipped: 'red',
};

// ── Годность строки ──

/**
 * Заказ ТС глазами недельной заявки — левая сторона всех проверок состава.
 *
 * Полей ровно столько, сколько спрашивают правила: и портал (у него строка суждения — DTO
 * заказа), и сервер (у него строка из-под `FOR UPDATE`) собирают этот объект сами.
 */
export interface WeeklySourceOrder {
  id: string;
  objectId: string | null;
  requestType: VehicleRequestType;
  status: RequestStatus;
  deletedAt: string | null;
  dateFrom: string;
  dateTo: string | null;
  /** Есть ли назначенная техника: без машины продлевать нечего. */
  hasAssignment: boolean;
}

/** Неделя и площадка заявки — правая сторона всех проверок состава. */
export interface WeeklyRequestScope {
  objectId: string;
  weekStart: string;
  weekEnd: string;
  /**
   * Активна ли площадка. Необязательно: спрашивает только строка `new` (создавать заказ на
   * погашенный объект нельзя, Р9), и заполняет поле сервер — состав справочника видит он.
   */
  objectIsActive?: boolean;
  /**
   * Сегодня по МСК. Необязательно и только для предупреждений: им отделяется лист ЭСМ-2, который
   * ещё можно аннулировать, от отработанной недели, которую сверка не трогает.
   */
  today?: string;
}

/**
 * Эффективный конец срока заказа — `coalesce(date_to, date_from)`. У однодневного заказа
 * `date_to` пуст, и читать его как «срока нет» нельзя: тем же выражением отбирают срез «На
 * объекте» и считают сводку смен, и снимок `expected_date_to` хранит именно его.
 */
export function orderEffectiveDateTo(order: { dateFrom: string; dateTo: string | null }): string {
  return order.dateTo || order.dateFrom;
}

/**
 * Почему строка, ссылающаяся на заказ, негодна: чужой объект, не спецтехника, не «В работе»,
 * в архиве, без назначения, срок вне окна недели, срок изменился после подачи.
 *
 * Общий для `extend` и `leave` — у отъезда те же вопросы к заказу, и второй список условий
 * разошёлся бы с первым при первой же правке.
 *
 * Принадлежность объекту проверяется всегда и первой: `source_request_id` — обычный внешний ключ,
 * и без явной проверки клиент подсунул бы заказ чужой площадки, а сервер продлил бы его.
 *
 * `expectedDateTo` — что видел составитель при подаче (Р14). `null` означает «снимка ещё нет»
 * (состав только собирается), и тогда срок ни с чем не сверяется. Сверяется именно срок, а не
 * версия заказа: версия растёт от любой правки, включая телефон ответственного, и выбрасывала бы
 * строки по поводам, к решению не относящимся.
 */
export function sourceItemBlocker(
  order: WeeklySourceOrder,
  weekly: WeeklyRequestScope,
  expectedDateTo: string | null,
): string | null {
  if (!order.objectId || order.objectId !== weekly.objectId) {
    return 'Заказ относится к другой площадке';
  }
  if (order.requestType !== 'special_equipment') {
    return 'Неделю собирают из заказов техники на объект: у грузоперевозки срока работ нет';
  }
  if (order.status !== 'confirmed') {
    return `Заказ не в статусе «${requestStatusLabels.confirmed}»`;
  }
  if (order.deletedAt) return 'Заказ в архиве';
  if (!order.hasAssignment) return 'На заказе нет назначенной техники';

  const last = orderEffectiveDateTo(order);
  // Заказ, заказанный за пределы недели, в состав не попадает вовсе: решать по нему на этой
  // неделе нечего — ни продлевать, ни отпускать. В шапке формы такие считаются отдельной строкой
  // («ещё 3 единицы заказаны дольше недели»).
  if (last >= weekly.weekEnd) {
    return `Срок заказа идёт до ${dayMonth(last)} — дальше недели заявки`;
  }
  // Машина, уехавшая в прошлом месяце, продлевается не продлением, а новым заказом: иначе период
  // заказа растянулся бы на недели простоя, за которые никто не выходил.
  if (last < shiftDateKey(weekly.weekStart, -7)) {
    return `Заказ кончился ${dayMonth(last)} — больше недели назад: нужен новый заказ, а не продление`;
  }
  if (expectedDateTo && expectedDateTo !== last) {
    return `Срок заказа изменился после подачи: было ${dayMonth(expectedDateTo)}, стало ${dayMonth(last)}`;
  }
  return null;
}

/**
 * То же плюс своё: дата продления лежит внутри недели заявки и **строго больше** нынешнего конца
 * срока (Р4).
 *
 * Последнее условие обязательно: иначе выходит скрытое сокращение — строку собрали, когда заказ
 * кончался во вторник, а до визы его продлили до пятницы, и «продлить до среды» отняло бы два дня
 * в обход досрочного завершения с визой (ADR 0044). В форме выбор дат ограничен снизу тем же
 * днём, на сервере — этим предикатом.
 */
export function extendBlocker(
  order: WeeklySourceOrder,
  weekly: WeeklyRequestScope,
  expectedDateTo: string | null,
  newDateTo: string,
): string | null {
  const source = sourceItemBlocker(order, weekly, expectedDateTo);
  if (source) return source;
  if (newDateTo < weekly.weekStart || newDateTo > weekly.weekEnd) {
    return `Продлевают до дня внутри недели заявки (${weeklyWeekLabel(weekly.weekStart)})`;
  }
  const last = orderEffectiveDateTo(order);
  if (newDateTo <= last) {
    return `Заказ и так идёт до ${dayMonth(last)}: продление не сокращает срок — сокращение согласуют досрочным завершением`;
  }
  return null;
}

/** Строка «нужна дополнительно» — то, что человек выбрал в форме (Р5). */
export interface WeeklyNewItem {
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  dateFrom: string;
  dateTo: string;
  responsibleName: string;
  responsiblePhone: string;
  deliveryNeeded: boolean;
  deliveryFrom: string;
}

/**
 * Состояние заказанной позиции классификатора (ADR 0028) — то, чего строка о себе не знает.
 * Портал берёт это из `VehicleClassificationDto`, сервер — из справочника под той же проверкой.
 */
export interface WeeklyItemClassification {
  typeIsActive: boolean;
  /** Активность выбранной категории; `null` — категория не выбрана. */
  categoryIsActive: boolean | null;
  /** Есть ли у типа категории: тогда позиция без категории неполна (ADR 0028). */
  hasCategories: boolean;
}

/**
 * Почему строка `new` негодна: погашенная площадка, погашенный тип или категория, неполная
 * позиция классификатора, срок вне недели, пустой контакт, доставка без места отправления.
 *
 * Проверяется наравне с `extend` и при применении тоже (Р9): деактивированный тип ТС в одной
 * строке не должен ронять неделю целиком, но и молча создавать заказ на погашенную позицию
 * классификатора нельзя.
 */
export function newItemBlocker(
  item: WeeklyNewItem,
  weekly: WeeklyRequestScope,
  classification: WeeklyItemClassification,
): string | null {
  if (weekly.objectIsActive === false) return 'Площадка погашена в справочнике';
  if (!classification.typeIsActive) return 'Тип ТС погашен в справочнике';
  if (classification.hasCategories && !item.vehicleCategoryId) {
    return 'У этого типа ТС выбирают категорию';
  }
  if (item.vehicleCategoryId && classification.categoryIsActive === false) {
    return 'Категория ТС погашена в справочнике';
  }
  if (item.dateTo < item.dateFrom) return 'Дата окончания раньше даты начала';
  if (item.dateFrom < weekly.weekStart || item.dateTo > weekly.weekEnd) {
    return `Срок строки выходит за пределы недели ${weeklyWeekLabel(weekly.weekStart)}`;
  }
  // Контакт обязателен ровно по той причине, что и в обычной заявке: машина выходит по заявке, а
  // о заезде, месте работ и допуске договариваются с человеком.
  if (!item.responsibleName.trim()) return 'Укажите ответственного на объекте';
  if (!/^\d{10}$/.test(item.responsiblePhone)) return PHONE_FORMAT_MESSAGE;
  if (item.deliveryNeeded && !item.deliveryFrom.trim()) {
    return 'Укажите, откуда доставить технику';
  }
  return null;
}

// ── Предупреждения строки ──

/**
 * Что строка говорит человеку до визы. Предупреждение — не отказ: каждое из этих состояний
 * допустимо, но узнать о нём надо **до** необратимого действия (Р13).
 */
export const WEEKLY_ITEM_WARNINGS = [
  'idle_days',
  'esm2_reissue',
  'early_end_pending',
  'rental',
  'other_weekly',
] as const;
export type WeeklyItemWarningKind = (typeof WEEKLY_ITEM_WARNINGS)[number];

export interface WeeklyItemWarning {
  kind: WeeklyItemWarningKind;
  /** Готовый текст: он одинаков в форме, в очереди визы и в ответе API. */
  text: string;
}

/**
 * Со скольких дней разрыва между концом срока и понедельником об этом говорят. Два дня — это
 * выходные, о которых сказать нечего; больше — уже простой, за который заказ платит.
 */
export const WEEKLY_IDLE_DAYS_THRESHOLD = 2;

/** Заказ вместе с тем, что о нём знает только сервер, — для предупреждений. */
export interface WeeklyWarningOrder extends WeeklySourceOrder {
  /** Чья машина назначена: арендной технике портал документов не выписывает (Р19). */
  ownership: VehicleOwnership | null;
  /** Дата ожидающего визы досрочного отъезда (ADR 0044); `null` — запроса нет. */
  pendingEarlyEndDate?: string | null;
  /** Другая активная недельная заявка, в составе которой этот заказ уже стоит (§8). */
  otherWeekly?: { num: number; weekStart: string } | null;
}

/**
 * Что показать под строкой: сплошное продление, перевыписка листа, ожидающий отъезд, аренда,
 * вторая неделя на тот же заказ.
 *
 * `newDateTo` — дата продления; `null` у строки `leave`, которая ничего не двигает и листов не
 * задевает.
 */
export function itemWarnings(
  order: WeeklyWarningOrder,
  weekly: WeeklyRequestScope,
  newDateTo: string | null,
): WeeklyItemWarning[] {
  const warnings: WeeklyItemWarning[] = [];
  const last = orderEffectiveDateTo(order);

  // Продление удлиняет период целиком, включая дни между старым концом и понедельником: у заказа
  // один период, и запретить это нельзя — но человек должен знать, за что платит (§13).
  const idle = dateKeySpan(shiftDateKey(last, 1), shiftDateKey(weekly.weekStart, -1));
  if (newDateTo && idle > WEEKLY_IDLE_DAYS_THRESHOLD) {
    warnings.push({
      kind: 'idle_days',
      text: `В срок войдут ${idle} дн. до начала недели — машина эти дни стоит на площадке`,
    });
  }

  // Лист ЭСМ-2 недели, в середине которой кончался заказ, при продлении аннулируется и
  // перевыписывается на всю неделю: номер бланка строгой отчётности при этом сгорает (§13).
  // Отработанная неделя сверкой не трогается — её лист закрыт, и предупреждать не о чем.
  const sourceWeekEnd = shiftDateKey(weekStartKey(last), 6);
  const sheetCancellable = !weekly.today || sourceWeekEnd >= weekly.today;
  if (newDateTo && order.ownership === 'own' && last !== sourceWeekEnd && sheetCancellable) {
    warnings.push({
      kind: 'esm2_reissue',
      text: `Лист ЭСМ-2 недели ${weeklyWeekLabel(last)} будет аннулирован и перевыписан — номер бланка сгорит`,
    });
  }

  // Молчаливого снятия ожидающего отъезда здесь не бывает (Р15): в недельной заявке состав
  // предвыбран целиком, и снятие десятка чужих решений оптом — не то, что делают галкой.
  if (order.pendingEarlyEndDate) {
    warnings.push({
      kind: 'early_end_pending',
      text: `Есть запрос на досрочный отъезд ${dayMonth(order.pendingEarlyEndDate)} — решите его или подтвердите продление`,
    });
  }

  // Нейтральным состоянием, а не красным «не выписано»: иначе неделя с арендой всегда выглядела
  // бы незаконченной (Р19).
  if (order.ownership && order.ownership !== 'own') {
    warnings.push({
      kind: 'rental',
      text: 'ЭСМ-2 и перегон ведёт арендодатель — портал документов на арендную технику не выписывает',
    });
  }

  // Запрета на две недели у одного заказа нет намеренно: планировать через неделю нормально, а
  // порядок применения разрешается сроком сам. Но видеть это человек должен заранее (§8).
  if (order.otherWeekly) {
    warnings.push({
      kind: 'other_weekly',
      text: `Заказ уже стоит в ${formatWeeklyRequestNumber(order.otherWeekly.num)} (${weeklyWeekLabel(order.otherWeekly.weekStart)})`,
    });
  }
  return warnings;
}

// ── Схемы запросов ──
//
// Чего в теле нет и быть не может (§7): `week_start` строки (берётся у шапки), `expected_date_to`
// (читается из самого заказа в момент сохранения состава — приняв его от клиента, сервер
// пропустил бы через визу продление заказа, срок которого давно другой), `previous_date_to`,
// `applied_source_version`, `snapshot_vehicle_id`, `created_request_id`, `result`, `skip_reason`,
// `approved_by`, `approved_at`, `applied_at`, `num`. Отсюда `.strict()` на каждой схеме: молча
// проглоченное лишнее поле — это ровно тот случай, когда клиент считает, что задал снимок.
//
// Исключение одно — `version`, и оно такое же, как в остальном портале: это не значение колонки,
// а токен оптимистичной блокировки. Сервер сверяет его с текущей версией и присваивает колонке
// своё `version + 1`; записать пришедшее число нельзя ни при каком раскладе.

const commentSchema = z.string().trim().max(2000);
const versionSchema = z.number().int().nonnegative();
/** Откуда доставить технику: адресная строка портала (ADR 0069). */
const deliveryFromSchema = z.string().trim().max(1000);

/**
 * «Остаётся»: ссылка на заказ и дата, по которую продлить. Ни типа ТС, ни контакта, ни доставки
 * здесь нет — они принадлежность строки `new`, и CHECK базы держит ту же развилку: иначе в базе
 * заводится «продление с запрошенной доставкой», которого никто не собирался разрешать.
 */
export const extendWeeklyItemSchema = z
  .object({
    kind: z.literal('extend'),
    sourceRequestId: uuidSchema,
    /** День внутри недели заявки; границы и «строго больше нынешнего конца» проверяет сервер. */
    dateTo: dateOnlySchema,
    /** Явное согласие снять ожидающий запрос на досрочный отъезд (Р15). */
    earlyEndOverride: z.boolean().optional().default(false),
    comment: commentSchema.optional().default(''),
  })
  .strict();

/**
 * «Нужна дополнительно»: позиция классификатора, срок внутри недели, контакт встречающего и
 * доставка по желанию. Конкретную машину строка не называет — её подбирает диспетчер при переводе
 * в работу: площадка не видит парка и не знает занятости.
 */
export const newWeeklyItemSchema = z
  .object({
    kind: z.literal('new'),
    vehicleTypeId: uuidSchema,
    // Категория передаётся вместе с типом: `null` — заказан тип без категорий. Требовать выбор
    // там, где категории есть, может только сервер — состав справочника видит он.
    vehicleCategoryId: uuidSchema.nullish(),
    dateFrom: dateOnlySchema,
    dateTo: dateOnlySchema,
    responsibleName: contactNameSchema,
    responsiblePhone: contactPhoneSchema,
    deliveryNeeded: z.boolean().optional().default(false),
    deliveryFrom: deliveryFromSchema.optional().default(''),
    comment: commentSchema.optional().default(''),
  })
  .strict();

/**
 * «Уезжает»: одна ссылка на заказ. Дат нет — срок кончится сам, и вторая дата здесь означала бы
 * сокращение срока в обход визы досрочного завершения (ADR 0044).
 */
export const leaveWeeklyItemSchema = z
  .object({
    kind: z.literal('leave'),
    sourceRequestId: uuidSchema,
    comment: commentSchema.optional().default(''),
  })
  .strict();

/**
 * Строка состава. Разбор по `kind`, а не «все поля необязательны»: у трёх видов строки три разных
 * обязательных набора, и общая схема с `optional()` принимала бы «уезжает с типом ТС» — то самое,
 * что CHECK `weekly_items_kind_shape_check` не пускает в базу.
 */
export const weeklyRequestItemSchema = z
  .discriminatedUnion('kind', [extendWeeklyItemSchema, newWeeklyItemSchema, leaveWeeklyItemSchema])
  .superRefine((v, ctx) => {
    if (v.kind !== 'new') return;
    if (v.dateTo < v.dateFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateTo'],
        message: 'Дата окончания раньше даты начала',
      });
    }
    // Границы недели схеме неизвестны — неделя живёт в шапке; здесь проверяется только то, что
    // видно самой строке (`newItemBlocker` добьёт остальное на сервере и в форме).
    if (v.deliveryNeeded && !v.deliveryFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['deliveryFrom'],
        message: 'Укажите, откуда доставить технику',
      });
    }
  });
export type WeeklyRequestItemInput = z.infer<typeof weeklyRequestItemSchema>;

/**
 * Состав правится целиком (массив переписывается), а не операциями «добавить строку»: две
 * одновременные правки иначе соберут дубли — тем же приёмом, что `routeOrderSchema`.
 *
 * Порядок строк задаёт сам массив, поля `position` в теле нет: вторая нумерация разошлась бы с
 * порядком массива, и `UNIQUE (weekly_request_id, position)` отвечал бы 409 на ровном месте.
 */
const itemsSchema = z.array(weeklyRequestItemSchema).max(100, 'Слишком много строк в составе');

/**
 * Заведение недельной заявки: площадка, неделя и состав. Пустой состав допустим — черновик
 * заводят и до того, как решили по каждой единице; подать его сервер не даст (§9).
 *
 * Неделя приходит от клиента, но проверяется сервером `weeklyWeekBlocker`: `selectableWeeks`
 * защищает только экран.
 */
export const createWeeklyRequestSchema = z
  .object({
    objectId: uuidSchema,
    weekStart: dateOnlySchema,
    items: itemsSchema.optional().default([]),
    comment: commentSchema.optional().default(''),
  })
  .strict();
export type CreateWeeklyRequestInput = z.infer<typeof createWeeklyRequestSchema>;
export type CreateWeeklyRequestBody = z.input<typeof createWeeklyRequestSchema>;

/**
 * Правка состава. Ни объекта, ни недели: пара «объект + неделя» — это тождество документа
 * (частичный `UNIQUE`), и смена любой её половины означала бы другую заявку, а не правку этой.
 */
export const updateWeeklyRequestSchema = z
  .object({
    items: itemsSchema,
    comment: commentSchema.optional(),
    version: versionSchema,
  })
  .strict();
export type UpdateWeeklyRequestInput = z.infer<typeof updateWeeklyRequestSchema>;
export type UpdateWeeklyRequestBody = z.input<typeof updateWeeklyRequestSchema>;

/**
 * Переходы, которые делает составитель: подать и снять. Визы и применения здесь нет — они
 * приходят одним решением через `approveWeeklyRequestSchema` (Р6), а `draft` возвращает отказ
 * визирующего, а не эта ручка: «вернуть себе черновик» — это не переход, а отсутствие подачи.
 */
export const WEEKLY_REQUEST_ACTIONS = [
  'pending',
  'cancelled',
] as const satisfies readonly WeeklyRequestStatus[];

export const weeklyRequestStatusSchema = z
  .object({
    status: z.enum(WEEKLY_REQUEST_ACTIONS),
    reason: commentSchema.optional().default(''),
    version: versionSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    // Причина снятия обязательна — как у отмены заявки ТС: документ площадки исчезает из очереди,
    // и «почему» спросят через неделю у того, кто уже не помнит.
    if (v.status === 'cancelled' && !v.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Укажите причину снятия' });
    }
  });
export type WeeklyRequestStatusInput = z.infer<typeof weeklyRequestStatusSchema>;
export type WeeklyRequestStatusBody = z.input<typeof weeklyRequestStatusSchema>;

/**
 * Виза либо отказ — одним маршрутом, как виза заявки ТС и решение по досрочному завершению: у них
 * одно право, одна область и один инвариант «пока заявка ждёт визы». Виза применяет заявку той же
 * транзакцией (Р6), поэтому версия обязательна и доходит до сервиса: согласуют тот состав,
 * который видел визирующий.
 */
export const approveWeeklyRequestSchema = z
  .object({
    approved: z.boolean(),
    comment: commentSchema.optional().default(''),
    version: versionSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    // Отклонённая заявка возвращается в черновик, и причина показывается сверху в ней самой (§5
    // шаг 5): тому, кто открыл её править, надо видеть, что именно не устроило.
    if (!v.approved && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отклонения' });
    }
  });
export type ApproveWeeklyRequestInput = z.infer<typeof approveWeeklyRequestSchema>;
export type ApproveWeeklyRequestBody = z.input<typeof approveWeeklyRequestSchema>;

// ── DTO ──

/** «5 продлений, 2 новых, 1 уезжает» — итог состава, который показывают и в списке, и в очереди визы. */
export interface WeeklyItemCounts {
  extend: number;
  new: number;
  leave: number;
}

/**
 * Строка состава: что выбрал человек, снимок момента применения и результат.
 *
 * Реквизиты заказа и машины едут join'ом, а не снимком: карточка показывает их сегодняшними — их
 * могли уточнить. Снимком хранится только то, что отвечает на вопрос «что было согласовано»
 * (Р14): срок до изменения, версия переписанного заказа и идентичность машины.
 */
export interface WeeklyRequestItemDto {
  id: string;
  position: number;
  kind: WeeklyRequestItemKind;

  /** Заказ, к которому относится строка (`extend`, `leave`); `null` у строки `new`. */
  sourceRequestId: string | null;
  sourceRequestNum: number | null;
  /** «ТС-341». */
  sourceDisplayNumber: string | null;
  sourceStatus: RequestStatus | null;
  sourceDateFrom: string | null;
  sourceDateTo: string | null;

  /** Заказанная позиция классификатора (`new`); `null` у строк, ссылающихся на заказ. */
  vehicleTypeId: string | null;
  vehicleTypeName: string | null;
  vehicleCategoryId: string | null;
  vehicleCategoryName: string | null;

  /** Срок строки: у `new` — период внутри недели, у `extend` — только дата продления. */
  dateFrom: string | null;
  dateTo: string | null;
  responsibleName: string;
  responsiblePhone: string;
  deliveryNeeded: boolean;
  deliveryFrom: string;
  comment: string;
  /** Явное согласие снять ожидающий досрочный отъезд (Р15). */
  earlyEndOverride: boolean;

  /** Эффективный конец срока заказа, каким его видел составитель при подаче (Р14). */
  expectedDateTo: string | null;
  /** Снимок момента применения: срок до изменения. */
  previousDateTo: string | null;
  /** Версия заказа, которую переписало применение. Диагностика и история, в проверках не участвует. */
  appliedSourceVersion: number | null;
  /** Машина, стоявшая на заказе в момент применения; подпись берётся join'ом — она сегодняшняя. */
  snapshotVehicleId: string | null;
  /** Машина заказа сейчас — правая сторона сравнения «машина изменилась после согласования». */
  currentVehicleId: string | null;
  currentVehicleLabel: string | null;
  /** Порождённый заказ (`new`, результат `created`). */
  createdRequestId: string | null;
  createdRequestNum: number | null;

  result: WeeklyRequestItemResult;
  /** Почему строка пропущена; пусто у всех остальных результатов. */
  skipReason: string;
  /** Предупреждения строки — те же, что видел составитель (`itemWarnings`). */
  warnings: WeeklyItemWarning[];
}

/** Недельная заявка целиком: шапка, состав и всё, что о ней спрашивают экраны. */
export interface WeeklyVehicleRequestDto {
  id: string;
  num: number;
  /** «НЗ-12». */
  displayNumber: string;

  objectId: string;
  objectCode: string | null;
  objectName: string;

  weekStart: string;
  /** Воскресенье недели: вычисляется, а не хранится, — но в DTO едет, чтобы не считался дважды. */
  weekEnd: string;
  /** «10–16 августа 2026» — подпись одна на портал, письма и ответы API. */
  weekLabel: string;

  status: WeeklyRequestStatus;
  comment: string;
  /** Причина снятия; заполнена только у снятых заявок. */
  cancelReason: string;

  /**
   * Виза руководителя строительства. Заполнена ровно у применённой заявки: виза и применение —
   * одно событие (Р6), и «завизирована, но не применена» физически невозможно.
   */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  appliedAt: string | null;

  items: WeeklyRequestItemDto[];
  counts: WeeklyItemCounts;

  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedByName: string | null;
  updatedAt: string;
  version: number;
}

/** Заказ среза, предложенный в состав: строка таблицы «что остаётся» и «что уезжает». */
export interface WeeklySuggestionOrderDto {
  requestId: string;
  num: number;
  displayNumber: string;
  dateFrom: string;
  dateTo: string | null;
  /** `coalesce(date_to, date_from)` — он же уйдёт в `expected_date_to` при сохранении состава. */
  effectiveDateTo: string;
  vehicleTypeName: string;
  vehicleCategoryName: string | null;
  vehicleId: string | null;
  vehicleLabel: string | null;
  ownership: VehicleOwnership | null;
  /** Дата, до которой продлить по умолчанию, — воскресенье недели. */
  suggestedDateTo: string;
  /** Отмечена ли строка умолчанием: строка с ожидающим отъездом приходит не включённой (Р15). */
  included: boolean;
  warnings: WeeklyItemWarning[];
}

/** Заказ, который в состав не годится, — с причиной от `sourceItemBlocker`. */
export interface WeeklyBlockedOrderDto {
  requestId: string;
  displayNumber: string;
  reason: string;
}

/**
 * Предложение состава (§5 шаг 2). Четыре списка, а не один с флагами: у них разная судьба —
 * `extend` предлагается отмеченным, `leaving` ждёт решения об отъезде, `beyond` в состав не
 * входит вовсе (в шапке считается строкой «ещё 3 единицы заказаны дольше недели»), `blocked`
 * объясняет, почему знакомой машины в списке нет.
 */
export interface WeeklySuggestionDto {
  objectId: string;
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  extend: WeeklySuggestionOrderDto[];
  leaving: WeeklySuggestionOrderDto[];
  beyond: WeeklySuggestionOrderDto[];
  blocked: WeeklyBlockedOrderDto[];
  /**
   * Черновик на эту пару «объект + неделя», если он уже есть: кнопка открывает его, а не заводит
   * второй — `UNIQUE` всё равно не даст (Р3).
   */
  existingRequestId: string | null;
}

/** Строка итога применения — по одной на каждую строку состава. */
export interface WeeklyApplyItemResultDto {
  itemId: string;
  kind: WeeklyRequestItemKind;
  result: WeeklyRequestItemResult;
  /** Заказ, которого действие коснулось: продлённый либо порождённый. */
  requestId: string | null;
  displayNumber: string | null;
  previousDateTo: string | null;
  newDateTo: string | null;
  /** Почему пропущена; пусто у применённых строк. */
  skipReason: string;
  /**
   * Сняло ли применение ожидавший визы запрос на досрочный отъезд (Р15). Отдельным полем, а не
   * молчанием: строку включали в состав явным согласием, и чужое решение об отъезде, отменённое
   * этим согласием, обязано быть видно и в ответе, и в истории заказа.
   */
  earlyEndDropped: boolean;
}

/**
 * Итог применения (Р9): «применено 5, пропущено 2» с причинами. Уходит ответом и хранится в
 * строках — у применённой заявки он объясняет разницу между согласованным и сделанным.
 *
 * Сгоревшие номера бланков — отдельным списком: перевыписка листа ЭСМ-2 нормальная работа сверки,
 * но номер строгой отчётности она расходует, и молча этого делать нельзя (§13).
 */
export interface WeeklyApplyResultDto {
  weeklyRequestId: string;
  status: WeeklyRequestStatus;
  applied: number;
  skipped: number;
  items: WeeklyApplyItemResultDto[];
  esm2: {
    requestId: string;
    /** Аннулированные листы — номерами: их спросят у того, кто ведёт журнал бланков. */
    cancelled: string[];
    /** Сколько листов выписано заново. */
    issued: number;
  }[];
}

/**
 * Состояние документа в чек-листе недели. `lessor` — не «нет документа», а «ведёт арендодатель»
 * (Р19): красным такая строка сделала бы неделю с арендой вечно незаконченной. `missing`, наоборот,
 * — то, чего ждут от диспетчера: вывоз не оформлен.
 */
export const WEEKLY_DOCUMENT_STATES = ['issued', 'awaiting', 'lessor', 'missing', 'none'] as const;
export type WeeklyDocumentState = (typeof WEEKLY_DOCUMENT_STATES)[number];

export const weeklyDocumentStateLabels: Record<WeeklyDocumentState, string> = {
  issued: 'Выписан',
  awaiting: 'Будет при назначении',
  lessor: 'Ведёт арендодатель',
  missing: 'Не оформлен',
  none: '—',
};

export const weeklyDocumentStateColors: Record<WeeklyDocumentState, string> = {
  issued: 'green',
  awaiting: 'blue',
  lessor: 'default',
  missing: 'red',
  none: 'default',
};

/** Клетка чек-листа: состояние плюс номер бланка, если он есть. */
export interface WeeklyDocumentCellDto {
  state: WeeklyDocumentState;
  /** Номер бланка — его показывают и тому, у кого нет права печати (§5 шаг 6). */
  number: string | null;
  /** Готовый текст клетки: «ведёт арендодатель», «вывоз не оформлен», «№ …4901». */
  text: string;
}

/** Строка чек-листа готовности недели (§5 шаг 6). */
export interface WeeklyDocumentRowDto {
  itemId: string;
  kind: WeeklyRequestItemKind;
  /** Как строка называется человеку: «Экскаватор (продление)». */
  title: string;
  requestId: string | null;
  displayNumber: string | null;
  vehicleLabel: string | null;
  /**
   * Машину переназначили **после** применения (Р14): снимок разошёлся с текущим назначением.
   * Переназначение между подачей и визой сюда не попадает — снимок берётся при применении.
   */
  vehicleChanged: boolean;
  ownership: VehicleOwnership | null;
  /**
   * Виза порождённого или продлённого заказа. Отдельной колонкой, потому что она с заказа может
   * слететь позже: содержательная правка лицом без права визы её снимает (Р8), и «неделя
   * согласована» без этой колонки читалось бы как «всё поедет».
   */
  approved: boolean;
  esm2: WeeklyDocumentCellDto;
  /** Перегон: доставка новой техники либо вывоз уезжающей (Р10, Р11). */
  relocation: WeeklyDocumentCellDto;
  result: WeeklyRequestItemResult;
  skipReason: string;
}

/** Чек-лист готовности недели — экран, ради которого модуль и делается (§5 шаг 6). */
export interface WeeklyRequestDocumentsDto {
  weeklyRequestId: string;
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  applied: number;
  skipped: number;
  rows: WeeklyDocumentRowDto[];
}
