import { sql } from 'drizzle-orm';
import type {
  TicketAuditAccuracyDto,
  TicketAuditOperationsDto,
  TicketAuditSubsystemState,
  TicketAuditAccuracyField,
  TicketAuditCascade,
  TicketAuditEventRow,
  TicketAuditEventsDto,
  TicketAuditEventsQuery,
  TicketAuditCohortRow,
  TicketAuditCohortsDto,
  TicketAuditFieldRow,
  TicketAuditPeriod,
  TicketAuditSummaryDto,
  WasteTicketField,
} from '@technic/contracts';
import {
  TICKET_AUDIT_DISPUTED_FIELDS,
  TICKET_AUDIT_FIELDS,
  TICKET_AUDIT_OPERATIONS_DAYS,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';

// ── Сводка аудита распознавания (ADR 0137, план §1, §5.1) ──
//
// Единственное место, где считается исход наблюдения. Считается ЗДЕСЬ, а не в шести ручках, по той
// же причине, по какой словарь метрик написан раньше экранов: разойдись два запроса в том, что
// считать знаменателем, — и два экрана покажут разные проценты об одном и том же, а спорить с
// ними будет нечем.
//
// ПЕРИОД ПРИМЕНЯЕТСЯ КО ВРЕМЕНИ НАБЛЮДЕНИЯ, а не решения. Иначе правка, сделанная сегодня по
// вчерашнему чтению, попала бы в числитель одного месяца и знаменатель другого. Границы суток —
// московские: `Europe/Moscow` назван явно, потому что сервер живёт в UTC, а человек — нет.

/** Московские сутки: `to` включительно, поэтому верхняя граница — начало следующего дня. */
const ZONE = 'Europe/Moscow';

/** Строка агрегата: drizzle требует от типа результата индексной сигнатуры. */
interface OutcomeRow extends Record<string, unknown> {
  field: WasteTicketField;
  outcome: string;
  was_disputed: boolean;
  n: number;
}

interface ReadingRow extends Record<string, unknown> {
  field: WasteTicketField;
  observations: number;
  unreadable: number;
  disputed: number;
}

/**
 * Исход наблюдения одним запросом (§1.2, приоритет шести правил).
 *
 * Правила проверяются строго по порядку, и порядок здесь — это `CASE`: первая сработавшая ветка
 * выигрывает. Без строгого порядка старое наблюдение после повторного чтения подходило бы разом
 * под `superseded` и `accepted`, а удалённый после правки талон — под `corrected` и `lost`.
 */
function outcomesQuery(from: string, to: string) {
  return sql`
    WITH obs AS (
      SELECT e.id, e.field, e.ticket_id, e.event, e.read_state, e.created_at
        FROM waste_ticket_field_events e
       WHERE e.event IN ('recognized', 'disputed')
         AND e.collection_version >= 2
         AND e.created_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE})
         AND e.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${ZONE})
    ),
    -- Первое РЕШЕНИЕ, адресованное наблюдению. Второе и последующие в исход не идут: три правки
    -- одного поля — одна ошибка машины, а не три. «arbitrated» в списке нет: это оценка (§1.2).
    decision AS (
      SELECT DISTINCT ON (d.observation_id)
             d.observation_id, d.event, d.proposal_differs
        FROM waste_ticket_field_events d
       WHERE d.observation_id IS NOT NULL
         AND d.event IN ('edited', 'proposal', 'proposal_dismissed', 'dismissed')
       ORDER BY d.observation_id, d.created_at
    ),
    -- Чтения ЖИВОГО предложения: их значения в талоне не стоят, и вытеснять ими чужие наблюдения
    -- нельзя. Связь живёт ровно столько же, сколько предложение (0210).
    proposed AS (
      SELECT po.observation_id FROM waste_ticket_proposal_observations po
    ),
    -- Чтения, ОТКЛОНЁННЫЕ человеком: их значения тоже не в талоне, хотя связи уже нет.
    rejected AS (
      SELECT r.observation_id FROM waste_ticket_field_events r
       WHERE r.observation_id IS NOT NULL AND r.event = 'proposal_dismissed'
    ),
    -- «Встало в талон» — только такое чтение вытесняет предыдущее (§1.2, правило 3).
    in_ticket AS (
      SELECT o.id, o.ticket_id, o.field, o.created_at FROM obs o
       WHERE o.id NOT IN (SELECT observation_id FROM proposed)
         AND o.id NOT IN (SELECT observation_id FROM rejected)
    ),
    resolved AS (
      SELECT
        o.field,
        o.event = 'disputed' AS was_disputed,
        CASE
          -- 1. Есть решение — исход по типу события и признаку отличия.
          WHEN d.event = 'edited' AND o.event = 'disputed' THEN 'resolved_dispute'
          WHEN d.event = 'edited' THEN 'corrected'
          WHEN d.event = 'proposal' AND d.proposal_differs THEN 'proposal_accepted'
          WHEN d.event = 'proposal_dismissed' AND d.proposal_differs THEN 'not_attributed'
          WHEN d.event IN ('proposal', 'proposal_dismissed') THEN 'uninformative'
          WHEN d.event = 'dismissed' THEN 'dismissed'
          -- 2. Живое предложение: человек его ещё не видел.
          WHEN o.id IN (SELECT observation_id FROM proposed) THEN 'pending'
          -- 3. Перечитали раньше, чем человек решил.
          WHEN EXISTS (
            SELECT 1 FROM in_ticket n
             WHERE n.ticket_id = o.ticket_id AND n.field = o.field AND n.created_at > o.created_at
          ) THEN 'superseded'
          -- 4. Талон подтверждён позже наблюдения — значит значение приняли как есть.
          WHEN EXISTS (
            SELECT 1 FROM waste_tickets wt
             WHERE wt.id = o.ticket_id AND wt.status = 'confirmed'
               AND wt.confirmed_at IS NOT NULL AND wt.confirmed_at >= o.created_at
          ) THEN 'accepted'
          -- 5. Талон жив, решения нет.
          WHEN o.ticket_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM waste_tickets wt WHERE wt.id = o.ticket_id
          ) THEN 'pending'
          -- 6. Талона нет: исход неизвестен навсегда.
          ELSE 'lost'
        END AS outcome
      FROM obs o
      LEFT JOIN decision d ON d.observation_id = o.id
    )
    SELECT field, outcome, was_disputed, count(*)::int AS n
      FROM resolved
     GROUP BY field, outcome, was_disputed
  `;
}

/** Не прочитано и спорных — от ВСЕХ наблюдений поля, а не от решённых (§1.4). */
function readingsQuery(from: string, to: string) {
  return sql`
    SELECT e.field,
           count(*)::int AS observations,
           count(*) FILTER (WHERE e.read_state = 'unreadable')::int AS unreadable,
           count(*) FILTER (WHERE e.event = 'disputed')::int AS disputed
      FROM waste_ticket_field_events e
     WHERE e.event IN ('recognized', 'disputed')
       AND e.collection_version >= 2
       AND e.created_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE})
       AND e.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${ZONE})
     GROUP BY e.field
  `;
}

/**
 * Предложения считаются ПРЕДЛОЖЕНИЯМИ, а не полями (§1.2.1): отказ говорит лишь «хотя бы одно из
 * отличавшихся неприемлемо». Пять событий одного решения пишутся одной транзакцией, поэтому у них
 * общий `created_at` — по этой тройке они и собираются обратно в одно предложение.
 */
function proposalsQuery(from: string, to: string) {
  return sql`
    SELECT d.event, count(*)::int AS n FROM (
      SELECT DISTINCT p.ticket_id, p.event, p.created_at
        FROM waste_ticket_field_events p
        JOIN waste_ticket_field_events o ON o.id = p.observation_id
       WHERE p.event IN ('proposal', 'proposal_dismissed')
         AND o.created_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE})
         AND o.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${ZONE})
    ) d
     GROUP BY d.event
  `;
}

/** Поле правили дважды и более: работа человека, а не вторая ошибка машины. */
function repeatedEditsQuery(from: string, to: string) {
  return sql`
    SELECT count(*)::int AS n FROM (
      SELECT e.observation_id
        FROM waste_ticket_field_events e
        JOIN waste_ticket_field_events o ON o.id = e.observation_id
       WHERE e.event = 'edited'
         AND o.created_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE})
         AND o.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${ZONE})
       GROUP BY e.observation_id
      HAVING count(*) > 1
    ) x
  `;
}

export async function ticketAuditSummary(
  period: TicketAuditPeriod,
): Promise<TicketAuditSummaryDto> {
  const { from, to } = period;
  const [outcomes, readings, proposals, repeated, since] = await Promise.all([
    db.execute<OutcomeRow>(outcomesQuery(from, to)),
    db.execute<ReadingRow>(readingsQuery(from, to)),
    db.execute<{ event: string; n: number }>(proposalsQuery(from, to)),
    db.execute<{ n: number }>(repeatedEditsQuery(from, to)),
    db.execute<{ since: string | null }>(sql`
      SELECT to_char(min(e.created_at) AT TIME ZONE ${ZONE}, 'YYYY-MM-DD') AS since
        FROM waste_ticket_field_events e
       WHERE e.collection_version >= 2 AND e.event IN ('recognized', 'disputed')
    `),
  ]);

  const byField = new Map<WasteTicketField, TicketAuditFieldRow>();
  for (const field of TICKET_AUDIT_FIELDS) {
    byField.set(field, {
      field,
      observations: 0,
      corrected: 0,
      decided: 0,
      resolvedDispute: 0,
      unreadable: 0,
      disputed: TICKET_AUDIT_DISPUTED_FIELDS.includes(field) ? 0 : null,
    });
  }
  for (const row of readings.rows) {
    const target = byField.get(row.field);
    if (!target) continue;
    target.observations = row.observations;
    target.unreadable = row.unreadable;
    if (target.disputed !== null) target.disputed = row.disputed;
  }

  const counts = {
    total: 0,
    resolved: 0,
    pending: 0,
    superseded: 0,
    dismissed: 0,
    lost: 0,
    outOfScope: 0,
  };
  for (const row of outcomes.rows) {
    counts.total += row.n;
    const target = byField.get(row.field);
    switch (row.outcome) {
      case 'corrected':
        counts.resolved += row.n;
        if (target) {
          target.corrected += row.n;
          target.decided += row.n;
        }
        break;
      case 'accepted':
        counts.resolved += row.n;
        if (target) target.decided += row.n;
        break;
      case 'resolved_dispute':
        counts.resolved += row.n;
        if (target) target.resolvedDispute += row.n;
        break;
      case 'proposal_accepted':
        counts.resolved += row.n;
        break;
      case 'dismissed':
        counts.dismissed += row.n;
        break;
      case 'superseded':
        counts.superseded += row.n;
        break;
      case 'pending':
        counts.pending += row.n;
        break;
      case 'lost':
        counts.lost += row.n;
        break;
      default:
        // `uninformative` и `not_attributed` — наблюдения предложений без полевого исхода (§1.2.1).
        counts.outOfScope += row.n;
    }
  }

  const proposalCounts = { accepted: 0, rejected: 0 };
  for (const row of proposals.rows) {
    if (row.event === 'proposal') proposalCounts.accepted = row.n;
    else proposalCounts.rejected = row.n;
  }

  return {
    period,
    collectingSince: since.rows[0]?.since ?? null,
    observations: counts,
    fields: [...byField.values()],
    proposals: proposalCounts,
    repeatedEdits: repeated.rows[0]?.n ?? 0,
    lostShare: counts.total === 0 ? 0 : counts.lost / counts.total,
  };
}

// ── Когорты конфигураций и каскад (§5.2) ──

interface CohortRow extends Record<string, unknown> {
  primary_model: string;
  escalation_model: string;
  prompt_version: number | null;
  preprocessing_version: number | null;
  runs: number;
  observations: number;
  corrected: number;
  decided: number;
  unreadable: number;
}

/**
 * Разбор — группа наблюдений одного чтения: те же талон, номер разбора и момент записи.
 *
 * Считать разборы по числу наблюдений, поделив на пять, нельзя: у предложения полей столько же, а
 * у талона с удалённой строкой ссылки уже нет, и деление дало бы дробь, выдаваемую за число.
 */
const RUN_KEY = sql`(o.ticket_id, o.recognition_run_id, o.created_at)`;

export async function ticketAuditCohorts(
  period: TicketAuditPeriod,
): Promise<TicketAuditCohortsDto> {
  const { from, to } = period;
  const window = sql`
    o.event IN ('recognized', 'disputed')
    AND o.collection_version >= 2
    AND o.created_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE})
    AND o.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${ZONE})
  `;

  const cohorts = await db.execute<CohortRow>(sql`
    WITH decision AS (
      SELECT DISTINCT ON (d.observation_id) d.observation_id, d.event, d.new_value
        FROM waste_ticket_field_events d
       WHERE d.observation_id IS NOT NULL
         AND d.event IN ('edited', 'proposal', 'proposal_dismissed', 'dismissed')
       ORDER BY d.observation_id, d.created_at
    )
    SELECT
      o.primary_model_reported AS primary_model,
      o.escalation_model_reported AS escalation_model,
      o.prompt_version,
      o.preprocessing_version,
      count(DISTINCT ${RUN_KEY})::int AS runs,
      count(*)::int AS observations,
      count(*) FILTER (WHERE d.event = 'edited' AND o.event = 'recognized')::int AS corrected,
      -- Знаменатель тот же, что в сводке: исправленные плюс принятые как есть. Разбор спора,
      -- предложения и всё нерешённое сюда не идут — иначе доли двух экранов разошлись бы.
      count(*) FILTER (
        WHERE (d.event = 'edited' AND o.event = 'recognized')
           OR (d.observation_id IS NULL AND EXISTS (
                 SELECT 1 FROM waste_tickets wt
                  WHERE wt.id = o.ticket_id AND wt.status = 'confirmed'
                    AND wt.confirmed_at IS NOT NULL AND wt.confirmed_at >= o.created_at))
      )::int AS decided,
      count(*) FILTER (WHERE o.read_state = 'unreadable')::int AS unreadable
    FROM waste_ticket_field_events o
    LEFT JOIN decision d ON d.observation_id = o.id
    WHERE ${window}
    GROUP BY 1, 2, 3, 4
    ORDER BY observations DESC
  `);

  const cascade = await db.execute<{
    runs_with_escalation: number;
    empty_after_primary: number;
    filled_by_second: number;
    disputes: number;
    chose_primary: number;
    chose_escalation: number;
    chose_third: number;
    unresolved: number;
  }>(sql`
    WITH obs AS (
      SELECT o.* FROM waste_ticket_field_events o WHERE ${window}
    ),
    decision AS (
      SELECT DISTINCT ON (d.observation_id) d.observation_id, d.new_value
        FROM waste_ticket_field_events d
       WHERE d.observation_id IS NOT NULL AND d.event = 'edited'
       ORDER BY d.observation_id, d.created_at
    )
    SELECT
      (SELECT count(DISTINCT (o.ticket_id, o.recognition_run_id, o.created_at))
         FROM obs o WHERE o.escalation_attempt_id IS NOT NULL)::int AS runs_with_escalation,
      -- Пустое после первого прохода считается только там, где вторая ступень отработала: где её
      -- не было, «первый проход пуст» означает просто нечитаемое поле, а не работу каскада.
      count(*) FILTER (WHERE o.escalation_attempt_id IS NOT NULL AND o.primary_value IS NULL)::int
        AS empty_after_primary,
      count(*) FILTER (
        WHERE o.escalation_attempt_id IS NOT NULL AND o.primary_value IS NULL
          AND o.source_stage = 'escalation'
      )::int AS filled_by_second,
      count(*) FILTER (WHERE o.event = 'disputed')::int AS disputes,
      count(*) FILTER (
        WHERE o.event = 'disputed' AND btrim(d.new_value) IS NOT DISTINCT FROM btrim(o.primary_value)
      )::int AS chose_primary,
      count(*) FILTER (
        WHERE o.event = 'disputed' AND btrim(d.new_value) IS NOT DISTINCT FROM btrim(o.escalation_value)
          AND btrim(d.new_value) IS DISTINCT FROM btrim(o.primary_value)
      )::int AS chose_escalation,
      count(*) FILTER (
        WHERE o.event = 'disputed' AND d.new_value IS NOT NULL
          AND btrim(d.new_value) IS DISTINCT FROM btrim(o.primary_value)
          AND btrim(d.new_value) IS DISTINCT FROM btrim(o.escalation_value)
      )::int AS chose_third,
      count(*) FILTER (WHERE o.event = 'disputed' AND d.observation_id IS NULL)::int AS unresolved
    FROM obs o
    LEFT JOIN decision d ON d.observation_id = o.id
  `);

  const c = cascade.rows[0];
  const outcome: TicketAuditCascade = {
    runsWithEscalation: c?.runs_with_escalation ?? 0,
    emptyAfterPrimary: c?.empty_after_primary ?? 0,
    filledBySecond: c?.filled_by_second ?? 0,
    disputes: c?.disputes ?? 0,
    disputeOutcomes: {
      primary: c?.chose_primary ?? 0,
      escalation: c?.chose_escalation ?? 0,
      third: c?.chose_third ?? 0,
      unresolved: c?.unresolved ?? 0,
    },
  };

  return {
    period,
    cohorts: cohorts.rows.map((row): TicketAuditCohortRow => ({
      primaryModel: row.primary_model,
      // Пустая строка в снимке значит «эскалации не было»: колонка объявлена NOT NULL DEFAULT ''.
      escalationModel: row.escalation_model === '' ? null : row.escalation_model,
      promptVersion: row.prompt_version,
      preprocessingVersion: row.preprocessing_version,
      runs: row.runs,
      observations: row.observations,
      corrected: row.corrected,
      decided: row.decided,
      unreadable: row.unreadable,
    })),
    cascade: outcome,
  };
}

// ── Лента событий (§5.3) ──

interface EventRow extends Record<string, unknown> {
  id: string;
  at: string;
  field: WasteTicketField;
  event: string;
  old_value: string | null;
  new_value: string | null;
  actor_name: string | null;
  model: string;
  prompt_version: number | null;
  preprocessing_version: number | null;
  request_id: string | null;
  request_num: string | null;
  read_state: string | null;
  file_id: string | null;
  page_no: number | null;
  total: number;
}

/**
 * Лента: события за период с фильтрами и постранично.
 *
 * Модель берётся из СНИМКА события, а не через ссылку на попытку: попытки убираются по сроку, и
 * лента годичной давности осталась бы без имени модели — то есть без ответа на вопрос, ради
 * которого её и читают.
 *
 * Общее число считается тем же запросом оконной функцией: отдельным `count(*)` он разошёлся бы с
 * выборкой на любом параллельном разборе, и постраничность показывала бы страницы, которых нет.
 */
export async function ticketAuditEvents(
  query: TicketAuditEventsQuery,
): Promise<TicketAuditEventsDto> {
  const { page, pageSize } = query;
  const offset = (page - 1) * pageSize;
  const from = query.from ?? null;
  const to = query.to ?? null;

  const rows = await db.execute<EventRow>(sql`
    SELECT
      e.id,
      to_char(e.created_at AT TIME ZONE ${ZONE}, 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
      e.field,
      e.event,
      e.old_value,
      e.new_value,
      u.full_name AS actor_name,
      -- Снимок модели: у человеческого события он скопирован из наблюдения, к которому событие
      -- адресовано, поэтому строка ленты всегда называет ту модель, о чьей работе идёт речь.
      COALESCE(NULLIF(e.primary_model_reported, ''), e.model_reported, '') AS model,
      e.prompt_version,
      e.preprocessing_version,
      e.request_id,
      -- Номер заявки целочисленный; в ленте он показывается и ищется как текст.
      wr.num::text AS request_num,
      e.read_state,
      e.file_id,
      e.page_no,
      count(*) OVER ()::int AS total
    FROM waste_ticket_field_events e
    LEFT JOIN users u ON u.id = e.actor_id
    LEFT JOIN waste_requests wr ON wr.id = e.request_id
    WHERE e.collection_version >= 2
      AND (${from}::date IS NULL OR e.created_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE}))
      AND (${to}::date IS NULL OR e.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${ZONE}))
      AND (${query.field ?? null}::text IS NULL OR e.field = ${query.field ?? null})
      AND (${query.event ?? null}::text IS NULL OR e.event = ${query.event ?? null})
      AND (${query.model ?? null}::text IS NULL
           OR COALESCE(NULLIF(e.primary_model_reported, ''), e.model_reported, '') = ${query.model ?? null})
      AND (${query.promptVersion ?? null}::int IS NULL OR e.prompt_version = ${query.promptVersion ?? null})
      AND (${query.preprocessingVersion ?? null}::int IS NULL
           OR e.preprocessing_version = ${query.preprocessingVersion ?? null})
      AND (${query.requestNum ?? null}::text IS NULL
           OR wr.num::text ILIKE ${'%' + (query.requestNum ?? '') + '%'})
    ORDER BY e.created_at DESC, e.id
    LIMIT ${pageSize} OFFSET ${offset}
  `);

  return {
    rows: rows.rows.map((row): TicketAuditEventRow => ({
      id: row.id,
      at: row.at,
      field: row.field,
      event: row.event as TicketAuditEventRow['event'],
      oldValue: row.old_value,
      newValue: row.new_value,
      actorName: row.actor_name,
      model: row.model,
      promptVersion: row.prompt_version,
      preprocessingVersion: row.preprocessing_version,
      requestId: row.request_id,
      requestNum: row.request_num,
      readState: (row.read_state ?? null) as TicketAuditEventRow['readState'],
      fileId: row.file_id,
      pageNo: row.page_no,
    })),
    total: rows.rows[0]?.total ?? 0,
    page,
    pageSize,
  };
}

// ── Точность среди неисправленных подтверждённых талонов (§3, §5.5) ──

interface AccuracyRow extends Record<string, unknown> {
  field: TicketAuditAccuracyField['field'];
  matched: number;
  diverged: number;
  arbitrated: number;
  machine_right: number;
  checker_right: number;
  both_wrong: number;
}

/**
 * Сравнение чтений по полю.
 *
 * Номер сравнивается по КЛЮЧУ, а не по сырой строке: «26213» и «№ 26213» — одна бумага, и
 * расхождение регистра или пробела здесь означало бы ошибку там, где её нет. Объём — числом, иначе
 * «20» и «20.000» разойдутся. Дата сравнивается как есть: у неё одна форма записи.
 */
export async function ticketAuditAccuracy(
  period: TicketAuditPeriod,
): Promise<TicketAuditAccuracyDto> {
  const { from, to } = period;
  const window = sql`
    b.created_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE})
    AND b.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${ZONE})
  `;

  const totals = await db.execute<{
    issued: number;
    returned: number;
    waiting_checker: number;
    waiting_arbitration: number;
  }>(sql`
    SELECT
      count(*)::int AS issued,
      count(*) FILTER (WHERE b.status <> 'pending')::int AS returned,
      count(*) FILTER (WHERE b.status = 'pending')::int AS waiting_checker,
      -- Расхождение без арбитра: проверка вернулась, но верного значения ещё никто не назвал.
      count(*) FILTER (WHERE b.status = 'mismatch')::int AS waiting_arbitration
    FROM waste_ticket_blind_checks b
    WHERE ${window}
  `);

  const rows = await db.execute<AccuracyRow>(sql`
    WITH cmp AS (
      SELECT
        f.field,
        f.same,
        f.final_value,
        f.baseline_value,
        f.review_value,
        b.status,
        f.field = ANY(b.resolved_fields) AS resolved
      FROM waste_ticket_blind_checks b
      CROSS JOIN LATERAL (VALUES
        ('number',
         b.baseline_number_key IS NOT DISTINCT FROM b.review_number_key,
         b.final_number_key, b.baseline_number_key, b.review_number_key),
        ('issuedOn',
         b.baseline_issued_on IS NOT DISTINCT FROM b.review_issued_on,
         b.final_issued_on::text, b.baseline_issued_on::text, b.review_issued_on::text),
        ('volumeM3',
         b.baseline_volume_m3 IS NOT DISTINCT FROM b.review_volume_m3,
         b.final_volume_m3::text, b.baseline_volume_m3::text, b.review_volume_m3::text)
      ) AS f(field, same, final_value, baseline_value, review_value)
      WHERE ${window} AND b.status <> 'pending'
    )
    SELECT
      field,
      count(*) FILTER (WHERE same)::int AS matched,
      count(*) FILTER (WHERE NOT same)::int AS diverged,
      -- Разобранным считается только поле, названное арбитром: «верного значения нет» и «поле не
      -- разобрано» — разные вещи, и складывать их в один знаменатель нельзя.
      count(*) FILTER (WHERE NOT same AND status = 'arbitrated' AND resolved)::int AS arbitrated,
      count(*) FILTER (
        WHERE NOT same AND status = 'arbitrated' AND resolved
          AND final_value IS NOT DISTINCT FROM baseline_value
      )::int AS machine_right,
      count(*) FILTER (
        WHERE NOT same AND status = 'arbitrated' AND resolved
          AND final_value IS NOT DISTINCT FROM review_value
          AND final_value IS DISTINCT FROM baseline_value
      )::int AS checker_right,
      count(*) FILTER (
        WHERE NOT same AND status = 'arbitrated' AND resolved
          AND final_value IS DISTINCT FROM baseline_value
          AND final_value IS DISTINCT FROM review_value
      )::int AS both_wrong
    FROM cmp
    GROUP BY field
  `);

  const byField = new Map<string, TicketAuditAccuracyField>();
  for (const field of ['number', 'issuedOn', 'volumeM3'] as const) {
    byField.set(field, {
      field,
      matched: 0,
      diverged: 0,
      arbitrated: 0,
      machineRight: 0,
      checkerRight: 0,
      bothWrong: 0,
    });
  }
  for (const row of rows.rows) {
    byField.set(row.field, {
      field: row.field,
      matched: row.matched,
      diverged: row.diverged,
      arbitrated: row.arbitrated,
      machineRight: row.machine_right,
      checkerRight: row.checker_right,
      bothWrong: row.both_wrong,
    });
  }

  const t = totals.rows[0];
  return {
    period,
    issued: t?.issued ?? 0,
    returned: t?.returned ?? 0,
    waitingChecker: t?.waiting_checker ?? 0,
    waitingArbitration: t?.waiting_arbitration ?? 0,
    fields: [...byField.values()],
  };
}

// ── Состояние подсистемы (§5.4) ──

/**
 * Состояние и цена работы.
 *
 * Отдельная ручка, а не расширение существующего `health`: тот отвечает на вопрос «работает ли
 * прямо сейчас» и живёт в окне часа — его читает разбирающий талоны, и лишние числа ему мешают.
 * Здесь вопрос другой: во что обходится и что копится. Общего у них только состояние, и оно
 * считается по тем же правилам, чтобы два экрана не спорили друг с другом.
 */
export async function ticketAuditOperations(): Promise<TicketAuditOperationsDto> {
  const days = TICKET_AUDIT_OPERATIONS_DAYS;

  const [window, hour, queue, awaiting, journal] = await Promise.all([
    db.execute<{
      calls: number;
      failures: number;
      tokens: number;
      last_success_at: string | null;
    }>(sql`
      SELECT
        count(*)::int AS calls,
        count(*) FILTER (WHERE a.status = 'failed')::int AS failures,
        COALESCE(sum(COALESCE(a.input_tokens, 0) + COALESCE(a.output_tokens, 0)), 0)::int AS tokens,
        to_char(max(a.created_at) FILTER (WHERE a.status = 'done') AT TIME ZONE ${ZONE},
                'YYYY-MM-DD"T"HH24:MI:SS') AS last_success_at
      FROM waste_ticket_recognition_attempts a
      WHERE a.created_at >= now() - (${days} || ' days')::interval
    `),
    db.execute<{ failures: number }>(sql`
      SELECT count(*)::int AS failures
        FROM waste_ticket_recognition_attempts a
       WHERE a.status = 'failed' AND a.created_at >= now() - interval '1 hour'
    `),
    db.execute<{
      waiting: number;
      running: number;
      failed: number;
      dead: number;
      oldest_minutes: number | null;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE j.status = 'pending')::int AS waiting,
        count(*) FILTER (WHERE j.status = 'running')::int AS running,
        count(*) FILTER (WHERE j.status = 'failed')::int AS failed,
        count(*) FILTER (WHERE j.status = 'dead')::int AS dead,
        floor(extract(epoch FROM (now() - min(j.created_at) FILTER (WHERE j.status = 'pending'))) / 60)::int
          AS oldest_minutes
      FROM jobs j
      WHERE j.type = 'recognize_waste_ticket_file'
    `),
    db.execute<{ n: number }>(sql`
      SELECT count(DISTINCT rf.request_id)::int AS n
        FROM request_files rf
        JOIN waste_requests wr ON wr.id = rf.request_id AND wr.deleted_at IS NULL
       WHERE rf.kind = 'ticket'
         AND NOT EXISTS (
           SELECT 1 FROM waste_tickets wt
            WHERE wt.request_id = rf.request_id AND wt.status = 'confirmed'
         )
    `),
    db.execute<{ rows: number; cache_hits: number }>(sql`
      SELECT
        count(*)::int AS rows,
        count(*) FILTER (
          WHERE e.cache_hit AND e.created_at >= now() - (${days} || ' days')::interval
        )::int AS cache_hits
      FROM waste_ticket_field_events e
    `),
  ]);

  const codes = await db.execute<{ error_class: string; error_scope: string; count: number }>(sql`
    SELECT COALESCE(a.error_class, '')::text AS error_class,
           COALESCE(a.error_scope, '')::text AS error_scope,
           count(*)::int AS count
      FROM waste_ticket_recognition_attempts a
     WHERE a.status = 'failed' AND a.created_at >= now() - (${days} || ' days')::interval
     GROUP BY 1, 2
     ORDER BY count DESC
  `);

  const w = window.rows[0];
  const calls = w?.calls ?? 0;
  const failures = w?.failures ?? 0;
  const q = queue.rows[0];

  /*
   * Состояние — по тем же правилам, что у health: выключено настройкой; вырождено, когда отказов
   * половина и больше при заметном потоке; иначе работает. «Не настроено» отдельно от «выключено»:
   * первое — беда, второе — решение, и путать их на экране нельзя.
   */
  let state: TicketAuditSubsystemState = 'ok';
  if (!config.ticketOcr.enabled) state = 'disabled';
  else if (calls === 0 && (q?.waiting ?? 0) > 0) state = 'degraded';
  else if (calls >= 5 && failures / calls >= 0.5) state = 'degraded';

  return {
    state,
    generatedAt: new Date().toISOString(),
    lastSuccessAt: w?.last_success_at ?? null,
    failuresLastHour: hour.rows[0]?.failures ?? 0,
    window: {
      days,
      calls,
      failures,
      cacheHits: journal.rows[0]?.cache_hits ?? 0,
      tokens: w?.tokens ?? 0,
      failureCodes: codes.rows.map((row) => ({
        errorClass: row.error_class,
        errorScope: row.error_scope,
        count: row.count,
      })),
    },
    queue: {
      waiting: q?.waiting ?? 0,
      running: q?.running ?? 0,
      failed: q?.failed ?? 0,
      dead: q?.dead ?? 0,
      oldestMinutes: q?.oldest_minutes ?? null,
    },
    requestsAwaitingReview: awaiting.rows[0]?.n ?? 0,
    journalRows: journal.rows[0]?.rows ?? 0,
  };
}
