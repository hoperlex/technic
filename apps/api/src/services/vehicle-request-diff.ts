import {
  formatMoscowDateTime,
  type RequestChangeDto,
  type VehicleRequestDto,
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
  diff.changed('vehicleType', before.vehicleTypeName, after.vehicleTypeName);

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
