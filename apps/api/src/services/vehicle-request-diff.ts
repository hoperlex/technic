import {
  assignmentTitle,
  formatMoscowDateTime,
  formatPhone,
  type FreightTransportRequestDto,
  type RequestChangeDto,
  type SpecialEquipmentRequestDto,
  tripCargoLabel,
  vehicleClassificationLabel,
  type VehicleRequestAssignmentDto,
  type VehicleRequestCompletionDto,
  type VehicleRequestDto,
  type VehicleRequestEarlyEndDto,
  type VehicleRequestShiftDto,
  type VehicleRequestTripDto,
  vehicleRequestTypeLabels,
  workedAmountLabel,
} from '@technic/contracts';
import { changeSet, EMPTY, short } from './request-diff';

// Что изменила правка заявки на технику — для истории в её карточке (ADR 0015). Общая механика
// диффа — в request-diff.ts; здесь перечень полей этого модуля.

/** Дата без времени (`YYYY-MM-DD`) в человеческом виде; через JS Date она бы поехала на день. */
function dateOnly(value: string | null): string {
  if (!value) return EMPTY;
  const [y, m, d] = value.split('-');
  return y && m && d ? `${d}.${m}.${y}` : value;
}

function measure(v: number | null, unit: string): string {
  return v == null ? EMPTY : `${v} ${unit}`;
}

/**
 * Заказчик заявки (ADR 0040) — «код — наименование» объекта либо отдела. Одной строкой на обе оси:
 * заказчик у заявки один, и его переезд с отдела на площадку — одно событие, а не пара «отдел
 * пропал» / «объект появился». Без этого у заявки отдела в истории стояло бы «null — null»:
 * колонки объекта у неё пусты по устройству, а не по недосмотру.
 */
function customerValue(r: VehicleRequestDto): string {
  if (r.objectId) return `${r.objectCode} — ${r.objectName}`;
  if (r.departmentId) return `${r.departmentCode} — ${r.departmentName}`;
  return EMPTY;
}

/** Заявка этой стороны сравнения — если она того самого типа; иначе `null` (поля читаются пустыми). */
function asSpecial(r: VehicleRequestDto): SpecialEquipmentRequestDto | null {
  return r.requestType === 'special_equipment' ? r : null;
}

function asFreight(r: VehicleRequestDto): FreightTransportRequestDto | null {
  return r.requestType === 'freight_transport' ? r : null;
}

/**
 * Значение поля ездки в истории: номер ездки и само значение — «2 · Карьер Сычёво».
 *
 * Номер живёт **в значении, а не в ключе** (§5.7): словарь подписей
 * (`vehicleRequestChangeLabels`) фиксирован, и ключ вида `trip.2.from` подписи бы не нашёл —
 * история напечатала бы сырую строку. Двум строкам с одним ключом ничто не мешает: изменения
 * складываются массивом, и правка двух ездок читается двумя строками подряд.
 *
 * Прочерк вместо пустого значения — как и везде в истории: пустой контакт у ездки, доехавшей
 * бэкфилом, это законное состояние (§5.7), а не пропуск в событии.
 */
function tripValue(num: number, text: string): string {
  return `${num} · ${text || EMPTY}`;
}

/**
 * Ездка целиком — одной строкой для событий состава (`tripAdded` / `tripRemoved`): номер, пара
 * адресов и количество. По форме это те же события-списки, что `filesAdded`/`filesRemoved`, и
 * значима у них только правая часть — «было» у появившейся ездки не бывает.
 *
 * Количество печатается тем же правилом, что и в бланке (`tripCargoLabel`): у легкового его нет
 * вовсе, и пустая часть в строку не попадает.
 */
function tripSummary(t: VehicleRequestTripDto): string {
  const cargo = tripCargoLabel(t);
  return [`${t.num} · ${t.fromLocation} → ${t.toLocation}`, cargo].filter(Boolean).join(' · ');
}

/**
 * Что стало с ездками заявки (Р1, Р13а, §5.7).
 *
 * Ездки сопоставляются по `id`, а не по номеру и не по порядку в списке: номер не
 * переиспользуется (Р13а), а порядок в DTO задан им же — сравнивать позиции значило бы прочесть
 * удаление второй из трёх как «вторая переехала в третью».
 *
 * Пропавшая ездка — это мягкое удаление: удалённые в DTO не приходят вовсе, и «её нет в „стало“»
 * означает ровно то, что она больше не едет. Появившаяся — заведённая правкой.
 *
 * Стороны бывают пустыми: у переоформления (ADR 0091) заявка приезжает сюда заказом на объект, у
 * которого ездок не бывает, — и тогда все ездки читаются как добавленные либо как удалённые.
 */
function diffTrips(
  diff: ReturnType<typeof changeSet>,
  before: readonly VehicleRequestTripDto[],
  after: readonly VehicleRequestTripDto[],
): void {
  const afterById = new Map(after.map((t) => [t.id, t]));
  const beforeIds = new Set(before.map((t) => t.id));
  for (const b of before) {
    const a = afterById.get(b.id);
    if (!a) continue;
    // Адрес сравнивается по строке, а не по метаданным: в истории читают, откуда и куда везли.
    diff.changed(
      'trip.from',
      tripValue(b.num, short(b.fromLocation)),
      tripValue(a.num, short(a.fromLocation)),
    );
    diff.changed(
      'trip.to',
      tripValue(b.num, short(b.toLocation)),
      tripValue(a.num, short(a.toLocation)),
    );
    // Объём и масса разными ключами: это разные единицы, а не разные значения одной.
    diff.changed(
      'trip.volume',
      tripValue(b.num, measure(b.volumeM3, 'м³')),
      tripValue(a.num, measure(a.volumeM3, 'м³')),
    );
    diff.changed(
      'trip.weight',
      tripValue(b.num, measure(b.weightTons, 'т')),
      tripValue(a.num, measure(a.weightTons, 'т')),
    );
    // Контакты на концах — четырьмя ключами: сменился ответственный за погрузку или за разгрузку,
    // читателю истории это разные события. Номер печатается тем же видом, что в карточке
    // (ADR 0066), иначе смена формата хранения читалась бы как смена телефона.
    diff.changed(
      'trip.fromResponsibleName',
      tripValue(b.num, b.fromResponsibleName),
      tripValue(a.num, a.fromResponsibleName),
    );
    diff.changed(
      'trip.fromResponsiblePhone',
      tripValue(b.num, formatPhone(b.fromResponsiblePhone)),
      tripValue(a.num, formatPhone(a.fromResponsiblePhone)),
    );
    diff.changed(
      'trip.toResponsibleName',
      tripValue(b.num, b.toResponsibleName),
      tripValue(a.num, a.toResponsibleName),
    );
    diff.changed(
      'trip.toResponsiblePhone',
      tripValue(b.num, formatPhone(b.toResponsiblePhone)),
      tripValue(a.num, formatPhone(a.toResponsiblePhone)),
    );
    // Своё время подачи (Р3): пусто — «как у заявки», и в истории это прочерк, а не «время сняли».
    diff.changed(
      'trip.scheduledAt',
      tripValue(b.num, b.scheduledAt ? formatMoscowDateTime(new Date(b.scheduledAt)) : ''),
      tripValue(a.num, a.scheduledAt ? formatMoscowDateTime(new Date(a.scheduledAt)) : ''),
    );
    diff.changed(
      'trip.comment',
      tripValue(b.num, short(b.comment)),
      tripValue(a.num, short(a.comment)),
    );
  }
  diff.listed('tripAdded', after.filter((t) => !beforeIds.has(t.id)).map(tripSummary));
  diff.listed('tripRemoved', before.filter((t) => !afterById.has(t.id)).map(tripSummary));
}

/**
 * Изменённые поля заявки. Значения — готовый текст на момент правки: тип ТС могли переименовать
 * или деактивировать, а история обязана показывать то, что было.
 *
 * Стороны бывают разных типов — так выглядит переоформление (ADR 0091). Тогда сравниваются поля
 * **обеих** деталей: срок работ уходит в прочерк, момент подачи из прочерка появляется. Пустая
 * сторона — это и есть ответ «у заявки такого поля больше нет»; пропусти её дифф, и в истории
 * заявка сменила бы тип, не сказав, что стало с заказанным сроком.
 */
export function diffVehicleRequests(
  before: VehicleRequestDto,
  after: VehicleRequestDto,
): RequestChangeDto[] {
  const diff = changeSet();

  // Первой строкой — сам тип: остальные поля события объясняются им, а не наоборот.
  diff.changed(
    'requestType',
    vehicleRequestTypeLabels[before.requestType],
    vehicleRequestTypeLabels[after.requestType],
  );
  diff.changed('object', customerValue(before), customerValue(after));
  // Заказанная позиция классификатора одной строкой (ADR 0028): наименование категории уже
  // начинается с типа, и две строки «Тип ТС» + «Категория» повторяли бы друг друга.
  diff.changed(
    'vehicleType',
    vehicleClassificationLabel({
      typeName: before.vehicleTypeName,
      categoryName: before.vehicleCategoryName,
    }),
    vehicleClassificationLabel({
      typeName: after.vehicleTypeName,
      categoryName: after.vehicleCategoryName,
    }),
  );

  // Детали сравниваются по отдельности, а не парой одного типа: у переоформления (ADR 0091)
  // стороны разных типов, и заполнена у каждой своя. Блок целиком пропускается там, где такой
  // детали нет ни до, ни после, — иначе всякая правка грузоперевозки писала бы «Дата начала: — → —».
  const specialBefore = asSpecial(before);
  const specialAfter = asSpecial(after);
  if (specialBefore || specialAfter) {
    diff.changed(
      'dateFrom',
      dateOnly(specialBefore?.dateFrom ?? null),
      dateOnly(specialAfter?.dateFrom ?? null),
    );
    diff.changed(
      'dateTo',
      dateOnly(specialBefore?.dateTo ?? null),
      dateOnly(specialAfter?.dateTo ?? null),
    );
    // Контакт ответственного (миграция 0062): в истории он читается наравне со сроком — по нему
    // звонят, и «телефон сменился» это событие, а не оформление.
    diff.changed(
      'responsibleName',
      specialBefore?.responsibleName || EMPTY,
      specialAfter?.responsibleName || EMPTY,
    );
    // Номер в истории — тем же видом, что в карточке (ADR 0066): иначе смена формата хранения
    // читалась бы как смена телефона.
    diff.changed(
      'responsiblePhone',
      formatPhone(specialBefore?.responsiblePhone ?? '') || EMPTY,
      formatPhone(specialAfter?.responsiblePhone ?? '') || EMPTY,
    );
  }

  const freightBefore = asFreight(before);
  const freightAfter = asFreight(after);
  if (freightBefore || freightAfter) {
    diff.changed(
      'scheduledAt',
      freightBefore
        ? formatMoscowDateTime(
            new Date(freightBefore.scheduledAt),
            freightBefore.scheduledTimeUnspecified,
          )
        : EMPTY,
      freightAfter
        ? formatMoscowDateTime(
            new Date(freightAfter.scheduledAt),
            freightAfter.scheduledTimeUnspecified,
          )
        : EMPTY,
    );
    /*
     * Адреса, количество и контакты уехали с заявки на ездку (Р2), и событий у них теперь свои
     * ключи — `trip.*` вместо `loadingLocation` и прочих. Старые ключи при этом остаются в
     * словаре подписей (§5.7): их читают события, записанные до миграции `0136`, и пересчитать
     * такую историю нечем — она говорит, что было.
     */
    diffTrips(diff, freightBefore?.trips ?? [], freightAfter?.trips ?? []);
  }

  diff.changed('comment', short(before.comment) || EMPTY, short(after.comment) || EMPTY);
  diff.files(before.files, after.files);

  return diff.changes;
}

/**
 * Что несёт запрос на досрочное завершение (ADR 0044): до какого числа просят сократить срок и
 * почему. Событие запроса, а не правки: срок заявки в этот момент ещё прежний, и ключ у даты
 * поэтому свой (`earlyEndDate`), а не `dateTo` — иначе история сообщала бы о сокращении, которого
 * ещё не было. Согласование пишется обычным диффом заявки: там `dateTo` меняется по-настоящему.
 */
export function diffVehicleEarlyEnd(
  e: Pick<VehicleRequestEarlyEndDto, 'previousDateTo' | 'newDateTo' | 'reason'>,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('earlyEndDate', dateOnly(e.previousDateTo), dateOnly(e.newDateTo));
  diff.changed('earlyEndReason', EMPTY, short(e.reason));
  return diff.changes;
}

/**
 * Причина отказа или снятия запроса — событием-списком: значима только правая часть. «Было» у
 * причины не бывает: её называют один раз и в тот момент, когда решение принято.
 */
export function earlyEndReasonChange(reason: string): RequestChangeDto[] {
  const diff = changeSet();
  diff.listed('earlyEndReason', reason ? [reason] : []);
  return diff.changes;
}

/**
 * Продление срока недельной заявкой (ADR 0085): дата — той же парой «было → стало», что и у
 * обычной правки, а рядом номер пакета, которым её сдвинули.
 */
export function weeklyExtendChanges(
  weeklyNumber: string,
  previousDateTo: string | null,
  newDateTo: string | null,
): RequestChangeDto[] {
  const diff = changeSet();
  // Номер пакета — тоже изменением, а не только реквизитом события: до карточки заказа доезжают
  // именно `changes`, и без этой строки история сообщала бы, что срок сдвинулся, но не сказала бы,
  // чьим решением.
  diff.listed('weeklyRequest', [weeklyNumber]);
  diff.changed('dateTo', dateOnly(previousDateTo), dateOnly(newDateTo));
  return diff.changes;
}

/**
 * Что подтвердили (или с чего сняли подпись) — день и его показатели одной строкой:
 * «12.08.2026 · 08:00–20:00 · 11,5 ч · 120 л». Событием-списком, потому что «было» здесь нет:
 * решение принимают один раз про один день, а правки самих часов события не пишут вовсе.
 */
export function shiftChange(s: VehicleRequestShiftDto): RequestChangeDto[] {
  const parts = [dateOnly(s.date)];
  if (s.startedAt && s.endedAt) parts.push(`${s.startedAt}–${s.endedAt}`);
  parts.push(workedAmountLabel('hours', s.machineHours));
  if (s.refuel) parts.push(s.refuel);
  // Причина простоя — часть строки: без неё «0 ч» в истории читается как ошибка ввода.
  if (s.machineHours === 0 && s.comment) parts.push(s.comment);
  const diff = changeSet();
  diff.listed('shift', [parts.join(' · ')]);
  return diff.changes;
}

/** Ставка в рублях; незаполненная — прочерком, как и всякое пустое значение в истории. */
function rub(v: number | null): string {
  if (v == null) return EMPTY;
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Как машина названа в истории: подпись из справочника, её позиция классификатора и арендодатель —
 * без последнего две машины одной категории у разных арендодателей в истории неразличимы.
 *
 * Позиция пишется потому, что заказанное и вышедшее расходятся законно: категория — с ADR 0045,
 * тип — с ADR 0059. Чем закрыли заявку, по подписи собственной машины (госномеру) не видно вовсе.
 * Пишется всегда, а не только при расхождении: дифф сравнивает два назначения и заказанной
 * позиции не знает, да и «чем именно закрыли» интересно само по себе.
 *
 * Наименование категории уже содержит тип («Автокраны, г/п 25 т», ADR 0016 §11) — тип пишется
 * только там, где категории нет. Незаполненная позиция и позиция, которая и есть подпись, не
 * дублируются.
 */
function vehicleValue(a: VehicleRequestAssignmentDto): string {
  const title = assignmentTitle(a);
  const position = a.categoryName ?? a.typeName;
  return [title, position !== title ? position : null, a.lessorName].filter(Boolean).join(' · ');
}

/**
 * Что изменило назначение техники (ADR 0027). `before === null` — заявку берут в работу впервые,
 * и слева у всех полей прочерк: назначения не было. Ставки сравниваются наравне с машиной —
 * повторный перевод в работу той же машиной, но по другой цене, это тоже событие.
 *
 * `after === null` — назначение сняли: заявку вернули из работы в «Новую», и машины у неё больше
 * нет. Прочерки справа, а не пустое событие: «была такая-то машина по такой-то ставке, стало
 * ничего» — единственный след того, чем заявку собирались выполнять до отката.
 */
export function diffVehicleAssignment(
  before: VehicleRequestAssignmentDto | null,
  after: VehicleRequestAssignmentDto | null,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed(
    'vehicle',
    before ? vehicleValue(before) : EMPTY,
    after ? vehicleValue(after) : EMPTY,
  );
  diff.changed('pricePerHour', rub(before?.pricePerHour ?? null), rub(after?.pricePerHour ?? null));
  diff.changed(
    'pricePerShift',
    rub(before?.pricePerShift ?? null),
    rub(after?.pricePerShift ?? null),
  );
  diff.changed(
    'shiftHours',
    before?.shiftHours == null ? EMPTY : `${before.shiftHours} ч`,
    after?.shiftHours == null ? EMPTY : `${after.shiftHours} ч`,
  );
  return diff.changes;
}

/** Отработанное — с единицей: «26 ч» и «26 смен» это разные факты, а число одно. */
function worked(c: VehicleRequestCompletionDto | null): string {
  return c ? workedAmountLabel(c.workedUnit, c.workedAmount) : EMPTY;
}

/**
 * Что предъявило закрытие заявки (ADR 0029). `before === null` — заявку закрывают впервые, и
 * слева прочерки. Повторное закрытие (после отката администратором) сравнивается с прежним
 * фактом: «отработали не 3 смены, а 2, и сумма другая» — это событие, а не уточнение.
 *
 * `after === null` — факт сняли возвратом заявки в «Новую»: предъявленного больше нет, и справа
 * прочерки. Иначе сумма закрытия осталась бы в истории последним словом о заявке, которую с
 * работы сняли.
 */
export function diffVehicleCompletion(
  before: VehicleRequestCompletionDto | null,
  after: VehicleRequestCompletionDto | null,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('worked', worked(before), worked(after));
  diff.changed('rate', rub(before?.rate ?? null), rub(after?.rate ?? null));
  diff.changed('totalCost', rub(before?.totalCost ?? null), rub(after?.totalCost ?? null));
  return diff.changes;
}
