import { sql } from 'drizzle-orm';
import type { WasteTicketField } from '@technic/contracts';
import type { db } from '../db/client';
import { wasteTicketFieldEvents, wasteTicketRecognitionAttempts, wasteTickets } from '../db/schema';

// ── Журнал распознавания и разбора (ADR 0114, Р30/Р31, миграция 0206) ──
//
// Единственное место, где события заводятся со стороны API. Семь точек вызова — правка,
// подтверждение с предложением, арбитраж, «не талон» — обязаны писать одинаково: разойдись они в
// том, что считать «прежним значением» или откуда брать модель, и выгрузка стала бы складывать
// несравнимое.
//
// ЗНАЧЕНИЯ ТЕКСТОМ, КАК ПОКАЗАНЫ ЧЕЛОВЕКУ. Не числом и не датой: смысл журнала — увидеть
// «прочитано 3, верно 38» и «262 вместо 26213». Приведение к типу стёрло бы половину случая, а
// `null` и пустая строка перестали бы различаться.
//
// МОДЕЛЬ БЕРЁТСЯ ИЗ ПОПЫТКИ ТАЛОНА, А НЕ ИЗ НАСТРОЕК. Настройки меняются, а исправляют работу той
// модели, которая эту цифру прочитала, — иначе журнал припишет ошибку той, что пришла ей на смену.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Событие поля: что случилось и с какими значениями. */
export interface TicketFieldChange {
  field: WasteTicketField;
  /** Как показывалось до события; `null` — поля не было (модель вернула пусто). */
  oldValue: string | null;
  /** Как стало; у `dismissed` не меняется ничего и здесь `null`. */
  newValue: string | null;
}

export type TicketFieldEvent =
  | 'recognized'
  | 'disputed'
  | 'edited'
  | 'proposal'
  | 'arbitrated'
  | 'dismissed';

/**
 * Записать события по полям одного талона.
 *
 * Пишется одним `INSERT … SELECT` с подтягиванием попытки: модель, версии промпта и подготовки, а
 * также число проходов каскада берутся из строк, на которые ссылается сам талон. Отдельным
 * запросом их пришлось бы читать перед каждой правкой, а в транзакции правки лишний круг к базе —
 * это лишняя блокировка.
 *
 * Молчит, когда писать нечего: пустой список полей — обычное дело (правка без изменений отбивается
 * раньше, а «не талон» иногда приходит на строку без единого прочитанного поля).
 */
export async function recordTicketFieldEvents(
  tx: Tx,
  params: {
    ticketId: string;
    requestId: string;
    event: TicketFieldEvent;
    /** `null` только у машинных событий: их совершила модель, а не человек (держит `CHECK`). */
    actorId: string | null;
    changes: readonly TicketFieldChange[];
  },
): Promise<void> {
  if (params.changes.length === 0) return;

  for (const change of params.changes) {
    await tx.execute(sql`
      INSERT INTO ${wasteTicketFieldEvents}
        (ticket_id, request_id, page_sha256, event, field, old_value, new_value,
         model, model_reported, prompt_version, preprocessing_version, passes, escalated, actor_id)
      SELECT
        wt.id,
        ${params.requestId}::uuid,
        COALESCE(pa.page_sha256, ''),
        ${params.event},
        ${change.field},
        ${change.oldValue},
        ${change.newValue},
        COALESCE(pa.model, ''),
        COALESCE(pa.model_reported, ''),
        pa.prompt_version,
        pa.preprocessing_version,
        -- Проходов ровно столько, сколько попыток привязано к строке: вторая появляется только
        -- при эскалации (Р14), и по этой паре чисел считается, окупается ли вторая ступень.
        (CASE WHEN wt.primary_attempt_id IS NULL THEN 0 ELSE 1 END)
          + (CASE WHEN wt.escalation_attempt_id IS NULL THEN 0 ELSE 1 END),
        wt.escalation_attempt_id IS NOT NULL,
        ${params.actorId}::uuid
      FROM ${wasteTickets} wt
      LEFT JOIN ${wasteTicketRecognitionAttempts} pa ON pa.id = wt.primary_attempt_id
      WHERE wt.id = ${params.ticketId}::uuid
    `);
  }
}

/** Пять полей талона в порядке бланка: журналу нужен устойчивый обход, а не случайный. */
export const TICKET_FIELDS: readonly WasteTicketField[] = [
  'number',
  'issuedOn',
  'volumeM3',
  'workKind',
  'addressRaw',
];

/** Значение поля талона строкой — так же, как его видит человек в карточке. */
export function ticketFieldValue(
  ticket: {
    numberRaw: string;
    issuedOn: string | null;
    volumeM3: string | null;
    workKind: string;
    addressRaw: string;
  },
  field: WasteTicketField,
): string | null {
  switch (field) {
    case 'number':
      return ticket.numberRaw || null;
    case 'issuedOn':
      return ticket.issuedOn;
    case 'volumeM3':
      // Число приходит из `numeric` строкой вида «20.000» — в журнал идёт как есть: важно не
      // красивое «20», а то, что именно стояло в талоне.
      return ticket.volumeM3;
    case 'workKind':
      return ticket.workKind;
    case 'addressRaw':
      return ticket.addressRaw || null;
  }
}

/** Талон целиком одним снимком: пять полей — то, что пишется событием `recognized`. */
export function ticketFieldSnapshot(ticket: {
  numberRaw: string;
  issuedOn: string | null;
  volumeM3: string | null;
  workKind: string;
  addressRaw: string;
}): TicketFieldChange[] {
  return TICKET_FIELDS.map((field) => ({
    field,
    oldValue: null,
    newValue: ticketFieldValue(ticket, field),
  }));
}
