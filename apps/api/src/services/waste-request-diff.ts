import {
  formatMoscowDateTime,
  type RequestChangeDto,
  requestTypeLabels,
  vehicleVolume,
  type WasteRequestDto,
  type WasteRequestVehicleDto,
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

/** Строка факта в истории: «Самосвал 25 м³ × 2 — 50 м³» (ADR 0024). */
function vehicleLabel(v: WasteRequestVehicleDto): string {
  const total = vehicleVolume(v);
  return v.count > 1
    ? `${v.containerTypeName} × ${v.count} — ${total} м³`
    : `${v.containerTypeName} — ${total} м³`;
}

/**
 * Изменённые поля заявки. Значения — готовый текст на момент правки: справочник могли
 * переименовать или удалить, а история обязана показывать то, что было. Файлы и машины
 * сравниваются по составу — «было 3, стало 3» скрыло бы замену одного талона другим.
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
  diff.changed('comment', short(before.comment) || EMPTY, short(after.comment) || EMPTY);

  diff.files(before.files, after.files);

  const beforeVehicles = new Map(before.vehicles.map((v) => [v.id, v]));
  const afterVehicles = new Map(after.vehicles.map((v) => [v.id, v]));
  const added: string[] = [];
  const marked: string[] = [];
  const restored: string[] = [];
  const removed: string[] = [];
  for (const [id, v] of afterVehicles) {
    const was = beforeVehicles.get(id);
    if (!was) added.push(vehicleLabel(v));
    else if (!was.isDeleted && v.isDeleted) marked.push(vehicleLabel(v));
    else if (was.isDeleted && !v.isDeleted) restored.push(vehicleLabel(v));
  }
  for (const [id, v] of beforeVehicles) {
    if (!afterVehicles.has(id)) removed.push(vehicleLabel(v));
  }
  diff.listed('vehiclesAdded', added);
  diff.listed('vehiclesMarkedDeleted', marked);
  diff.listed('vehiclesRestored', restored);
  diff.listed('vehiclesRemoved', removed);

  return diff.changes;
}
