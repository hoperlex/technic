import { z } from 'zod';
import { requestStatusLabels, type RequestStatus, type VehicleRequestType } from './enums';
import {
  contactNameSchema,
  contactPhoneSchema,
  dateOnlySchema,
  PHONE_FORMAT_MESSAGE,
  uuidSchema,
} from './common';
import { can, type AccessSubject, type Permission } from './permissions';
import {
  type BackdateAccess,
  dateKeySpan,
  shiftDateKey,
  WAYBILL_CORRECTION_DAYS,
  weekStartKey,
} from './time';
// Граница глубины берётся у самого заднего числа (ADR 0101): нижний предел недели и отказ
// `backdateGuard` на визе обязано считать одно и то же выражение — иначе форма предложила бы
// неделю, на которой ручка отвечает «слишком давно». Тем же импортом живёт `vehicle-routes.ts`.
import { correctionFloorDateKey } from './waybills';
// Предел разблокировки один на все входы коррекции: 53 недели — календарный год (ADR 0101, Р11).
// Второй перечень того же числа разошёлся бы с первым при первой же правке.
import { ESM2_UNLOCK_LIMIT } from './vehicle-requests';
import { formatVehicleRouteNumber } from './vehicle-routes';
import type { VehicleOwnership } from './vehicles';
// Отпечаток и подписи предупреждений — те же, что у дверей истории назначения (ADR 0218 решение 8):
// аннулирование подтверждает последствия тем же рукопожатием, и своя форма отпечатка разошлась бы
// с чужой при первой же правке алгоритма хеширования.
import {
  assignmentAcknowledgementsSchema,
  assignmentFingerprintSchema,
} from './assignment-periods';

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

// ── Просроченная неделя (ADR 0101, режим прошлого) ──
//
// Неделя, которая уже началась или прошла, была закрыта наглухо: заявку на неё нельзя было ни
// завести, ни подать, ни завизировать. Это оказалось той же дырой, что у дат заявок до ADR 0101:
// техника отработала неделю, документа-основания у продления нет, и площадка либо просит
// диспетчера продлить сроки мимо портала, либо оформляет заявку «сегодняшней неделей», в которой
// написано не то, что было. Теперь неделя открывается **правом прошлого** — тем же
// `waybills.correct`, той же глубиной и с той же ценой: причина, запись операции и след в журнале
// коррекций (см. `docs/adr/0101-backdated-correction.md`).
//
// Всё, что о прошлом, спрашивается **на визе**: заведение и подача ничего не двигают, и требовать
// от них объяснение значило бы спрашивать причину у черновика.

/**
 * Сколько прошедших недель предлагается, когда прошлое открыто правом.
 *
 * Предел нужен ровно одному случаю — `waybills.correctBeyondLimit`: границы глубины у него нет
 * вовсе (`minRequestDateKey` отвечает `null`), и список недель без собственного предела оказался бы
 * бесконечным. Восемь недель — два месяца: глубина `waybills.correct` (30 дней) укладывается в них
 * целиком с запасом, а администратору, которому нужно глубже, селект не единственный вход — неделя
 * приходит телом запроса, и там её проверяет `weeklyWeekBlocker`, а не длина списка.
 */
export const WEEKLY_PAST_SELECTABLE_WEEKS = 8;

/**
 * Просрочена ли неделя — то есть началась или прошла.
 *
 * Одним сравнением на оба случая: право у них по решению заказчика одно (право прошлого), и
 * различать «началась» и «прошла» предикатом значило бы завести два ответа на вопрос, у которого
 * ответ один. Различаются они только текстом отказа и вердиктом `backdateGuard`: у начавшейся
 * недели воскресенье ещё впереди, и задним числом такая виза не считается.
 */
export function isWeeklyWeekOverdue(weekStart: string, today: string): boolean {
  return weekStart <= today;
}

/**
 * Эффективная дата операции над неделей — её воскресенье.
 *
 * Конец недели, а не понедельник: той же границей `canCancelWaybill` считает лист ЭСМ-2
 * отработанным, и второй расчёт того же «когда неделя кончилась» разошёлся бы с первым на шесть
 * дней — то есть на целую границу глубины у недели, лежащей на её краю. По этой же дате
 * `esm2SyncPlan` решает, выписывать ли неделе бумагу.
 */
export function weeklyWeekEffectiveDate(weekStart: string): string {
  return weeklyWeekBounds(weekStart).to;
}

/**
 * Прошедшие недели, на которые заявку ещё можно завести, — сестра `selectableWeeks` для режима
 * прошлого. Ею форма создания наполняет вторую половину селекта.
 *
 * Порядок восходящий и заканчивается **текущей** неделей: список читают сверху вниз как календарь,
 * а «эта неделя» стоит вплотную к первой будущей из `selectableWeeks` — вместе они и есть один
 * непрерывный выбор.
 *
 * Права нет — пусто, а не «весь список серым»: недоступный вариант в селекте обещает то, чем ручка
 * отвечает отказом. Граница глубины считается по воскресенью недели, тем же концом, каким её
 * считает виза, — иначе список предлагал бы неделю, на которой `backdateGuard` скажет «слишком
 * давно».
 */
export function pastSelectableWeeks(
  today: string,
  access: BackdateAccess,
  count = WEEKLY_PAST_SELECTABLE_WEEKS,
): string[] {
  if (!access.correct) return [];
  const current = weekStartKey(today);
  const floor = access.beyondLimit ? null : correctionFloorDateKey(today);
  const weeks: string[] = [];
  for (let i = Math.max(0, Math.trunc(count)); i >= 0; i -= 1) {
    const week = shiftDateKey(current, -7 * i);
    if (floor && weeklyWeekEffectiveDate(week) < floor) continue;
    weeks.push(week);
  }
  return weeks;
}

/**
 * Каким правом визируется эта неделя.
 *
 * Обычную (будущую) визирует руководитель строительства — `weeklyRequests.approve`, как и было.
 * Просроченную визирует тот, у кого есть право прошлого: виза применяет заявку той же транзакцией,
 * а применение просроченной недели жжёт номера отработанных бланков и выписывает бумагу за уже
 * прошедшие дни — это работа диспетчера, а не подпись площадки. Матрица ролей при этом не
 * менялась: право визы осталось там же, просто на просроченной неделе спрашивается другое.
 *
 * Правило возвращает **право**, а не «да/нет», потому что спрашивают его двое: портал (кнопка
 * «Завизировать») и сервер (страж и обработчик), и второй перечень тех же двух случаев разошёлся
 * бы с первым — кнопка предлагала бы то, чем ручка отвечает отказом.
 */
export function weeklyApprovalPermission(weekStart: string, today: string): Permission {
  return isWeeklyWeekOverdue(weekStart, today) ? 'waybills.correct' : 'weeklyRequests.approve';
}

/** Есть ли у субъекта право визы **этой** недели; область спрашивается отдельно и рядом. */
export function canApproveWeeklyWeek(
  subject: AccessSubject | null | undefined,
  weekStart: string,
  today: string,
): boolean {
  return can(subject, weeklyApprovalPermission(weekStart, today));
}

/**
 * Почему на эту неделю заявки не бывает — текстом, либо `null`, если неделя годится: понедельник,
 * в пределах предлагаемых, а прошлое — в пределах глубины права.
 *
 * Отдельно от `selectableWeeks` потому, что тот защищает только экран, а тело запроса приходит и
 * мимо него. Сервер прогоняет проверку в пяти точках — предложение, создание, правка состава,
 * подача и применение под блокировкой (§8): черновик, заведённый в четверг на следующую неделю,
 * спокойно доживает до её понедельника, и без проверки на визе портал продлил бы сроки задним
 * числом относительно собственного правила.
 *
 * Режим прошлого снимает ровно два запрета из этого списка — «уже прошла» и «уже началась». Формат,
 * понедельник и верхняя граница будущего остаются: они не про прошлое, а про то, что документ
 * вообще осмыслен. Взамен появляется нижняя граница — глубина права
 * (`WAYBILL_CORRECTION_DAYS`, снимается `waybills.correctBeyondLimit`), и считается она по
 * воскресенью недели: тем же концом, каким её считает виза.
 */
export function weeklyWeekBlocker(
  weekStart: string,
  today: string,
  count = WEEKLY_SELECTABLE_WEEKS,
  /**
   * Что субъекту позволено задним числом. Не передан — прошлое закрыто, как было до режима
   * прошлого: вызывающие, у которых субъекта нет вовсе (форма без учётки, разбор тела до
   * авторизации), спрашивают прежнее правило и не обязаны знать о новом.
   */
  past?: BackdateAccess,
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
  const last = weeks[weeks.length - 1];
  if (!last) return 'Недельные заявки сейчас не заводятся';
  if (weekStart > last) {
    return `Неделя ${weeklyWeekLabel(weekStart)} слишком далеко: заявку заводят не дальше недели ${weeklyWeekLabel(last)}`;
  }
  // Будущая неделя — прежнее правило целиком: понедельник строго после сегодняшнего дня и не
  // дальше последней предлагаемой.
  if (!isWeeklyWeekOverdue(weekStart, today)) return null;
  if (!past?.correct) {
    return weekStart < weekStartKey(today)
      ? `Неделя ${weeklyWeekLabel(weekStart)} уже прошла`
      : `Неделя ${weeklyWeekLabel(weekStart)} уже началась — на неё заявку подать нельзя, ` +
          'то, что нужно на этой неделе, заказывают обычной заявкой';
  }
  // Второе право в одиночку предела не снимает — тем же порядком его читает `backdateGuard`:
  // сперва право, потом глубина.
  if (!past.beyondLimit && weeklyWeekEffectiveDate(weekStart) < correctionFloorDateKey(today)) {
    return (
      `Неделя ${weeklyWeekLabel(weekStart)} кончилась больше ${WAYBILL_CORRECTION_DAYS} дней ` +
      'назад — такую давность проводит администратор, попросите его завизировать заявку'
    );
  }
  return null;
}

// ── Статусы, виды строк и результаты применения ──

/**
 * Document lifecycle: composed → awaiting approval → approved and applied. There is no separate
 * "apply": approval applies the request in the same transaction (R6), so `applied` means exactly
 * "approved", and a state "approved, yet no term moved" does not exist.
 *
 * One edge goes back (ADR 0219): `applied → pending`, the return for re-approval. It reverses every
 * consequence and clears the approval, so the invariant above holds on both sides of it — a
 * returned week is an ordinary pending one, and its next approval applies it from scratch.
 *
 * Two states are terminal and must not be confused (ADR 0218): `cancelled` is "withdrawn before
 * approval, no consequences", `annulled` is "approved, consequences reversed". The order of values
 * repeats the database enum (`annulled` before `cancelled`, migration `0354`): `ORDER BY status`
 * follows it, and diverging orders would sort the list differently from what the dictionary says.
 */
export const WEEKLY_REQUEST_STATUSES = [
  'draft',
  'pending',
  'applied',
  'annulled',
  'cancelled',
] as const;
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
  annulled: 'Аннулирована',
  cancelled: 'Снята',
};

/**
 * Цвета те же, что у визы заявки ТС: ожидание — оранжевое, состоявшееся — зелёное.
 *
 * У аннулированной цвет свой (`volcano`), а не красный «Снятой»: это разные события, и один цвет
 * на оба читался бы как «ничего не было», тогда как у аннулированной виза была и номера бланков
 * сгорели.
 */
export const weeklyRequestStatusColors: Record<WeeklyRequestStatus, string> = {
  draft: 'default',
  pending: 'orange',
  applied: 'green',
  annulled: 'volcano',
  cancelled: 'red',
};

/**
 * Whether the **composition** may be edited. Before approval — yes, by anyone holding the right in
 * their scope; after it the request is history: an applied or annulled composition never changes.
 *
 * Since ADR 0218 this no longer means "nothing can be done after approval". Annulment reverses the
 * **consequences** and keeps the rows with their results: they answer "what was decided and what
 * was undone", and the document state is told by the header. The return for re-approval
 * (ADR 0219) reverses the same consequences but resets the rows to `pending`, because the week is
 * approved again and its rows must be applicable; the previous results go to the history event.
 */
export function isWeeklyRequestEditable(status: WeeklyRequestStatus): boolean {
  return status === 'draft' || status === 'pending';
}

/**
 * Действует ли документ, занимая пару «объект + неделя».
 *
 * Два терминальных состояния сюда не входят, и предикат заведён ровно затем, чтобы это правило
 * было одно (ADR 0218 решение 12): кроме частичного уникального индекса «живость» недели
 * спрашивают ещё три места — создание заявки, предложение состава и предупреждение о другой
 * активной неделе, — и каждое сверяло `status <> 'cancelled'` своей строкой. Добавление второго
 * терминального статуса такой перечень молча бы пропустило.
 */
export function isWeeklyRequestLive(status: WeeklyRequestStatus): boolean {
  return status !== 'cancelled' && status !== 'annulled';
}

/**
 * Применялась ли заявка, то есть есть ли у неё следствия в заказах.
 *
 * `annulled` отвечает `true`: следствия были, их развернули, и ссылки строк по-прежнему держат
 * заказы, типы и категории (ADR 0218 решение 9 — уборка при удалении насовсем аннулированную
 * заявку не чистит).
 */
export function isWeeklyRequestApplied(status: WeeklyRequestStatus): boolean {
  return status === 'applied' || status === 'annulled';
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
  /**
   * Оформленный вывоз — рейс-перегон по этому заказу (`vehicle_routes.purpose = 'pickup'`).
   * `null` — вывоза нет.
   *
   * Поле одиночное, а не список, потому что таким его держит база: частичный
   * `vehicle_routes_source_request_unique` на пару `(source_request_id, purpose)` разрешает по
   * одному вывозу на заказ.
   */
  pickupRoute: { num: number; routeDate: string } | null;
  /**
   * Решение «уезжает», уже принятое **другой** применённой недельной заявкой. `null` — такого
   * решения нет.
   *
   * Только номер: заявку называют им, и вопрос «где это решили» им и закрывается.
   */
  leftBy: { num: number } | null;
  /** Дата ожидающего визы досрочного отъезда (ADR 0044); `null` — запроса нет. */
  pendingEarlyEndDate: string | null;
  /**
   * Машинист заказа стоит в справочнике снятой карточкой (план `machinist-card-removal`, Э4).
   *
   * Продлению это не мешает — бумага наследует того, кто уже в ней напечатан (Р6), — но человек,
   * визирующий неделю, обязан знать, что очередной бланк строгой отчётности выпишется на
   * удалённого. Иначе портал делает это молча, и узнают об этом в бухгалтерии заказчика.
   */
  machinistCardRemoved: boolean;
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
 * в архиве, без назначения, вывоз уже назначен или заявлен, срок вне окна недели, срок изменился
 * после подачи.
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

  // Единица, чей отъезд уже назначен или заявлен, в неделю не идёт ни продлением, ни отъездом:
  // решение по ней принято, и второе решение о той же машине этому первому противоречило бы.
  // Проверки стоят до сроков намеренно — «вывоз оформлен» объясняет исчезновение машины точнее,
  // чем «срок кончился неделю назад», а причина показывается ровно одна.
  //
  // Молча такая единица не пропадает: она уходит в `blocked` с текстом, иначе штаб не поймёт, куда
  // делась знакомая машина, и заведёт вторую строку.
  if (order.pickupRoute) {
    return (
      `Вывоз оформлен рейсом ${formatVehicleRouteNumber(order.pickupRoute.num)} на ` +
      `${dayMonth(order.pickupRoute.routeDate)} — отмените рейс, если техника остаётся`
    );
  }
  if (order.leftBy) {
    return `Уезжает по ${formatWeeklyRequestNumber(order.leftBy.num)} — решение уже принято`;
  }
  // Ожидающий визы запрос на отъезд — тоже заявленный вывоз (Р15 в редакции плана «Отбор
  // состава»): снять чужое решение неделя не вправе, а согласовать продление поверх нерешённого
  // запроса значило бы завизировать два противоположных решения об одной машине. Решённый —
  // одобренный или отклонённый — здесь не при чём: запись о нём остаётся историей, а `pending`
  // у него больше нет.
  if (order.pendingEarlyEndDate) {
    return (
      `Запрос на досрочный отъезд ${dayMonth(order.pendingEarlyEndDate)} ждёт визы — ` +
      'решите его, потом собирайте неделю'
    );
  }

  const last = orderEffectiveDateTo(order);
  // Заказ, заказанный **дальше** недели, в состав не попадает вовсе: решать по нему на этой неделе
  // нечего — ни продлевать, ни отпускать. В шапке формы такие считаются отдельной строкой («ещё 3
  // единицы заказаны дольше недели»).
  //
  // Граница строгая: срок ровно до воскресенья — это последний день недели заявки, и решение по
  // такой единице как раз и принимают — «уезжает». Продлить её внутри этой недели нельзя
  // арифметически, и об этом отвечает `extendBlocker` словами «заказ и так идёт до …»; второго
  // описания одного запрета здесь не заводится.
  if (last > weekly.weekEnd) {
    return `Срок заказа идёт до ${dayMonth(last)} — дальше недели заявки (по ${dayMonth(weekly.weekEnd)})`;
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
 *
 * Оно же отвечает единице, чей срок идёт ровно до воскресенья недели заявки: в составе она стоит
 * (по ней принимают решение «уезжает»), но продлить её внутри этой недели нечем — дня строго
 * позже воскресенья в неделе нет. Ответ здесь один на оба случая; в форме он приезжает полем
 * `WeeklySuggestionOrderDto.extendBlockedReason` и гасит вариант «Остаётся».
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
 *
 * Ожидающего досрочного отъезда среди них больше нет: он стал причиной негодности строки
 * (`sourceItemBlocker`) — такая единица в неделю не попадает вовсе, и предупреждать о ней некому.
 */
export const WEEKLY_ITEM_WARNINGS = [
  'idle_days',
  'esm2_reissue',
  'machinist_removed',
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
  /** Другая активная недельная заявка, в составе которой этот заказ уже стоит (§8). */
  otherWeekly?: { num: number; weekStart: string } | null;
}

/**
 * Что показать под строкой: сплошное продление, перевыписка листа, аренда, вторая неделя на тот же
 * заказ.
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

  /*
   * Лист ЭСМ-2, на котором кончался заказ, при продлении аннулируется и перевыписывается: номер
   * бланка строгой отчётности при этом сгорает (§13). Отработанное сверкой не трогается — тот лист
   * закрыт, и предупреждать не о чем.
   *
   * Лист назван **днём, который он накрывает**, а не неделей, и это не стилистика (ADR 0126).
   * Пока лист и неделя — одно и то же, «лист недели» было верно; после разреза в неделе законно
   * живут два листа с разными машинами, и аннулируется из них ровно тот, что накрывает последний
   * день заказа. Обещание «лист недели такой-то» стало бы неправдой дважды: и про границы, и про
   * состав. Функция при этом остаётся чистой — листов она не читает и читать не должна: её ответ
   * нужен форме до всякого запроса.
   *
   * Условие от режима не зависит: заказ, кончающийся ровно в воскресенье, продлевают, не трогая
   * старой бумаги — новый лист начнётся с понедельника. Кончающийся в середине — расширяет свой
   * лист, каким бы тот ни был.
   */
  const sourceWeekEnd = shiftDateKey(weekStartKey(last), 6);
  const sheetCancellable = !weekly.today || sourceWeekEnd >= weekly.today;
  if (newDateTo && order.ownership === 'own' && last !== sourceWeekEnd && sheetCancellable) {
    warnings.push({
      kind: 'esm2_reissue',
      text: `Лист ЭСМ-2, накрывающий ${dayMonth(last)}, будет аннулирован и перевыписан — номер бланка сгорит`,
    });
  }

  // Снятая карточка машиниста (план `machinist-card-removal`, Э4): предупреждение, а не блокер.
  // Продлить заказ с таким машинистом можно и нужно — иначе заявка встаёт целиком, — но сказать об
  // этом надо до визы, а не после первого напечатанного бланка.
  if (newDateTo && order.ownership === 'own' && order.machinistCardRemoved) {
    warnings.push({
      kind: 'machinist_removed',
      text: 'Машинист заказа снят из справочника — листы ЭСМ-2 выпишутся на удалённую карточку; назначьте другого в карточке заказа',
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
 *
 * Согласия снять чужой запрос на досрочный отъезд здесь тоже нет: единица с нерешённым запросом в
 * состав не идёт вовсе (`sourceItemBlocker`), и второй, недостижимый способ отменить чужое решение
 * модулю не нужен. Колонка `early_end_override` в базе остаётся историей уже применённых заявок.
 */
export const extendWeeklyItemSchema = z
  .object({
    kind: z.literal('extend'),
    sourceRequestId: uuidSchema,
    /** День внутри недели заявки; границы и «строго больше нынешнего конца» проверяет сервер. */
    dateTo: dateOnlySchema,
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
/**
 * Причина операции задним числом. Своя, потому что общая (`backdateReasonSchema`) объявлена
 * приватной в схемах заказа ТС, а вынести её в общее место значило бы тронуть четыре чужие ручки
 * ради одной строки. Форма и предел совпадают дословно — расходиться им нечем: обе описывают одно
 * поле «объясните правку прошедшего дня».
 */
const weeklyBackdateReasonSchema = z.string().trim().min(1, 'Укажите причину').max(2000);

/**
 * Признак коррекции у визы недельной заявки — явным блоком, а не догадкой сервера.
 *
 * Устроен так же, как `correctAssignmentSchema` у смены назначения (ADR 0101, Р8), и по той же
 * причине: догадаться по телу нельзя. Виза просроченной недели двигает сроки заказов за уже
 * прошедшие дни, жжёт номера отработанных бланков и выписывает бумагу задним числом — цену эту
 * называет человек, а не выводит сервер из даты в шапке.
 *
 * Авторизацией блок при этом **не является**. Право (`waybills.correct`), глубину
 * (`WAYBILL_CORRECTION_DAYS` от воскресенья недели), область площадки и принадлежность названных
 * листов заказам состава сервер спрашивает сам и всегда: тело перечисляет намерение, а не
 * разрешение.
 *
 * Обязателен ли блок, схема не решает: неделя лежит в шапке заявки, а не в теле визы, и ответ на
 * этот вопрос знает только сервер, прочитавший её под блокировкой.
 */
export const weeklyCorrectionSchema = z
  .object({
    /** Ключ идемпотентности (Р31 ADR 0101): повтор после обрыва связи не проводит неделю дважды. */
    operationId: uuidSchema,
    /** Причина операции: она же уходит в аннулированные и выписанные листы (Р35 ADR 0101). */
    reason: weeklyBackdateReasonSchema,
    /**
     * Листы ЭСМ-2 отработанных недель, которые операция правит, — идентификаторами, а не
     * понедельниками: после линейной техники в одной неделе законно живут листы двух машин
     * (ADR 0100 п. 7), и понедельник как ключ разблокировал бы не тот лист или сразу оба.
     *
     * Пусто — отработанные недели не трогаются вовсе: проведение тогда лишь двигает сроки и
     * выписывает бумагу тем прошедшим неделям, у которых листа нет вовсе.
     */
    unlockWaybillIds: z.array(uuidSchema).max(ESM2_UNLOCK_LIMIT).optional().default([]),
  })
  .strict();
export type WeeklyCorrectionInput = z.infer<typeof weeklyCorrectionSchema>;
export type WeeklyCorrectionBody = z.input<typeof weeklyCorrectionSchema>;

/**
 * Отказ визе просроченной недели без блока коррекции. Текст называет и цену, и то, чего не хватает:
 * «нужна причина» без объяснения, за что она, читается как придирка формы.
 */
export const WEEKLY_CORRECTION_REQUIRED_MESSAGE =
  'Неделя уже началась или прошла: провести её можно только коррекцией задним числом — укажите причину и ключ операции. Причина останется в журнале коррекций и в выписанных листах';

export const approveWeeklyRequestSchema = z
  .object({
    approved: z.boolean(),
    comment: commentSchema.optional().default(''),
    version: versionSchema,
    /**
     * Блок коррекции: нужен ровно у просроченной недели и приходит только с визой. Отсутствие его
     * у обычной недели — не «забыли», а нормальное состояние: будущая неделя о прошлом ничего не
     * утверждает.
     */
    correction: weeklyCorrectionSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Отказ возвращает заявку в черновик и не двигает ни одного срока — корректировать ему нечего.
    // Молча проглотить блок нельзя: клиент, приславший его с отказом, считает, что просроченную
    // неделю этим действием закрыли, а её никто не трогал.
    if (!v.approved && v.correction) {
      ctx.addIssue({
        code: 'custom',
        path: ['correction'],
        message: 'Отказ ничего не двигает — блок коррекции прикладывают только к визе',
      });
    }
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
   * Разворот применённой заявки (ADR 0218): кто аннулировал, когда и почему. Заполнено ровно у
   * аннулированной — CHECK схемы держит полную развилку, а не три «или».
   */
  annulledBy: string | null;
  annulledByName: string | null;
  annulledAt: string | null;
  annulReason: string;

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
  /**
   * Дата, до которой продлить по умолчанию, — воскресенье недели. `null` — продлевать эту единицу
   * нечем: её срок и так идёт до воскресенья (см. `extendBlockedReason`).
   *
   * Тип именно `string | null`, а не «воскресенье всегда»: отдай сервер дату, которую он же тут
   * же и отвергнет, — форма подставила бы её в решение, и «Остаётся» снова стало бы доступным.
   */
  suggestedDateTo: string | null;
  /**
   * Почему по этой единице нельзя выбрать «Остаётся»; `null` — можно. Текстом, как отвечают все
   * предикаты модуля (Р4), и считает его **сервер** тем же `extendBlocker`: разойдись форма с
   * сервером, площадка видела бы вариант, который всегда отказывает.
   *
   * Живой случай ровно один — срок, идущий ровно до воскресенья недели заявки: продлевать внутри
   * этой недели нечего, а решение «оставить дальше» принимает заявка на следующую неделю.
   */
  extendBlockedReason: string | null;
  /**
   * Отмечена ли строка умолчанием: единица, которую продлить нельзя, приходит без решения — за
   * неё выбирают «Уезжает» или не выбирают ничего.
   */
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
 * Отчёт по прошлой неделе: что из последней применённой заявки этой площадки предлагается дальше,
 * а что выбыло и почему.
 *
 * Блок нужен потому, что преемственность недель — правило, а не побочный эффект среза: каждая
 * следующая заявка пытается продлить все позиции прошлой, и позиция, вышедшая из среза (закрыта
 * фактом, отменена, откачена в «Новую», потеряла назначение), обязана быть объяснена, а не
 * исчезнуть молча.
 *
 * «Прошлая» — это **последняя применённая** заявка объекта, а не «неделя минус семь дней»: неделю
 * могли пропустить, и тогда преемственность тянется от той, что была.
 */
export interface WeeklyPreviousWeekDto {
  weeklyRequestId: string;
  num: number;
  /** «10–16 августа 2026» — та же подпись, что у самой заявки. */
  weekLabel: string;
  /** Сколько позиций прошлой недели пришли в предложение годными. */
  carried: number;
  /** Выбывшие — каждая с причиной: без неё исчезновение знакомой машины не объясняется ничем. */
  dropped: { displayNumber: string; reason: string }[];
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
   * Отчёт по последней применённой заявке этой площадки; `null` — её ещё не было. Отдельным
   * блоком, а не пометкой на строках: вопрос у него свой — «всё ли, что решали неделю назад,
   * доехало до этой недели».
   */
  previous: WeeklyPreviousWeekDto | null;
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
   * Сняло ли применение ожидавший визы запрос на досрочный отъезд.
   *
   * У недельной заявки это всегда `false`, и так теперь и задумано: единица с нерешённым запросом
   * в состав не идёт вовсе (`sourceItemBlocker`), а снимать чужое решение оптом неделя не вправе.
   * Поле остаётся ответом общего сервиса правки срока (`extendSpecialEquipmentPeriod`), которым
   * пользуются оба пути, — и молчания на месте снятого чужого решения не бывает ни в одном из них.
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
  /**
   * Номера бланков — их показывают и тому, у кого нет права печати (§5 шаг 6).
   *
   * Список, а не один номер (ADR 0142): у недели, в которой кончается месяц, листов ЭСМ-2 два —
   * «31–31 августа» и «1–6 сентября», — и клетка, называющая первый, молчала бы о втором. У
   * перегона номер по-прежнему один, и список у него из одного элемента.
   */
  numbers: string[];
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
  /**
   * Состояние обратного хода строки (ADR 0218): чем её развернуть и что мешает.
   *
   * Считает сервер тем же предикатом, которым считает команда (`weeklyAnnulItemState`). Портал
   * посчитать это не может и не должен: в строке чек-листа нет ни статуса заказа, ни его
   * эффективного конца, ни ожидающего отъезда, ни недель, решивших позже, — а была бы, второе
   * описание правила разошлось бы с первым молча.
   *
   * `null` у заявки, которую ещё не применяли: разворачивать нечего.
   */
  reversal: {
    state: WeeklyAnnulState;
    reason: string;
    reverse: WeeklyAnnulReversal;
    /** Дата, к которой вернётся срок; `null` у остальных ходов. */
    shortenTo: string | null;
  } | null;
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

// ── Предпросмотр проведения просроченной недели ──
//
// Читающая половина визы: та же работа теми же функциями, но без единой правки. Окно показывает ею
// цену операции — какие номера сгорят, за какие недели появится бумага, какая у операции
// эффективная дата и докуда достаёт глубина субъекта, — и её запреты, если провести неделю нельзя.
//
// Расхождение предпросмотра и исполнения здесь недопустимо ровно по той же причине, по какой
// `buildEsm2SyncPlan` считает план один раз на оба входа: диалог обещает человеку сгоревшие номера,
// и обещание верно ровно до тех пор, пока считает его та же работа, что и исполняет.

/** Действующий лист ЭСМ-2 заказа состава — его номером окно называет то, что сгорит. */
export interface WeeklyCorrectionSheetDto {
  waybillId: string;
  requestId: string;
  /** «ТС-341» — заказ, к которому подшит лист. */
  displayNumber: string;
  /** «260604-646-00000004897» — как номер напечатан на бланке. */
  number: string;
  periodFrom: string;
  periodTo: string;
}

/** Неделя, за которую проведение выпишет бумагу само: листа у неё нет вовсе. */
export interface WeeklyCorrectionWeekDto {
  requestId: string;
  displayNumber: string;
  from: string;
  to: string;
}

/** Что проведение этой недели тронет в прошлом — посчитанное до первой правки. */
export interface WeeklyCorrectionPreviewDto {
  weeklyRequestId: string;
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  /** Сегодня по МСК — им портал считает всё то же, что и сервер, и не спрашивает часы браузера. */
  today: string;
  /** Просрочена ли неделя: ровно от этого зависит, нужен ли блок коррекции. */
  overdue: boolean;
  /** Эффективная дата операции — воскресенье недели. */
  effectiveDate: string;
  /**
   * Пройдёт ли операция **задним числом** — вердикт того же `backdateGuard`, что решает на визе.
   * У начавшейся, но не кончившейся недели он `false`: воскресенье ещё впереди, прошлого нет.
   */
  backdated: boolean;
  /**
   * Нижняя граница глубины этого субъекта; `null` — предела нет
   * (`waybills.correctBeyondLimit`). Ею окно объясняет, почему неделя доступна или нет.
   */
  correctionFloor: string | null;
  /** Может ли этот субъект провести неделю: право визы этой недели плюс область площадки. */
  allowed: boolean;
  /** Почему провести нельзя, текстом; `null` — можно. */
  blockedReason: string | null;
  /**
   * Листы отработанных недель, которые человек может назвать к перевыписке
   * (`correction.unlockWaybillIds`). Неназванный лист остаётся нетронутым, а его неделя — закрытой
   * для выписки: разблокировка адресная и сама в стороны не растёт.
   */
  unlockable: WeeklyCorrectionSheetDto[];
  /** Прошедшие недели без листа: их проведение выпишет само, получив контекст операции. */
  pastWeeks: WeeklyCorrectionWeekDto[];
}

// ── Аннулирование применённой недели (ADR 0218) ──
//
// Виза недели той же транзакцией продлила заказы, породила новые и зафиксировала решения
// «уезжает». Аннулирование разворачивает **следствия**: сроки возвращаются к снимку
// `previous_date_to`, порождённые заказы отменяются, решения «уезжает» перестают действовать.
// Строки состава при этом не переписываются — состояние документа сказано шапкой (решение 9).
//
// Ветвей две, и выбирает их **эффективная дата операции** — первый снимаемый день. Не раньше
// сегодня — обычная ветвь, журнала коррекций нет; раньше — ветвь коррекции под правом прошлого,
// как проведение просроченной недели (ADR 0116). Правило живёт здесь, потому что спрашивают его
// двое: окно (какую цену назвать и чем подписать) и сервер (что принять и чем авторизовать).

/**
 * Состояние обратного хода строки. Третье значение — не удобство, а условие работоспособности
 * (решение 4): поштучный путь остаётся, и неделя, у которой одну строку уже развернули руками,
 * иначе оказалась бы заперта навсегда.
 */
export const WEEKLY_ANNUL_STATES = ['reversible', 'reverted', 'blocked'] as const;
export type WeeklyAnnulState = (typeof WEEKLY_ANNUL_STATES)[number];

/** Что именно сделает аннулирование со строкой: ею окно подписывает ход, а сервер исполняет. */
export const WEEKLY_ANNUL_REVERSALS = ['shorten_to', 'cancel', 'release_leave', 'none'] as const;
export type WeeklyAnnulReversal = (typeof WEEKLY_ANNUL_REVERSALS)[number];

/**
 * Серверные препятствия — кодом и текстом, приёмом `VEHICLE_REQUEST_ROLLBACK_BLOCKERS`
 * (ADR 0211 решение 3).
 *
 * Они не живут предикатами здесь, потому что считаются **планом**: подпись дня, заморозка рейса и
 * состояние листа лежат в таблицах, которых у строки состава нет. Но текст у них один на отказ и
 * на окно — иначе человек увидел бы препятствие, названное двумя способами.
 */
export const WEEKLY_ANNUL_BLOCKERS = ['approved_shift', 'frozen_day', 'locked_sheet'] as const;
export type WeeklyAnnulBlockerCode = (typeof WEEKLY_ANNUL_BLOCKERS)[number];

export interface WeeklyAnnulBlockerDto {
  code: WeeklyAnnulBlockerCode;
  /** Строка состава, к которой относится препятствие. */
  itemId: string;
  /** Дни, которыми препятствие объясняется: подписанные смены, замороженные дни. */
  dates: string[];
  message: string;
}

/**
 * Какое право аннулирует эту неделю — приёмом `weeklyApprovalPermission` (ADR 0116 п. 1) и по той
 * же причине: правило спрашивают двое, и второй перечень тех же двух случаев разошёлся бы с
 * первым.
 *
 * Ветвь коррекции — одно право прошлого. Обычная ветвь — **два**, и это не щедрость: аннулирование
 * гасит номера бланков и переписывает бумагу, то есть это работа того, кто ведёт бланки, ровно в
 * той же мере, в какой это снятие подписи площадки (решение 7). Поэтому массив, а не одно
 * значение: держателю любого из них ветвь открыта.
 */
export function weeklyAnnulPermission(backdated: boolean): Permission[] {
  return backdated ? ['waybills.correct'] : ['weeklyRequests.approve', 'waybills.correct'];
}

/**
 * Есть ли у субъекта право на эту ветвь. Область площадки спрашивается **отдельно и рядом**: она
 * нужна только там, где право пришло визой, — у `waybills.correct` своей области нет вовсе.
 */
export function canAnnulWeeklyRequest(
  subject: AccessSubject | null | undefined,
  backdated: boolean,
): boolean {
  return weeklyAnnulPermission(backdated).some((permission) => can(subject, permission));
}

/**
 * Нужна ли области площадки проверка: право пришло визой, а не журналом бланков.
 *
 * Разделено потому, что у двух прав обычной ветви разная природа. `weeklyRequests.approve` — право
 * заказчика на своей площадке, и без области оно открыло бы руководителю строительства чужую
 * неделю. `waybills.correct` — право офиса на бумагу всего портала, и область ему взять негде:
 * у диспетчера площадок нет (ADR 0085 п. 7).
 */
export function weeklyAnnulNeedsSiteScope(
  subject: AccessSubject | null | undefined,
  backdated: boolean,
): boolean {
  return !backdated && !can(subject, 'waybills.correct') && can(subject, 'weeklyRequests.approve');
}

/**
 * Были ли у строки следствия в заказах — то есть есть ли что закрывать документом.
 *
 * Отвечает `result`, а не состояние обратного хода: «уже развёрнута» и «следствий не было» — два
 * разных ответа, которые `weeklyAnnulItemState` сводит в одно значение `reverted`. Первое означает,
 * что неделя сработала и её след убрали руками; второе — что строка не применялась вовсе
 * (`skipped`, `pending`), и закрывать по ней нечего.
 *
 * Разница решает, можно ли аннулировать неделю (решение 4 ADR 0218): документ, все следствия
 * которого уже развёрнуты поштучно, обязан закрываться — иначе он навсегда остаётся «Применённой»
 * и держит пару «объект + неделя», а человек, начавший разбор руками, не может его закончить.
 */
export function weeklyItemHadEffect(result: WeeklyRequestItemResult): boolean {
  return result === 'extended' || result === 'created' || result === 'left';
}

/** Строка состава глазами аннулирования — ровно те поля, которые спрашивают правила. */
export interface WeeklyAnnulItem {
  id: string;
  kind: WeeklyRequestItemKind;
  result: WeeklyRequestItemResult;
  /** Дата, до которой строка продлила заказ (`extend`), либо `null`. */
  dateTo: string | null;
  /** Снимок момента применения: срок до изменения. Пуст у `new` и у пропущенной строки. */
  previousDateTo: string | null;
  /**
   * Недели, применённые **позже** нашей и тронувшие тот же заказ: их решения стоят поверх нашего,
   * и разворачивать наше, не тронув их, значило бы отменить чужое решение молча.
   */
  laterWeekRefs: { num: number }[];
}

/**
 * Заказ, на который смотрит строка аннулирования. Меньше, чем `WeeklySourceOrder`: сборке состава
 * нужны вид заявки, назначение и окно недели, а обратному ходу — только сегодняшнее состояние.
 */
export interface WeeklyAnnulOrder {
  status: RequestStatus;
  deletedAt: string | null;
  dateFrom: string;
  dateTo: string | null;
  /** Оформленный вывоз: `null` — рейса нет. */
  pickupRoute: { num: number; routeDate: string } | null;
  /** Дата ожидающего визы досрочного отъезда; `null` — запроса нет. */
  pendingEarlyEndDate: string | null;
}

/**
 * Что аннулирование сделает со строкой и почему — текстом, как `extendBlocker`/`sourceItemBlocker`
 * (ADR 0085 п. 4): сервер отдаёт эту строку в предпросмотре и в 422, окно и чек-лист подписывают
 * ею строку. Второго описания в портале нет.
 *
 * Наступившие дни строку **не блокируют** — они выбирают ветвь (решение 2). Блокируют факты
 * работы на снимаемых днях, но их знает только план (`WEEKLY_ANNUL_BLOCKERS`), и здесь их нет.
 *
 * `order` равен `null` у строки, заказ которой снесли насовсем: такая строка следствий больше не
 * имеет, и разворачивать по ней нечего.
 */
export function weeklyAnnulItemState(
  item: WeeklyAnnulItem,
  order: WeeklyAnnulOrder | null,
): { state: WeeklyAnnulState; reason: string; reverse: WeeklyAnnulReversal } {
  const reverted = (reason: string) => ({ state: 'reverted', reason, reverse: 'none' }) as const;
  const blocked = (reason: string) => ({ state: 'blocked', reason, reverse: 'none' }) as const;

  // Пропущенная строка следствий не имела вовсе: снимка у неё нет (`previous_date_to IS NULL`), и
  // «эффективный конец равен снимку» на ней не вычислимо. В счёт «хотя бы одна обратима» такая
  // строка не входит — разворачивать по ней нечего, но и запирать неделю ею нельзя.
  if (item.result === 'skipped') {
    return reverted('Строка была пропущена при применении — следствий у неё нет');
  }
  if (item.result === 'pending') {
    return reverted('Строка не применялась');
  }

  if (item.kind === 'new') {
    if (!order) return reverted('Порождённый заказ удалён из портала');
    if (order.deletedAt) return reverted('Порождённый заказ в архиве');
    if (order.status === 'cancelled') return reverted('Порождённый заказ отменён');
    if (order.status !== 'new') {
      return blocked(
        `Порождённый заказ уже в статусе «${requestStatusLabels[order.status]}» — ` +
          'сначала закройте или откатите его',
      );
    }
    if (item.laterWeekRefs.length > 0) {
      return blocked(weeklyAnnulLaterWeeksMessage(item.laterWeekRefs));
    }
    return { state: 'reversible', reason: '', reverse: 'cancel' };
  }

  if (item.kind === 'leave') {
    // Решение «уезжает» снимается самой шапкой: `loadLeftBy` отбирает только применённые недели.
    // Поэтому у строки нет своего «уже развёрнуто» — есть только рейс, который мешает.
    if (order?.pickupRoute) {
      return blocked(
        `Вывоз оформлен рейсом ${formatVehicleRouteNumber(order.pickupRoute.num)} на ` +
          `${dayMonth(order.pickupRoute.routeDate)} — сначала отмените рейс`,
      );
    }
    return { state: 'reversible', reason: '', reverse: 'release_leave' };
  }

  // `extend`: снимок обязателен — его пишет применение той же транзакцией, что и срок.
  const snapshot = item.previousDateTo;
  if (!snapshot) return reverted('Снимка срока у строки нет — разворачивать нечего');
  if (!order) return reverted('Заказ удалён из портала');

  const current = orderEffectiveDateTo(order);
  // «Уже развёрнута» — **не позже** снимка, а не «равно ему»: досрочное завершение сокращает срок
  // до любой даты от сегодня (ADR 0044 п. 5), то есть и ниже прежнего конца. Требуй мы равенства,
  // строка с сокращённым руками сроком оказалась бы «блокирована: срок изменён», хотя следствие
  // недели исчезло целиком.
  if (current <= snapshot) {
    return reverted(`Срок заказа уже возвращён: идёт до ${dayMonth(current)}`);
  }
  if (order.deletedAt) return blocked('Заказ в архиве — верните его из архива или сократите срок');
  if (order.status !== 'confirmed') {
    return blocked(
      `Заказ не в статусе «${requestStatusLabels.confirmed}» — сократите срок вручную`,
    );
  }
  // Сверяется срок, а не версия: версия растёт от правки телефона ответственного (ADR 0085 п. 10),
  // и строки выбрасывались бы из обратного хода по поводам, к решению не относящимся.
  if (item.dateTo && current !== item.dateTo) {
    return blocked(
      `Срок заказа изменился после недели: неделя продлила до ${dayMonth(item.dateTo)}, ` +
        `сейчас ${dayMonth(current)} — сократите срок вручную`,
    );
  }
  if (order.pendingEarlyEndDate) {
    return blocked(
      `Запрос на досрочный отъезд ${dayMonth(order.pendingEarlyEndDate)} ждёт визы — ` +
        'сначала решите его',
    );
  }
  if (item.laterWeekRefs.length > 0) {
    return blocked(weeklyAnnulLaterWeeksMessage(item.laterWeekRefs));
  }
  return { state: 'reversible', reason: '', reverse: 'shorten_to' };
}

/** Один текст на оба вида строк: перечень недель, решивших по заказу позже нашей. */
function weeklyAnnulLaterWeeksMessage(refs: { num: number }[]): string {
  const list = refs.map((r) => formatWeeklyRequestNumber(r.num)).join(', ');
  return refs.length === 1
    ? `Заказ тронут неделей ${list}, применённой позже — разверните сначала её`
    : `Заказ тронут неделями ${list}, применёнными позже — разверните сначала их`;
}

/**
 * Почему шапку аннулировать нельзя — текстом; `null` — можно.
 *
 * Спрашивается ровно статус: запись операции `weekly` у проведённой задним числом недели шапку
 * **не** запирает (решение 2), её следствия разворачивает ветвь коррекции тем же правом, которым
 * неделю провели.
 */
export function weeklyAnnulHeaderBlocker(header: { status: WeeklyRequestStatus }): string | null {
  if (header.status === 'annulled') return 'Заявка уже аннулирована';
  if (header.status === 'applied') return null;
  return isWeeklyRequestEditable(header.status)
    ? 'Аннулируют применённую заявку: эта ещё не применялась — её снимают'
    : 'Заявка снята: следствий у неё не было';
}

/**
 * Эффективная дата операции — **первый снимаемый день**: `min(previous_date_to + 1)` по строкам,
 * которые аннулирование действительно сократит. `null` — срок не двигается вовсе (строк `extend`
 * к развороту нет), и прошлого операция не трогает.
 *
 * Воскресенье недели (приём проведения, ADR 0116 п. 7) здесь солгало бы в обе стороны: у недели,
 * чей первый снимаемый день ещё впереди, оно уже прошло бы, а у строки с «дырой» до понедельника —
 * наоборот, стояло бы позже реально переписываемого дня. Предмет у аннулирования — снимаемые дни,
 * и первый из них отвечает на вопрос «переписываем ли мы прошлое» точнее всякого другого.
 */
export function weeklyAnnulEffectiveDate(
  states: { reverse: WeeklyAnnulReversal; previousDateTo: string | null }[],
): string | null {
  let earliest: string | null = null;
  for (const row of states) {
    if (row.reverse !== 'shorten_to' || !row.previousDateTo) continue;
    const firstRemoved = shiftDateKey(row.previousDateTo, 1);
    if (!earliest || firstRemoved < earliest) earliest = firstRemoved;
  }
  return earliest;
}

/** Строка предпросмотра: что аннулирование сделает с этой строкой состава. */
export interface WeeklyAnnulItemDto {
  itemId: string;
  kind: WeeklyRequestItemKind;
  /** «Экскаватор (продление)» — тем же текстом, что в чек-листе. */
  title: string;
  requestId: string | null;
  displayNumber: string | null;
  state: WeeklyAnnulState;
  reason: string;
  reverse: WeeklyAnnulReversal;
  /** Дата, к которой вернётся срок (`shorten_to`); `null` у остальных ходов. */
  shortenTo: string | null;
}

/** Лист ЭСМ-2 в ответе предпросмотра — номер показывается только держателю `waybills.read`. */
export interface WeeklyAnnulSheetDto {
  waybillId: string;
  requestId: string;
  displayNumber: string;
  number: string;
  periodFrom: string;
  periodTo: string;
}

/**
 * Цена операции в бумаге — счётчиками всем, номерами только держателю журнала (решение 8).
 *
 * `reissue` отделён от `cancel` намеренно: аннулированный без замены номер и аннулированный с
 * выпиской взамен — разные события для бухгалтерии, и один счётчик на оба отвечал бы на вопрос
 * «сколько бланков списано» и молчал о том, сколько ушло из серии.
 */
export interface WeeklyAnnulPaperDto {
  /** Листы, которые сгорят без замены: их недели уходят из срока целиком. */
  cancel: number;
  /** Листы, которым правится период вниз (ADR 0178 решение 1): номер не горит. */
  trim: number;
  /** Листы, которые сгорят и будут выписаны заново укороченными. */
  reissue: number;
  /** По какое число подрежется лист недели снимка; `null` — подрезать нечего. */
  trimmedTo: string | null;
}

/** Решение истории назначения, которое сокращение погасит (ADR 0126, решение 6). */
export interface WeeklyAnnulCancelGroupDto {
  /** День, с которого решение вступало в силу. */
  effectiveDate: string;
  /** «Машина», «Машинист» — что именно меняли; состав читается целиком (гашение групповое). */
  dimensions: string[];
  /** Подпись решения: «ТС-355: машина А → Б». */
  title: string;
}

/**
 * Что сделает аннулирование — посчитанное сервером до первой правки и подтверждаемое отпечатком
 * (ADR 0211 решения 1, 4).
 *
 * Форма отвечает на три вопроса в том порядке, в каком их задаёт человек: можно ли вообще
 * (`allowed`, `blockedReason`), какой ценой (`paper`, `cancelGroups`, `shifts`, `linearDays`) и
 * что подписать (`fingerprint`, `cancelGroupsFingerprint`, `issues`).
 */
export interface WeeklyAnnulPreviewDto {
  weeklyRequestId: string;
  weekStart: string;
  weekLabel: string;
  /** Сегодня по МСК: окно считает им всё то же, что сервер, и не спрашивает часы браузера. */
  today: string;
  /**
   * Эффективная дата операции — первый снимаемый день; `null` — срок не двигается.
   * Ею объясняется ветвь, и ею же считается глубина.
   */
  effectiveDate: string | null;
  /** Ветвь коррекции: вердикт того же `backdateGuard`, что решит на команде. */
  backdated: boolean;
  /** Нужны ли ключ операции и причина в журнале: ветвь коррекции **или** гасимые группы. */
  requiresOperation: boolean;
  /** Нижняя граница глубины субъекта; `null` — предела нет (`waybills.correctBeyondLimit`). */
  correctionFloor: string | null;
  /** Может ли этот субъект аннулировать: право по ветви, область, шапка и ни одной блокировки. */
  allowed: boolean;
  /** Почему нельзя — в том же порядке, в каком откажет команда; `null` — можно. */
  blockedReason: string | null;
  items: WeeklyAnnulItemDto[];
  /** Препятствия, которые знает только план: подпись дня, заморозка, незваный лист. */
  blockers: WeeklyAnnulBlockerDto[];
  paper: WeeklyAnnulPaperDto;
  /**
   * Листы отработанных недель, которые придётся назвать поимённо (`correction.unlockWaybillIds`,
   * ADR 0116 п. 11). Номера — только держателю `waybills.read`; остальным `null`, и о том, что
   * называть есть что, отвечает `unlockableCount`.
   */
  unlockable: WeeklyAnnulSheetDto[] | null;
  unlockableCount: number;
  cancelGroups: WeeklyAnnulCancelGroupDto[];
  /** Отпечаток перечня гасимых групп; `null` — гасить нечего. */
  cancelGroupsFingerprint: string | null;
  /** Предупреждения по выпускаемым листам — обезличенные, как у визы досрочного завершения. */
  issues: { issueKey: number; codes: string[]; warningFingerprint: string }[];
  /** Дни линейных заказов, которые уйдут из рейсов. */
  linearDays: { detachable: string[]; frozen: string[] };
  /** Черновики смен на снимаемых днях — их удалит команда. */
  shifts: string[];
  /** Недели в работе по тем же заказам: после разворота их строки станут «срок изменился». */
  pendingWeeks: string[];
  fingerprint: string;
  asOf: string;
}

/**
 * Тело команды аннулирования.
 *
 * Причина обязательна **всегда**, не только в ветви коррекции: `annul_reason` объясняет документ
 * («почему эту неделю развернули»), а `correction.reason` — разрыв нумерации бланков. В ветви
 * коррекции это один и тот же текст, и спрашивается он один раз — вторым полем окно просило бы
 * человека написать одно и то же дважды.
 *
 * Отпечатки приходят отдельными полями по образцу двери срока: `fingerprint` подтверждает
 * последствия целиком, `cancelGroupsFingerprint` — перечень гасимых решений истории. Один
 * отпечаток на оба не годится: группы человек подтверждает как чужие решения, которые он гасит, и
 * увидеть их он обязан перечнем, а не числом внутри общего хеша.
 *
 * Обязателен ли блок `correction`, схема не решает: ветвь выбирает эффективная дата, а её знает
 * только сервер, прочитавший состав под блокировкой. Текст отказа — `WEEKLY_ANNUL_CORRECTION_REQUIRED_MESSAGE`.
 */
export const annulWeeklyRequestSchema = z
  .object({
    reason: weeklyBackdateReasonSchema,
    version: versionSchema,
    fingerprint: assignmentFingerprintSchema,
    cancelGroupsFingerprint: assignmentFingerprintSchema.optional(),
    acknowledgements: assignmentAcknowledgementsSchema.optional(),
    /**
     * Ключ идемпотентности и названные листы — ровно у операции журнала. Причина здесь не
     * повторяется: её уже спросило поле `reason` выше.
     */
    correction: z
      .object({
        operationId: uuidSchema,
        unlockWaybillIds: z.array(uuidSchema).max(ESM2_UNLOCK_LIMIT).optional().default([]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AnnulWeeklyRequestInput = z.infer<typeof annulWeeklyRequestSchema>;
export type AnnulWeeklyRequestBody = z.input<typeof annulWeeklyRequestSchema>;

/**
 * Отказ команде без ключа операции там, где он нужен. Называет и причину требования, и то, чего
 * не хватает: «нужен ключ операции» без объяснения читается как придирка формы.
 */
export const WEEKLY_ANNUL_CORRECTION_REQUIRED_MESSAGE =
  'Аннулирование трогает прошедшие дни либо гасит запланированные решения — нужен ключ операции: она уйдёт в журнал коррекций вместе с причиной и вашим именем';

/**
 * Схема ответа предпросмотра — **замок обезличивания**, а не украшение маршрута (приём
 * `earlyEndApprovalPreviewResponseSchema`).
 *
 * Она объявляется у Fastify, и ответ сериализуется через неё: поле, случайно попавшее в объект, до
 * клиента не доедет. `satisfies` связывает схему с типом на этапе компиляции — разойтись им молча
 * нечем.
 */
export const weeklyAnnulPreviewResponseSchema = z
  .object({
    weeklyRequestId: uuidSchema,
    weekStart: dateOnlySchema,
    weekLabel: z.string(),
    today: dateOnlySchema,
    effectiveDate: dateOnlySchema.nullable(),
    backdated: z.boolean(),
    requiresOperation: z.boolean(),
    correctionFloor: dateOnlySchema.nullable(),
    allowed: z.boolean(),
    blockedReason: z.string().nullable(),
    items: z.array(
      z
        .object({
          itemId: uuidSchema,
          kind: z.enum(WEEKLY_ITEM_KINDS),
          title: z.string(),
          requestId: uuidSchema.nullable(),
          displayNumber: z.string().nullable(),
          state: z.enum(WEEKLY_ANNUL_STATES),
          reason: z.string(),
          reverse: z.enum(WEEKLY_ANNUL_REVERSALS),
          shortenTo: dateOnlySchema.nullable(),
        })
        .strict(),
    ),
    blockers: z.array(
      z
        .object({
          code: z.enum(WEEKLY_ANNUL_BLOCKERS),
          itemId: uuidSchema,
          dates: z.array(dateOnlySchema),
          message: z.string(),
        })
        .strict(),
    ),
    paper: z
      .object({
        cancel: z.number().int().nonnegative(),
        trim: z.number().int().nonnegative(),
        reissue: z.number().int().nonnegative(),
        trimmedTo: dateOnlySchema.nullable(),
      })
      .strict(),
    unlockable: z
      .array(
        z
          .object({
            waybillId: uuidSchema,
            requestId: uuidSchema,
            displayNumber: z.string(),
            number: z.string(),
            periodFrom: dateOnlySchema,
            periodTo: dateOnlySchema,
          })
          .strict(),
      )
      .nullable(),
    unlockableCount: z.number().int().nonnegative(),
    cancelGroups: z.array(
      z
        .object({
          effectiveDate: dateOnlySchema,
          dimensions: z.array(z.string()),
          title: z.string(),
        })
        .strict(),
    ),
    cancelGroupsFingerprint: assignmentFingerprintSchema.nullable(),
    issues: z.array(
      z
        .object({
          issueKey: z.number().int().nonnegative(),
          codes: z.array(z.string()),
          warningFingerprint: assignmentFingerprintSchema,
        })
        .strict(),
    ),
    linearDays: z
      .object({ detachable: z.array(dateOnlySchema), frozen: z.array(dateOnlySchema) })
      .strict(),
    shifts: z.array(dateOnlySchema),
    pendingWeeks: z.array(z.string()),
    fingerprint: assignmentFingerprintSchema,
    asOf: dateOnlySchema,
  })
  .strict() satisfies z.ZodType<WeeklyAnnulPreviewDto>;

/**
 * What a reversal of an applied week did — the answer of both commands that run the annulment
 * engine (ADR 0218 annulment, ADR 0219 return for re-approval). One shape on both sides: the portal
 * reports the result in numbers, and a second copy of the type there drifted from the server once
 * already.
 */
export interface WeeklyReversalResultDto {
  weeklyRequestId: string;
  /** `annulled` after annulment, `pending` after a return for re-approval. */
  status: Extract<WeeklyRequestStatus, 'annulled' | 'pending'>;
  shortened: { requestId: string; displayNumber: string; dateTo: string }[];
  cancelled: { requestId: string; displayNumber: string }[];
  released: number;
  esm2: { cancelled: number; issued: number };
}

// ── Return of an applied week for re-approval (ADR 0219) ──
//
// The dispatcher finds that the applied week lacks equipment the site needs. The week goes back to
// "awaiting approval": its consequences are reversed by the annulment engine, its rows are reset to
// the pre-approval state, the site adds what was forgotten, and the construction manager approves
// it again through the ordinary apply. Nothing of the first approval survives in the orders, so the
// second approval cannot double an extension or a created order.

/**
 * The right that returns a week, in both branches (survey 06.10.2026, R3). It is the dispatcher's
 * tool: the site manager already has rejection before approval and annulment after it, while the
 * return burns form numbers and rewrites paper, which is the work of whoever keeps the forms.
 *
 * Unlike annulment (`weeklyAnnulPermission`), the branch does not change the right, so there is no
 * site scope to ask: `waybills.correct` has none. The depth of the past is still a separate
 * verdict of `checkBackdate`, exactly as for every other backdated entry.
 */
export const WEEKLY_RETURN_PERMISSION: Permission = 'waybills.correct';

export function canReturnWeeklyRequest(subject: AccessSubject | null | undefined): boolean {
  return can(subject, WEEKLY_RETURN_PERMISSION);
}

/**
 * Why this header cannot be returned for re-approval — text, or `null` when it can.
 *
 * Only an applied week has anything to return. An annulled one is refused rather than revived:
 * annulment freed the "object + week" pair, a new request may already occupy it, and the partial
 * unique index would reject the revived one at the very transition.
 */
export function weeklyReturnHeaderBlocker(header: { status: WeeklyRequestStatus }): string | null {
  if (header.status === 'applied') return null;
  if (header.status === 'annulled') {
    return 'Заявка аннулирована — вернуть её на согласование нельзя, неделю собирают заново';
  }
  if (header.status === 'cancelled') return 'Заявка снята: возвращать на согласование нечего';
  return 'Заявка ещё не завизирована — она и так ждёт визы или собирается';
}

/**
 * Body of the return command — the annulment body as it is (reason, header version, both
 * fingerprints, acknowledgements, operation block). The command runs the same plan and confirms the
 * same consequences, and a second schema of the same fields would drift at the first edit.
 */
export const returnWeeklyRequestSchema = annulWeeklyRequestSchema;
export type ReturnWeeklyRequestInput = AnnulWeeklyRequestInput;
export type ReturnWeeklyRequestBody = AnnulWeeklyRequestBody;

/** Refusal without an operation key where one is required; names both the cause and the remedy. */
export const WEEKLY_RETURN_CORRECTION_REQUIRED_MESSAGE =
  'Возврат на согласование трогает прошедшие дни либо гасит запланированные решения — нужен ключ операции: она уйдёт в журнал коррекций вместе с причиной и вашим именем';
