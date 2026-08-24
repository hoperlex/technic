import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  acceptWasteTicketCheckSchema,
  arbitrateWasteTicketBlindCheckSchema,
  confirmWasteTicketSchema,
  createWasteTicketSchema,
  dismissWasteTicketSchema,
  updateWasteTicketSchema,
  WASTE_TICKET_CHECK_CODES,
  wasteTicketBlindCheckSchema,
  wasteTicketNumberFuzzy,
  wasteTicketNumberKey,
  type WasteTicketAttemptDto,
  type WasteTicketBlindCheckDto,
  type WasteTicketBlindCheckField,
  type WasteTicketCandidateDto,
  type WasteTicketDto,
  type WasteTicketField,
  type WasteTicketFileDto,
  type WasteTicketPageDto,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import {
  counterparties,
  files,
  jobs,
  users,
  wasteRequests,
  wasteTicketBlindChecks,
  wasteTicketCheckResolutions,
  wasteTicketFiles,
  wasteTicketPages,
  wasteTicketProposals,
  wasteTicketRecognitionAttempts,
  wasteTickets,
} from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import { assertOperatorScope, assertWasteObjectScope } from '../lib/access';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  blindBaselineFingerprint,
  shouldSampleBlindCheck,
} from '../services/waste-ticket-blind';
import { wasteTicketCheckFingerprint, wasteTicketChecks } from '../services/waste-ticket-checks';
import {
  loadTicketCheckInputs,
  loadTicketCheckRequestRow,
  type RequestVisibility,
  type TicketCheckBundle,
} from '../services/waste-ticket-inputs';
import { enqueueTicketRecognition } from '../services/waste-tickets';

/**
 * Разбор талонов вывоза (ADR 0114, план `docs/waste-ticket-ocr-plan.md`, раздел 8).
 *
 * **Весь файл закрыт правом `wasteRequests.ticketReview`, включая чтение.** Это не перестраховка:
 * право `wasteRequests.status` есть у внешнего исполнителя — он и приносит талон, — а распознанные
 * значения такой же результат сверки, как и сами замечания. Отдай их проверяемому, и он увидит,
 * какую цифру портал считает спорной, раньше того, кто эту сверку ведёт (Р25).
 *
 * Права мало: оно говорит, что человек разбирает талоны, но не говорит, **чьи**. Поэтому каждая
 * ручка вложена в заявку и проходит ту же объектную и операторскую область, что остальной модуль.
 */
export default async function wasteTicketsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canReview = {
    preHandler: [
      app.authenticate,
      app.requirePermission('wasteRequests.ticketReview', 'Недостаточно прав для разбора талонов'),
    ],
  };

  const requestParams = z.object({ id: z.string().uuid() });
  const ticketParams = requestParams.extend({ ticketId: z.string().uuid() });

  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  /**
   * Заявка вместе с проверкой области — общее начало каждой ручки. Возвращает то, что нужно и
   * сверкам, и текстам замечаний: тип, план, плановую дату, объект и оператора.
   */
  async function loadRequest(requestId: string) {
    const rows = await db
      .select({
        id: wasteRequests.id,
        num: wasteRequests.num,
        objectId: wasteRequests.objectId,
        requestType: wasteRequests.requestType,
        status: wasteRequests.status,
        volumeM3: wasteRequests.volumeM3,
        deliveryAt: wasteRequests.deliveryAt,
        operatorCounterpartyId: wasteRequests.operatorCounterpartyId,
        deletedAt: wasteRequests.deletedAt,
      })
      .from(wasteRequests)
      .where(eq(wasteRequests.id, requestId))
      .limit(1);
    const request = rows[0];
    if (!request || request.deletedAt) throw err.notFound('Заявка не найдена');
    return request;
  }

  /** Талон этой заявки. Проверка принадлежности здесь, а не в запросе выше: 404 честнее 403. */
  async function loadTicket(tx: Tx, requestId: string, ticketId: string) {
    const rows = await tx
      .select()
      .from(wasteTickets)
      .where(and(eq(wasteTickets.id, ticketId), eq(wasteTickets.requestId, requestId)))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) throw err.notFound('Талон не найден');
    return ticket;
  }

  /**
   * Замок области уникальности номера: два человека, одновременно подтверждающие один номер в
   * разных заявках, иначе разойдутся на гонке между проверкой и вставкой, и один получит ошибку
   * базы вместо внятного 409 с соседом (Р27).
   */
  async function lockNumberArea(
    tx: Tx,
    operatorId: string | null,
    numberKey: string,
  ): Promise<void> {
    if (!numberKey) return;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${operatorId ?? 'nobody'}:${numberKey}`}))`,
    );
  }

  /**
   * Ищет подтверждённый талон с тем же номером в области того же перевозчика. Возвращает соседа,
   * если он есть, — и **скрывает его заявку**, когда та вне области видимости спрашивающего:
   * сообщение об ошибке такой же канал утечки, как ручка чтения, и по нему чужую площадку можно
   * перебрать номерами (Р28).
   */
  async function findNumberConflict(
    tx: Tx,
    params: { ticketId: string; operatorId: string | null; numberKey: string },
  ) {
    if (!params.numberKey) return null;
    const rows = await tx
      .select({
        id: wasteTickets.id,
        requestId: wasteTickets.requestId,
        requestNum: wasteRequests.num,
        objectId: wasteRequests.objectId,
        operatorCounterpartyId: wasteRequests.operatorCounterpartyId,
      })
      .from(wasteTickets)
      .innerJoin(wasteRequests, eq(wasteRequests.id, wasteTickets.requestId))
      .where(
        and(
          eq(wasteTickets.numberKey, params.numberKey),
          eq(wasteTickets.status, 'confirmed'),
          sql`${wasteTickets.duplicateOverrideAt} IS NULL`,
          ne(wasteTickets.id, params.ticketId),
          params.operatorId
            ? eq(wasteTickets.operatorCounterpartyId, params.operatorId)
            : sql`${wasteTickets.operatorCounterpartyId} IS NULL`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Видит ли этот человек чужую заявку. Не бросает, в отличие от `assert*`: здесь ответ нужен
   * значением — им решается, назвать соседа номером или сказать «по другой заявке» (Р28).
   */
  function visibilityFor(principal: ReturnType<typeof requirePrincipal>): RequestVisibility {
    return (objectId, operatorCounterpartyId) => {
      try {
        assertWasteObjectScope(principal, objectId);
        assertOperatorScope(principal, operatorCounterpartyId);
        return true;
      } catch {
        return false;
      }
    };
  }

  /** Ошибка конфликта: называет соседа только тому, кто вправе его видеть (Р28). */
  function numberConflictError(
    principal: ReturnType<typeof requirePrincipal>,
    neighbour: { requestNum: number; objectId: string; operatorCounterpartyId: string | null },
    numberRaw: string,
  ) {
    let visible = true;
    try {
      assertWasteObjectScope(principal, neighbour.objectId);
      assertOperatorScope(principal, neighbour.operatorCounterpartyId);
    } catch {
      visible = false;
    }
    return err.conflict(
      visible
        ? `Номер ${numberRaw} уже предъявлен по заявке М-${neighbour.requestNum}`
        : `Номер ${numberRaw} уже предъявлен по другой заявке`,
    );
  }

  /**
   * Собирает вход сверок: заявка, факт, талоны, соседи по номеру и принятия расхождений. Отдельной
   * функцией потому, что её зовут двое — чтение экрана и принятие расхождения, — и отпечаток
   * (Р21) обязан считаться от ТОГО ЖЕ состояния, которое человек видел на экране. Собери его
   * вторым запросом с другими джойнами, и отпечаток начал бы расходиться с показанным.
   */
  /**
   * Вход сверки для этой заявки. Читает его общий загрузчик (`waste-ticket-inputs.ts`) — тот же,
   * что считает значки списка: сверка карточки и значок в строке обязаны сходиться до штуки, а два
   * запроса «примерно об одном» разъезжаются молча и именно в ту сторону, где список успокаивает.
   *
   * Видимость соседа берётся с этого же пользователя: заявка называется по номеру только тому, кто
   * вправе её читать (Р28) — текст замечания такой же канал утечки, как ручка чтения.
   */
  async function collectCheckInputs(
    principal: ReturnType<typeof requirePrincipal>,
    requestId: string,
  ): Promise<TicketCheckBundle> {
    const row = await loadTicketCheckRequestRow(requestId);
    if (!row) throw err.notFound('Заявка не найдена');
    const bundle = await loadTicketCheckInputs([row], { visible: visibilityFor(principal) });
    return (
      bundle.get(requestId) ?? {
        // Заявка без единой строки распознавания: талонов нет, сверять нечего — но замечания об
        // объёме и дате считаются и по пустому списку (в талонах 0 м³ против закрытых 40).
        inputs: {
          request: {
            requestedVolumeM3: row.volumeM3 == null ? null : Number(row.volumeM3),
            deliveryAt: row.deliveryAt,
            objectAddress: row.objectAddress,
            objectName: row.objectName,
            operatorCounterpartyId: row.operatorCounterpartyId,
          },
          completion: null,
          tickets: [],
        },
        tickets: [],
        pages: [],
      }
    );
  }

  // ── Чтение ──

  /**
   * Всё, что нужно экрану разбора: талоны, страницы, файловые строки и посчитанные замечания.
   * Замечания не хранятся — они считаются здесь функцией от заявки, факта и талонов, иначе
   * разошлись бы с талонами на первой же правке цифры (Р21).
   */
  r.get('/:id/tickets', { ...canReview, schema: { params: requestParams } }, async (req) => {
    const p = requirePrincipal(req);
    const request = await loadRequest(req.params.id);
    assertWasteObjectScope(p, request.objectId);
    assertOperatorScope(p, request.operatorCounterpartyId);

    // Вход сверки и всё, что нужно только этому экрану, читаются параллельно: первое — общим
    // загрузчиком (он же считает значки списка), остальное — здесь.
    const [bundle, fileRows, attempts] = await Promise.all([
      collectCheckInputs(p, request.id),
      // Файловая строка отвечает на вопрос, которого у талонов нет: почему их нет вовсе (Р29).
      // Имя файла и живая задача — оттуда же: «попытка 3 из 5, следующая в 14:32» собирается из
      // очереди, и собирать её вторым запросом с экрана значило бы показывать вчерашнее число.
      db
        .select({
          fileId: wasteTicketFiles.fileId,
          filename: files.filename,
          status: wasteTicketFiles.status,
          reason: wasteTicketFiles.reason,
          errorClass: wasteTicketFiles.errorClass,
          errorScope: wasteTicketFiles.errorScope,
          totalPages: wasteTicketFiles.totalPages,
          processedPages: wasteTicketFiles.processedPages,
          createdAt: wasteTicketFiles.createdAt,
          updatedAt: wasteTicketFiles.updatedAt,
          jobId: jobs.id,
          jobAttempt: jobs.attempts,
          jobMaxAttempts: jobs.maxAttempts,
          jobRunAt: jobs.nextRunAt,
          jobStatus: jobs.status,
        })
        .from(wasteTicketFiles)
        .leftJoin(files, eq(files.id, wasteTicketFiles.fileId))
        .leftJoin(jobs, eq(jobs.id, wasteTicketFiles.activeJobId))
        .where(eq(wasteTicketFiles.requestId, request.id)),
      // Журнал попыток (Р29): по нему человек называет оператору прокси идентификатор запроса,
      // когда разбираются, почему не работает. Без него разговор сводится к «у нас не читается».
      db
        .select({
          id: wasteTicketRecognitionAttempts.id,
          pageSha256: wasteTicketRecognitionAttempts.pageSha256,
          engine: wasteTicketRecognitionAttempts.engine,
          model: wasteTicketRecognitionAttempts.model,
          modelReported: wasteTicketRecognitionAttempts.modelReported,
          promptVersion: wasteTicketRecognitionAttempts.promptVersion,
          preprocessingVersion: wasteTicketRecognitionAttempts.preprocessingVersion,
          status: wasteTicketRecognitionAttempts.status,
          forced: wasteTicketRecognitionAttempts.forced,
          inputTokens: wasteTicketRecognitionAttempts.inputTokens,
          outputTokens: wasteTicketRecognitionAttempts.outputTokens,
          durationMs: wasteTicketRecognitionAttempts.durationMs,
          proxyRequestId: wasteTicketRecognitionAttempts.proxyRequestId,
          upstreamRequestId: wasteTicketRecognitionAttempts.upstreamRequestId,
          errorCode: wasteTicketRecognitionAttempts.errorCode,
          errorClass: wasteTicketRecognitionAttempts.errorClass,
          errorScope: wasteTicketRecognitionAttempts.errorScope,
          error: wasteTicketRecognitionAttempts.error,
          createdAt: wasteTicketRecognitionAttempts.createdAt,
        })
        .from(wasteTicketRecognitionAttempts)
        .innerJoin(
          wasteTicketPages,
          eq(wasteTicketPages.pageSha256, wasteTicketRecognitionAttempts.pageSha256),
        )
        .where(eq(wasteTicketPages.requestId, request.id))
        .orderBy(asc(wasteTicketRecognitionAttempts.createdAt)),
    ]);

    const { tickets, pages } = bundle;
    const checks = wasteTicketChecks(bundle.inputs);

    // Имена людей и перевозчика — вторым запросом и только по тем, кто вправду встретился в
    // строках: карточка показывает «подтвердил Плехотин А.», а не идентификатор.
    const personIds = [
      ...new Set(
        tickets
          .flatMap((t) => [t.editedBy, t.confirmedBy, t.duplicateOverrideBy])
          .filter((id): id is string => !!id),
      ),
    ];
    const operatorIds = [
      ...new Set(tickets.map((t) => t.operatorCounterpartyId).filter((id): id is string => !!id)),
    ];
    const ticketIds = tickets.map((t) => t.id);
    const [personRows, operatorRows, proposalRows, blindRows] = await Promise.all([
      personIds.length
        ? db
            .select({ id: users.id, fullName: users.fullName })
            .from(users)
            .where(inArray(users.id, personIds))
        : Promise.resolve([]),
      operatorIds.length
        ? db
            .select({ id: counterparties.id, name: counterparties.name })
            .from(counterparties)
            .where(inArray(counterparties.id, operatorIds))
        : Promise.resolve([]),
      ticketIds.length
        ? db
            .select()
            .from(wasteTicketProposals)
            .where(inArray(wasteTicketProposals.ticketId, ticketIds))
        : Promise.resolve([]),
      // Слепые перепроверки (Р31): показываются разбирающему рядом с талоном — но только со
      // стороны, где чтение проверяющего уже есть. Пустое задание в карточке было бы приглашением
      // подсмотреть машинное чтение до того, как второй человек прочитал бумагу сам.
      ticketIds.length
        ? db
            .select({
              row: wasteTicketBlindChecks,
              checkerName: sql<string | null>`checker.full_name`,
              arbiterName: sql<string | null>`arbiter.full_name`,
            })
            .from(wasteTicketBlindChecks)
            .leftJoin(
              sql`users AS checker`,
              sql`checker.id = ${wasteTicketBlindChecks.checkerId}`,
            )
            .leftJoin(
              sql`users AS arbiter`,
              sql`arbiter.id = ${wasteTicketBlindChecks.arbiterId}`,
            )
            .where(inArray(wasteTicketBlindChecks.ticketId, ticketIds))
        : Promise.resolve([]),
    ]);
    const personName = new Map(personRows.map((row) => [row.id, row.fullName ?? '']));
    const operatorName = new Map(operatorRows.map((row) => [row.id, row.name]));
    const proposalOf = new Map(proposalRows.map((row) => [row.ticketId, row]));

    const pagesByFile = new Map<string, WasteTicketPageDto[]>();
    const pageDtos = pages.map((page): WasteTicketPageDto & { fileId: string } => {
      const dto = {
        id: page.id,
        fileId: page.fileId,
        pageNo: page.pageNo,
        status: page.status,
        ticketsFound: page.ticketsFound,
      };
      const list = pagesByFile.get(page.fileId);
      if (list) list.push(dto);
      else pagesByFile.set(page.fileId, [dto]);
      return dto;
    });

    return {
      tickets: tickets.map(
        (t): WasteTicketDto => ({
          id: t.id,
          requestId: t.requestId,
          pageId: t.pageId,
          seq: t.seq,
          origin: t.origin,
          status: t.status,
          number: t.numberRaw,
          issuedOn: t.issuedOn,
          volumeM3: t.volumeM3 == null ? null : Number(t.volumeM3),
          workKind: t.workKind,
          addressRaw: t.addressRaw,
          needsReviewFields: t.needsReviewFields as WasteTicketField[],
          candidates: t.candidates as WasteTicketCandidateDto[],
          operatorCounterpartyId: t.operatorCounterpartyId,
          operatorName: t.operatorCounterpartyId
            ? (operatorName.get(t.operatorCounterpartyId) ?? null)
            : null,
          editedAt: t.editedAt?.toISOString() ?? null,
          editedByName: t.editedBy ? (personName.get(t.editedBy) ?? null) : null,
          confirmedAt: t.confirmedAt?.toISOString() ?? null,
          confirmedByName: t.confirmedBy ? (personName.get(t.confirmedBy) ?? null) : null,
          // Тройка клапана неразделима (её держит `CHECK`), поэтому и здесь она одним объектом:
          // «снято, но без причины» — состояние, которого не бывает (Р17).
          duplicateOverride:
            t.duplicateOverrideAt && t.duplicateOverrideBy
              ? {
                  at: t.duplicateOverrideAt.toISOString(),
                  byName: personName.get(t.duplicateOverrideBy) ?? '',
                  reason: t.duplicateOverrideReason,
                }
              : null,
          proposal: (() => {
            const row = proposalOf.get(t.id);
            return row
              ? {
                  ticketId: row.ticketId,
                  number: row.numberRaw,
                  issuedOn: row.issuedOn,
                  volumeM3: row.volumeM3 == null ? null : Number(row.volumeM3),
                  workKind: row.workKind,
                  addressRaw: row.addressRaw,
                  primaryAttemptId: row.primaryAttemptId,
                  escalationAttemptId: row.escalationAttemptId,
                  createdAt: row.createdAt.toISOString(),
                }
              : null;
          })(),
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        }),
      ),
      pages: pageDtos,
      files: fileRows.map(
        (f): WasteTicketFileDto => ({
          fileId: f.fileId,
          filename: f.filename ?? '',
          status: f.status,
          reason: f.reason,
          // Пустая строка в базе и «сбоя не было» — одно состояние для читающего экрана, и в DTO
          // оно одно: `null`. Иначе каждое место показа сравнивало бы значение с `''`.
          errorClass: f.errorClass === '' ? null : f.errorClass,
          errorScope: f.errorScope === '' ? null : f.errorScope,
          totalPages: f.totalPages,
          processedPages: f.processedPages,
          // Задача показывается, только пока повтор ещё будет: завершённая и мёртвая обещают
          // человеку то, чего не случится (Р29).
          activeJob:
            f.jobId && (f.jobStatus === 'pending' || f.jobStatus === 'running')
              ? {
                  id: f.jobId,
                  attempt: f.jobAttempt ?? 0,
                  maxAttempts: f.jobMaxAttempts ?? 0,
                  nextRunAt: f.jobStatus === 'running' ? null : (f.jobRunAt?.toISOString() ?? null),
                }
              : null,
          pages: pagesByFile.get(f.fileId) ?? [],
          createdAt: f.createdAt.toISOString(),
          updatedAt: f.updatedAt.toISOString(),
        }),
      ),
      checks: checks.checks,
      attempts: attempts.map(
        (a): WasteTicketAttemptDto => ({
          ...a,
          errorClass: a.errorClass === '' ? null : a.errorClass,
          errorScope: a.errorScope === '' ? null : a.errorScope,
          createdAt: a.createdAt.toISOString(),
        }),
      ),
      blindChecks: blindRows.map(
        ({ row, checkerName, arbiterName }): WasteTicketBlindCheckDto => ({
          id: row.id,
          ticketId: row.ticketId,
          requestId: request.id,
          status: row.status,
          checkerName: checkerName ?? null,
          review: {
            number: row.reviewNumberRaw,
            issuedOn: row.reviewIssuedOn,
            volumeM3: row.reviewVolumeM3 == null ? null : Number(row.reviewVolumeM3),
          },
          baseline: {
            number: row.baselineNumberRaw,
            issuedOn: row.baselineIssuedOn,
            volumeM3: row.baselineVolumeM3 == null ? null : Number(row.baselineVolumeM3),
          },
          final:
            row.status === 'arbitrated'
              ? {
                  number: row.finalNumberRaw,
                  issuedOn: row.finalIssuedOn,
                  volumeM3: row.finalVolumeM3 == null ? null : Number(row.finalVolumeM3),
                }
              : null,
          resolvedFields: row.resolvedFields as WasteTicketBlindCheckField[],
          arbiterName: arbiterName ?? null,
          arbitratedAt: row.arbitratedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        }),
      ),
      ticketsVolumeM3: checks.ticketsVolumeM3,
      preliminary: checks.preliminary,
      acceptanceAllowed: checks.acceptanceAllowed,
      badge: checks.badge,
    };
  });

  // ── Разбор ──

  /**
   * Подтверждение талона: именно здесь распознанное становится основанием сверки.
   *
   * Три вещи делаются в одной транзакции и ни одну нельзя вынести. Отказ при спорном поле — потому
   * что подтвердить значение, которого нет, значит согласиться с пустотой (Р14). Снимок оператора
   * берётся **сейчас**, а не при записи распознанного: до подтверждения строка в индекс не входит,
   * а исполнителя выполненной заявки законно меняют (Р17). И проверка конфликта под замком области
   * (Р27) — иначе двое, подтверждающие один номер, получат ошибку базы вместо внятного отказа.
   */
  r.post(
    '/:id/tickets/:ticketId/confirm',
    { ...canReview, schema: { params: ticketParams, body: confirmWasteTicketSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);

      const reason = req.body.duplicateOverrideReason?.trim() ?? '';
      const result = await db.transaction(async (tx) => {
        const ticket = await loadTicket(tx, request.id, req.params.ticketId);
        if (ticket.status === 'dismissed') {
          throw err.badRequest('Талон снят как «не талон» — подтверждать нечего');
        }
        if (ticket.needsReviewFields.length > 0) {
          throw err.badRequest('Сначала разберите спорные поля', {
            needsReviewFields: 'Модели прочитали по-разному',
          });
        }

        await lockNumberArea(tx, request.operatorCounterpartyId, ticket.numberKey);
        const neighbour = await findNumberConflict(tx, {
          ticketId: ticket.id,
          operatorId: request.operatorCounterpartyId,
          numberKey: ticket.numberKey,
        });
        // Причина без конфликта клапана НЕ создаёт: иначе первый же талон можно было бы вывести из
        // индекса «на всякий случай», открыв его номер всем будущим дублям (Р28).
        if (neighbour && !reason) throw numberConflictError(p, neighbour, ticket.numberRaw);
        const overrideUsed = !!neighbour && !!reason;

        const [updated] = await tx
          .update(wasteTickets)
          .set({
            status: 'confirmed',
            confirmedBy: p.id,
            confirmedAt: new Date(),
            // Снимок области уникальности — на момент подтверждения (Р17).
            operatorCounterpartyId: request.operatorCounterpartyId,
            ...(overrideUsed
              ? {
                  duplicateOverrideAt: new Date(),
                  duplicateOverrideBy: p.id,
                  duplicateOverrideReason: reason,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(wasteTickets.id, ticket.id))
          .returning({ id: wasteTickets.id });
        if (!updated) throw err.conflict();

        // Отбор в слепую перепроверку (Р31) — здесь и только здесь: подтверждение и есть момент,
        // когда машинное чтение становится основанием сверки, и мерить качество надо именно его.
        //
        // Только НЕПРАВЛЕНЫЕ МАШИННЫЕ талоны: `baseline_*` — это чтение модели, а ручной или уже
        // исправленный талон сравнивал бы человека с человеком, и метрика при этом называлась бы
        // «ошибки OCR». Отбор случайный и без памяти: доля задана долей, а не квотой, — квота
        // означала бы, что попадание талона в выборку зависит от того, сколько бумаг принесли
        // соседи в тот же день.
        const blind = shouldSampleBlindCheck(ticket, config.ticketOcr.blindCheckRate);
        if (blind) {
          await tx.insert(wasteTicketBlindChecks).values({
            ticketId: ticket.id,
            // Снимок, а не ссылка на талон: талон после подтверждения правят, и сравнение с
            // поехавшей величиной меряло бы не то, ради чего заведено.
            baselineNumberRaw: ticket.numberRaw,
            baselineNumberKey: ticket.numberKey,
            baselineIssuedOn: ticket.issuedOn,
            baselineVolumeM3: ticket.volumeM3,
            baselineFingerprint: blindBaselineFingerprint(ticket),
          });
        }
        return { ticketId: ticket.id, number: ticket.numberRaw, overrideUsed, blind };
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_confirm',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: {
          ticketId: result.ticketId,
          number: result.number,
          duplicateOverride: result.overrideUsed || undefined,
          reason: result.overrideUsed ? reason : undefined,
        },
      });
      return { ok: true, duplicateOverrideApplied: result.overrideUsed };
    },
  );

  /**
   * Правка поля талона. Происхождение НЕ меняется: правленый машинный талон остаётся машинным,
   * иначе метрика «доля правок» перестала бы его видеть ровно тогда, когда он для неё интереснее
   * всего (Р14). Правка снимает поле со спора — человек и есть тот арбитр, которого ждали.
   *
   * Смена номера обнуляет клапан: исправленный номер — уже другой, ни с чем не конфликтующий, и
   * оставить его вне индекса значило бы навсегда открыть его для следующей бумаги (Р27).
   */
  r.patch(
    '/:id/tickets/:ticketId',
    { ...canReview, schema: { params: ticketParams, body: updateWasteTicketSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);

      const body = req.body;
      const reason = body.duplicateOverrideReason?.trim() ?? '';
      const changed = await db.transaction(async (tx) => {
        const ticket = await loadTicket(tx, request.id, req.params.ticketId);
        const nextNumber = body.number === undefined ? ticket.numberRaw : body.number.trim();
        const numberChanged = nextNumber !== ticket.numberRaw;
        const numberKey = nextNumber ? wasteTicketNumberKey(nextNumber) : '';

        // Правка может ПРИВЕСТИ к конфликту — проверяем только когда талон уже подтверждён либо
        // номер поменялся: неподтверждённый талон в индекс не входит и мешать никому не может.
        if (numberChanged && ticket.status === 'confirmed') {
          await lockNumberArea(tx, ticket.operatorCounterpartyId, numberKey);
          const neighbour = await findNumberConflict(tx, {
            ticketId: ticket.id,
            operatorId: ticket.operatorCounterpartyId,
            numberKey,
          });
          if (neighbour && !reason) throw numberConflictError(p, neighbour, nextNumber);
        }

        const fields = ['number', 'issuedOn', 'volumeM3', 'workKind', 'addressRaw'] as const;
        const touched = fields.filter((f) => body[f] !== undefined);
        if (touched.length === 0) throw err.badRequest('Нечего исправлять');

        const [updated] = await tx
          .update(wasteTickets)
          .set({
            ...(body.number !== undefined
              ? {
                  numberRaw: nextNumber,
                  numberKey,
                  numberFuzzy: nextNumber ? wasteTicketNumberFuzzy(nextNumber) : '',
                }
              : {}),
            ...(body.issuedOn !== undefined ? { issuedOn: body.issuedOn } : {}),
            ...(body.volumeM3 !== undefined
              ? { volumeM3: body.volumeM3 == null ? null : String(body.volumeM3) }
              : {}),
            ...(body.workKind !== undefined ? { workKind: body.workKind } : {}),
            ...(body.addressRaw !== undefined ? { addressRaw: body.addressRaw } : {}),
            // Правленые поля уходят со спора: два кандидата больше не нужны, есть решение человека.
            needsReviewFields: ticket.needsReviewFields.filter(
              (f) => !touched.includes(f as (typeof fields)[number]),
            ),
            editedAt: new Date(),
            editedBy: p.id,
            ...(numberChanged
              ? {
                  duplicateOverrideAt: null,
                  duplicateOverrideBy: null,
                  duplicateOverrideReason: '',
                }
              : {}),
            ...(numberChanged && reason
              ? {
                  duplicateOverrideAt: new Date(),
                  duplicateOverrideBy: p.id,
                  duplicateOverrideReason: reason,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(wasteTickets.id, ticket.id))
          .returning({ id: wasteTickets.id });
        if (!updated) throw err.conflict();
        return { ticketId: ticket.id, touched, numberChanged };
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_edit',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: { ticketId: changed.ticketId, fields: changed.touched },
      });
      return { ok: true };
    },
  );

  /** «Не талон»: обложка, дубль страницы, посторонний лист. Строка выбывает из всех проверок. */
  r.post(
    '/:id/tickets/:ticketId/dismiss',
    { ...canReview, schema: { params: ticketParams, body: dismissWasteTicketSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);

      await db.transaction(async (tx) => {
        const ticket = await loadTicket(tx, request.id, req.params.ticketId);
        await tx
          .update(wasteTickets)
          .set({ status: 'dismissed', updatedAt: new Date() })
          .where(eq(wasteTickets.id, ticket.id));
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_dismiss',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: { ticketId: req.params.ticketId },
      });
      return { ok: true };
    },
  );

  /**
   * Талон руками (Р26). Нужен там, где машине читать нечего: на снимке две бумаги, графа залита
   * или страницу вообще не удалось разобрать. Создаётся сразу подтверждённым — его завёл человек,
   * и подтверждать самому себе нечего, — поэтому конфликт номера проверяется тем же запросом.
   */
  r.post(
    '/:id/tickets',
    { ...canReview, schema: { params: requestParams, body: createWasteTicketSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);

      const body = req.body;
      const reason = body.duplicateOverrideReason?.trim() ?? '';
      const numberRaw = body.number.trim();
      const numberKey = wasteTicketNumberKey(numberRaw);

      const created = await db.transaction(async (tx) => {
        if (body.pageId) {
          const page = await tx
            .select({ id: wasteTicketPages.id })
            .from(wasteTicketPages)
            .where(
              and(eq(wasteTicketPages.id, body.pageId), eq(wasteTicketPages.requestId, request.id)),
            )
            .limit(1);
          if (!page[0]) throw err.badRequest('Страница не принадлежит этой заявке');
        }

        await lockNumberArea(tx, request.operatorCounterpartyId, numberKey);
        const neighbour = await findNumberConflict(tx, {
          ticketId: '00000000-0000-0000-0000-000000000000',
          operatorId: request.operatorCounterpartyId,
          numberKey,
        });
        if (neighbour && !reason) throw numberConflictError(p, neighbour, numberRaw);
        const overrideUsed = !!neighbour && !!reason;

        // Позиция среди ручных талонов страницы: машинный на паре «страница + позиция» уникален,
        // ручных на том же кадре бывает столько, сколько бумаг там правда есть (Р2).
        const maxSeq = await tx
          .select({ seq: sql<number>`COALESCE(MAX(${wasteTickets.seq}), 0)` })
          .from(wasteTickets)
          .where(
            body.pageId
              ? and(eq(wasteTickets.requestId, request.id), eq(wasteTickets.pageId, body.pageId))
              : eq(wasteTickets.requestId, request.id),
          );

        const [row] = await tx
          .insert(wasteTickets)
          .values({
            requestId: request.id,
            pageId: body.pageId ?? null,
            seq: Number(maxSeq[0]?.seq ?? 0) + 1,
            operatorCounterpartyId: request.operatorCounterpartyId,
            numberRaw,
            numberKey,
            numberFuzzy: wasteTicketNumberFuzzy(numberRaw),
            issuedOn: body.issuedOn ?? null,
            volumeM3: body.volumeM3 == null ? null : String(body.volumeM3),
            workKind: body.workKind,
            addressRaw: body.addressRaw ?? '',
            origin: 'manual',
            status: 'confirmed',
            confirmedBy: p.id,
            confirmedAt: new Date(),
            ...(overrideUsed
              ? {
                  duplicateOverrideAt: new Date(),
                  duplicateOverrideBy: p.id,
                  duplicateOverrideReason: reason,
                }
              : {}),
          })
          .returning({ id: wasteTickets.id });
        return { id: row!.id, overrideUsed };
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_create',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: { ticketId: created.id, number: numberRaw, manual: true },
      });
      reply.code(201);
      return { id: created.id, duplicateOverrideApplied: created.overrideUsed };
    },
  );

  // ── Замыкание сверки ──

  /**
   * Принять расхождение (Р21). Записывается не «замечание снято», а РЕШЕНИЕ человека вместе с
   * отпечатком всего, из чего расхождение сложилось. Изменится любая величина — принятие перестанет
   * действовать само, и замечание вернётся: иначе «принято» означало бы «замолчать навсегда», в том
   * числе про расхождение, которого в момент принятия не было.
   *
   * Разрешено только когда разобраны все талоны заявки (Р15): отпечаток, снятый с промежуточного
   * состояния, слетел бы на следующем же подтверждении, и человек принимал бы одно и то же дважды.
   */
  r.post(
    '/:id/checks/:checkCode/accept',
    {
      ...canReview,
      schema: {
        // Код замечания перечислением, а не свободной строкой: принять можно только то, что
        // портал считает, и незнакомый код обязан отвечать 400, а не молча заводить строку
        // принятия, которую никогда ни с чем не сравнят.
        params: requestParams.extend({ checkCode: z.enum(WASTE_TICKET_CHECK_CODES) }),
        querystring: z.object({ subjectKey: z.string().max(64).optional() }),
        body: acceptWasteTicketCheckSchema,
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);

      const subjectKey = req.query.subjectKey ?? '';
      const bundle = await collectCheckInputs(p, request.id);
      const state = wasteTicketChecks(bundle.inputs);
      if (!state.acceptanceAllowed) {
        throw err.badRequest('Сначала разберите все талоны заявки', {
          tickets: 'Есть неподтверждённые талоны',
        });
      }
      const target = state.checks.find(
        (c) => c.code === req.params.checkCode && (c.subjectKey ?? '') === subjectKey,
      );
      if (!target) throw err.badRequest('Этого расхождения у заявки нет');

      // Отпечаток снимается с ТОГО ЖЕ входа, по которому только что посчитаны замечания (Р21):
      // собери его вторым запросом — и он начнёт расходиться с показанным человеку.
      const fingerprint = wasteTicketCheckFingerprint({
        request: bundle.inputs.request,
        completion: bundle.inputs.completion,
        tickets: bundle.inputs.tickets,
        checkCode: req.params.checkCode,
        subjectKey,
      });

      await db
        .insert(wasteTicketCheckResolutions)
        .values({
          requestId: request.id,
          checkCode: req.params.checkCode,
          subjectKey,
          inputFingerprint: fingerprint,
          acceptedBy: p.id,
          comment: req.body.comment,
        })
        .onConflictDoUpdate({
          target: [
            wasteTicketCheckResolutions.requestId,
            wasteTicketCheckResolutions.checkCode,
            wasteTicketCheckResolutions.subjectKey,
          ],
          // Повторное принятие переписывает отпечаток: расхождение изменилось, и человек принимает
          // уже другое — старая запись описывала состояние, которого больше нет.
          set: {
            inputFingerprint: fingerprint,
            acceptedBy: p.id,
            comment: req.body.comment,
            acceptedAt: new Date(),
          },
        });

      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_check_accept',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: { checkCode: req.params.checkCode, subjectKey, comment: req.body.comment },
      });
      return { ok: true };
    },
  );

  /**
   * Перераспознать файл (Р13). Ставит задачу с признаком `forced`: при тех же версиях промпта
   * попытка обходит кэш и уходит в прокси со своим ключом идемпотентности — иначе кнопка молча
   * вернула бы прежний результат, ничего не перераспознав.
   */
  r.post(
    '/:id/ticket-files/:fileId/recognize',
    { ...canReview, schema: { params: requestParams.extend({ fileId: z.string().uuid() }) } },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);
      if (request.status !== 'done') {
        throw err.badRequest('Талоны разбираются у выполненной заявки');
      }

      await db.transaction(async (tx) => {
        // Связь проверяется здесь же: право говорит «разбирает талоны», но не «этот файл».
        const linked = await tx.execute(sql`
          SELECT 1 FROM request_files rf
            JOIN files f ON f.id = rf.file_id
           WHERE rf.request_id = ${request.id} AND rf.file_id = ${req.params.fileId}
             AND rf.kind = 'ticket' AND f.deleted_at IS NULL`);
        if (linked.rows.length === 0) throw err.notFound('Талон не найден');
        await enqueueTicketRecognition(tx, request.id, request.requestType, [req.params.fileId], {
          forced: true,
        });
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_recognize',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: { fileId: req.params.fileId, forced: true },
      });
      return { ok: true };
    },
  );

  // ── Слепая перепроверка (Р31) ──

  /**
   * Чтение второго человека. Задание берётся атомарно: `checker_id IS NULL` в условии — это и есть
   * разрешение гонки двух проверяющих в пользу первого, второму реестр отдаст следующий талон.
   *
   * Статус выставляет база сравнением снимков: совпали — `match`, разошлись — `mismatch`, и такая
   * строка уходит в реестр на арбитраж. Сама перепроверка не говорит, кто прав.
   */
  r.post(
    '/:id/tickets/:ticketId/blind-check',
    { ...canReview, schema: { params: ticketParams, body: wasteTicketBlindCheckSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);

      const body = req.body;
      const reviewKey = body.number ? wasteTicketNumberKey(body.number) : '';
      const updated = await db
        .update(wasteTicketBlindChecks)
        .set({
          checkerId: p.id,
          reviewNumberRaw: body.number,
          reviewNumberKey: reviewKey,
          reviewIssuedOn: body.issuedOn,
          reviewVolumeM3: body.volumeM3 == null ? null : String(body.volumeM3),
          status: sql`CASE
              WHEN ${wasteTicketBlindChecks.baselineNumberKey} IS NOT DISTINCT FROM ${reviewKey}
               AND ${wasteTicketBlindChecks.baselineIssuedOn} IS NOT DISTINCT FROM ${body.issuedOn}
               AND ${wasteTicketBlindChecks.baselineVolumeM3} IS NOT DISTINCT FROM ${
                 body.volumeM3 == null ? null : String(body.volumeM3)
               }
              THEN 'match' ELSE 'mismatch' END`,
        })
        .where(
          and(
            eq(wasteTicketBlindChecks.ticketId, req.params.ticketId),
            eq(wasteTicketBlindChecks.status, 'pending'),
            sql`${wasteTicketBlindChecks.checkerId} IS NULL`,
          ),
        )
        .returning({ id: wasteTicketBlindChecks.id, status: wasteTicketBlindChecks.status });

      if (!updated[0]) throw err.conflict('Это задание уже взял другой проверяющий');
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_blind_check',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: { ticketId: req.params.ticketId, status: updated[0].status },
      });
      return { id: updated[0].id, status: updated[0].status };
    },
  );

  /**
   * Арбитраж расхождения (Р31). Вердикта одним словом нет: номер бывает за машиной, дата за
   * человеком, а объём ошибочен у обоих. Арбитр вписывает верные значения по каждому разошедшемуся
   * полю, и полноту разбора проверяет база — частично закрытая строка хуже неразобранной, потому
   * что выглядит законченной.
   */
  r.post(
    '/:id/blind-checks/:blindCheckId/arbitrate',
    {
      ...canReview,
      schema: {
        params: requestParams.extend({ blindCheckId: z.string().uuid() }),
        body: arbitrateWasteTicketBlindCheckSchema,
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);

      const body = req.body;
      const finalNumber = body.number === undefined ? null : body.number;
      const updated = await db
        .update(wasteTicketBlindChecks)
        .set({
          status: 'arbitrated',
          arbiterId: p.id,
          arbitratedAt: new Date(),
          resolvedFields: body.resolvedFields,
          finalNumberRaw: finalNumber,
          finalNumberKey: finalNumber === null ? null : wasteTicketNumberKey(finalNumber),
          finalIssuedOn: body.issuedOn === undefined ? null : body.issuedOn,
          finalVolumeM3:
            body.volumeM3 === undefined || body.volumeM3 === null ? null : String(body.volumeM3),
        })
        .where(
          and(
            eq(wasteTicketBlindChecks.id, req.params.blindCheckId),
            eq(wasteTicketBlindChecks.status, 'mismatch'),
          ),
        )
        .returning({ id: wasteTicketBlindChecks.id });

      // Не нашлось — либо чужая строка, либо чтения совпали: совпавшую разбирать нечего, и это
      // держит `CHECK` в базе, а не только маршрут.
      if (!updated[0])
        throw err.badRequest('Разбирать нечего: расхождения нет или оно уже разобрано');
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_blind_arbitrate',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: { blindCheckId: req.params.blindCheckId, resolvedFields: body.resolvedFields },
      });
      return { ok: true };
    },
  );

  // ── Состояние подсистемы (Р29) ──

  /**
   * Питает баннер «распознавание недоступно». Молчащее распознавание неотличимо от «талоны в
   * порядке» — и это худшее, чем может закончиться сбой прокси, поэтому состояние спрашивается
   * отдельно, а не выводится из отсутствия талонов.
   *
   * Правило поднятия сложнее «доли ошибок за час», и каждая его часть закрывает свой способ
   * соврать:
   *
   * - в знаменателе только попытки, которые **действительно ходили в прокси** (`engine='proxy'`),
   *   а в числителе — из них те, чей отказ относится к подсистеме. Один упёршийся в лимит файл не
   *   означает, что сервис не настроен;
   * - порог 50 % при не менее чем пяти попытках: на двух неудачах подряд баннер не поднимается;
   * - `terminal` + `subsystem` (403, 401, сломанный конфиг) поднимает баннер **сразу**, минуя
   *   порог, и держит его до первой успешной попытки: через час после такой ошибки подсистема
   *   останется ровно так же сломанной, и гасить баннер по времени значит врать;
   * - гистерезис для порогового баннера — три успеха подряд, иначе он мигал бы на каждой удачной
   *   ретрай-попытке;
   * - нулевой трафик сам по себе не «всё хорошо»: если попыток нет, но задачи ждут дольше
   *   пятнадцати минут, значит воркер их не берёт — и это тоже недоступность.
   */
  r.get('/ticket-recognition/health', { ...canReview }, async () => {
    const windowSql = sql`now() - interval '1 hour'`;

    const stats = await db.execute<{
      total: number;
      failed_subsystem: number;
      last_terminal_at: Date | null;
      last_terminal_code: string | null;
      last_success_at: Date | null;
      recent_statuses: string[];
    }>(sql`
      WITH win AS (
        SELECT status, error_class, error_scope, error_code, created_at
          FROM waste_ticket_recognition_attempts
         WHERE engine = 'proxy' AND created_at >= ${windowSql}
      )
      SELECT
        (SELECT count(*) FROM win)::int AS total,
        (SELECT count(*) FROM win WHERE status = 'failed' AND error_scope = 'subsystem')::int
          AS failed_subsystem,
        (SELECT max(created_at) FROM win
          WHERE status = 'failed' AND error_scope = 'subsystem' AND error_class = 'terminal')
          AS last_terminal_at,
        (SELECT error_code FROM win
          WHERE status = 'failed' AND error_scope = 'subsystem' AND error_class = 'terminal'
          ORDER BY created_at DESC LIMIT 1) AS last_terminal_code,
        (SELECT max(created_at) FROM win WHERE status = 'done') AS last_success_at,
        COALESCE((SELECT array_agg(status ORDER BY created_at DESC)
                    FROM (SELECT status, created_at FROM win ORDER BY created_at DESC LIMIT 3) t),
                 ARRAY[]::text[]) AS recent_statuses`);

    const row = stats.rows[0];
    const total = Number(row?.total ?? 0);
    const failed = Number(row?.failed_subsystem ?? 0);
    const lastTerminalAt = row?.last_terminal_at ?? null;
    const lastSuccessAt = row?.last_success_at ?? null;
    const recent = row?.recent_statuses ?? [];

    // Задачи, которые ждут дольше пятнадцати минут: очередь есть, а попыток нет — значит их никто
    // не берёт. Такой случай доля ошибок не покажет никогда, потому что делить не на что.
    const stuck = await db.execute<{ waiting: number; oldest: Date | null }>(sql`
      SELECT count(*)::int AS waiting, min(created_at) AS oldest
        FROM jobs
       WHERE type = 'recognize_waste_ticket_file'
         AND status IN ('pending', 'running')
         AND created_at < now() - interval '15 minutes'`);
    const waiting = Number(stuck.rows[0]?.waiting ?? 0);

    const terminalHeld = !!lastTerminalAt && (!lastSuccessAt || lastSuccessAt < lastTerminalAt);
    if (terminalHeld) {
      return {
        state: 'unconfigured' as const,
        since: lastTerminalAt?.toISOString() ?? null,
        code: row?.last_terminal_code ?? '',
        attempts: total,
        failed,
        waiting,
      };
    }

    const overThreshold = total >= 5 && failed / total >= 0.5;
    const recovered = recent.length >= 3 && recent.every((st) => st === 'done');
    if ((overThreshold && !recovered) || (total === 0 && waiting > 0)) {
      return {
        state: 'degraded' as const,
        since: (stuck.rows[0]?.oldest ?? lastSuccessAt)?.toISOString() ?? null,
        code: '',
        attempts: total,
        failed,
        waiting,
      };
    }

    return {
      state: 'ok' as const,
      since: null,
      code: '',
      attempts: total,
      failed,
      waiting,
    };
  });
}
