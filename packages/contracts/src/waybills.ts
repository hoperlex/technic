import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';
import type { FileDto } from './files';
import { dateKeysBetween, shiftDateKey, weekStartKey } from './time';
import type { VehicleOwnership } from './vehicles';
import type { RequestStatus, VehicleRequestType } from './enums';

// ── Путевой лист (ADR 0037) ──
// Лист — документ строгой отчётности: серия, номер, журнал учёта. Черновика у него нет: он
// выписывается с маршрута сразу выданным (ADR 0050), а испорченный бланк аннулируют с причиной.

export const WAYBILL_STATUSES = ['issued', 'cancelled'] as const;
export const waybillStatusSchema = z.enum(WAYBILL_STATUSES);
export type WaybillStatus = (typeof WAYBILL_STATUSES)[number];

export const waybillStatusLabels: Record<WaybillStatus, string> = {
  issued: 'Выдан',
  cancelled: 'Аннулирован',
};

export const waybillStatusColors: Record<WaybillStatus, string> = {
  issued: 'green',
  cancelled: 'red',
};

/**
 * Бланки. Расширение области идёт значением в справочнике, а не второй схемой (ADR 0037).
 */
export const WAYBILL_FORM_CODES = ['4p', 'leg3', 'esm2'] as const;
export const waybillFormCodeSchema = z.enum(WAYBILL_FORM_CODES);
export type WaybillFormCode = (typeof WAYBILL_FORM_CODES)[number];

/**
 * Бланки, которые закрепляются за типом ТС в справочнике (ADR 0065).
 *
 * ЭСМ-2 сюда не входит, и это не забывчивость: он выписывается порталом **по виду заявки**
 * (`esm2Required`), а не по типу техники — заявку на технику берут в работу, и листы на все недели
 * её срока рождаются сами. Проставленный типу `'esm2'` не включил бы ничего, зато у машины,
 * которой этот тип стоит, лист на рейс печатался бы недельным бланком строительной машины.
 *
 * Умолчание — 4-П: у собственной техники лист есть всегда, а форма № 3 включается признаком
 * «легковой транспорт» в справочнике типов.
 */
export const TYPE_WAYBILL_FORM_CODES = ['4p', 'leg3'] as const;
export const typeWaybillFormCodeSchema = z.enum(TYPE_WAYBILL_FORM_CODES, {
  error: 'Типу закрепляют бланк 4-П или форму № 3: ЭСМ-2 портал выписывает сам по заявке',
});
export type TypeWaybillFormCode = (typeof TYPE_WAYBILL_FORM_CODES)[number];

/** Бланк типа по умолчанию: им заводится тип, у которого не сказано обратного (миграция 0094). */
export const DEFAULT_TYPE_WAYBILL_FORM: TypeWaybillFormCode = '4p';

/**
 * Легковой ли это транспорт — так вопрос стоит в справочнике типов, и бланк из него следует.
 * Признак и код формы — одно и то же знание в двух видах, поэтому колонки «легковой» нет:
 * второй источник правды разошёлся бы с первым на первой же правке.
 */
export function isPassengerTypeForm(formCode: WaybillFormCode): boolean {
  return formCode === 'leg3';
}

/** Обратный перевод: чекбокс формы справочника — в значение, которое ляжет в справочник. */
export function typeWaybillFormOf(isPassenger: boolean): TypeWaybillFormCode {
  return isPassenger ? 'leg3' : DEFAULT_TYPE_WAYBILL_FORM;
}

export const waybillFormLabels: Record<WaybillFormCode, string> = {
  '4p': 'Форма 4-П (грузовой автомобиль)',
  leg3: 'Форма № 3 (легковой автомобиль)',
  esm2: 'Форма ЭСМ-2 (строительная машина)',
};

/**
 * Как форму называют в столбце журнала: полная подпись туда не влезает, а на вопрос «какой это
 * бланк» отвечает и короткая. Полная остаётся в подсказке фильтра — там место есть.
 */
export const waybillFormShortLabels: Record<WaybillFormCode, string> = {
  '4p': '4-П',
  leg3: '№ 3',
  esm2: 'ЭСМ-2',
};

// ── На какой рейс выписывается лист (ADR 0037 п. 1, ADR 0041) ──

export interface WaybillRequirementInput {
  /** Тип заявки: лист выписывается только на грузоперевозку. */
  requestType: VehicleRequestType;
  /** Принадлежность машины: на арендную лист выписывает арендодатель. */
  ownership: VehicleOwnership;
  /** Бланк, закреплённый за типом ТС (`vehicle_types.waybill_form_code`). Пустым не бывает. */
  formCode: WaybillFormCode;
}

export interface WaybillRequirement {
  /** Бланк, по которому выписывается лист; `null` — на этот рейс лист не выписывается. */
  formCode: WaybillFormCode | null;
  /**
   * Почему не выписывается — это показывают человеку вместо отсутствующего блока. `null` при
   * пустом `formCode` означает другое: заявка такого вида путевого листа не знает вовсе, и
   * говорить не о чем — ни блока, ни объяснения (ADR 0041).
   */
  reason: string | null;
}

/** Единственная причина, по которой у рейса не бывает листа при живой заявке-грузоперевозке. */
export const RENTAL_WAYBILL_REASON = 'Путевой лист на арендную технику выписывает арендодатель';

/**
 * Нужен ли на этот рейс путевой лист.
 *
 * Отказов осталось два, и оба — не про тип техники (ADR 0065). Первый: заказ техники на объект
 * листа не знает вовсе — там нет ни рейса, ни маршрута, ни груза, и объяснять в форме нечего
 * (ADR 0041). Второй: арендную машину ведёт арендодатель, и об этом сказать надо.
 *
 * Третьего отказа — «у типа не заведён бланк» — больше не существует: у собственной техники лист
 * есть всегда, а тип отвечает лишь на вопрос, каким бланком (миграция 0094). Прежнее пустое
 * значение означало не решение, а незаполненную колонку, и молча отключало документ у каждого
 * типа, заведённого через справочник.
 */
export function waybillRequirement(input: WaybillRequirementInput): WaybillRequirement {
  if (input.requestType !== 'freight_transport') return { formCode: null, reason: null };
  if (input.ownership !== 'own') return { formCode: null, reason: RENTAL_WAYBILL_REASON };
  return { formCode: input.formCode, reason: null };
}

// ── ЭСМ-2: лист на неделю работы машины на площадке ──

/**
 * Нужны ли заявке листы ЭСМ-2.
 *
 * Третий вход в то же семейство, что `waybillRequirement` (лист на рейс грузоперевозки) и
 * `routeWaybillForm` (лист на рейс маршрута), и правило здесь своё: бланк выбирается **путём
 * выписки**, а не справочником типов. Проставить `vehicle_types.waybill_form_code='esm2'` типам
 * спецтехники нельзя — заполненный бланк у типа `assertRouteVehicle` считает разрешением заводить
 * грузовой рейс (ADR 0057 Р13).
 *
 * Статус спрашивается наравне с типом: у заявки, ушедшей из работы, действующих листов быть не
 * должно, и «сколько их нужно» — это ноль, а не «столько же, сколько было».
 */
export function esm2Required(input: {
  requestType: VehicleRequestType;
  status: RequestStatus;
  ownership: VehicleOwnership | null;
  deletedAt?: string | null;
}): boolean {
  if (input.requestType !== 'special_equipment') return false;
  if (input.status !== 'confirmed' && input.status !== 'done') return false;
  if (input.deletedAt) return false;
  // Лист на арендную технику выписывает арендодатель — тем же правилом, что и у грузоперевозки.
  return input.ownership === 'own';
}

/** Неделя работы машины: то, что печатается одним бланком ЭСМ-2. */
export interface Esm2Period {
  /** Первый рабочий день недели — он же дата листа и «Период работы: с». */
  from: string;
  /** Последний рабочий день недели — «Период работы: по». */
  to: string;
}

/**
 * Срок заявки, разрезанный на недели: по листу на каждую.
 *
 * Единица бланка — календарная неделя (семь строк «пн…вс» и недельные итоги), поэтому границ,
 * режущих срок, ровно две: его начало и его конец. По границе месяца неделя **не дробится** —
 * лист остаётся одним документом, а в графе «месяца» печатаются оба номера («08–09»).
 *
 * Пустая дата окончания — однодневный срок: так её читают и отбор среза, и подписи присутствия.
 */
export function esm2Periods(dateFrom: string, dateTo: string | null): Esm2Period[] {
  const last = dateTo || dateFrom;
  if (!dateFrom || last < dateFrom) return [];
  const periods: Esm2Period[] = [];
  let from = dateFrom;
  while (from <= last) {
    const weekEnd = shiftDateKey(weekStartKey(from), 6);
    const to = weekEnd < last ? weekEnd : last;
    periods.push({ from, to });
    from = shiftDateKey(to, 1);
  }
  return periods;
}

/**
 * Семь дней недели листа — от понедельника до воскресенья, независимо от того, какой кусок недели
 * покрывает сам лист: строки «пн…вс» впечатаны в бланк, и сдвигать их нельзя. В дни вне периода
 * заявки печатается только число — графа «Наименование и адрес объекта» остаётся пустой (портал
 * не знает, работала ли машина в субботу).
 */
export function esm2WeekDays(period: Esm2Period): { date: string; inPeriod: boolean }[] {
  const monday = weekStartKey(period.from);
  return dateKeysBetween(monday, shiftDateKey(monday, 6)).map((date) => ({
    date,
    inPeriod: date >= period.from && date <= period.to,
  }));
}

/** Действующий лист ЭСМ-2 заявки — то, с чем сверяется нужный набор недель. */
export interface Esm2Sheet {
  id: string;
  periodFrom: string;
  periodTo: string;
  vehicleId: string;
  driverPersonId: string;
}

/** Что сделать с бумагой, чтобы она сошлась с заявкой. */
export interface Esm2SyncPlan {
  /** Листы под аннулирование: их данные разошлись с заявкой либо недели больше нет. */
  cancel: string[];
  /** Недели, на которые листа не осталось: их выписывают новыми номерами. */
  issue: Esm2Period[];
}

/**
 * Сверка «что должно быть» с «что есть» — сердце ведения ЭСМ-2 порталом.
 *
 * Выданный лист не правится никогда: бланк строгой отчётности с исправленными задним числом
 * графами — не документ. Изменить содержание можно только аннулированием номера и выпиской
 * нового. И столь же твёрдо обратное: сошлось — не трогаем. Пустые списки в ответе означают, что
 * бумага в порядке, и ни один номер не сгорит.
 *
 * Отработанные недели неприкосновенны. Лист, чей последний день уже прошёл (`canCancelWaybill`),
 * не аннулируется и не считается расхождением: машина эти дни отстояла, заказчик заполнил оборот.
 * Больше того — такой лист закрывает свою календарную неделю целиком: выписать на неё второй,
 * «правильный», значило бы выдать два документа на одну работу.
 */
export function esm2SyncPlan(input: {
  /** Недели, которые должны быть выписаны (`esm2Periods`); пусто — листов быть не должно. */
  wanted: readonly Esm2Period[];
  /** Действующие листы заявки. */
  existing: readonly Esm2Sheet[];
  /** Машина и машинист, какими они стоят на заявке сейчас. */
  vehicleId: string | null;
  driverPersonId: string | null;
  /** Сегодня по МСК: им отделяются отработанные недели от предстоящих. */
  today: string;
}): Esm2SyncPlan {
  const locked = new Set<string>();
  const kept = new Set<string>();
  const cancel: string[] = [];

  for (const sheet of input.existing) {
    // У ЭСМ-2 дата листа — первый рабочий день недели, а граница аннулирования — последний.
    if (
      !canCancelWaybill({ issuedForDate: sheet.periodFrom, periodTo: sheet.periodTo }, input.today)
    ) {
      locked.add(weekStartKey(sheet.periodFrom));
      continue;
    }
    const matches =
      sheet.vehicleId === input.vehicleId &&
      sheet.driverPersonId === input.driverPersonId &&
      input.wanted.some((p) => p.from === sheet.periodFrom && p.to === sheet.periodTo);
    if (matches) kept.add(sheet.periodFrom);
    else cancel.push(sheet.id);
  }

  const issue = input.wanted.filter((p) => !kept.has(p.from) && !locked.has(weekStartKey(p.from)));
  return { cancel, issue };
}

/** Номер бланка с ведущими нулями: «00000004897» при ширине 8 и больше. */
export function formatWaybillNumber(num: number, width: number): string {
  return String(num).padStart(width, '0');
}

/**
 * Как лист называют в журнале и в разговоре: «260604-646-00000004897». Без серии остаётся один
 * номер — префикс печатается в своей графе бланка и у новых серий пуст, пока его не задали.
 */
export function waybillDisplayNumber(prefix: string, num: number, width: number): string {
  return `${prefix}${formatWaybillNumber(num, width)}`;
}

/**
 * Ключи снимка — они же плейсхолдеры бланка. Объявлены списком, а не выводятся из кода сборки:
 * по нему тест сверяет шаблон, и графа, которой в снимке нет, не доедет до бумаги молча
 * (ADR 0037 п. 10).
 */
export const WAYBILL_SNAPSHOT_KEYS = [
  'org_name',
  'org_address',
  'org_phone',
  'org_okpo',
  'org_ogrn',
  'waybill_series',
  'waybill_number',
  'waybill_date',
  'vehicle_brand',
  'vehicle_reg_number',
  'vehicle_garage_number',
  'vehicle_inventory_number',
  'trailer1_brand',
  'trailer1_reg_number',
  'trailer2_brand',
  'trailer2_reg_number',
  'driver_fio',
  'driver_snils',
  'driver_personnel_no',
  'driver_license_number',
  'driver_license_issued_on',
  'communication_kind',
  'transportation_kind',
  'customer_name',
  'customer_address',
  // Телефон ответственного на площадке: у ЭСМ-2 графа «Заказчик» просит его наравне с адресом —
  // машина стоит на объекте неделю, и звонят туда, а не в организацию.
  'customer_phone',
  'task_from',
  'task_to',
  // Груз: количество первой строкой, комментарий заявки — второй (ADR 0071). Две строки, а не
  // две графы: в бланке на груз отведена одна ячейка, и разводит их перенос внутри неё.
  'task_cargo',
  // Графа «заказчик, телефон» 4-П: две строки — контакт погрузки и контакт разгрузки, по одному
  // на каждый конец маршрута (миграция 0062). Наименование заказчика туда не идёт: оно уже стоит
  // в шапке задания «в чьё распоряжение», а водителю в дороге нужен тот, кто откроет ворота.
  'task_contacts',
  // Время выезда графой 4-П. Клеток «ч» и «мин» формы № 3 здесь больше нет: задание в ней не
  // печатается вовсе (ADR 0071), и разбирать время по двум ключам стало не для чего.
  'task_departure_time',
  // Талоны 2–4 нижнего задания: в таблице бланка четыре строки, и рейс из четырёх заявок
  // печатается целиком. Пустые строки остаются пустыми — так же, как до маршрутов печаталась
  // единственная (ADR 0050 п. 15). Наименования заказчика у этих строк нет: графы под него в
  // 4-П не заведено, а печатала его только форма № 3 — до того, как задание ушло из неё вовсе
  // (ADR 0071).
  'task2_from',
  'task2_to',
  'task2_cargo',
  'task2_contacts',
  'task3_from',
  'task3_to',
  'task3_cargo',
  'task3_contacts',
  'task4_from',
  'task4_to',
  'task4_cargo',
  'task4_contacts',
  /*
   * Рейсы 5–7 (ADR 0068). В 4-П им отведены три нижние строки блока «Дополнительное задание
   * водителю» — три объединённые ячейки без единой графы внутри, поэтому туда идёт готовая строка
   * `*_line`: «откуда → куда, груз, контакты». Собирает её сервер, а не бланк: склейка
   * плейсхолдеров в ячейке напечатала бы у пустого рейса осиротевшие стрелку и запятые.
   *
   * Разобранных граф рядом больше нет: они размечались на обороте формы № 3, а задание в ней не
   * печатается вовсе (ADR 0071). Восьмой, девятой и десятой строк не осталось по той же причине —
   * в 4-П места под них нет, и печатать их стало негде.
   */
  'task5_line',
  'task6_line',
  'task7_line',
  // Графы диспетчера здесь нет намеренно: подпись и её расшифровку портал не печатает, и из
  // обоих бланков они стёрты. Документ подписывают на бумаге, а напечатанная рядом с пустой
  // линией фамилия читалась бы как подпись, которой нет. Кто выписал лист, помнят
  // `waybills.issued_by` и журнал аудита.

  // ── Графы ЭСМ-2 (лист на неделю работы машины) ──
  // «Дата составления» разложена на три клетки бланка: одной строкой «31.08.2026» их не заполнить.
  'waybill_date_dd',
  'waybill_date_mm',
  'waybill_date_yyyy',
  /** Код объекта затрат — им бухгалтерия разносит машино-часы по стройкам. */
  'object_code',
  // «Период работы: с __ по __ месяца __ года __» — фактические рабочие дни этой недели. Месяц
  // один на графу: у недели через границу месяца туда идут оба номера («08–09»).
  'period_from_day',
  'period_to_day',
  'period_month',
  'period_year',
  // Семь строк недели: числа месяца понедельника…воскресенья и объект — только в дни срока.
  'day1_date',
  'day2_date',
  'day3_date',
  'day4_date',
  'day5_date',
  'day6_date',
  'day7_date',
  'day1_object',
  'day2_object',
  'day3_object',
  'day4_object',
  'day5_object',
  'day6_object',
  'day7_object',
] as const;

export type WaybillSnapshotKey = (typeof WAYBILL_SNAPSHOT_KEYS)[number];

/**
 * Снимок листа, выписанного до того, как графа «заказчик, телефон» стала печатать контакты рейса.
 * Ключей `task*_contacts` у такого снимка нет вовсе, а бланк уже размечен ими — и графа вышла бы
 * из принтера пустой. Повторная печать обязана давать тот же документ, что выдан на руки
 * (ADR 0037 п. 10), поэтому старому снимку графа достаётся тем, чем она была на момент выдачи:
 * наименованием заказчика талона.
 *
 * Признаком служит отсутствие самого ключа, а не пустое значение в нём: у нового листа пустая
 * графа значит «контакта в заявке не было», и подменять её наименованием нельзя.
 */
export function snapshotForPrint(data: Record<string, string>): Record<string, string> {
  if ('task_contacts' in data) return data;
  return {
    ...data,
    task_contacts: data.customer_name ?? '',
    task2_contacts: data.task2_customer ?? '',
    task3_contacts: data.task3_customer ?? '',
    task4_contacts: data.task4_customer ?? '',
  };
}

// ── Журнал учёта (ADR 0037) ──
// Лист — бланк строгой отчётности: журнал отвечает, какие номера выданы, на какие машины и что
// с ними стало. Аннулированные из него не исчезают — пропуск в нумерации означал бы утраченный
// бланк, а не отменённый рейс.

export interface WaybillRequestLinkDto {
  requestId: string;
  /** «ТС-501» — номер заявки, как его читают в портале. */
  displayNumber: string;
  /**
   * Место заявки в задании листа, 1–7. Первые четыре — талоны заказчиков бланка 4-П, остальные
   * печатаются строкой доп. задания и талона не имеют (ADR 0068).
   */
  slot: number;
  objectName: string;
  /**
   * Состояние заявки на сейчас. Журналу оно не колонка — им выбирают, куда вести номер талона:
   * лист выписывают на рейс, а читают журнал позже, когда заявка чаще всего уже закрыта и лежит
   * не в списке заявок, а в журнале закрытых (ADR 0029).
   */
  status: RequestStatus;
}

export interface WaybillDto {
  id: string;
  /** «260604-646-00000004897» — как номер напечатан на бланке. */
  number: string;
  formCode: WaybillFormCode;
  status: WaybillStatus;
  /** День, на который выписан лист; у ЭСМ-2 — первый рабочий день его недели. */
  issuedForDate: string;
  /**
   * Неделя работы машины у ЭСМ-2: первый и последний рабочий день листа. `null` у 4-П и формы
   * № 3 — те выписываются на рейс одного дня, и периода у них нет вовсе.
   */
  periodFrom: string | null;
  periodTo: string | null;
  organizationName: string;
  vehicleId: string;
  /** «КамАЗ 65201 · Е646СК799» — чем именно ехали. */
  vehicleLabel: string;
  driverPersonId: string;
  driverName: string;
  withTrailer: boolean;
  trailerLabel: string;
  issuedByName: string;
  issuedAt: string;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancelReason: string;
  /**
   * Когда лист печатали и когда выгружали файлом — последний раз и кем угодно (`null` — ни разу).
   *
   * Это отметка о факте, а не о намерении: печать пачкой считается наравне с одиночной, и чужая
   * печать наравне со своей. Вопрос, на который она отвечает, один — «эта бумага уже уехала?»:
   * второй экземпляр того же номера на руках у двух людей хуже, чем лишний поход в журнал.
   *
   * Считается по журналу аудита, где эти события и так пишутся (`waybill.print`,
   * `waybill.export`), — своих колонок у листа под это нет.
   */
  printedAt: string | null;
  exportedAt: string | null;
  /** Заявки, которые машина выполняет по этому листу — талоны заказчиков. */
  requests: WaybillRequestLinkDto[];
  /**
   * Что подшито к бланку: скан заполненного заказчиком оборота, фотография отметок, акт. Портал
   * этих значений не разбирает — журнал учёта отвечает, чем кончился выданный номер.
   */
  files: FileDto[];
}

/**
 * Лист, выписанный по заявке (ADR 0041): его показывает карточка заявки, чтобы печатать бланк
 * там же, где заявку взяли в работу, а не искать её номер в журнале.
 *
 * У грузоперевозки он один — рейс один. У заказа техники на объект их столько, сколько недель в
 * сроке: карточка показывает список, а `periodFrom`/`periodTo` отвечают, какая это неделя.
 */
export interface RequestWaybillDto {
  id: string;
  /** «260604-646-00000004897» — как номер напечатан на бланке. */
  number: string;
  formCode: WaybillFormCode;
  status: WaybillStatus;
  issuedForDate: string;
  /** Неделя работы у ЭСМ-2; `null` у листов на рейс (см. `WaybillDto`). */
  periodFrom: string | null;
  periodTo: string | null;
  /** Талон заказчика, в котором стоит эта заявка: 1–4 (ADR 0037 п. 3). */
  slot: number;
  driverName: string;
  /**
   * Рейс, по которому лист выписан (маршруты). `null` — лист выдан до маршрутов и ещё не
   * перенесён: пока история не перенесена, такие листы живут наравне с новыми, и карточка
   * показывает их так же — без номера рейса.
   */
  routeId: string | null;
  routeNumber: string | null;
}

export const WAYBILL_SORT_FIELDS = ['issuedForDate', 'number', 'issuedAt'] as const;

export const waybillListQuerySchema = baseListQuery(WAYBILL_SORT_FIELDS).extend({
  /** Период выдачи: журнал читают по дням, а не по всей истории сразу. */
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  vehicleId: uuidSchema.optional(),
  driverPersonId: uuidSchema.optional(),
  status: waybillStatusSchema.optional(),
  /**
   * Бланк: 4-П, форма № 3 или ЭСМ-2. Журнал у них один — журнал строгой отчётности, — а читают
   * их разные люди по разным поводам, и без этого сужения недельные листы спецтехники тонут в
   * ежедневных рейсовых.
   */
  formCode: waybillFormCodeSchema.optional(),
});
export type WaybillListQuery = z.infer<typeof waybillListQuerySchema>;

/**
 * Аннулирование листа. Причина обязательна: испорченный бланк списывают, и в журнале должно быть
 * видно, почему номер не ушёл в рейс.
 */
export const cancelWaybillSchema = z
  .object({ reason: z.string().trim().min(1, 'Укажите причину').max(2000) })
  .strict();
export type CancelWaybillInput = z.infer<typeof cancelWaybillSchema>;

/**
 * Можно ли ещё аннулировать лист (ADR 0037 п. 9 в редакции ADR 0052). По последний день листа
 * включительно — да; со следующего дня — нет: работа состоялась, бланк отработал, и лист стал
 * историей, а не планом.
 *
 * Последний день у листов разный, и в этом всё различие. У 4-П и формы № 3 это день рейса:
 * граница «строго до даты выезда» писалась, когда лист рождался переводом заявки в работу — часто
 * накануне, — а с маршрутами документ выписывают утром дня выезда, и «нельзя в день выезда»
 * означало бы «нельзя никогда». У ЭСМ-2 это последний рабочий день недели: неделя ещё идёт, бланк
 * ещё у машиниста, и досрочно завершённая заявка обязана успеть его переписать.
 */
export function canCancelWaybill(
  waybill: { issuedForDate: string; periodTo?: string | null },
  today: string,
): boolean {
  return today <= (waybill.periodTo || waybill.issuedForDate);
}

export const WAYBILL_LOCKED_MESSAGE =
  'Лист выписан на прошедший день — работа состоялась, и аннулировать бланк уже нельзя';

/**
 * Аннулированный лист не печатают и не выгружают — ни одной роли.
 *
 * Прежде бумага у аннулированного бланка была доступна наравне с выданным: испорченный бланк
 * подшивают к журналу. Но напечатанный аннулированный лист неотличим от действующего — те же
 * реквизиты, тот же номер, — и оказавшись у водителя, он ездит документом, которого уже нет. Что
 * с номером стало, отвечает сама строка журнала, а заполненный оборот подшивают вложением
 * (ADR 0037 п. 11), не перепечатывая бланк.
 *
 * Правило одно на портал и на сервер: кнопка не должна обещать того, чем ручка ответит отказом.
 */
export function canPrintWaybill(status: WaybillStatus): boolean {
  return status !== 'cancelled';
}

export const WAYBILL_CANCELLED_PRINT_MESSAGE =
  'Лист аннулирован: номер списан, и печатать или выгружать такой бланк нельзя';

/**
 * Пачка листов, печатаемая одним документом (ADR 0041 в редакции массовой печати).
 *
 * Предел — не про сервер, а про бумагу и терпение: каждый лист это отдельный бланк A4, и полсотни
 * страниц печатают уже пачкой в лотке, а не «ещё разок». Он же держит время сборки: бланки
 * переводит в PDF LibreOffice, и на сотне листов запрос ушёл бы за минуту.
 */
export const WAYBILL_PRINT_BATCH_LIMIT = 50;

export const printWaybillsBatchSchema = z
  .object({
    /**
     * Листы в том порядке, в каком их напечатать. Порядок задаёт портал (как в журнале), а не
     * сервер: пачку разбирают по столу в том же виде, в каком её видели на экране.
     */
    ids: z.array(uuidSchema).min(1, 'Выберите хотя бы один лист').max(WAYBILL_PRINT_BATCH_LIMIT),
  })
  .strict();
export type PrintWaybillsBatchInput = z.infer<typeof printWaybillsBatchSchema>;

/** Сколько листов выбрано — так это подписывает виджет над пагинацией: «Выбрано 3 листа». */
export function selectedWaybillsLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const word =
    mod100 >= 11 && mod100 <= 14
      ? 'листов'
      : mod10 === 1
        ? 'лист'
        : mod10 >= 2 && mod10 <= 4
          ? 'листа'
          : 'листов';
  return `Выбрано ${count} ${word}`;
}

// ── Вложения к листу ──

/**
 * Что подшивают к номеру бланка: скан заполненного заказчиком оборота ЭСМ-2, фотографию отметок
 * 4-П, акт. Файл крепится к самому листу, а не к заявке: заявок у листа бывает четыре, а неделя
 * работ распадается на несколько листов — «чей это скан» отвечает только номер бланка.
 *
 * Лимит держит сервер тем же `config.files.maxPerRequest`, что и у заявок: файловая подсистема
 * одна на портал (ADR 0024).
 */
export const attachWaybillFilesSchema = z
  .object({ addFileIds: z.array(uuidSchema).min(1).max(20) })
  .strict();
export type AttachWaybillFilesInput = z.infer<typeof attachWaybillFilesSchema>;
