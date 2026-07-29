import type { RequestStatus } from './enums';

// ── История заявки (ADR 0012) ──
// Что с заявкой происходило: кто и когда её завёл, правил, менял статус. Собирается из двух
// источников — истории статусов и аудита; третьей таблицы не заводим, обе уже пишутся.
// Форма событий общая для всех модулей заявок: «Вывоз мусора» и «Заказ ТС» показывают историю
// одной и той же таблицей, и расхождение в DTO означало бы два разных рассказа об одном и том же.
// Модульного здесь только подписи полей (`wasteRequestChangeLabels`, `vehicleRequestChangeLabels`).

/**
 * Изменение одного поля при правке. Значения — готовый текст на момент правки, а не ссылки:
 * переименование справочника не должно переписывать прошлое. `from === null` — событие-список
 * («прикреплены файлы»), у него значима только правая часть.
 */
export interface RequestChangeDto {
  field: string;
  from: string | null;
  to: string | null;
}

/**
 * `operator` есть только у вывоза мусора: там исполнителя назначают контрагентом, а не машиной.
 * `approved` / `approvalRevoked` (виза руководителя строительства, ADR 0025) и `assigned`
 * (техника со ставками, ADR 0027) — наоборот, только у заявок на технику.
 */
export type RequestHistoryKind =
  | 'created'
  | 'updated'
  | 'status'
  | 'operator'
  | 'approved'
  | 'approvalRevoked'
  | 'assigned'
  | 'deleted'
  | 'restored';

export interface RequestHistoryEntryDto {
  id: string;
  kind: RequestHistoryKind;
  /** Момент события (ISO). */
  at: string;
  /** Автор события; null — учётная запись удалена или действие выполнено системой. */
  actorId: string | null;
  actorName: string | null;
  /** Смена статуса: откуда и куда. У остальных событий — null. */
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  /** Комментарий к переходу; при отмене — причина. */
  comment: string;
  /** Изменённые поля у правок; у остальных событий список пуст. */
  changes: RequestChangeDto[];
}
