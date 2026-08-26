import { sql } from 'drizzle-orm';
import type { WasteTicketField } from '@technic/contracts';
import type { db } from '../db/client';
import {
  wasteTicketFieldEvents,
  wasteTicketProposalObservations,
  wasteTickets,
} from '../db/schema';

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
// МОДЕЛЬ БЕРЁТСЯ ИЗ НАБЛЮДЕНИЯ, А НЕ ИЗ ТАЛОНА И НЕ ИЗ НАСТРОЕК. Настройки меняются, талон помнит
// только последнюю попытку, а исправляют работу той модели, которая эту цифру прочитала. Раньше
// контекст подтягивался из `primary_attempt_id` талона — и принятие предложения приписывало ошибку
// попытке, которая предложения не делала (миграция 0210, план §1.1).

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
  | 'proposal_dismissed'
  | 'arbitrated'
  | 'dismissed';

/**
 * Чем адресовано человеческое решение — то самое машинное чтение, о котором оно судит.
 *
 * `current` годится правке и снятию: человек смотрит на то, что стоит в талоне сейчас. Двум
 * процессам он не годится совсем: принятие и отклонение предложения судят о чтении, лежащем
 * отдельной строкой со своими попытками, а арбитраж — о `baseline`, снятом в момент отбора.
 * Между отбором и арбитражем талон мог смениться дважды, и «последнее по времени» приписало бы
 * ошибку не той модели.
 */
export type TicketObservationTarget =
  | { kind: 'current' }
  | { kind: 'explicit'; byField: Readonly<Partial<Record<WasteTicketField, string | null>>> };

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
    /** По умолчанию — текущее чтение поля; предложение и арбитраж называют своё (см. тип). */
    target?: TicketObservationTarget;
    /**
     * Отличалось ли поле предложения от талона в момент чтения. Хранится, а не выводится из
     * значений события: между чтением и решением человек мог править талон, и «повторило ли
     * чтение то, что стояло в талоне» — свойство момента чтения, а не момента решения.
     */
    proposalDiffers?: Readonly<Partial<Record<WasteTicketField, boolean>>>;
  },
): Promise<void> {
  if (params.changes.length === 0) return;

  const target = params.target ?? { kind: 'current' };
  const isProposal = params.event === 'proposal' || params.event === 'proposal_dismissed';

  for (const change of params.changes) {
    /*
     * Наблюдение подставляется джойном, а не читается отдельным запросом: в транзакции правки
     * лишний круг к базе — это лишняя блокировка. Явная ветка берёт строку по идентификатору,
     * ветка «текущее» — последнее машинное чтение этого поля второй версии сбора.
     */
    const observation =
      target.kind === 'explicit'
        ? sql`LEFT JOIN ${wasteTicketFieldEvents} obs
                ON obs.id = ${target.byField[change.field] ?? null}::uuid`
        : sql`LEFT JOIN LATERAL (
                SELECT e.* FROM ${wasteTicketFieldEvents} e
                 WHERE e.ticket_id = wt.id AND e.field = ${change.field}
                   AND e.event IN ('recognized', 'disputed')
                   AND e.collection_version >= 2
                   /*
                    * Чтения предложения — тоже «recognized» этого талона, и они СВЕЖЕЕ того, чьи
                    * значения человек видит в карточке. Возьми мы просто последнее — правка талона
                    * при живом предложении легла бы на модель, чьё чтение никто не принимал, а
                    * прежнее чтение осталось бы без исхода. Поэтому «текущее» — это то, чьи
                    * значения стоят в талоне сейчас:
                    *   · пока предложение живо, его чтение не в счёт (есть строка связи);
                    *   · отклонённое чтение не в счёт и после удаления связи (есть исход-отказ);
                    *   · принятое — в счёт: его значения и переехали в талон.
                    */
                   AND NOT EXISTS (
                     SELECT 1 FROM ${wasteTicketProposalObservations} po
                      WHERE po.observation_id = e.id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM ${wasteTicketFieldEvents} d
                      WHERE d.observation_id = e.id AND d.event = 'proposal_dismissed'
                   )
                 ORDER BY e.created_at DESC
                 LIMIT 1
              ) obs ON TRUE`;

    await tx.execute(sql`
      INSERT INTO ${wasteTicketFieldEvents}
        (ticket_id, request_id, page_sha256, event, field, old_value, new_value,
         model, model_reported, prompt_version, preprocessing_version, passes, escalated,
         observation_id, primary_attempt_id, escalation_attempt_id, selected_attempt_id,
         primary_model_reported, escalation_model_reported, file_id, page_no,
         recognition_run_id, cache_hit, proposal_differs, collection_version, actor_id)
      SELECT
        wt.id,
        ${params.requestId}::uuid,
        COALESCE(obs.page_sha256, ''),
        ${params.event},
        ${change.field},
        ${change.oldValue},
        ${change.newValue},
        -- Контекст чтения копируется ИЗ НАБЛЮДЕНИЯ, а не из талона: талон помнит только последнюю
        -- попытку, а судят здесь о той, что эту цифру прочитала. Для ручного талона наблюдения
        -- нет вовсе — и колонки остаются пустыми, что и означает «модель тут ни при чём».
        COALESCE(obs.model, ''),
        COALESCE(obs.model_reported, ''),
        obs.prompt_version,
        obs.preprocessing_version,
        COALESCE(obs.passes, 0),
        COALESCE(obs.escalated, false),
        obs.id,
        obs.primary_attempt_id,
        obs.escalation_attempt_id,
        obs.selected_attempt_id,
        COALESCE(obs.primary_model_reported, ''),
        COALESCE(obs.escalation_model_reported, ''),
        obs.file_id,
        obs.page_no,
        obs.recognition_run_id,
        COALESCE(obs.cache_hit, false),
        ${isProposal ? (params.proposalDiffers?.[change.field] ?? false) : null},
        2,
        ${params.actorId}::uuid
      FROM ${wasteTickets} wt
      ${observation}
      WHERE wt.id = ${params.ticketId}::uuid
    `);
  }
}

/**
 * Наблюдения талона: поле → идентификатор последнего машинного чтения.
 *
 * Нужно там, где связь заводится вперёд решения — при создании предложения и при отборе в слепую
 * перепроверку. Читается в той же транзакции, что и запись связи: иначе воркер успеет перечитать
 * страницу между чтением и записью, и связь укажет на чтение, которого человек не видел.
 */
export async function currentTicketObservations(
  tx: Tx,
  ticketId: string,
): Promise<Partial<Record<WasteTicketField, string>>> {
  const rows = await tx.execute<{ field: WasteTicketField; id: string }>(sql`
    SELECT DISTINCT ON (e.field) e.field, e.id
      FROM ${wasteTicketFieldEvents} e
     WHERE e.ticket_id = ${ticketId}::uuid
       AND e.event IN ('recognized', 'disputed')
       AND e.collection_version >= 2
     ORDER BY e.field, e.created_at DESC
  `);
  const byField: Partial<Record<WasteTicketField, string>> = {};
  for (const row of rows.rows) byField[row.field] = row.id;
  return byField;
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
