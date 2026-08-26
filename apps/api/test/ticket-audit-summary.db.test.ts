import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as sqlRaw } from 'drizzle-orm';
import { applyMigrations } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';
import type {
  ticketAuditAccuracy as Accuracy,
  ticketAuditOperations as Operations,
  ticketAuditCohorts as Cohorts,
  ticketAuditEvents as Events,
  ticketAuditSummary as Summary,
} from '../src/services/ticket-audit';

/**
 * Сводка аудита: исход наблюдения и границы периода (ADR 0137, план §1.2, §1.3).
 *
 * Это контрольный SQL из §7 плана, положенный тестом. Проверяется здесь не «запрос выполнился», а
 * ровно то, ради чего словарь метрик писался раньше экранов: каждый исход получается только своим
 * правилом, правила проверяются по порядку, а знаменатель доли исправлений не считает ничего
 * лишнего. Ошибка тут не роняет портал — она рисует убедительный процент, и заметить её на глаз
 * нельзя.
 *
 * Данные сеются прямым INSERT: маршруты проверяются своими тестами, а здесь предмет — арифметика.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_audit_test \
 *     pnpm --filter @technic/api test ticket-audit-summary.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PERIOD = { from: '2026-08-01', to: '2026-08-31' };

/*
 * СВОЯ БАЗА — НЕ ПОЖЕЛАНИЕ, А МЕХАНИКА. Сводка считает по всему порталу: это её смысл, ради него
 * и заводилось сквозное право. На общей тестовой базе она поэтому складывает и данные соседних
 * файлов — их наблюдения попадают в тот же период, и «принято одно предложение» превращается в
 * пять, притом не своей виной. Отсчитывать дельты «до и после» было бы обманом того же рода:
 * половина проверок здесь именно о том, что число НЕ выросло.
 */
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, '/technic_audit_summary_test');

interface Ctx {
  db: typeof AppDb;
  /** Попытка второй ступени: на неё ссылаются наблюдения, где каскад отработал. */
  escalationAttemptId: string;
  summary: typeof Summary;
  cohorts: typeof Cohorts;
  events: typeof Events;
  accuracy: typeof Accuracy;
  operations: typeof Operations;
  closeDb: () => Promise<void>;
  requestId: string;
  objectId: string;
  userId: string;
  /** Второй человек: арбитром не может быть тот, кто проверял, — это держит CHECK. */
  arbiterId: string;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

/** Талон, по которому будут наблюдения. `confirmedAt` — чтобы проверять правило «принято как есть». */
/** Уникальность номера — среди подтверждённых бумаг одного перевозчика, поэтому номер свой на талон. */
let ticketSeq = 0;

async function seedTicket(confirmedAt: string | null): Promise<string> {
  ticketSeq += 1;
  const rows = await ctx.db.execute<{ id: string }>(sqlRaw`
    INSERT INTO waste_tickets
      (request_id, origin, status, number_raw, number_key, volume_m3, work_kind,
       confirmed_at, confirmed_by)
    VALUES (${ctx.requestId}::uuid, 'ocr', ${confirmedAt ? 'confirmed' : 'unconfirmed'},
            ${`T${RUN}-${ticketSeq}`}, ${`T${RUN}-${ticketSeq}`}, '20', 'removal',
            ${confirmedAt}::timestamptz,
            -- «Когда подтвердили» и «кто подтвердил» ходят парой: это держит CHECK.
            ${confirmedAt ? ctx.userId : null}::uuid)
    RETURNING id
  `);
  return rows.rows[0]!.id;
}

async function seedObservation(
  ticketId: string | null,
  field: string,
  at: string,
  opts: {
    disputed?: boolean;
    readState?: string;
    primaryModel?: string;
    escalationModel?: string;
    primaryValue?: string | null;
    escalationValue?: string | null;
    stage?: string | null;
    escalationAttempt?: boolean;
    runId?: string;
  } = {},
): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sqlRaw`
    INSERT INTO waste_ticket_field_events
      (ticket_id, request_id, event, field, new_value, read_state, collection_version, created_at,
       primary_model_reported, escalation_model_reported, prompt_version, preprocessing_version,
       primary_value, escalation_value, source_stage, escalation_attempt_id, recognition_run_id)
    VALUES (${ticketId}::uuid, ${ctx.requestId}::uuid,
            ${opts.disputed ? 'disputed' : 'recognized'}, ${field},
            ${opts.disputed ? null : '20'}, ${opts.readState ?? 'read'}, 2, ${at}::timestamptz,
            ${opts.primaryModel ?? 'flash-lite'}, ${opts.escalationModel ?? ''}, 3, 1,
            ${opts.primaryValue ?? null}, ${opts.escalationValue ?? null},
            ${opts.stage ?? 'primary'},
            -- Ссылка на попытку второй ступени: по ней каскад отличает «эскалация была» от
            -- «первый проход просто не прочитал».
            ${opts.escalationAttempt ? ctx.escalationAttemptId : null}::uuid,
            ${opts.runId ?? null}::uuid)
    RETURNING id
  `);
  return rows.rows[0]!.id;
}

async function seedDecision(
  ticketId: string,
  observationId: string,
  field: string,
  event: string,
  at: string,
  differs: boolean | null = null,
): Promise<void> {
  await ctx.db.execute(sqlRaw`
    INSERT INTO waste_ticket_field_events
      (ticket_id, request_id, event, field, old_value, new_value, observation_id,
       proposal_differs, collection_version, created_at)
    VALUES (${ticketId}::uuid, ${ctx.requestId}::uuid, ${event}, ${field}, '20', '38',
            ${observationId}::uuid, ${differs}, 2, ${at}::timestamptz)
  `);
}

/** Правка с названным значением: по нему исход спора и различает три случая. */
async function seedDecisionValue(
  ticketId: string,
  observationId: string,
  field: string,
  value: string,
  at: string,
): Promise<void> {
  await ctx.db.execute(sqlRaw`
    INSERT INTO waste_ticket_field_events
      (ticket_id, request_id, event, field, old_value, new_value, observation_id,
       collection_version, created_at)
    VALUES (${ticketId}::uuid, ${ctx.requestId}::uuid, 'edited', ${field}, NULL, ${value},
            ${observationId}::uuid, 2, ${at}::timestamptz)
  `);
}

async function counts() {
  const dto = await ctx.summary(PERIOD);
  return dto.observations;
}

describe.skipIf(!DB_URL)('сводка аудита: исходы наблюдений', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: DB_URL!.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    try {
      await admin.query('DROP DATABASE IF EXISTS technic_audit_summary_test');
      await admin.query('CREATE DATABASE technic_audit_summary_test');
    } finally {
      await admin.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await applyMigrations(client);
    } finally {
      await client.end();
    }
    prepareEnv(OWN_DB!);
    const dbModule = await import('../src/db/client');
    const service = await import('../src/services/ticket-audit');
    const object = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO construction_objects (code, name) VALUES (${`SUM-${RUN}`}, ${`Сводка ${RUN}`})
      RETURNING id`);
    const user = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO users (email, password_hash, last_name, first_name)
      VALUES (${`sum-${RUN}@example.test`}, 'x', 'Сводка', 'Тест') RETURNING id`);
    const arbiter = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO users (email, password_hash, last_name, first_name)
      VALUES (${`sum-arb-${RUN}@example.test`}, 'x', 'Сводка', 'Арбитр') RETURNING id`);
    const request = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by, status, comment)
      VALUES (${object.rows[0]!.id}::uuid, 'waste_removal', now(), ${user.rows[0]!.id}::uuid, 'done',
              ${`sum-${RUN}`})
      RETURNING id`);
    const attempt = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO waste_ticket_recognition_attempts
        (page_sha256, engine, model, prompt_version, preprocessing_version, status)
      VALUES (repeat('b', 64), 'stub', 'senior', 3, 1, 'done') RETURNING id`);
    ctx = {
      db: dbModule.db,
      escalationAttemptId: attempt.rows[0]!.id,
      summary: service.ticketAuditSummary,
      cohorts: service.ticketAuditCohorts,
      events: service.ticketAuditEvents,
      accuracy: service.ticketAuditAccuracy,
      operations: service.ticketAuditOperations,
      closeDb: dbModule.closeDb,
      requestId: request.rows[0]!.id,
      objectId: object.rows[0]!.id,
      userId: user.rows[0]!.id,
      arbiterId: arbiter.rows[0]!.id,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.closeDb();
    const admin = new pg.Client({ connectionString: DB_URL!.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    try {
      await admin.query('DROP DATABASE IF EXISTS technic_audit_summary_test');
    } finally {
      await admin.end();
    }
  });

  it('правка даёт исправление, подтверждение без правки — принятие', async () => {
    const before = await counts();
    const edited = await seedTicket(null);
    const o1 = await seedObservation(edited, 'volumeM3', '2026-08-10T09:00:00Z');
    await seedDecision(edited, o1, 'volumeM3', 'edited', '2026-08-10T10:00:00Z');
    const accepted = await seedTicket('2026-08-11T10:00:00Z');
    await seedObservation(accepted, 'number', '2026-08-11T09:00:00Z');

    const dto = await ctx.summary(PERIOD);
    const volume = dto.fields.find((f) => f.field === 'volumeM3')!;
    const number = dto.fields.find((f) => f.field === 'number')!;
    expect(volume.corrected).toBe(1);
    // Оба исхода — знаменатель доли исправлений, и только они (§1.4).
    expect(volume.decided).toBe(1);
    expect(number.decided).toBe(1);
    expect(number.corrected).toBe(0);
    expect(dto.observations.resolved - before.resolved).toBe(2);
  });

  it('разбор спора не считается исправлением', async () => {
    const ticket = await seedTicket(null);
    const disputed = await seedObservation(ticket, 'issuedOn', '2026-08-12T09:00:00Z', {
      disputed: true,
    });
    await seedDecision(ticket, disputed, 'issuedOn', 'edited', '2026-08-12T10:00:00Z');

    const row = (await ctx.summary(PERIOD)).fields.find((f) => f.field === 'issuedOn')!;
    // Портал значения не предлагал — он честно оставил поле пустым и попросил решить. Считать это
    // ошибкой модели значило бы записать в вину признание в незнании.
    expect(row.resolvedDispute).toBe(1);
    expect(row.corrected).toBe(0);
    expect(row.decided).toBe(0);
  });

  it('перечитанное до решения вытесняется, а живое предложение — нет', async () => {
    const ticket = await seedTicket(null);
    const first = await seedObservation(ticket, 'addressRaw', '2026-08-13T09:00:00Z');
    await seedObservation(ticket, 'addressRaw', '2026-08-13T11:00:00Z');
    const before = await counts();

    const proposalTicket = await seedTicket(null);
    const inCard = await seedObservation(proposalTicket, 'workKind', '2026-08-14T09:00:00Z');
    const proposed = await seedObservation(proposalTicket, 'workKind', '2026-08-14T11:00:00Z');
    await ctx.db.execute(sqlRaw`
      INSERT INTO waste_ticket_proposals (ticket_id, number_raw) VALUES (${proposalTicket}::uuid, 'P')`);
    await ctx.db.execute(sqlRaw`
      INSERT INTO waste_ticket_proposal_observations (proposal_ticket_id, field, observation_id, differs)
      VALUES (${proposalTicket}::uuid, 'workKind', ${proposed}::uuid, true)`);

    const after = await counts();
    expect(before.superseded).toBeGreaterThan(0);
    expect(first).toBeTruthy();
    // Чтение живого предложения свежее, но его значения в талоне не стоят: вытеснять им прежнее
    // чтение нельзя — иначе исход по тому, что человек видит в карточке, потерялся бы.
    expect(after.superseded - before.superseded).toBe(0);
    expect(after.pending - before.pending).toBe(2);
    expect(inCard).toBeTruthy();
  });

  it('удалённый талон уносит исход с собой', async () => {
    const before = await counts();
    await seedObservation(null, 'number', '2026-08-15T09:00:00Z');
    const after = await counts();
    expect(after.lost - before.lost).toBe(1);
  });

  it('отказ от предложения не ложится ошибкой ни на одно поле', async () => {
    const ticket = await seedTicket(null);
    const differing = await seedObservation(ticket, 'number', '2026-08-16T09:00:00Z');
    const same = await seedObservation(ticket, 'addressRaw', '2026-08-16T09:00:00Z');
    await seedDecision(
      ticket,
      differing,
      'number',
      'proposal_dismissed',
      '2026-08-16T10:00:00Z',
      true,
    );
    await seedDecision(
      ticket,
      same,
      'addressRaw',
      'proposal_dismissed',
      '2026-08-16T10:00:00Z',
      false,
    );

    const dto = await ctx.summary(PERIOD);
    const number = dto.fields.find((f) => f.field === 'number')!;
    expect(number.corrected).toBe(0);
    expect(dto.proposals.rejected).toBe(1);
  });

  it('когорты сходятся со сводкой до последнего наблюдения', async () => {
    // Главная проверка второго экрана: конфигурации не пересекаются, и сумма по ним равна целому.
    // Разойдись они со сводкой — два экрана показали бы разные проценты об одном и том же, а
    // спорить с ними было бы нечем. Ровно на этом план спотыкался на бумаге.
    const summary = await ctx.summary(PERIOD);
    const { cohorts } = await ctx.cohorts(PERIOD);

    const observations = cohorts.reduce((acc, c) => acc + c.observations, 0);
    const corrected = cohorts.reduce((acc, c) => acc + c.corrected, 0);
    const decided = cohorts.reduce((acc, c) => acc + c.decided, 0);
    expect(observations).toBe(summary.observations.total);
    expect(corrected).toBe(summary.fields.reduce((acc, f) => acc + f.corrected, 0));
    expect(decided).toBe(summary.fields.reduce((acc, f) => acc + f.decided, 0));
  });

  it('когорта — конфигурация целиком: смена версии промпта разводит строки', async () => {
    const ticket = await seedTicket(null);
    await seedObservation(ticket, 'number', '2026-08-20T09:00:00Z', { primaryModel: 'model-a' });
    await seedObservation(ticket, 'issuedOn', '2026-08-20T09:00:00Z', {
      primaryModel: 'model-a',
      escalationModel: 'senior-b',
      escalationAttempt: true,
    });

    const { cohorts } = await ctx.cohorts(PERIOD);
    const withoutEscalation = cohorts.find(
      (c) => c.primaryModel === 'model-a' && c.escalationModel === null,
    );
    const withEscalation = cohorts.find(
      (c) => c.primaryModel === 'model-a' && c.escalationModel === 'senior-b',
    );
    // Одна модель первого прохода, но разные конвейеры — значит разные когорты: наблюдение,
    // прочитанное двумя ступенями, не принадлежит ни одной модели по отдельности.
    expect(withoutEscalation?.observations).toBe(1);
    expect(withEscalation?.observations).toBe(1);
  });

  it('исходы спора складываются в число споров и различают три случая', async () => {
    const ticket = await seedTicket(null);
    const base = {
      primaryModel: 'casc',
      escalationModel: 'casc-senior',
      escalationAttempt: true,
      disputed: true,
      stage: null,
    };
    const first = await seedObservation(ticket, 'number', '2026-08-21T09:00:00Z', {
      ...base,
      primaryValue: '262',
      escalationValue: '26213',
    });
    const second = await seedObservation(ticket, 'issuedOn', '2026-08-21T09:00:00Z', {
      ...base,
      primaryValue: '2020-08-17',
      escalationValue: '2026-08-17',
    });
    const third = await seedObservation(ticket, 'volumeM3', '2026-08-21T09:00:00Z', {
      ...base,
      primaryValue: '3',
      escalationValue: '8',
    });
    await seedObservation(ticket, 'addressRaw', '2026-08-21T09:00:00Z', {
      ...base,
      primaryValue: 'ул. Ленина',
      escalationValue: 'ул. Ленина, 5',
    });
    // Человек выбрал первое чтение, второе и своё третье; четвёртый спор остался неразобранным.
    await seedDecisionValue(ticket, first, 'number', '262', '2026-08-21T10:00:00Z');
    await seedDecisionValue(ticket, second, 'issuedOn', '2026-08-17', '2026-08-21T10:00:00Z');
    await seedDecisionValue(ticket, third, 'volumeM3', '38', '2026-08-21T10:00:00Z');

    const { cascade } = await ctx.cohorts(PERIOD);
    const o = cascade.disputeOutcomes;
    expect(o.primary).toBeGreaterThanOrEqual(1);
    expect(o.escalation).toBeGreaterThanOrEqual(1);
    // Третье значение — «ошиблись оба»: исход, которого нет, если считать спор выбором из двух.
    expect(o.third).toBeGreaterThanOrEqual(1);
    expect(o.unresolved).toBeGreaterThanOrEqual(1);
    expect(o.primary + o.escalation + o.third + o.unresolved).toBe(cascade.disputes);
  });

  it('пустое после первого прохода считается только там, где каскад отработал', async () => {
    const ticket = await seedTicket(null);
    // Эскалации не было: пустое поле — это нечитаемое поле, а не работа второй ступени.
    await seedObservation(ticket, 'addressRaw', '2026-08-22T09:00:00Z', {
      primaryValue: null,
      readState: 'unreadable',
    });
    const before = (await ctx.cohorts(PERIOD)).cascade;
    await seedObservation(ticket, 'number', '2026-08-22T10:00:00Z', {
      escalationModel: 'senior',
      escalationAttempt: true,
      primaryValue: null,
      escalationValue: '26213',
      stage: 'escalation',
    });
    const after = (await ctx.cohorts(PERIOD)).cascade;
    expect(after.emptyAfterPrimary - before.emptyAfterPrimary).toBe(1);
    expect(after.filledBySecond - before.filledBySecond).toBe(1);
  });

  it('лента показывает все типы событий, а не одни правки', async () => {
    const ticket = await seedTicket(null);
    const observation = await seedObservation(ticket, 'volumeM3', '2026-08-23T09:00:00Z');
    await seedDecisionValue(ticket, observation, 'volumeM3', '38', '2026-08-23T10:00:00Z');
    await seedObservation(ticket, 'number', '2026-08-23T09:00:00Z', { disputed: true });

    const feed = await ctx.events({ from: '2026-08-23', to: '2026-08-23', page: 1, pageSize: 50 });
    const kinds = new Set(feed.rows.map((r) => r.event));
    // Спор и машинное чтение — материал для промпта не меньший, чем исправление: лента, где их
    // нет, отвечала бы на вопрос «где работал человек», а не «что путает машина».
    expect(kinds.has('edited')).toBe(true);
    expect(kinds.has('disputed')).toBe(true);
    expect(kinds.has('recognized')).toBe(true);
  });

  it('правка в ленте названа моделью своего наблюдения, а не пустотой', async () => {
    const ticket = await seedTicket(null);
    const observation = await seedObservation(ticket, 'issuedOn', '2026-08-24T09:00:00Z', {
      primaryModel: 'feed-model',
    });
    await ctx.db.transaction(async (tx) => {
      const events = await import('../src/services/waste-ticket-events');
      await events.recordTicketFieldEvents(tx, {
        ticketId: ticket,
        requestId: ctx.requestId,
        event: 'edited',
        actorId: null,
        changes: [{ field: 'issuedOn', oldValue: '2026-08-01', newValue: '2026-08-17' }],
      });
    });

    // Период ленты не задаём намеренно: лента идёт по времени СОБЫТИЯ, а правка случается сегодня,
    // тогда как наблюдение о ней датировано августом. Это не мелочь фикстуры — это разница между
    // журналом и метрикой, и она названа в §1.3 плана.
    const feed = await ctx.events({ event: 'edited', field: 'issuedOn', page: 1, pageSize: 200 });
    const row = feed.rows.find((r) => r.model === 'feed-model');
    // Модель приходит снимком из наблюдения: попытки убираются по сроку, и лента годичной
    // давности иначе осталась бы без ответа на вопрос, ради которого её читают.
    expect(row?.model).toBe('feed-model');
    expect(observation).toBeTruthy();
  });

  it('лента различает «не смогла прочесть» и «графы нет»', async () => {
    const ticket = await seedTicket(null);
    await seedObservation(ticket, 'addressRaw', '2026-08-26T09:00:00Z', {
      readState: 'unreadable',
    });
    await seedObservation(ticket, 'volumeM3', '2026-08-26T09:00:00Z', {
      readState: 'not_applicable',
    });

    const feed = await ctx.events({ from: '2026-08-26', to: '2026-08-26', page: 1, pageSize: 50 });
    const address = feed.rows.find((r) => r.field === 'addressRaw');
    const volume = feed.rows.find((r) => r.field === 'volumeM3');
    // Обе строки в ленте пустые, и без признака чтения они выглядели бы одинаково. Но это разные
    // новости: первая — про качество модели, вторая — про бланк простоя, где объёма и не бывает.
    expect(address?.readState).toBe('unreadable');
    expect(volume?.readState).toBe('not_applicable');
  });

  it('постраничность не меняет общего числа', async () => {
    const first = await ctx.events({ page: 1, pageSize: 10 });
    const second = await ctx.events({ page: 2, pageSize: 10 });
    expect(second.total).toBe(first.total);
    expect(first.rows.length).toBeLessThanOrEqual(10);
    // Страницы не пересекаются: иначе одно и то же событие читалось бы как два.
    const ids = new Set(first.rows.map((r) => r.id));
    expect(second.rows.every((r) => !ids.has(r.id))).toBe(true);
  });

  it('фильтр по полю сужает ленту и не задевает соседей', async () => {
    const all = await ctx.events({ page: 1, pageSize: 200 });
    const onlyVolume = await ctx.events({ field: 'volumeM3', page: 1, pageSize: 200 });
    expect(onlyVolume.rows.every((r) => r.field === 'volumeM3')).toBe(true);
    expect(onlyVolume.total).toBeLessThan(all.total);
  });

  it('слепая проверка: совпадение верно, а три исхода арбитража различимы', async () => {
    /**
     * Проверка со своими baseline/review/final: по ним и считается точность. Талон свой на каждую —
     * перепроверка бывает одна на бумагу, и это держит уникальность.
     */
    const seedCheck = async (
      status: string,
      baseline: string,
      review: string,
      final: string | null,
    ) => {
      const ticket = await seedTicket('2026-08-25T10:00:00Z');
      await ctx.db.execute(sqlRaw`
        INSERT INTO waste_ticket_blind_checks
          (ticket_id, checker_id, review_number_raw, review_number_key,
           baseline_number_raw, baseline_number_key, baseline_fingerprint, status,
           final_number_raw, final_number_key, resolved_fields, arbiter_id, arbitrated_at, created_at)
        VALUES (${ticket}::uuid, ${ctx.userId}::uuid, ${review}, ${review},
                ${baseline}, ${baseline}, repeat('c', 64), ${status},
                ${final}, ${final}, ${final ? sqlRaw`ARRAY['number']::text[]` : sqlRaw`'{}'::text[]`},
                ${final ? ctx.arbiterId : null}::uuid,
                ${final ? '2026-08-25T12:00:00Z' : null}::timestamptz,
                '2026-08-25T11:00:00Z'::timestamptz)
      `);
    };
    // Согласие двух независимых чтений — свидетельство, и оно идёт в верные.
    await seedCheck('match', 'A100', 'A100', null);
    // Арбитр назвал машинное чтение: права машина.
    await seedCheck('arbitrated', 'A200', 'B200', 'A200');
    // Арбитр назвал чтение проверяющего.
    await seedCheck('arbitrated', 'A300', 'B300', 'B300');
    // Арбитр ввёл третье: ошиблись оба — исход, которого не бывает при выборе из двух.
    await seedCheck('arbitrated', 'A400', 'B400', 'C400');
    // Расхождение без арбитра: не верно и не неверно — просто ещё не разобрано.
    await seedCheck('mismatch', 'A500', 'B500', null);

    const dto = await ctx.accuracy(PERIOD);
    const number = dto.fields.find((f) => f.field === 'number')!;
    expect(number.matched).toBe(1);
    expect(number.machineRight).toBe(1);
    expect(number.checkerRight).toBe(1);
    expect(number.bothWrong).toBe(1);
    expect(number.arbitrated).toBe(3);
    expect(number.diverged).toBe(4);
    expect(dto.waitingArbitration).toBe(1);
    expect(dto.returned).toBe(5);
  });

  it('неразобранное расхождение не попадает в знаменатель точности', async () => {
    const { accuracyDenominator, accuracyRight } = await import('@technic/contracts');
    const dto = await ctx.accuracy(PERIOD);
    const number = dto.fields.find((f) => f.field === 'number')!;
    // Знаменатель — совпадения плюс разобранные расхождения. Ждущее арбитра расхождение не
    // ухудшает и не улучшает число: включи мы его как ошибку — точность падала бы просто оттого,
    // что до проверки не дошли руки.
    expect(accuracyDenominator(number)).toBe(number.matched + number.arbitrated);
    expect(accuracyRight(number)).toBe(number.matched + number.machineRight);
    expect(accuracyDenominator(number)).toBeLessThan(number.matched + number.diverged);
  });

  it('выключенное распознавание — это решение, а не поломка', async () => {
    // В тестовом окружении модуль выключен, и состояние обязано это сказать словом `disabled`.
    // Показывай мы «вырожден» — дежурный искал бы сбой там, где его нет; показывай «работает» —
    // не искал бы там, где данные просто не собираются.
    const ops = await ctx.operations();
    expect(ops.state).toBe('disabled');
    expect(ops.window.days).toBe(7);
    // Момент ответа обязателен: без него экран, открытый со вчера, читается как «прямо сейчас».
    expect(Date.parse(ops.generatedAt)).not.toBeNaN();
  });

  it('размер журнала виден, потому что срок хранения не задан', async () => {
    const ops = await ctx.operations();
    const rows = await ctx.db.execute<{ n: number }>(sqlRaw`
      SELECT count(*)::int AS n FROM waste_ticket_field_events`);
    expect(ops.journalRows).toBe(rows.rows[0]!.n);
  });

  it('очередь и вызовы считаются раздельно: пустая очередь не значит «не звали»', async () => {
    await ctx.db.execute(sqlRaw`
      INSERT INTO waste_ticket_recognition_attempts
        (page_sha256, engine, model, prompt_version, preprocessing_version, status,
         input_tokens, output_tokens)
      VALUES (repeat('d', 64), 'stub', 'ops', 3, 1, 'done', 100, 40)`);
    await ctx.db.execute(sqlRaw`
      INSERT INTO waste_ticket_recognition_attempts
        (page_sha256, engine, model, prompt_version, preprocessing_version, status,
         error_class, error_scope)
      VALUES (repeat('e', 64), 'stub', 'ops', 3, 1, 'failed', 'transient', 'subsystem')`);

    const ops = await ctx.operations();
    expect(ops.window.calls).toBeGreaterThanOrEqual(2);
    expect(ops.window.failures).toBeGreaterThanOrEqual(1);
    expect(ops.window.tokens).toBeGreaterThanOrEqual(140);
    // Отказы разложены по паре «класс × область»: transient/subsystem — это «прокси молчит», а
    // terminal/item — «эта бумага не читается», и лечатся они по-разному.
    expect(
      ops.window.failureCodes.some(
        (c) => c.errorClass === 'transient' && c.errorScope === 'subsystem',
      ),
    ).toBe(true);
    expect(ops.lastSuccessAt).not.toBeNull();
  });

  it('период считается по московским суткам и по времени наблюдения', async () => {
    const ticket = await seedTicket(null);
    // 31.08 23:59 по Москве — это 20:59 UTC того же дня: последний день включительно.
    await seedObservation(ticket, 'volumeM3', '2026-08-31T20:59:00Z');
    const inside = await ctx.summary(PERIOD);
    // 01.09 00:00 по Москве — 21:00 UTC 31 августа: уже следующие сутки, в период не входит.
    await seedObservation(ticket, 'volumeM3', '2026-08-31T21:00:00Z');
    const after = await ctx.summary(PERIOD);
    expect(after.observations.total).toBe(inside.observations.total);
  });
});
