import { and, eq, inArray, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  countsUnreviewedTicketPaper,
  type RequestType,
  type WasteTicketAttachedFile,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  files,
  jobs,
  requestFiles,
  users,
  wasteRequestCompletions,
  wasteRequests,
  wasteTicketBlindChecks,
  wasteTicketCheckResolutions,
  wasteTicketFiles,
  wasteTicketPages,
  wasteTicketProposals,
  wasteTickets,
} from '../db/schema';
import { JOB_RECOGNIZE_WASTE_TICKET_FILE } from '../lib/jobs';
import { classifyTicketFile, effectiveTicketArea } from './waste-ticket-checks';
import type {
  TicketFileReview,
  WasteTicketCheckTicket,
  WasteTicketChecksInput,
  WasteTicketNeighbour,
} from './waste-ticket-checks';

/**
 * Кто выполняет запросы: соединение или транзакция. Пересчёт состояния разбора идёт под замком
 * заявки и обязан читать той же транзакцией (ADR 0155, Р22), а список и карточка — обычным
 * соединением.
 */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Вход сверки талонов: чтение базы, отдельное от самой сверки (ADR 0114, Р15–Р21) ──
//
// Сверка (`waste-ticket-checks.ts`) — чистая функция: её проверяют без постгреса, и это её главное
// свойство. Значит кто-то обязан превращать строки таблиц в её вход, и делать это ОДИН раз на
// портал. Мест, где вход нужен, три: карточка заявки, принятие расхождения (отпечаток обязан
// сниматься с того же состояния, которое человек видел) и значок в списке (Р24). Собери каждое
// своим запросом — и они разъедутся: карточка покажет расхождение, список скажет «всё в порядке»,
// а отпечаток снимется с третьего состояния и слетит на ровном месте.
//
// Работает пакетно с самого начала: список зовёт его на страницу заявок целиком, карточка — на
// одну. Пакетность здесь не оптимизация впрок, а условие того, чтобы список вообще мог считать
// значок через сверку, а не через второй, упрощённый и потому лгущий SQL.

export type { TicketFileReview, TicketFileReviewState } from './waste-ticket-checks';

/** Заявка, как её видит сверка. Поля читает вызывающий: у списка они уже есть в строке. */
export interface TicketCheckRequestRow {
  id: string;
  num: number;
  objectId: string;
  objectName: string;
  objectAddress: string;
  requestType: RequestType;
  volumeM3: string | number | null;
  deliveryAt: Date;
  operatorCounterpartyId: string | null;
}

type TicketRow = typeof wasteTickets.$inferSelect;
type PageRow = Pick<
  typeof wasteTicketPages.$inferSelect,
  'id' | 'requestId' | 'fileId' | 'pageNo' | 'pageSha256' | 'status' | 'ticketsFound'
>;
/** Всё, что прочитано про одну заявку: вход сверки плюс сырые строки для ответа маршрута. */
export interface TicketCheckBundle {
  inputs: WasteTicketChecksInput;
  tickets: TicketRow[];
  pages: PageRow[];
  /**
   * Every ticket file the review knows of, classified with the recognition queue read alongside.
   * The card renders its file rows from this, so the card and the badge cannot tell two stories.
   */
  files: TicketFileReview[];
  /**
   * A recognition job of a counted file is pending or running. The badge then depends on queue
   * state that may end without anyone marking the stored review state stale (a skipped job, the
   * gap between the worker's result and its job status), so a writer stores it as stale.
   */
  liveRecognition: boolean;
}

/**
 * Independent reads: together on the pool, one after another on a transaction. A transaction is
 * one connection: queuing several queries on a busy `pg` client is deprecated and goes away in
 * pg 9, and the terminal check and the card read through a transaction (snow-removal plan, §3.2).
 */
export async function readAll<T extends readonly unknown[] | []>(
  exec: DbExecutor,
  reads: { readonly [K in keyof T]: () => PromiseLike<T[K]> },
): Promise<T> {
  const thunks = reads as unknown as readonly (() => PromiseLike<unknown>)[];
  if (exec === db) return (await Promise.all(thunks.map((read) => read()))) as unknown as T;
  const out: unknown[] = [];
  for (const read of thunks) out.push(await read());
  return out as unknown as T;
}

/**
 * A timestamp as sortable microsecond UTC text. JavaScript dates keep milliseconds, and the
 * question "was the file row written after this job was created" is decided by statements that can
 * fall into one millisecond; the text keeps PostgreSQL's precision and compares as a string.
 */
export function timestampKey(column: SQLWrapper): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
}

/** Видимость чужой заявки: сосед называется по номеру только тому, кто вправе его читать (Р28). */
export type RequestVisibility = (
  objectId: string,
  operatorCounterpartyId: string | null,
) => boolean;

const ALWAYS_HIDDEN: RequestVisibility = () => false;

function toCheckTicket(
  row: TicketRow,
  pageSha256: string,
  fileId: string | null,
  hasProposal: boolean,
): WasteTicketCheckTicket {
  return {
    id: row.id,
    numberRaw: row.numberRaw,
    numberKey: row.numberKey,
    numberFuzzy: row.numberFuzzy,
    issuedOn: row.issuedOn,
    volumeM3: row.volumeM3 == null ? null : Number(row.volumeM3),
    workKind: row.workKind,
    addressRaw: row.addressRaw,
    status: row.status,
    operatorCounterpartyId: row.operatorCounterpartyId,
    pageId: row.pageId,
    pageSha256,
    duplicateOverride: row.duplicateOverrideAt !== null,
    fileId,
    disputed: row.needsReviewFields.length > 0,
    hasProposal,
    updatedAt: row.updatedAt,
  };
}

/**
 * Соседи — совпадения в ЧУЖИХ заявках (Р17). Ищутся по трём признакам сразу и одним запросом на
 * всю пачку: страница из тридцати заявок по три талона иначе стоила бы девяноста запросов ради
 * колонки списка.
 *
 * Ищутся только среди подтверждённых талонов без снятого клапана — то есть ровно среди тех, что
 * стоят в частичных индексах уникальности. Неподтверждённый талон номера не занимает, и ругаться
 * на него значило бы предъявлять человеку чужую нераспознанную догадку.
 */
async function loadNeighbours(
  ownRequestIds: string[],
  own: readonly { ticket: TicketRow; pageSha256: string; area: string | null }[],
  visible: RequestVisibility,
  exec: DbExecutor,
): Promise<WasteTicketNeighbour[]> {
  const keys = [...new Set(own.map((o) => o.ticket.numberKey).filter(Boolean))];
  const fuzzies = [...new Set(own.map((o) => o.ticket.numberFuzzy).filter(Boolean))];
  const shas = [...new Set(own.map((o) => o.pageSha256).filter(Boolean))];
  if (keys.length === 0 && fuzzies.length === 0 && shas.length === 0) return [];

  const rows = await exec
    .select({
      numberRaw: wasteTickets.numberRaw,
      numberKey: wasteTickets.numberKey,
      numberFuzzy: wasteTickets.numberFuzzy,
      operatorCounterpartyId: wasteTickets.operatorCounterpartyId,
      pageSha256: wasteTicketPages.pageSha256,
      requestNum: wasteRequests.num,
      requestObjectId: wasteRequests.objectId,
      requestOperatorId: wasteRequests.operatorCounterpartyId,
    })
    .from(wasteTickets)
    .innerJoin(wasteRequests, eq(wasteRequests.id, wasteTickets.requestId))
    .leftJoin(wasteTicketPages, eq(wasteTicketPages.id, wasteTickets.pageId))
    .where(
      and(
        eq(wasteTickets.status, 'confirmed'),
        // Клапан «это разные бумаги» выводит строку из-под индекса уникальности — значит и из
        // соседей: ругаться на неё второй раз значит спрашивать про то, что человек уже решил.
        sql`${wasteTickets.duplicateOverrideAt} IS NULL`,
        notInArray(wasteTickets.requestId, ownRequestIds),
        sql`${wasteRequests.deletedAt} IS NULL`,
        or(
          keys.length ? inArray(wasteTickets.numberKey, keys) : undefined,
          fuzzies.length ? inArray(wasteTickets.numberFuzzy, fuzzies) : undefined,
          shas.length ? inArray(wasteTicketPages.pageSha256, shas) : undefined,
        ),
      ),
    );

  const found: WasteTicketNeighbour[] = [];
  for (const { ticket, pageSha256, area: ownArea } of own) {
    if (ticket.status === 'dismissed') continue;
    const area = ownArea ?? '';
    for (const row of rows) {
      const label = visible(row.requestObjectId, row.requestOperatorId)
        ? `М-${row.requestNum}`
        : null;
      const push = (kind: WasteTicketNeighbour['kind']): void => {
        found.push({ ticketId: ticket.id, kind, requestLabel: label, number: row.numberRaw });
      };
      // Порядок ветвей — от самого сильного совпадения к самому слабому, и ровно один вывод на
      // пару: тот же лист, предъявленный второй раз, не нуждается ещё и в замечании «похожий
      // номер» — это одно расхождение, показанное дважды.
      if (pageSha256 && row.pageSha256 === pageSha256) {
        push('page');
        continue;
      }
      if (!ticket.numberKey) continue;
      const sameArea = (row.operatorCounterpartyId ?? '') === area;
      if (row.numberKey === ticket.numberKey) {
        push(sameArea ? 'number' : 'other_operator');
        continue;
      }
      if (sameArea && ticket.numberFuzzy && row.numberFuzzy === ticket.numberFuzzy) {
        push('similar_number');
      }
    }
  }
  return found;
}

/**
 * Прочитать вход сверки для пачки заявок. Ключ карты — заявка; заявки без единой строки
 * распознавания в карте нет вовсе: «бумаги не приносили» и «бумага в порядке» — разные ответы, и
 * значок в списке обязан их различать.
 */
export async function loadTicketCheckInputs(
  rows: readonly TicketCheckRequestRow[],
  opts: { visible?: RequestVisibility; exec?: DbExecutor } = {},
): Promise<Map<string, TicketCheckBundle>> {
  // Исполнитель приезжает параметром (ADR 0155, Р22): пересчёт под замком заявки обязан читать ТОЙ
  // ЖЕ транзакцией, иначе «состояние под замком» на самом деле прочитано мимо него — и решение
  // принимается по данным, которых в транзакции нет.
  const exec = opts.exec ?? db;
  const result = new Map<string, TicketCheckBundle>();
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return result;

  const [
    ticketRows,
    pageRows,
    fileRows,
    completionRows,
    resolutionRows,
    blindRows,
    paperRows,
    proposalRows,
    jobRows,
  ] = await readAll(exec, [
    () => exec.select().from(wasteTickets).where(inArray(wasteTickets.requestId, ids)),
    () =>
      exec
        .select({
          id: wasteTicketPages.id,
          requestId: wasteTicketPages.requestId,
          fileId: wasteTicketPages.fileId,
          pageNo: wasteTicketPages.pageNo,
          pageSha256: wasteTicketPages.pageSha256,
          status: wasteTicketPages.status,
          ticketsFound: wasteTicketPages.ticketsFound,
        })
        .from(wasteTicketPages)
        .where(inArray(wasteTicketPages.requestId, ids)),
    // Мёртвая задача — тоже нечитаемый файл (Р24): строка стоит `pending`, но двигать её больше
    // некому. Без соединения с очередью такой файл выглядел бы как «ещё считается» — вечно.
    () =>
      exec
        .select({
          requestId: wasteTicketFiles.requestId,
          fileId: wasteTicketFiles.fileId,
          status: wasteTicketFiles.status,
          jobStatus: jobs.status,
          updatedAtKey: timestampKey(wasteTicketFiles.updatedAt),
        })
        .from(wasteTicketFiles)
        .leftJoin(jobs, eq(jobs.id, wasteTicketFiles.activeJobId))
        .where(inArray(wasteTicketFiles.requestId, ids)),
    () =>
      exec
        .select()
        .from(wasteRequestCompletions)
        .where(inArray(wasteRequestCompletions.requestId, ids)),
    () =>
      exec
        .select({
          requestId: wasteTicketCheckResolutions.requestId,
          checkCode: wasteTicketCheckResolutions.checkCode,
          subjectKey: wasteTicketCheckResolutions.subjectKey,
          inputFingerprint: wasteTicketCheckResolutions.inputFingerprint,
          comment: wasteTicketCheckResolutions.comment,
          acceptedAt: wasteTicketCheckResolutions.acceptedAt,
          acceptedByName: users.fullName,
        })
        .from(wasteTicketCheckResolutions)
        .leftJoin(users, eq(users.id, wasteTicketCheckResolutions.acceptedBy))
        .where(inArray(wasteTicketCheckResolutions.requestId, ids)),
    () =>
      exec
        .select({ requestId: wasteTickets.requestId, status: wasteTicketBlindChecks.status })
        .from(wasteTicketBlindChecks)
        .innerJoin(wasteTickets, eq(wasteTickets.id, wasteTicketBlindChecks.ticketId))
        .where(inArray(wasteTickets.requestId, ids)),
    // Приложенная бумага заявки — та, что легла в неё при закрытии (ADR 0020, ADR 0024). Читается
    // здесь, а не выводится из строк распознавания: вопрос «есть ли бумага» и вопрос «дошла ли
    // она до разбора» — разные, и второй отвечает `waste_ticket_files`. Разойдись они (модуль
    // был выключен, задача не дошла до страниц) — заявка с нетронутым сканом выглядела бы
    // разобранной.
    () =>
      exec
        .select({ requestId: requestFiles.requestId, fileId: requestFiles.fileId })
        .from(requestFiles)
        .innerJoin(files, eq(files.id, requestFiles.fileId))
        .where(
          and(
            inArray(requestFiles.requestId, ids),
            eq(requestFiles.kind, 'ticket'),
            eq(files.status, 'active'),
          ),
        ),
    // Живые предложения перераспознавания (ADR 0155, Р16): талон с непринятым вторым чтением
    // одним действием не подтверждают — человек ещё не решил, какое из двух чтений верное.
    // Отдельным запросом, а не соединением с талонами: строка предложения есть у меньшинства, и
    // тащить её левым соединением в основную выборку значило бы платить за неё всегда.
    () =>
      exec
        .select({ ticketId: wasteTicketProposals.ticketId })
        .from(wasteTicketProposals)
        .innerJoin(wasteTickets, eq(wasteTickets.id, wasteTicketProposals.ticketId))
        .where(inArray(wasteTickets.requestId, ids)),
    // Recognition jobs that are live or died (see `classifyTicketFile`). Done jobs are not read: a
    // finished job either wrote its outcome into the file row or skipped and left the earlier one
    // intact. The status list keeps the scan on the `jobs_due_idx` prefix — the queue table grows
    // with every mail and storage delete, and only these states stay few.
    () =>
      exec
        .select({
          id: jobs.id,
          requestId: sql<string>`${jobs.payload}->>'requestId'`,
          // Lowercase on read: the ids it is compared with come from `uuid` columns, and a payload
          // written with an uppercase id (a route accepts one) would otherwise never match.
          fileId: sql<string>`lower(${jobs.payload}->>'fileId')`,
          status: jobs.status,
          attempts: jobs.attempts,
          maxAttempts: jobs.maxAttempts,
          nextRunAt: jobs.nextRunAt,
          createdAtKey: timestampKey(jobs.createdAt),
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, JOB_RECOGNIZE_WASTE_TICKET_FILE),
            inArray(jobs.status, ['pending', 'running', 'failed', 'dead']),
            inArray(sql`${jobs.payload}->>'requestId'`, ids),
          ),
        ),
  ]);

  const pageById = new Map(pageRows.map((p) => [p.id, p]));
  const shaOf = (t: TicketRow): string =>
    t.pageId ? (pageById.get(t.pageId)?.pageSha256 ?? '') : '';
  // Файл талона известен только через страницу: ручной талон бумаге не принадлежит вовсе, и это
  // не пробел данных, а свойство ручного ввода (ADR 0155, Р18).
  const fileOf = (t: TicketRow): string | null =>
    t.pageId ? (pageById.get(t.pageId)?.fileId ?? null) : null;
  const withProposal = new Set(proposalRows.map((r) => r.ticketId));

  // Область у неподтверждённого талона берётся у ЗАЯВКИ (ADR 0155, Р15) — той же функцией, что и в
  // сверке: сосед по «похожему номеру» ищется в области, а посчитай мы её здесь иначе, список и
  // карточка разошлись бы ровно на тех талонах, ради которых заведена кнопка.
  const operatorOf = new Map(rows.map((r) => [r.id, r.operatorCounterpartyId]));
  const neighbours = await loadNeighbours(
    ids,
    ticketRows.map((ticket) => ({
      ticket,
      pageSha256: shaOf(ticket),
      area: effectiveTicketArea(ticket, operatorOf.get(ticket.requestId) ?? null),
    })),
    opts.visible ?? ALWAYS_HIDDEN,
    exec,
  );

  for (const row of rows) {
    const tickets = ticketRows.filter((t) => t.requestId === row.id);
    const recognitionFiles = fileRows.filter((f) => f.requestId === row.id);
    const pagesOfRequest = pageRows.filter((p) => p.requestId === row.id);
    /*
     * "Attached, but review never started" counts only for the types the contract names
     * (`countsUnreviewedTicketPaper`: garbage and snow). Since ADR 0150 this is no longer a
     * consequence of which types get recognition — every type does. The reason is the past.
     *
     * The number blocks completion (`wasteTicketReviewSettled`). Count it for scrap or container
     * operations and every long-closed request of those types that ever carried a ticket file would
     * stop completing at deploy time: it has no review and never will, because jobs are enqueued at
     * closing, and it was closed months ago. Exactly that happened with deploy `0195` and needed
     * migration `0204` to return those requests (ADR 0135). New paper of other types reaches review
     * on its own — through recognition at closing — and an unconfirmed ticket blocks completion by
     * `pendingConfirmation`, the same way as for garbage.
     *
     * Lifting the boundary means migrating the past requests (clear their paper at once or select
     * them by closing date), not deleting this condition. Snow is inside the boundary from its first
     * request: it has no past to protect (snow-removal plan, S4).
     */
    const countsPaper = countsUnreviewedTicketPaper(row.requestType);
    const attached = new Set(paperRows.filter((f) => f.requestId === row.id).map((f) => f.fileId));
    const jobsOfRequest = jobRows.filter((j) => j.requestId === row.id);
    // Files the review knows of: attached scans and recognition rows (a row cannot outlive its
    // link — composite key with cascade). A live job of an unlinked file is ignored: the reset to
    // «Новая» unlinks tickets and leaves queued jobs to become no-ops (ADR 0114, decision 4).
    const universe = [...new Set([...attached, ...recognitionFiles.map((f) => f.fileId)])];
    const files: TicketFileReview[] = universe.map((fileId) => {
      const recognition = recognitionFiles.find((f) => f.fileId === fileId);
      return {
        fileId,
        ...classifyTicketFile({
          row: recognition
            ? {
                status: recognition.status,
                jobStatus: recognition.jobStatus,
                updatedAtKey: recognition.updatedAtKey,
              }
            : null,
          jobs: jobsOfRequest.filter((j) => j.fileId === fileId),
          pageFailed: pagesOfRequest.some((p) => p.fileId === fileId && p.status === 'failed'),
        }),
      };
    });
    /*
     * Which files count, per type. Inside the unreviewed-paper boundary every attached file does.
     * Outside it (scrap, container operations) an attached file counts only once recognition is
     * involved — a row, a live or interrupted attempt, a dead one — so an old receipt never queued
     * stays out of review (ADR 0150) while new paper in flight still holds completion.
     */
    const counted = files.filter(
      (f) =>
        recognitionFiles.some((r) => r.fileId === f.fileId) ||
        (attached.has(f.fileId) && (countsPaper || f.state !== 'unread')),
    );
    const needsReading = (f: TicketFileReview): boolean =>
      f.state === 'live' || f.state === 'interrupted';
    const attachedTicketFiles: WasteTicketAttachedFile[] = counted
      .filter((f) => attached.has(f.fileId) && (countsPaper || needsReading(f)))
      .map((f) => ({
        fileId: f.fileId,
        // "Broken" is what 🚫 counts, a failed page included: otherwise a single unreadable sheet
        // would show twice, as 🚫 and as 📄 (ADR 0155, R18).
        broken: f.state === 'failed',
        readOk: f.state === 'read',
        pending: needsReading(f),
      }));
    /*
     * A request without paper gets no badge (`badge = null`, which does not block completion).
     * An attached ticket counts as paper just like a recognition row: it is what awaits review.
     */
    if (tickets.length === 0 && counted.length === 0) {
      continue;
    }

    const pages = pagesOfRequest;
    const blind = blindRows.filter((b) => b.requestId === row.id);
    const completion = completionRows.find((c) => c.requestId === row.id) ?? null;
    const ticketIds = new Set(tickets.map((t) => t.id));

    result.set(row.id, {
      tickets,
      pages,
      files,
      liveRecognition: counted.some((f) => f.state === 'live'),
      inputs: {
        request: {
          requestedVolumeM3: row.volumeM3 == null ? null : Number(row.volumeM3),
          deliveryAt: row.deliveryAt,
          objectAddress: row.objectAddress,
          objectName: row.objectName,
          operatorCounterpartyId: row.operatorCounterpartyId,
        },
        completion: completion
          ? {
              volumeM3: completion.volumeM3 == null ? null : Number(completion.volumeM3),
              removedOn: completion.removedOn ?? null,
              removedOnSource: completion.removedOnSource,
            }
          : null,
        tickets: tickets.map((t) => toCheckTicket(t, shaOf(t), fileOf(t), withProposal.has(t.id))),
        neighbours: neighbours.filter((n) => ticketIds.has(n.ticketId)),
        resolutions: resolutionRows
          .filter((r) => r.requestId === row.id)
          .map((r) => ({
            checkCode: r.checkCode,
            subjectKey: r.subjectKey,
            inputFingerprint: r.inputFingerprint,
            acceptedByName: r.acceptedByName ?? '',
            acceptedAt: r.acceptedAt.toISOString(),
            comment: r.comment,
          })),
        subsystem: {
          attachedTicketFiles,
          // Once per file: a partially failed scan is one unreadable file, not one per page.
          failedFiles: counted.filter((f) => f.failedBy === 'file').length,
          failedPages: counted.filter((f) => f.failedBy === 'page').length,
          blindPending: blind.filter((b) => b.status === 'pending').length,
          blindMismatch: blind.filter((b) => b.status === 'mismatch').length,
        },
      },
    });
  }
  return result;
}

/** Заявка объекта: имя и адрес площадки нужны сверке адреса (Р20) — без них она сравнивает с пустым. */
export async function loadTicketCheckRequestRow(
  requestId: string,
  exec: DbExecutor = db,
): Promise<TicketCheckRequestRow | null> {
  const rows = await exec
    .select({
      id: wasteRequests.id,
      num: wasteRequests.num,
      objectId: wasteRequests.objectId,
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      requestType: wasteRequests.requestType,
      volumeM3: wasteRequests.volumeM3,
      deliveryAt: wasteRequests.deliveryAt,
      operatorCounterpartyId: wasteRequests.operatorCounterpartyId,
    })
    .from(wasteRequests)
    .innerJoin(constructionObjects, eq(constructionObjects.id, wasteRequests.objectId))
    .where(and(eq(wasteRequests.id, requestId), sql`${wasteRequests.deletedAt} IS NULL`))
    .limit(1);
  return rows[0] ?? null;
}
