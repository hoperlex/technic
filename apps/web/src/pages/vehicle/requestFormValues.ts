import dayjs, { type Dayjs } from 'dayjs';
import {
  costTargetKeyOf,
  type FreightTransportRequestDto,
  type SpecialEquipmentRequestDto,
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

/** Момент подачи грузоперевозки в московском дне. Общий для правки, копии и надписи о ней. */
export function scheduledMoment(
  r: VehicleRequestDto & { requestType: 'freight_transport' },
): Dayjs {
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
 * Заявка, с которой снимают копию, вместе с календарём на момент открытия формы.
 *
 * Оба дня снимаются один раз и едут дальше вместе: поля заполняются при открытии, а надпись
 * рисуется на каждом рендере, и спроси она календарь заново — форма, пережившая 15:00 или
 * полночь, объясняла бы человеку не тот срок, что стоит у неё же в полях.
 */
export interface CopySource {
  source: VehicleRequestDto;
  /** Самый ранний день, который примет форма заведения (`vehicleRequestDateRules`). */
  minDate: Dayjs;
  /** Сегодняшний московский день `YYYY-MM-DD`. */
  today: string;
}

/**
 * Что копия предлагает вместо прежнего срока спецтехники — и каким из трёх способов (ADR 0206).
 *
 * Отдельной функцией от подстановки, потому что тот же ответ нужен надписи в форме (`copyNotice`):
 * посчитай его каждая сторона сама — и надпись однажды объяснила бы человеку не те даты, которые
 * стоят в полях. Верят при этом надписи, а не полям: в поля после неё уже не смотрят.
 *
 * - `ahead` — срок целиком впереди, он и предложен как есть: его человек и повторяет;
 * - `remainder` — заказ уже идёт и ещё не кончился, предложен его хвост: начало едет на первый
 *   доступный день, конец остаётся прежним;
 * - `shifted` — срок прошёл целиком, он сдвинут вперёд **с сохранением длительности**: «кран на
 *   пять дней» остаётся заказом на пять дней.
 */
export type CopyTermKind = 'ahead' | 'remainder' | 'shifted';

export interface CopyTermPlan {
  kind: CopyTermKind;
  dateFrom: Dayjs;
  dateTo: Dayjs | null;
}

export function copyTermPlan(
  r: SpecialEquipmentRequestDto,
  minDate: Dayjs,
  today: string,
): CopyTermPlan {
  const from = dayjs(r.dateFrom);
  const to = r.dateTo ? dayjs(r.dateTo) : null;
  const floor = minDate.startOf('day');
  /*
   * Сегодняшний московский день приходит параметром, а не спрашивается здесь: форму открывают
   * один раз, и надпись обязана объяснять те самые даты, что стоят в полях. Спроси его каждая
   * сторона сама — и форма, пережившая полночь, показала бы поля одной ветки и текст другой.
   *
   * Границу ветки «остаток» держит именно он, а не `minDate`, и подменять одно другим нельзя:
   * `minDate` — это заблаговременность роли (ADR 0104), заявителю после 15:00 она отдаёт
   * послезавтра. Спроси ветку у неё — и копия ещё не начавшегося чужого заказа (начало
   * завтра, конец через неделю) молча превратилась бы в остаток с послезавтра, потеряв день-два
   * работы вместо честного сдвига всего срока вперёд.
   *
   * Дни сравниваются календарными ключами `YYYY-MM-DD`: обе даты `date-only`, и перевод их в
   * момент браузерного пояса добавил бы к сравнению час, которого в сроке нет.
   */
  const floorKey = floor.format('YYYY-MM-DD');
  // «Уже идёт» — это и заказ, начатый сегодня: техника на объекте с утра, и повторяют её на те же
  // оставшиеся дни. Строгое «начался раньше сегодня» ошибалось тут у заявителя: заказ 22.09–30.09,
  // скопированный им после 15:00, уезжал сдвигом на 24.09–02.10 — то есть на два дня за конец
  // оригинала, ровно то, ради чего ветку «остаток» и заводили.
  const started = r.dateFrom <= today;
  // Пустая дата окончания — однодневный срок (тем же `coalesce` его читает сервер), и в ветку
  // «остаток» такой заказ не попадает по построению: начавшись, он в тот же день и кончился.
  const end = r.dateTo || r.dateFrom;
  // Третье условие — «есть что двигать»: заказ, начавшийся сегодня, первый доступный день которого
  // сегодня же, никакого остатка не образует, и предлагать его надо целиком (`ahead`), иначе
  // надпись объявляла бы остатком нетронутый срок.
  if (started && end >= floorKey && floorKey > r.dateFrom) {
    // Сдвигать длительность у идущего заказа нельзя: конец уехал бы за прежний, то есть копия
    // заказала бы больше, чем просили, — а просят тут дотянуть до того же дня другой машиной.
    return { kind: 'remainder', dateFrom: floor, dateTo: to };
  }
  // Сдвиг считается сутками календаря, а не арифметикой миллисекунд, и это держится самой
  // библиотекой: `diff(…, 'day')` вычитает разницу смещений, а `add(n, 'day')` двигает номер дня.
  // В поясе с переводом часов сырые миллисекунды дали бы 2.96 суток вместо трёх — и копия
  // трёхдневного заказа стала бы двухдневной у того, кто открыл портал в таком поясе.
  const shift = Math.max(0, floor.diff(from.startOf('day'), 'day'));
  return {
    kind: shift === 0 ? 'ahead' : 'shifted',
    dateFrom: from.add(shift, 'day'),
    dateTo: to ? to.add(shift, 'day') : null,
  };
}

/**
 * То же для грузоперевозки: день подачи и час, с которым копия его предлагает (ADR 0206).
 *
 * Ветки тут две, а не три: у грузоперевозки не период, а момент подачи — «остатку» неоткуда
 * взяться. Правило прежнее (ADR 0173) и вынесено сюда по той же причине, что и срок: надпись
 * называет предложенный день, и считать его дважды — значит однажды разойтись.
 */
export interface CopyScheduledPlan {
  kind: 'ahead' | 'shifted';
  scheduledDate: Dayjs;
  /** Час подачи `HH:mm`; `undefined` — время у заявки не задано (в `scheduledAt` полночь МСК). */
  scheduledTime?: string;
}

export function copyScheduledPlan(
  r: FreightTransportRequestDto,
  minDate: Dayjs,
): CopyScheduledPlan {
  const at = scheduledMoment(r);
  const floor = minDate.startOf('day');
  const moved = at.isBefore(floor);
  return {
    kind: moved ? 'shifted' : 'ahead',
    scheduledDate: moved ? floor : at,
    // Час подачи копия сохраняет: «песок к восьми утра» — часть повторяемого заказа, а рабочее
    // окно у прежней заявки уже проверено. День в него не входит, поэтому сдвиг календаря время
    // не трогает — вместе с ним переезжают и часы ездок (`copyTrip`).
    scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
  };
}

/**
 * Значения формы для копии заявки (ADR 0173): тот же заказ, заведённый заново.
 *
 * Копия — заявка, а не правка, поэтому подстановка отличается от `editFormValues` тремя вещами, и
 * каждая из них — про то, что новая заявка не наследует:
 *
 * 1. **Календарь предлагается заново** — тремя способами, по `copyTermPlan` и
 *    `copyScheduledPlan`. Заведение не принимает необъявленное прошлое, а у копии прошлого срока
 *    никакого объяснения и нет: повторяют заказ, а не правят вчерашний день. Копию при этом
 *    снимают с заявки любого статуса (ADR 0206), и «сдвинуть на первый доступный день» перестало
 *    быть единственным ответом — у идущего заказа так уехал бы за прежний и конец.
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
    /** Сегодняшний московский день `YYYY-MM-DD` — им ветвится календарь копии. */
    today: string;
    /** Есть ли позиция классификатора заявки в живом справочнике. */
    hasClassification: boolean;
    /** Есть ли заказчик заявки в подборе копирующего. */
    hasCustomer: boolean;
  },
): Partial<FormValues> {
  const { minDate, today, hasClassification, hasCustomer } = options;
  const common = {
    requestType: r.requestType,
    customerKey: hasCustomer ? (costTargetKeyOf(r) ?? undefined) : undefined,
    classificationKey: hasClassification ? classificationKeyOf(r) : '',
    comment: r.comment,
  };
  if (r.requestType === 'special_equipment') {
    const term = copyTermPlan(r, minDate, today);
    return {
      ...common,
      dateFrom: term.dateFrom,
      dateTo: term.dateTo,
      responsibleName: r.responsibleName,
      responsiblePhone: r.responsiblePhone,
    };
  }
  const plan = copyScheduledPlan(r, minDate);
  return {
    ...common,
    scheduledDate: plan.scheduledDate,
    scheduledTime: plan.scheduledTime,
    trips: r.trips.map(copyTrip),
  };
}
