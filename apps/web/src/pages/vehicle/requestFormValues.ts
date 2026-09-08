import dayjs, { type Dayjs } from 'dayjs';
import {
  costTargetKeyOf,
  type VehicleRequestDto,
  type VehicleRequestType,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { classificationKeyOf } from '../../hooks/useVehicleClassifications';
import { copyTrip, tripNeedsList, tripToForm, type TripFormValue } from './requestTripsForm';

/**
 * Значения формы заявки на автотехнику: сам тип и две подстановки — правкой и копией.
 *
 * Отдельным файлом от `VehicleRequestsTab`, потому что обе подстановки — чистый перевод заявки в
 * поля, о показе они не знают ничего, а вкладка стоит в бюджете длины (`scripts/quality.mjs`).
 * Тип едет вместе с ними: он и есть то, во что они переводят, — разъедься они по файлам, поле,
 * добавленное в одном месте, забывалось бы в двух других.
 */

/**
 * Единая форма заявки на автотехнику. Тип заявки выбирают явно — он задаёт и набор полей,
 * и список доступной техники: на объект заказывают технику любого вида, грузоперевозку —
 * только грузовым (`isVehicleKindAllowedForRequest`). Поля чужого типа скрыты вместе с
 * лейблами, пока тип заявки не выбран — не видно ни одного из двух блоков.
 */
export interface FormValues {
  requestType: VehicleRequestType;
  /**
   * Заказчик (ADR 0040) одним ключом `object:<id>` | `department:<id>` (план Р2): пара колонок для
   * тела запроса собирается из выбранной опции (`customerPairOf`), а не разбором строки.
   */
  customerKey?: string;
  /** Ключ позиции классификатора «тип:категория» (ADR 0028); в API уходит парой полей. */
  classificationKey: string;
  // Техника на объект: период работы (date-only) и контакт встречающего.
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  responsibleName?: string;
  responsiblePhone?: string;
  // Грузоперевозка: дата + необязательное время `HH:mm` первой подачи (Р3) и список ездок.
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  /**
   * Ездки заявки (Р1, Р2 плана `docs/route-trips-plan.md`): адреса, количество и контакты обоих
   * концов лежат у них, а не у заявки — у заявки с ездками `A→B` и `A→C` «адреса разгрузки
   * заявки» не существует.
   *
   * Списком в значениях формы, а не антовским `Form.List`: адресное поле и контакт зовут форму
   * напрямую и путь к полю знают целиком (`trips.3.fromLocation`), а `Form.List` подставляет свой
   * префикс только элементам `Form.Item`. Ведёт список `RequestTripsBlock`.
   */
  trips?: TripFormValue[];
  comment?: string;
  /**
   * Причина заднего числа (ADR 0101). Полем формы, а не состоянием экрана: показывается оно по
   * выбранной дате, и `resetFields` обязан уносить его вместе с ней — иначе объяснение вчерашней
   * заявки уехало бы в следующую, заведённую в том же окне.
   */
  backdateReason?: string;
}

/**
 * Разворачивать ли список ездок при открытии формы.
 *
 * Свёрнутый вид годится не всякой заявке (§4.1): списком открываются те, у кого ездок несколько, и
 * та, у кого ездка одна, но со своим временем подачи или примечанием — их свёрнутый вид не
 * показывает вовсе, и человек правил бы заявку, не видя половины заказа. Тем же правилом решает
 * карточка (`tripNeedsList`), показывать ли ездку парой полей.
 */
export function tripsNeedExpanding(r: VehicleRequestDto): boolean {
  const trips = r.requestType === 'freight_transport' ? r.trips : [];
  return trips.length > 1 || trips.some(tripNeedsList);
}

/** Момент подачи грузоперевозки в московском дне. Общий для правки и копии. */
function scheduledMoment(r: VehicleRequestDto & { requestType: 'freight_transport' }): Dayjs {
  // Момент с сервера переводится в МСК, а не читается как московское время: `dayjs.tz(iso, tz)`
  // теряет пришедшее смещение и показывал бы подачу на три часа раньше — а правка сохраняла бы
  // этот сдвиг обратно в заявку. Так же читает подачу заявка на вывоз мусора.
  return dayjs(r.scheduledAt).tz(MOSCOW_TZ);
}

/** Значения формы для правки заявки: заявка как есть, включая прошедшие даты. */
export function editFormValues(r: VehicleRequestDto): Partial<FormValues> {
  if (r.requestType === 'special_equipment') {
    return {
      requestType: r.requestType,
      // Заказчик — ключом из самой заявки (Р2): пара колонок под CHECK заполнена ровно
      // наполовину, и род берётся из неё, а не из оси того, кто правит.
      customerKey: costTargetKeyOf(r) ?? undefined,
      classificationKey: classificationKeyOf(r),
      dateFrom: dayjs(r.dateFrom),
      dateTo: r.dateTo ? dayjs(r.dateTo) : null,
      responsibleName: r.responsibleName,
      responsiblePhone: r.responsiblePhone,
      comment: r.comment,
    };
  }
  const at = scheduledMoment(r);
  /*
   * Адреса, груз и контакты лежат у ездок (Р2 плана `docs/route-trips-plan.md`) — у заявки их
   * больше нет, и форма правит их полным списком (§7).
   *
   * Переносится каждая ездка как есть, включая непроверенный адрес и пустой контакт: у строк,
   * доехавших бэкфилом от заявок старше ADR 0006 и миграции `0062`, их не бывает, и выдумывать
   * за прошлое форма не станет (Р2а). Метаданные едут вместе со строкой — по ним адресное поле
   * само откроется в том режиме, каким адрес и заводили.
   *
   * Пустой список тут теоретически невозможен (ездок не бывает ноль), но окно правки не то
   * место, где это стоит утверждать падением: список просто окажется без строк.
   */
  return {
    requestType: r.requestType,
    customerKey: costTargetKeyOf(r) ?? undefined,
    classificationKey: classificationKeyOf(r),
    scheduledDate: at,
    // Время не задано — поле остаётся пустым (в scheduledAt лежит полночь МСК).
    scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
    trips: r.trips.map(tripToForm),
    comment: r.comment,
  };
}

/**
 * Значения формы для копии заявки (ADR 0173): тот же заказ, заведённый заново.
 *
 * Копия — заявка, а не правка, поэтому подстановка отличается от `editFormValues` тремя вещами, и
 * каждая из них — про то, что новая заявка не наследует:
 *
 * 1. **Календарь двигается вперёд.** Заведение не принимает необъявленное прошлое, а у копии
 *    прошлого срока никакого объяснения и нет — повторяют заказ, а не правят вчерашний день.
 *    Даты, не дотягивающие до `minDate` (в нём же сидит заблаговременность роли), сдвигаются на
 *    неё **с сохранением длительности**: «кран на пять дней» остаётся заказом на пять дней, а
 *    подставленный конец срока раньше начала форма не приняла бы вовсе. Срок, целиком лежащий
 *    впереди, не трогается: его человек и повторяет.
 * 2. **Позиция классификатора и заказчик подставляются, только если они у копирующего есть.**
 *    Выключенный из справочника тип сервер не примет (`resolveClassification`), а заказчик вне
 *    подбора учётки уйдёт пустой парой (К8) — в обоих случаях поле остаётся пустым и спрашивает
 *    человека, вместо того чтобы показывать значение, которое отклонят при сохранении.
 * 3. **Ездки теряют `id`** (`copyTrip`): это новые строки, номера им назначит сервер.
 *
 * Вложения не переносятся вовсе, и решает это не подстановка: файл по построению привязан не
 * более чем к одной заявке (`assertFilesAttachable`), и «скопировать» его можно было бы только
 * копией объекта в хранилище.
 */
export function copyFormValues(
  r: VehicleRequestDto,
  options: {
    /** Самый ранний день, который примет форма заведения (`vehicleRequestDateRules`). */
    minDate: Dayjs;
    /** Есть ли позиция классификатора заявки в живом справочнике. */
    hasClassification: boolean;
    /** Есть ли заказчик заявки в подборе копирующего. */
    hasCustomer: boolean;
  },
): Partial<FormValues> {
  const { minDate, hasClassification, hasCustomer } = options;
  const common = {
    requestType: r.requestType,
    customerKey: hasCustomer ? (costTargetKeyOf(r) ?? undefined) : undefined,
    classificationKey: hasClassification ? classificationKeyOf(r) : '',
    comment: r.comment,
  };
  if (r.requestType === 'special_equipment') {
    const from = dayjs(r.dateFrom);
    // Сдвиг — по дням календаря, а не по миллисекундам: обе даты `date-only`, и разница в сутках
    // от летнего времени не зависит.
    const shift = Math.max(0, minDate.startOf('day').diff(from.startOf('day'), 'day'));
    return {
      ...common,
      dateFrom: from.add(shift, 'day'),
      dateTo: r.dateTo ? dayjs(r.dateTo).add(shift, 'day') : null,
      responsibleName: r.responsibleName,
      responsiblePhone: r.responsiblePhone,
    };
  }
  const at = scheduledMoment(r);
  const day = at.isBefore(minDate.startOf('day')) ? minDate.startOf('day') : at;
  return {
    ...common,
    scheduledDate: day,
    // Час подачи копия сохраняет: «песок к восьми утра» — часть повторяемого заказа, а рабочее
    // окно у прежней заявки уже проверено. День в него не входит, поэтому сдвиг календаря время
    // не трогает — вместе с ним переезжают и часы ездок (`copyTrip`).
    scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
    trips: r.trips.map(copyTrip),
  };
}
