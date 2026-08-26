import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  acceptWasteTicketCheckSchema,
  acceptWasteTicketProposalSchema,
  arbitrateWasteTicketBlindCheckSchema,
  confirmWasteTicketSchema,
  createWasteTicketSchema,
  dismissWasteTicketProposalSchema,
  dismissWasteTicketSchema,
  type RequestStatus,
  updateWasteTicketSchema,
  WASTE_TICKET_CHECK_CODES,
  wasteTicketBlindCheckSchema,
  wasteTicketNumberFuzzy,
  wasteTicketFieldLabels,
  wasteTicketNumberKey,
  type WasteTicketAttemptDto,
  type WasteTicketBlindCheckDto,
  type WasteTicketBlindCheckTaskDto,
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
  constructionObjects,
  counterparties,
  files,
  requestFiles,
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
import {
  assertOperatorScope,
  assertWasteObjectScope,
  operatorVisibilityWhere,
  wasteRequestVisibilityWhere,
} from '../lib/access';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  blindBaselineFingerprint,
  shouldSampleBlindCheck,
} from '../services/waste-ticket-blind';
import { wasteTicketCheckFingerprint, wasteTicketChecks } from '../services/waste-ticket-checks';
import {
  recordTicketFieldEvents,
  ticketFieldValue,
  TICKET_FIELDS,
  type TicketFieldChange,
} from '../services/waste-ticket-events';
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

  /**
   * Разбор бумаги открыт, пока заявка «Выполнена» (ADR 0135). Завершение и есть объявление разбора
   * законченным: правь талон после него — и сверка задним числом нарисовала бы расхождение в
   * заявке, про которую уже сказано «принято». Понадобилась правка — администратор возвращает
   * заявку в «Выполнена» тем же откатом, что и всюду, и разбор открывается снова.
   *
   * Читающие ручки этой проверки не знают: посмотреть талоны завершённой заявки можно всегда.
   */
  function assertReviewOpen(request: { status: RequestStatus }): void {
    if (request.status === 'done') return;
    throw err.badRequest(
      request.status === 'completed'
        ? 'Заявка завершена — талоны в ней больше не правят. Нужна правка — верните заявку в «Выполнена»'
        : 'Талоны разбирают у выполненной заявки',
    );
  }

  /** Талон этой заявки. Проверка принадлежности здесь, а не в запросе выше: 404 честнее 403. */
  /**
   * Талон ЭТОЙ заявки. Принимает и транзакцию, и само соединение: проверка принадлежности нужна и
   * там, где писать нечего, — а требовать ради неё транзакцию значило бы открывать её впустую.
   */
  async function loadTicket(tx: Tx | typeof db, requestId: string, ticketId: string) {
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
    const [bundle, attachedRows, fileRows, attempts] = await Promise.all([
      collectCheckInputs(p, request.id),
      // Приложенные талоны — ВСЕ, а не только те, у кого есть строка распознавания. Талон,
      // приложенный при выключенном модуле, строки не имеет вовсе, и без этого запроса экран
      // показывал бы пустоту там, где бумага лежит и ждёт человека (Р29).
      db
        .select({
          fileId: requestFiles.fileId,
          filename: files.filename,
          contentType: files.contentType,
          // Связь `request_files` своей даты не имеет — берём дату файла: она и есть «когда талон
          // приложили», потому что файл загружают тем же действием.
          createdAt: files.createdAt,
        })
        .from(requestFiles)
        .innerJoin(files, eq(files.id, requestFiles.fileId))
        .where(
          and(
            eq(requestFiles.requestId, request.id),
            eq(requestFiles.kind, 'ticket'),
            sql`${files.deletedAt} IS NULL`,
          ),
        ),
      // Файловая строка отвечает на вопрос, которого у талонов нет: почему их нет вовсе (Р29).
      // Имя файла и живая задача — оттуда же: «попытка 3 из 5, следующая в 14:32» собирается из
      // очереди, и собирать её вторым запросом с экрана значило бы показывать вчерашнее число.
      db
        .select({
          fileId: wasteTicketFiles.fileId,
          filename: files.filename,
          contentType: files.contentType,
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
      // Порядок: сперва то, что в разборе, затем приложенное и не поступившее. Второе — не
      // «пустая строка», а состояние, требующее человека: талон лежит, машина его не видела.
      files: [
        ...fileRows.map(
        (f): WasteTicketFileDto => ({
          fileId: f.fileId,
          filename: f.filename ?? '',
          contentType: f.contentType ?? '',
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
        ...attachedRows
          .filter((a) => !fileRows.some((f) => f.fileId === a.fileId))
          .map(
            (a): WasteTicketFileDto => ({
              fileId: a.fileId,
              filename: a.filename,
              contentType: a.contentType,
              status: 'not_queued',
              reason:
                'Талон приложен, но в разбор не поступал: распознавание было выключено. ' +
                'Прочитайте его сами кнопкой «Добавить талон вручную» или включите распознавание ' +
                'и нажмите «Перераспознать».',
              errorClass: null,
              errorScope: null,
              totalPages: 0,
              processedPages: 0,
              activeJob: null,
              pages: [],
              createdAt: a.createdAt.toISOString(),
              updatedAt: a.createdAt.toISOString(),
            }),
          ),
      ],
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
      assertReviewOpen(request);

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
      assertReviewOpen(request);

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

        // Журнал разбора (Р30): «было → стало» по каждому тронутому полю. Прежние значения берутся
        // из строки, прочитанной до обновления, — после него их уже не восстановить, и самый
        // сильный сигнал качества модели пропал бы вместе с ними.
        await recordTicketFieldEvents(tx, {
          ticketId: ticket.id,
          requestId: request.id,
          event: 'edited',
          actorId: p.id,
          changes: touched.map((field) => ({
            field,
            oldValue: ticketFieldValue(ticket, field),
            newValue:
              field === 'number'
                ? nextNumber
                : field === 'issuedOn'
                  ? (body.issuedOn ?? null)
                  : field === 'volumeM3'
                    ? (body.volumeM3 == null ? null : String(body.volumeM3))
                    : field === 'workKind'
                      ? (body.workKind ?? ticket.workKind)
                      : (body.addressRaw ?? ''),
          })),
        });
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
      assertReviewOpen(request);

      await db.transaction(async (tx) => {
        const ticket = await loadTicket(tx, request.id, req.params.ticketId);
        await tx
          .update(wasteTickets)
          .set({ status: 'dismissed', updatedAt: new Date() })
          .where(eq(wasteTickets.id, ticket.id));
        // «Не талон» — сильный сигнал: модель увидела бумагу там, где её нет, либо приняла за
        // талон приписку или шапку бланка. В журнале это событие без нового значения: поля не
        // менялись, изменилась их судьба.
        await recordTicketFieldEvents(tx, {
          ticketId: ticket.id,
          requestId: request.id,
          event: 'dismissed',
          actorId: p.id,
          changes: TICKET_FIELDS.map((field) => ({
            field,
            oldValue: ticketFieldValue(ticket, field),
            newValue: null,
          })),
        });
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
   * Принять предложение перераспознавания (Р13): значения переезжают в талон, пишется `edited_at`,
   * строка предложения уходит.
   *
   * Значений в теле НЕТ: они лежат снимком в самом предложении. Присылай их клиент — принять можно
   * было бы что угодно под видом «так прочитала машина», и метрика качества считала бы ручной ввод
   * машинным чтением.
   *
   * Номер идёт тем же путём, что и обычная правка (Р27): замок области, сброс клапана и повторная
   * проверка конфликта. Предложение — не обход уникальности: бумага, чей номер уже занят, остаётся
   * конфликтующей, кто бы её ни прочитал.
   */
  r.post(
    '/:id/tickets/:ticketId/proposal/accept',
    { ...canReview, schema: { params: ticketParams, body: acceptWasteTicketProposalSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);
      assertReviewOpen(request);

      const reason = req.body.duplicateOverrideReason?.trim() ?? '';
      const result = await db.transaction(async (tx) => {
        const ticket = await loadTicket(tx, request.id, req.params.ticketId);
        const [proposal] = await tx
          .select()
          .from(wasteTicketProposals)
          .where(eq(wasteTicketProposals.ticketId, ticket.id))
          .limit(1);
        if (!proposal) throw err.badRequest('Предложения нет: принимать нечего');

        const numberKey = proposal.numberRaw ? wasteTicketNumberKey(proposal.numberRaw) : '';
        const numberChanged = numberKey !== ticket.numberKey;
        let overrideUsed = false;
        if (numberChanged && ticket.status === 'confirmed') {
          await lockNumberArea(tx, ticket.operatorCounterpartyId, numberKey);
          const neighbour = await findNumberConflict(tx, {
            ticketId: ticket.id,
            operatorId: ticket.operatorCounterpartyId,
            numberKey,
          });
          if (neighbour && !reason) throw numberConflictError(p, neighbour, proposal.numberRaw);
          overrideUsed = !!neighbour && !!reason;
        }

        await tx
          .update(wasteTickets)
          .set({
            numberRaw: proposal.numberRaw,
            numberKey,
            numberFuzzy: proposal.numberRaw ? wasteTicketNumberFuzzy(proposal.numberRaw) : '',
            issuedOn: proposal.issuedOn,
            volumeM3: proposal.volumeM3,
            workKind: proposal.workKind,
            addressRaw: proposal.addressRaw,
            // Спорных полей после принятия не остаётся: человек согласился с чтением целиком.
            needsReviewFields: [],
            candidates: [],
            // Принятие — правка (Р13): талон помечается тронутым, и следующий проход уже не
            // перепишет его молча. `origin` при этом не меняется — он про происхождение строки,
            // а не про то, кто последним её касался.
            editedAt: new Date(),
            editedBy: p.id,
            ...(numberChanged
              ? { duplicateOverrideAt: null, duplicateOverrideBy: null, duplicateOverrideReason: '' }
              : {}),
            ...(overrideUsed
              ? {
                  duplicateOverrideAt: new Date(),
                  duplicateOverrideBy: p.id,
                  duplicateOverrideReason: reason,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(wasteTickets.id, ticket.id));
        // Принятие предложения — тоже правка, но чужой рукой: значения предложил новый проход, а
        // согласился человек. Событие отдельного вида, чтобы не смешивать с ручным исправлением.
        await recordTicketFieldEvents(tx, {
          ticketId: ticket.id,
          requestId: request.id,
          event: 'proposal',
          actorId: p.id,
          changes: ([
            { field: 'number', oldValue: ticketFieldValue(ticket, 'number'), newValue: proposal.numberRaw || null },
            { field: 'issuedOn', oldValue: ticket.issuedOn, newValue: proposal.issuedOn },
            { field: 'volumeM3', oldValue: ticket.volumeM3, newValue: proposal.volumeM3 },
            { field: 'workKind', oldValue: ticket.workKind, newValue: proposal.workKind },
            { field: 'addressRaw', oldValue: ticket.addressRaw || null, newValue: proposal.addressRaw || null },
          ] satisfies TicketFieldChange[]).filter((c) => c.oldValue !== c.newValue),
        });
        await tx.delete(wasteTicketProposals).where(eq(wasteTicketProposals.ticketId, ticket.id));
        return { number: proposal.numberRaw, overrideUsed };
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_proposal_accept',
        entityType: 'waste_request',
        entityId: request.id,
        metadata: {
          ticketId: req.params.ticketId,
          number: result.number,
          duplicateOverride: result.overrideUsed || undefined,
        },
      });
      return { ok: true, duplicateOverrideApplied: result.overrideUsed };
    },
  );

  /**
   * Отклонить предложение (Р13). Талон не трогается вовсе: человек уже сказал, что написано на
   * бумаге, и новый проход этого не отменяет. Уходит только строка предложения — иначе она висела
   * бы вечно и держала бы попытки, на которые ссылается.
   */
  r.post(
    '/:id/tickets/:ticketId/proposal/dismiss',
    { ...canReview, schema: { params: ticketParams, body: dismissWasteTicketProposalSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const request = await loadRequest(req.params.id);
      assertWasteObjectScope(p, request.objectId);
      assertOperatorScope(p, request.operatorCounterpartyId);
      assertReviewOpen(request);

      const removed = await db.transaction(async (tx) => {
        const ticket = await loadTicket(tx, request.id, req.params.ticketId);
        return tx
          .delete(wasteTicketProposals)
          .where(eq(wasteTicketProposals.ticketId, ticket.id))
          .returning({ ticketId: wasteTicketProposals.ticketId });
      });
      if (!removed[0]) throw err.badRequest('Предложения нет: отклонять нечего');

      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.ticket_proposal_dismiss',
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
      assertReviewOpen(request);

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
      assertReviewOpen(request);

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
      // Выключенный модуль задачу не заведёт (`enqueueTicketRecognition` выходит сразу), и без
      // этой проверки кнопка отвечала бы «отправлено на распознавание», не отправив ничего.
      // Обещание, которого никто не исполнит, хуже отказа: человек ждёт результата и не заводит
      // талон руками.
      if (!config.ticketOcr.enabled) {
        throw err.badRequest(
          'Распознавание талонов выключено: включите модуль либо заведите талон вручную',
        );
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
   * Очередь заданий проверяющему (Р31). Отдельной ручкой, а не куском карточки: перепроверка —
   * своя работа, и человек приходит за ней, а не за заявкой.
   *
   * **Значений здесь нет ни одного.** Ни распознанного, ни подтверждённого, ни снимка сравнения:
   * спрячь мы их на клиенте, слепота держалась бы вёрсткой — цифры приехали бы в браузер, и вся
   * метрика зависела бы от того, открыл человек инструменты разработчика или нет. Приходит только
   * то, без чего задание не выполнить: какой файл открыть, какая страница, какой по счёту талон на
   * ней, и чья это заявка.
   *
   * Свои подтверждения из очереди убраны: человек, согласившийся с цифрами, во второй раз читал бы
   * не бумагу, а собственную память (Р31). Отказ он получил бы и при отправке, но показывать
   * задание, которое нельзя выполнить, — значит тратить его время дважды.
   *
   * Область та же, что у всего модуля: свои объекты и свой перевозчик (ADR 0039, ADR 0010).
   */
  r.get(
    '/ticket-blind-checks',
    {
      ...canReview,
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const rows = await db
        .select({
          id: wasteTicketBlindChecks.id,
          ticketId: wasteTicketBlindChecks.ticketId,
          requestId: wasteTickets.requestId,
          pageId: wasteTickets.pageId,
          seq: wasteTickets.seq,
          fileId: wasteTicketPages.fileId,
          pageNo: wasteTicketPages.pageNo,
          ticketsOnPage: wasteTicketPages.ticketsFound,
          filename: files.filename,
          requestNum: wasteRequests.num,
          objectName: constructionObjects.name,
          createdAt: wasteTicketBlindChecks.createdAt,
        })
        .from(wasteTicketBlindChecks)
        .innerJoin(wasteTickets, eq(wasteTickets.id, wasteTicketBlindChecks.ticketId))
        .innerJoin(wasteRequests, eq(wasteRequests.id, wasteTickets.requestId))
        .innerJoin(constructionObjects, eq(constructionObjects.id, wasteRequests.objectId))
        .leftJoin(wasteTicketPages, eq(wasteTicketPages.id, wasteTickets.pageId))
        .leftJoin(files, eq(files.id, wasteTicketPages.fileId))
        .where(
          and(
            eq(wasteTicketBlindChecks.status, 'pending'),
            sql`${wasteTicketBlindChecks.checkerId} IS NULL`,
            sql`${wasteRequests.deletedAt} IS NULL`,
            // Талон, снятый как «не талон» или переехавший в правки, из очереди уходит: читать
            // второй раз нечего, а строка перепроверки живёт до уборки заявки.
            ne(wasteTickets.status, 'dismissed'),
            sql`${wasteTickets.confirmedBy} IS DISTINCT FROM ${p.id}`,
            wasteRequestVisibilityWhere(p, wasteRequests.objectId),
            operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId),
          ),
        )
        // Первым — то, что ждёт дольше всех: очередь без порядка означала бы, что часть заданий не
        // берут никогда, а срок жизни задания и есть срок жизни метрики.
        .orderBy(asc(wasteTicketBlindChecks.createdAt))
        .limit(req.query.limit);

      return {
        items: rows.map(
          (row): WasteTicketBlindCheckTaskDto => ({
            id: row.id,
            ticketId: row.ticketId,
            requestId: row.requestId,
            pageId: row.pageId,
            fileId: row.fileId,
            filename: row.filename ?? '',
            pageNo: row.pageNo,
            requestNum: row.requestNum,
            objectName: row.objectName,
            ticketsOnPage: row.ticketsOnPage ?? 0,
            seq: row.seq,
            createdAt: row.createdAt.toISOString(),
          }),
        ),
      };
    },
  );

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

      // Талон обязан принадлежать ЭТОЙ заявке: право `ticketReview` говорит, что человек разбирает
      // талоны, но не говорит, чьи (Р26). Без проверки чужую бумагу можно было бы прочитать,
      // прикрывшись своей заявкой.
      const ticket = await loadTicket(db, request.id, req.params.ticketId);
      // Проверяющий не может быть тем, кто талон подтвердил (Р31). Он уже видел эти цифры и
      // согласился с ними — его «второе чтение» мерило бы память, а не рукопись. `CHECK` в базе
      // этого не удержит: подтвердивший записан в другой таблице, подзапрос в `CHECK` невозможен.
      if (ticket.confirmedBy === p.id) {
        throw err.forbidden('Этот талон подтвердили вы — перепроверить его должен другой человек');
      }

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

      // Строка перепроверки обязана принадлежать этой заявке, а разбирающий — не быть ни
      // проверяющим (это же держит `CHECK`), ни тем, кто талон подтвердил. Оба запрета про одно:
      // арбитраж — третий взгляд, и совпади он с одним из двух первых, метрика уверенных ошибок
      // считала бы человека, оценивающего собственную работу.
      const [target] = await db
        .select({
          id: wasteTicketBlindChecks.id,
          status: wasteTicketBlindChecks.status,
          checkerId: wasteTicketBlindChecks.checkerId,
          requestId: wasteTickets.requestId,
          confirmedBy: wasteTickets.confirmedBy,
          ticketId: wasteTicketBlindChecks.ticketId,
          baselineNumberRaw: wasteTicketBlindChecks.baselineNumberRaw,
          baselineNumberKey: wasteTicketBlindChecks.baselineNumberKey,
          baselineIssuedOn: wasteTicketBlindChecks.baselineIssuedOn,
          baselineVolumeM3: wasteTicketBlindChecks.baselineVolumeM3,
          reviewNumberKey: wasteTicketBlindChecks.reviewNumberKey,
          reviewIssuedOn: wasteTicketBlindChecks.reviewIssuedOn,
          reviewVolumeM3: wasteTicketBlindChecks.reviewVolumeM3,
        })
        .from(wasteTicketBlindChecks)
        .innerJoin(wasteTickets, eq(wasteTickets.id, wasteTicketBlindChecks.ticketId))
        .where(eq(wasteTicketBlindChecks.id, req.params.blindCheckId))
        .limit(1);
      // 404, а не 403: чужая строка не должна отвечать «она есть, но не ваша» — по такому ответу
      // чужие заявки перебираются идентификаторами (Р28).
      if (!target || target.requestId !== request.id) throw err.notFound('Перепроверка не найдена');
      if (target.checkerId === p.id) {
        throw err.forbidden('Читали эту бумагу вы — разобрать расхождение должен третий человек');
      }
      if (target.confirmedBy === p.id) {
        throw err.forbidden('Этот талон подтвердили вы — разобрать расхождение должен другой');
      }

      const body = req.body;
      // Разобрано должно быть КАЖДОЕ разошедшееся поле. Это же держит `CHECK` в базе, но ответ
      // «нарушение ограничения» человеку ничего не говорит: он узнал бы, что запрос не прошёл, но
      // не что именно осталось неразобранным. Частично закрытая строка хуже неразобранной ровно
      // тем, что выглядит законченной (Р31).
      const diverged: WasteTicketBlindCheckField[] = [
        ...(target.baselineNumberKey !== target.reviewNumberKey ? (['number'] as const) : []),
        ...((target.baselineIssuedOn ?? null) !== (target.reviewIssuedOn ?? null)
          ? (['issuedOn'] as const)
          : []),
        // Объём — `numeric`: сравнивается числом, иначе «20» и «20.000» разошлись бы строками.
        ...(Number(target.baselineVolumeM3 ?? NaN) !== Number(target.reviewVolumeM3 ?? NaN) &&
        !(target.baselineVolumeM3 == null && target.reviewVolumeM3 == null)
          ? (['volumeM3'] as const)
          : []),
      ];
      const unresolved = diverged.filter((field) => !body.resolvedFields.includes(field));
      if (unresolved.length > 0) {
        throw err.badRequest('Разберите все разошедшиеся поля', {
          resolvedFields: `Не разобрано: ${unresolved.map((f) => wasteTicketFieldLabels[f]).join(', ')}`,
        });
      }

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

      // Арбитраж — САМЫЙ СИЛЬНЫЙ сигнал качества (Р31): человек читал бумагу, не видя машинного
      // чтения, а третий назвал верное значение. В журнале «было» — это снимок машины
      // (`baseline_*`), а не текущее состояние талона: талон после подтверждения правят, и
      // сравнение с поехавшей величиной меряло бы не то.
      await db.transaction(async (tx) => {
        await recordTicketFieldEvents(tx, {
          ticketId: target.ticketId,
          requestId: request.id,
          event: 'arbitrated',
          actorId: p.id,
          changes: body.resolvedFields.map((field) => ({
            field,
            oldValue:
              field === 'number'
                ? target.baselineNumberRaw || null
                : field === 'issuedOn'
                  ? target.baselineIssuedOn
                  : target.baselineVolumeM3,
            newValue:
              field === 'number'
                ? (finalNumber ?? null)
                : field === 'issuedOn'
                  ? (body.issuedOn ?? null)
                  : body.volumeM3 == null
                    ? null
                    : String(body.volumeM3),
          })),
        });
      });

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
    // Выключенный модуль — отдельное состояние, а не «работает». Задач он не заводит и попыток не
    // делает, поэтому доля отказов у него идеальная: ноль из нуля. Скажи мы «ok» — портал написал
    // бы «расхождений нет» над бумагой, которую никто не читал (Р29). Проверка стоит до запросов:
    // считать окно попыток, которых по построению нет, незачем.
    if (!config.ticketOcr.enabled) {
      return {
        state: 'disabled' as const,
        since: null,
        code: '',
        attempts: 0,
        failed: 0,
        waiting: 0,
      };
    }

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
