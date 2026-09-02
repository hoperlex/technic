import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { RequestType, WasteTicketAttachedFile } from '@technic/contracts';
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
import { effectiveTicketArea } from './waste-ticket-checks';
import type {
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
  ] = await Promise.all([
    exec.select().from(wasteTickets).where(inArray(wasteTickets.requestId, ids)),
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
    exec
      .select({
        requestId: wasteTicketFiles.requestId,
        fileId: wasteTicketFiles.fileId,
        status: wasteTicketFiles.status,
        jobStatus: jobs.status,
      })
      .from(wasteTicketFiles)
      .leftJoin(jobs, eq(jobs.id, wasteTicketFiles.activeJobId))
      .where(inArray(wasteTicketFiles.requestId, ids)),
    exec
      .select()
      .from(wasteRequestCompletions)
      .where(inArray(wasteRequestCompletions.requestId, ids)),
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
    exec
      .select({ ticketId: wasteTicketProposals.ticketId })
      .from(wasteTicketProposals)
      .innerJoin(wasteTickets, eq(wasteTickets.id, wasteTicketProposals.ticketId))
      .where(inArray(wasteTickets.requestId, ids)),
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
    /*
     * «Приложено, а разбор не начинался» считается по-прежнему только вывозу мусора — и с ADR 0150
     * это уже НЕ следствие того, какому типу ставится распознавание: читаются теперь талоны всех
     * типов. Причина другая и целиком про прошлое.
     *
     * Это число закрывает завершение заявки (`wasteTicketReviewSettled`). Сними его здесь для
     * прочих типов — и каждая давно закрытая заявка металлолома или контейнерной операции, к
     * которой когда-либо прикладывали талон, в момент выката перестала бы завершаться: разбора у
     * неё нет и не будет, потому что задачи ставятся при закрытии, а её закрыли месяцы назад.
     * Ровно так уже случилось с выкатом `0195`, и возвращать эти заявки пришлось миграцией `0204`
     * (ADR 0135). Новая бумага прочих типов в разбор попадает своим ходом — через распознавание
     * при закрытии, — и неподтверждённый талон закрывает завершение уже по `pendingConfirmation`,
     * то есть ровно так же, как у вывоза.
     *
     * Отменить границу — значит не удалить это условие, а провести прошлые заявки: снять их
     * бумагу разом либо отобрать по дате закрытия. Это отдельная работа с миграцией, а не строка
     * в сверке.
     */
    const pagesOfRequest = pageRows.filter((p) => p.requestId === row.id);
    const attachedTicketFiles: WasteTicketAttachedFile[] =
      row.requestType === 'waste_removal'
        ? paperRows
            .filter((f) => f.requestId === row.id)
            .map((f) => {
              const recognition = recognitionFiles.find((r) => r.fileId === f.fileId);
              // «Сломан» — то же самое, что попало в 🚫, и провалившаяся страница входит сюда
              // наравне с отказом по файлу: иначе единственный нечитаемый лист показывался бы
              // дважды — и как 🚫, и как 📄 (ADR 0155, Р18).
              const broken =
                recognition?.status === 'unsupported' ||
                recognition?.status === 'failed' ||
                recognition?.jobStatus === 'dead' ||
                pagesOfRequest.some((p) => p.fileId === f.fileId && p.status === 'failed');
              return { fileId: f.fileId, broken, readOk: recognition?.status === 'done' };
            })
        : [];
    /*
     * Заявка без бумаги вовсе значка не получает (`badge = null`, и завершению это не помеха).
     * Приложенный талон бумагой считается наравне со строкой распознавания: именно он и есть то,
     * что предстоит разобрать.
     */
    if (tickets.length === 0 && recognitionFiles.length === 0 && attachedTicketFiles.length === 0) {
      continue;
    }

    const pages = pagesOfRequest;
    const blind = blindRows.filter((b) => b.requestId === row.id);
    const completion = completionRows.find((c) => c.requestId === row.id) ?? null;
    const ticketIds = new Set(tickets.map((t) => t.id));

    result.set(row.id, {
      tickets,
      pages,
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
          failedFiles: recognitionFiles.filter(
            (f) => f.status === 'unsupported' || f.status === 'failed' || f.jobStatus === 'dead',
          ).length,
          failedPages: pages.filter((p) => p.status === 'failed').length,
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
