import {
  formatMoscowDateTime,
  type RequestChangeDto,
  requestTypeLabels,
  type WasteRequestCompletionDto,
  type WasteRequestDto,
} from '@technic/contracts';
import { changeSet, EMPTY, short } from './request-diff';

// Что изменила правка заявки на вывоз — для истории в её карточке (ADR 0012). Общая механика
// диффа — в request-diff.ts; здесь перечень полей этого модуля.

function money(v: number | null): string {
  if (v == null) return EMPTY;
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function volume(v: number | null): string {
  return v == null ? EMPTY : `${v} м³`;
}

function delivery(r: WasteRequestDto): string {
  return formatMoscowDateTime(new Date(r.deliveryAt), r.deliveryTimeUnspecified);
}

/**
 * Изменённые поля заявки. Значения — готовый текст на момент правки: справочник могли
 * переименовать или удалить, а история обязана показывать то, что было. Файлы сравниваются по
 * составу — «было 3, стало 3» скрыло бы замену одного документа другим.
 */
export function diffWasteRequests(
  before: WasteRequestDto,
  after: WasteRequestDto,
): RequestChangeDto[] {
  const diff = changeSet();

  diff.changed(
    'object',
    `${before.objectCode} — ${before.objectName}`,
    `${after.objectCode} — ${after.objectName}`,
  );
  diff.changed(
    'requestType',
    requestTypeLabels[before.requestType],
    requestTypeLabels[after.requestType],
  );
  diff.changed(
    'containerType',
    before.containerTypeName ?? EMPTY,
    after.containerTypeName ?? EMPTY,
  );
  diff.changed('wasteType', before.wasteTypeName ?? EMPTY, after.wasteTypeName ?? EMPTY);
  diff.changed('volumeM3', volume(before.volumeM3), volume(after.volumeM3));
  diff.changed('pricePerM3', money(before.pricePerM3), money(after.pricePerM3));
  diff.changed('amount', money(before.amount), money(after.amount));
  diff.changed('operator', before.operatorName ?? EMPTY, after.operatorName ?? EMPTY);
  diff.changed('deliveryAt', delivery(before), delivery(after));
  // Контакт ответственного (миграция 0062): по нему звонят с площадки, и смена телефона —
  // событие истории наравне с датой доставки.
  diff.changed('responsibleName', before.responsibleName || EMPTY, after.responsibleName || EMPTY);
  diff.changed(
    'responsiblePhone',
    before.responsiblePhone || EMPTY,
    after.responsiblePhone || EMPTY,
  );
  diff.changed('comment', short(before.comment) || EMPTY, short(after.comment) || EMPTY);

  diff.files(before.files, after.files);

  return diff.changes;
}

/**
 * Что предъявило закрытие заявки (ADR 0035). Отдельным событием от смены статуса: «выполнена» и
 * «вывезли 48 м³ на 40 800 ₽» отвечают на разные вопросы. Повторное закрытие (после отката
 * администратором) сравнивается с прошлым фактом — видно, какую именно цифру исправили.
 */
export function diffWasteCompletion(
  before: WasteRequestCompletionDto | null,
  after: WasteRequestCompletionDto,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('factVolume', volume(before?.volumeM3 ?? null), volume(after.volumeM3));
  diff.changed('factPrice', money(before?.pricePerM3 ?? null), money(after.pricePerM3));
  diff.changed('factCost', money(before?.totalCost ?? null), money(after.totalCost));
  return diff.changes;
}
