import {
  formatMoscowDateTime,
  requestTypeLabels,
  type WasteRequestChangeDto,
  type WasteRequestDto,
  type WasteRequestVehicleDto,
} from '@technic/contracts';

// Что изменила правка заявки — для истории в её карточке. Сравниваются DTO «до» и «после», а не
// сырые колонки: человеку нужны названия справочников и суммы, а не идентификаторы. Модуль
// намеренно не знает о БД — так его считает и проверяет тест без поднятого приложения.

/** Больше в историю не помещается: смысл правки виден по началу значения. */
const MAX_VALUE_LENGTH = 300;

const EMPTY = '—';

function short(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

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

function vehicleLabel(v: WasteRequestVehicleDto): string {
  return `${v.containerTypeName} — ${v.volumeM3} м³`;
}

/**
 * Изменённые поля заявки. Значения — готовый текст на момент правки: справочник могли
 * переименовать или удалить, а история обязана показывать то, что было. Файлы и машины
 * сравниваются по составу — «было 3, стало 3» скрыло бы замену одного талона другим.
 */
export function diffWasteRequests(
  before: WasteRequestDto,
  after: WasteRequestDto,
): WasteRequestChangeDto[] {
  const changes: WasteRequestChangeDto[] = [];
  const changed = (field: string, from: string, to: string): void => {
    if (from !== to) changes.push({ field, from, to });
  };
  // Событие-список: значима только правая часть («прикреплены файлы: акт.pdf»).
  const listed = (field: string, items: string[]): void => {
    if (items.length > 0) changes.push({ field, from: null, to: short(items.join(', ')) });
  };

  changed(
    'object',
    `${before.objectCode} — ${before.objectName}`,
    `${after.objectCode} — ${after.objectName}`,
  );
  changed(
    'requestType',
    requestTypeLabels[before.requestType],
    requestTypeLabels[after.requestType],
  );
  changed('containerType', before.containerTypeName ?? EMPTY, after.containerTypeName ?? EMPTY);
  changed('wasteType', before.wasteTypeName ?? EMPTY, after.wasteTypeName ?? EMPTY);
  changed('volumeM3', volume(before.volumeM3), volume(after.volumeM3));
  changed('pricePerM3', money(before.pricePerM3), money(after.pricePerM3));
  changed('amount', money(before.amount), money(after.amount));
  changed('operator', before.operatorName ?? EMPTY, after.operatorName ?? EMPTY);
  changed('deliveryAt', delivery(before), delivery(after));
  changed('comment', short(before.comment) || EMPTY, short(after.comment) || EMPTY);

  const beforeFiles = new Map(before.files.map((f) => [f.id, f.filename]));
  const afterFiles = new Map(after.files.map((f) => [f.id, f.filename]));
  listed(
    'filesAdded',
    [...afterFiles].filter(([id]) => !beforeFiles.has(id)).map(([, name]) => name),
  );
  listed(
    'filesRemoved',
    [...beforeFiles].filter(([id]) => !afterFiles.has(id)).map(([, name]) => name),
  );

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
  listed('vehiclesAdded', added);
  listed('vehiclesMarkedDeleted', marked);
  listed('vehiclesRestored', restored);
  listed('vehiclesRemoved', removed);

  return changes;
}
