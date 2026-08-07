import {
  SERVICE_CLOSING_DOCUMENT_KINDS,
  type ServiceFileKind,
  type ServiceRequestDto,
} from '@technic/contracts';

/**
 * Документы заявки: чем работа подтверждена и чего не хватает (Р16).
 *
 * Вид документа заведён ровно ради этого вопроса: «закрыто, но акта нет» — рабочее состояние
 * (акт присылают через неделю), а не ошибка, и портал обязан уметь его показать и отобрать
 * очередью «Ожидаются документы».
 */

/** Сколько документов каждого вида подшито к заявке. */
export function serviceDocumentCounts(
  files: readonly { kind: ServiceFileKind }[],
): Partial<Record<ServiceFileKind, number>> {
  const counts: Partial<Record<ServiceFileKind, number>> = {};
  for (const file of files) counts[file.kind] = (counts[file.kind] ?? 0) + 1;
  return counts;
}

/**
 * Каких закрывающих документов недостаёт. Спрашивается только у заявки с предъявленным фактом:
 * до закрытия работ акта и счёта не бывает по определению, и «не хватает акта» у заявки в
 * диагностике читалось бы как претензия к исполнителю.
 *
 * Гарантийный талон в перечень недостающих не входит: он бывает не у каждого ремонта, и требовать
 * его от замены картриджа значило бы держать половину заявок вечно «неполными».
 */
export function missingClosingDocuments(
  request: Pick<ServiceRequestDto, 'status' | 'files'>,
): ServiceFileKind[] {
  if (request.status !== 'done' && request.status !== 'accepted') return [];
  const counts = serviceDocumentCounts(request.files);
  return SERVICE_CLOSING_DOCUMENT_KINDS.filter((kind) => kind !== 'warranty_card' && !counts[kind]);
}

/** Ждёт ли заявка бумаг: работы предъявлены или приняты, а закрывающих документов нет. */
export function isAwaitingDocuments(request: Pick<ServiceRequestDto, 'status' | 'files'>): boolean {
  return missingClosingDocuments(request).length > 0;
}
