import dayjs, { type Dayjs } from 'dayjs';
import {
  type CreateMailingScheduleBody,
  type DigestRequestScope,
  type MailingScheduleDto,
  type MailingType,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { errorMessage } from '../../utils/format';
import type { AudienceFormValues } from './MailingAudienceFields';

/**
 * Значения расписания рассылки: перевод между записью, полями формы и телом запроса — и подписи
 * настройки словами.
 *
 * Отдельно от формы и от списка, потому что нужны обоим: список печатает окно в колонке
 * «Настройка», форма — под парой полей, а тело запроса собирают и «Сохранить» в форме, и
 * переключатель «включена» в списке. Разойдись эти места, одна и та же настройка называлась бы
 * по-разному, а переключатель отправлял бы не то, что показывает форма.
 */

const DATE_KEY = 'YYYY-MM-DD';
export const TIME_FORMAT = 'HH:mm';

/** ISO-дни недели: 1 — понедельник, 7 — воскресенье. Тем же счётом живут БД и расчёт запуска. */
export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function weekdayShort(iso: number): string {
  return WEEKDAY_SHORT[iso - 1] ?? String(iso);
}

/** Короткая подпись окна для списка: «на завтра», «на 7 дн. с сегодняшнего». */
export function windowText(fromDays: number, days: number): string {
  const day = fromDays === 0 ? 'сегодня' : fromDays === 1 ? 'завтра' : `+${fromDays} дн.`;
  if (days <= 1) return `на ${day}`;
  const start =
    fromDays === 0 ? 'сегодняшнего' : fromDays === 1 ? 'завтрашнего' : `+${fromDays}-го дня`;
  return `на ${days} дн. с ${start}`;
}

/**
 * Расшифровка окна словами от сегодняшней даты. Настройка в днях без примера читается плохо:
 * «первый день 1, дней 7» — это про завтра или про неделю с сегодня? Дата отвечает сразу.
 */
export function windowExplain(type: MailingType, fromDays?: number, days?: number): string {
  if (fromDays == null || days == null) return '';
  const what = type === 'role_digest' ? 'Сводка' : 'Задание';
  const start = dayjs().add(fromDays, 'day');
  if (days <= 1) return `${what} на ${start.format('D MMMM (dddd)')}`;
  const end = start.add(days - 1, 'day');
  // Месяц у первой даты печатается только тогда, когда он другой: «10–16 августа» читается лучше,
  // чем «10 августа – 16 августа».
  const left = start.month() === end.month() ? start.format('D') : start.format('D MMMM');
  return `${what} на ${left}–${end.format('D MMMM')}`;
}

/** «18:00» → момент с этим временем: TimePicker работает с dayjs, а расписание хранит строку. */
function timeToDayjs(hhmm: string): Dayjs {
  const [hh, mm] = hhmm.split(':');
  return dayjs()
    .hour(Number(hh ?? 0))
    .minute(Number(mm ?? 0))
    .second(0)
    .millisecond(0);
}

function toDateKeys(values: Dayjs[] | undefined): string[] {
  return (values ?? []).map((d) => d.format(DATE_KEY));
}

function toDayjsList(values: string[]): Dayjs[] {
  return values.map((d) => dayjs(d));
}

/**
 * Список выбора вместе со строками для уже сохранённых значений, которых в справочнике нет:
 * карточку могли закрыть или отправить в архив. Без своей строки Select показал бы вместо имени
 * uuid, а «Сохранить» молча унесло бы это значение из набора исключений.
 */
export function withMissing(
  options: { value: string; label: string }[],
  selected: string[] | undefined,
): { value: string; label: string }[] {
  const known = new Set(options.map((o) => o.value));
  const missing = (selected ?? []).filter((id) => !known.has(id));
  return [...options, ...missing.map((id) => ({ value: id, label: 'Карточка вне справочника' }))];
}

export interface ScheduleFormValues extends AudienceFormValues {
  type: MailingType;
  name: string;
  isEnabled: boolean;
  sendAt: Dayjs;
  runWeekdays: number[];
  windowFromDays: number;
  windowDays: number;
  excludedRunDates?: Dayjs[];
  excludedRouteDates?: Dayjs[];
  excludedPersonIds?: string[];
  requestScope: DigestRequestScope;
  showTrips: boolean;
  showOnsite: boolean;
}

/**
 * Расписание целиком телом запроса. Правка уходит целиком (`updateMailingScheduleSchema`), поэтому
 * тем же телом пользуется и переключатель «включена» в списке: по одному присланному полю сервер
 * не сказал бы, законно ли оно.
 */
export function scheduleBody(r: MailingScheduleDto): CreateMailingScheduleBody {
  return {
    type: r.type,
    name: r.name,
    isEnabled: r.isEnabled,
    sendAt: r.sendAt,
    runWeekdays: r.runWeekdays,
    windowFromDays: r.windowFromDays,
    windowDays: r.windowDays,
    excludedRunDates: r.excludedRunDates,
    excludedRouteDates: r.excludedRouteDates,
    excludedPersonIds: r.excludedPersonIds,
    permissions: r.permissions,
    requestScope: r.requestScope,
    showTrips: r.showTrips,
    showOnsite: r.showOnsite,
    scopeMode: r.scopeMode,
    objectIds: r.objectIds,
    departmentIds: r.departmentIds,
    recipientMode: r.recipientMode,
    recipientUserIds: r.recipientUserIds,
  };
}

export function formToBody(v: ScheduleFormValues): CreateMailingScheduleBody {
  const digest = v.type === 'role_digest';
  return {
    type: v.type,
    name: v.name,
    isEnabled: v.isEnabled,
    sendAt: v.sendAt.format(TIME_FORMAT),
    runWeekdays: v.runWeekdays,
    windowFromDays: v.windowFromDays,
    windowDays: v.windowDays,
    excludedRunDates: toDateKeys(v.excludedRunDates),
    // Исключения чужого типа гасятся здесь: скрытое поле формы сохраняет прежнее значение, а
    // водители и даты рейсов у сводки не значат ничего — она собирается не из рейсов.
    excludedRouteDates: digest ? [] : toDateKeys(v.excludedRouteDates),
    excludedPersonIds: digest ? [] : (v.excludedPersonIds ?? []),
    // Аудитория — принадлежность сводки: получателей задания водителям задаёт не право, а наличие
    // рейса в окне, и сервер такую пару отвергает.
    permissions: digest ? v.permissions : [],
    requestScope: v.requestScope,
    showTrips: v.showTrips,
    showOnsite: v.showOnsite,
    scopeMode: digest ? v.scope.mode : 'all',
    objectIds: digest ? v.scope.objectIds : [],
    departmentIds: digest ? v.scope.departmentIds : [],
    recipientMode: digest ? v.recipients.mode : 'all',
    recipientUserIds: digest ? v.recipients.ids : [],
  };
}

/** Значения формы: у новой рассылки — умолчания, у правки — сама запись. */
export function valuesOf(r: MailingScheduleDto | null): ScheduleFormValues {
  if (!r) {
    return {
      type: 'driver_routes',
      name: '',
      // Новая рассылка заводится выключенной: сначала настраивают, потом включают.
      isEnabled: false,
      sendAt: timeToDayjs('18:00'),
      runWeekdays: ALL_WEEKDAYS,
      // Задание на завтра: вечерняя рассылка ради этого и существует.
      windowFromDays: 1,
      windowDays: 1,
      excludedRunDates: [],
      excludedRouteDates: [],
      excludedPersonIds: [],
      // Право модуля, про который сводка и написана: её получает тот, кто ведёт заказы техники.
      // Прежде здесь стояли все роли разом — набор, который заведомо не отвечал ни на один вопрос
      // о работе и сужался вручную при первой же правке.
      permissions: ['vehicleRequests.read'],
      requestScope: 'scope',
      showTrips: true,
      showOnsite: true,
      scope: { mode: 'all', objectIds: [], departmentIds: [] },
      recipients: { mode: 'all', ids: [] },
    };
  }
  return {
    type: r.type,
    name: r.name,
    isEnabled: r.isEnabled,
    sendAt: timeToDayjs(r.sendAt),
    runWeekdays: r.runWeekdays.length > 0 ? r.runWeekdays : ALL_WEEKDAYS,
    windowFromDays: r.windowFromDays,
    windowDays: r.windowDays,
    excludedRunDates: toDayjsList(r.excludedRunDates),
    excludedRouteDates: toDayjsList(r.excludedRouteDates),
    excludedPersonIds: r.excludedPersonIds,
    permissions: r.permissions,
    requestScope: r.requestScope,
    showTrips: r.showTrips,
    showOnsite: r.showOnsite,
    scope: { mode: r.scopeMode, objectIds: r.objectIds, departmentIds: r.departmentIds },
    recipients: { mode: r.recipientMode, ids: r.recipientUserIds },
  };
}

/**
 * Сообщение об отказе при сохранении. 409 здесь означает ровно одно — расписание успели изменить
 * в другом окне, и отправленная версия уже не последняя. Текст свой, а не серверный: человеку
 * нужно указание, что делать («обновите страницу»), а не констатация конфликта версий.
 */
export function saveErrorMessage(e: unknown): string {
  return isApiError(e) && e.status === 409
    ? 'Расписание уже изменили — обновите страницу'
    : errorMessage(e);
}
