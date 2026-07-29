import {
  assignmentTitle,
  formatMoscowDateTime,
  type RequestChangeDto,
  vehicleClassificationLabel,
  type VehicleRequestAssignmentDto,
  type VehicleRequestCompletionDto,
  type VehicleRequestDto,
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
 * Изменённые поля заявки. Значения — готовый текст на момент правки: тип ТС могли переименовать
 * или деактивировать, а история обязана показывать то, что было. Тип заявки неизменяем (сервер
 * отдаёт 422 при попытке смены), поэтому поля деталей сравниваются парой своего типа.
 */
export function diffVehicleRequests(
  before: VehicleRequestDto,
  after: VehicleRequestDto,
): RequestChangeDto[] {
  const diff = changeSet();

  diff.changed(
    'object',
    `${before.objectCode} — ${before.objectName}`,
    `${after.objectCode} — ${after.objectName}`,
  );
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

  if (before.requestType === 'special_equipment' && after.requestType === 'special_equipment') {
    diff.changed('dateFrom', dateOnly(before.dateFrom), dateOnly(after.dateFrom));
    diff.changed('dateTo', dateOnly(before.dateTo), dateOnly(after.dateTo));
  } else if (
    before.requestType === 'freight_transport' &&
    after.requestType === 'freight_transport'
  ) {
    diff.changed(
      'scheduledAt',
      formatMoscowDateTime(new Date(before.scheduledAt), before.scheduledTimeUnspecified),
      formatMoscowDateTime(new Date(after.scheduledAt), after.scheduledTimeUnspecified),
    );
    diff.changed('volumeM3', measure(before.volumeM3, 'м³'), measure(after.volumeM3, 'м³'));
    diff.changed('weightTons', measure(before.weightTons, 'т'), measure(after.weightTons, 'т'));
    // Адрес сравнивается по строке, а не по ФИАС: в истории читают, откуда и куда везли.
    diff.changed('loadingLocation', short(before.loadingLocation), short(after.loadingLocation));
    diff.changed(
      'unloadingLocation',
      short(before.unloadingLocation),
      short(after.unloadingLocation),
    );
  }

  diff.changed('comment', short(before.comment) || EMPTY, short(after.comment) || EMPTY);
  diff.files(before.files, after.files);

  return diff.changes;
}

/** Ставка в рублях; незаполненная — прочерком, как и всякое пустое значение в истории. */
function rub(v: number | null): string {
  if (v == null) return EMPTY;
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Как машина названа в истории: подпись из справочника плюс арендодатель — без него две машины
 * одной категории у разных арендодателей в истории неразличимы.
 */
function vehicleValue(a: VehicleRequestAssignmentDto): string {
  const title = assignmentTitle(a);
  return a.lessorName ? `${title} · ${a.lessorName}` : title;
}

/**
 * Что изменило назначение техники (ADR 0027). `before === null` — заявку берут в работу впервые,
 * и слева у всех полей прочерк: назначения не было. Ставки сравниваются наравне с машиной —
 * повторный перевод в работу той же машиной, но по другой цене, это тоже событие.
 */
export function diffVehicleAssignment(
  before: VehicleRequestAssignmentDto | null,
  after: VehicleRequestAssignmentDto,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('vehicle', before ? vehicleValue(before) : EMPTY, vehicleValue(after));
  diff.changed('pricePerHour', rub(before?.pricePerHour ?? null), rub(after.pricePerHour));
  diff.changed('pricePerShift', rub(before?.pricePerShift ?? null), rub(after.pricePerShift));
  diff.changed(
    'shiftHours',
    before?.shiftHours == null ? EMPTY : `${before.shiftHours} ч`,
    after.shiftHours == null ? EMPTY : `${after.shiftHours} ч`,
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
 */
export function diffVehicleCompletion(
  before: VehicleRequestCompletionDto | null,
  after: VehicleRequestCompletionDto,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('worked', worked(before), worked(after));
  diff.changed('rate', rub(before?.rate ?? null), rub(after.rate));
  diff.changed('totalCost', rub(before?.totalCost ?? null), rub(after.totalCost));
  return diff.changes;
}
