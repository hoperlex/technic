import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  attachWaybillFilesSchema,
  cancelWaybillSchema,
  canCancelWaybill,
  canPrintWaybill,
  type FileDto,
  printWaybillsBatchSchema,
  WAYBILL_CANCELLED_PRINT_MESSAGE,
  formatVehicleRequestNumber,
  moscowDateKeyOf,
  requestCustomerName,
  snapshotForPrint,
  waybillDisplayNumber,
  type WaybillDto,
  waybillListQuerySchema,
  WAYBILL_LOCKED_MESSAGE,
  type WaybillRequestLinkDto,
} from '@technic/contracts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/client';
import {
  auditLog,
  constructionObjects,
  departments,
  files,
  organizations,
  persons,
  users,
  vehicleModels,
  vehicleRequests,
  vehicles,
  waybillFiles,
  waybillRequests,
  waybills,
  waybillSeries,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams } from '../lib/pagination';
import { renderPdf, renderPdfBatch } from '../services/office-pdf';
import { renderOfficeTemplate } from '../services/office-template';
import { mergePdfs } from '../services/pdf-merge';
import {
  assertFilesAttachable,
  assertTotalWithinLimit,
  markFilesActive,
  scheduleFilesDeletion,
} from '../services/request-files';

/**
 * Журнал учёта путевых листов (ADR 0037).
 *
 * Лист — бланк строгой отчётности: журнал отвечает, какие номера выданы, на какие машины и что с
 * ними стало. Аннулированные из него не исчезают — пропуск в нумерации означал бы утраченный
 * бланк, а не отменённый рейс.
 *
 * Выдачи здесь нет: лист выписывается с маршрута (`vehicle-routes`, ADR 0050), и отдельной ручки
 * «выписать» не существует — иначе появился бы лист, не связанный ни с одним рейсом.
 */

const idParams = z.object({ id: z.string().uuid() });

/**
 * Выгружается xlsx: бланки пришли от бухгалтерии в этом формате, и ods-двойника у них нет.
 * Движок подстановки формат не различает — появится исходник в ods, добавится и он.
 */
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_TYPE = 'application/pdf';

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

/**
 * Бланк читается с диска при каждой выгрузке, а не кэшируется между запросами: файл меняют редко,
 * зато правку подхватывает следующий же запрос, без перезапуска сервиса.
 *
 * Внутри одного запроса чтение всё же переиспользуется (`cache`): пачка из полусотни листов идёт
 * по двум-трём бланкам, и полсотни синхронных чтений подряд встали бы поперёк цикла событий ради
 * тех же самых байтов.
 */
function readTemplate(formCode: string, cache?: Map<string, Uint8Array>): Uint8Array {
  const cached = cache?.get(formCode);
  if (cached) return cached;
  try {
    const bytes = new Uint8Array(readFileSync(join(templatesDir, `waybill-${formCode}.xlsx`)));
    cache?.set(formCode, bytes);
    return bytes;
  } catch {
    throw err.conflict(
      `Бланк ${formCode} не размечен: положите оригинал в templates/source и прогоните template:waybill`,
    );
  }
}

/** Кто выписал и кто аннулировал — два join'а на одну таблицу учёток. */
const issuers = users;

/**
 * Сегодня по МСК: граница правки листа — календарные сутки, и UTC сдвинул бы её. Тем же
 * `moscowDateKeyOf` границу считает портал — двух расчётов одной даты быть не должно.
 */
function today(): string {
  return moscowDateKeyOf(new Date());
}

/** Сам номер с ведущими нулями — то, что напечатано в бланке после серии: «00000004897». */
const paddedNumberSql = sql<string>`lpad(${waybills.number}::text, ${waybillSeries.numberWidth}, '0')`;

/**
 * Номер бланка так, как его читает человек: «260604-646-00000004897». Собирается в SQL из серии и
 * числа — искать по нему нужно там же, где отбирают строки, а не после выборки.
 */
const displayNumberSql = sql<string>`${waybillSeries.prefix} || ${paddedNumberSql}`;

/**
 * Наибольшее число, которое `Number` держит без потери точности. Колонка номера — bigint, и
 * шестнадцатизначный ввод, пройдя через `Number`, сравнивался бы с округлённым значением, то есть
 * находил бы соседний бланк или не находил ничего.
 */
const SAFE_NUMBER_DIGITS = 15;

/**
 * Поиск по номеру листа. Называют его тремя способами: целиком («260604-646-00000004897»), хвостом
 * («4897» — так и говорят вслух) и без ведущих нулей.
 *
 * Разделение по виду ввода не украшательство. Одни цифры — это номер, и подстрока ищется **только
 * в самом номере**: захвати она серию, запрос «646» вернул бы весь журнал — префикс серии
 * «260604-646-» содержит эти цифры у каждой строки. Есть посторонние знаки (дефис, буквы) — значит
 * набрали напечатанный номер целиком, и тогда подстрока идёт по склейке с серией.
 *
 * Точное равенство числа стоит рядом с подстрокой: «4897» обязано находить «00000004897», где
 * подстрока с началом не совпала бы.
 *
 * Отбор по номеру нужен не только полю поиска: журнал открывают ссылкой `?number=…` из маршрута и
 * из карточки заявки — до сих пор такая ссылка приводила в неотфильтрованный журнал.
 */
function numberSearchCondition(term: string | undefined): SQL | undefined {
  const trimmed = term?.trim();
  if (!trimmed) return undefined;
  const digits = trimmed.replace(/\D/gu, '');
  const exact =
    digits && digits.length <= SAFE_NUMBER_DIGITS ? eq(waybills.number, Number(digits)) : undefined;
  const like = digits === trimmed ? paddedNumberSql : displayNumberSql;
  return or(sql`${like} ILIKE ${`%${trimmed}%`}`, exact);
}

const waybillSelect = {
  id: waybills.id,
  number: waybills.number,
  prefix: waybillSeries.prefix,
  numberWidth: waybillSeries.numberWidth,
  formCode: waybills.formCode,
  status: waybills.status,
  issuedForDate: waybills.issuedForDate,
  periodFrom: waybills.periodFrom,
  periodTo: waybills.periodTo,
  organizationName: organizations.name,
  vehicleId: waybills.vehicleId,
  registrationNumber: vehicles.registrationNumber,
  modelName: vehicleModels.name,
  driverPersonId: waybills.driverPersonId,
  driverName: persons.fullName,
  withTrailer: waybills.withTrailer,
  trailer1Model: waybills.trailer1Model,
  trailer1RegNumber: waybills.trailer1RegNumber,
  issuedByName: issuers.fullName,
  issuedAt: waybills.issuedAt,
  cancelledAt: waybills.cancelledAt,
  cancelReason: waybills.cancelReason,
  cancelledBy: waybills.cancelledBy,
};

type WaybillRow = Awaited<ReturnType<typeof loadRows>>[number];

/**
 * Чем журнал сортируется. Ключи — те же, что объявлены в `WAYBILL_SORT_FIELDS` и стоят ключами
 * колонок таблицы: до этого порядок был жёстко зашит, и заголовки столбцов сортировали в никуда.
 */
const sortColumns = {
  issuedForDate: waybills.issuedForDate,
  number: waybills.number,
  issuedAt: waybills.issuedAt,
};

async function loadRows(
  where: ReturnType<typeof and>,
  limit?: number,
  offset?: number,
  sort?: { sortBy?: string; sortOrder: 'asc' | 'desc' },
) {
  const q = db
    .select(waybillSelect)
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .innerJoin(organizations, eq(organizations.id, waybills.organizationId))
    .innerJoin(vehicles, eq(vehicles.id, waybills.vehicleId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .innerJoin(persons, eq(persons.id, waybills.driverPersonId))
    .innerJoin(issuers, eq(issuers.id, waybills.issuedBy))
    .where(where)
    // Вторым ключом номер: листов одного дня десятки, и без него страницы разъезжались бы между
    // запросами. Когда сортируют по самому номеру, второго ключа нет — он повторял бы первый и
    // спорил бы с выбранным направлением.
    .orderBy(
      ...(sort?.sortBy === 'number'
        ? [orderByFrom(sortColumns, sort.sortBy, sort.sortOrder, 'issuedForDate')]
        : [
            orderByFrom(sortColumns, sort?.sortBy, sort?.sortOrder ?? 'desc', 'issuedForDate'),
            desc(waybills.number),
          ]),
    );
  if (limit === undefined) return q;
  return q.limit(limit).offset(offset ?? 0);
}

/** Талоны заказчиков: заявки, которые машина выполняет по этому листу. */
async function linksByWaybill(ids: string[]): Promise<Map<string, WaybillRequestLinkDto[]>> {
  const map = new Map<string, WaybillRequestLinkDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      waybillId: waybillRequests.waybillId,
      requestId: waybillRequests.requestId,
      slot: waybillRequests.slot,
      num: vehicleRequests.num,
      // Состояние заявки на сейчас: им портал выбирает, в каком списке её показать по нажатию на
      // номер талона — в рабочем или в журнале закрытых.
      status: vehicleRequests.status,
      // Талон заказчика: объект или отдел (ADR 0040) — innerJoin по объекту терял бы заявки
      // отдела вместе с их листами.
      objectName: constructionObjects.name,
      departmentName: departments.name,
    })
    .from(waybillRequests)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, waybillRequests.requestId))
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .where(inArray(waybillRequests.waybillId, ids))
    .orderBy(asc(waybillRequests.slot));

  for (const row of rows) {
    const list = map.get(row.waybillId) ?? [];
    list.push({
      requestId: row.requestId,
      displayNumber: formatVehicleRequestNumber(row.num),
      slot: row.slot,
      objectName: requestCustomerName(row),
      status: row.status,
    });
    map.set(row.waybillId, list);
  }
  return map;
}

/** Кто аннулировал — добором: второй join на учётки ради колонки, которая почти всегда пуста. */
async function cancelledByNames(rows: WaybillRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.cancelledBy).filter((v): v is string => !!v))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.fullName]));
}

/** Когда лист печатали и когда выгружали в последний раз; пусто — ни разу. */
interface PrintMarks {
  printedAt: string | null;
  exportedAt: string | null;
}

const NO_MARKS: PrintMarks = { printedAt: null, exportedAt: null };

/**
 * Отметки о печати и выгрузке — из журнала аудита, где эти события пишутся с самого появления
 * печати (ADR 0041). Своих колонок у листа под это нет и не заводится: две записи об одном факте
 * разошлись бы при первой же правке одной из них, а журнал аудита — то место, где факт уже лежит.
 *
 * Отметка означает «эта бумага уже уезжала», поэтому автор события не спрашивается: чужая печать
 * ничем не отличается от своей, а массовая — от одиночной (пачка пишет запись на каждый лист).
 *
 * Одним запросом на страницу журнала, как талоны и вложения: индекс `audit_log_entity_idx` держит
 * пару «тип + id», и полсотни отдельных походов в базу здесь ни к чему.
 */
async function printMarksByWaybill(ids: string[]): Promise<Map<string, PrintMarks>> {
  const map = new Map<string, PrintMarks>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      entityId: auditLog.entityId,
      action: auditLog.action,
      at: sql<Date>`max(${auditLog.createdAt})`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'waybill'),
        inArray(auditLog.action, ['waybill.print', 'waybill.export']),
        inArray(auditLog.entityId, ids),
      ),
    )
    .groupBy(auditLog.entityId, auditLog.action);

  for (const row of rows) {
    if (!row.entityId) continue;
    const marks = map.get(row.entityId) ?? { ...NO_MARKS };
    const at = new Date(row.at).toISOString();
    if (row.action === 'waybill.print') marks.printedAt = at;
    else marks.exportedAt = at;
    map.set(row.entityId, marks);
  }
  return map;
}

function toDto(
  row: WaybillRow,
  links: WaybillRequestLinkDto[],
  cancelledByName: string | null,
  files: FileDto[],
  marks: PrintMarks = NO_MARKS,
): WaybillDto {
  const trailer = [row.trailer1Model, row.trailer1RegNumber].filter(Boolean).join(' ');
  return {
    id: row.id,
    number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
    formCode: row.formCode,
    status: row.status,
    issuedForDate: row.issuedForDate,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    organizationName: row.organizationName,
    vehicleId: row.vehicleId,
    vehicleLabel: [row.modelName, row.registrationNumber].filter(Boolean).join(' · '),
    driverPersonId: row.driverPersonId,
    driverName: row.driverName,
    withTrailer: row.withTrailer,
    trailerLabel: trailer,
    issuedByName: row.issuedByName,
    issuedAt: row.issuedAt.toISOString(),
    cancelledByName,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    printedAt: marks.printedAt,
    exportedAt: marks.exportedAt,
    requests: links,
    files,
  };
}

/**
 * Вложения листов пачкой на страницу журнала — тем же приёмом, что и талоны заказчиков: запрос на
 * строку превратил бы открытие журнала в полсотни походов в базу.
 */
async function filesByWaybill(ids: string[]): Promise<Map<string, FileDto[]>> {
  const map = new Map<string, FileDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      waybillId: waybillFiles.waybillId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
    })
    .from(waybillFiles)
    .innerJoin(files, eq(files.id, waybillFiles.fileId))
    .where(and(inArray(waybillFiles.waybillId, ids), isNull(files.deletedAt)))
    .orderBy(asc(waybillFiles.addedAt));

  for (const row of rows) {
    const list = map.get(row.waybillId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.waybillId, list);
  }
  return map;
}

export default async function waybillsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('waybills.read');
  const canCancel = app.requirePermission('waybills.cancel');

  r.get(
    '/',
    { preHandler: [app.authenticate, canRead], schema: { querystring: waybillListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.dateFrom ? gte(waybills.issuedForDate, q.dateFrom) : undefined,
        q.dateTo ? lte(waybills.issuedForDate, q.dateTo) : undefined,
        q.vehicleId ? eq(waybills.vehicleId, q.vehicleId) : undefined,
        q.driverPersonId ? eq(waybills.driverPersonId, q.driverPersonId) : undefined,
        q.status ? eq(waybills.status, q.status) : undefined,
        // Бланк: журнал у трёх форм один, а читают их разные люди по разным поводам — без этого
        // сужения недельные листы спецтехники тонут в ежедневных рейсовых.
        q.formCode ? eq(waybills.formCode, q.formCode) : undefined,
        numberSearchCondition(q.search),
      );
      const pg = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        loadRows(where, pg.limit, pg.offset, { sortBy: q.sortBy, sortOrder: q.sortOrder }),
        // Счётчик идёт теми же join'ами, что и выборка: поиск по номеру читает серию, а без неё
        // условие сослалось бы на таблицу, которой в запросе нет.
        db
          .select({ c: count() })
          .from(waybills)
          .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
          .where(where),
      ]);
      const ids = rows.map((row) => row.id);
      const [links, cancelled, attachments, marks] = await Promise.all([
        linksByWaybill(ids),
        cancelledByNames(rows),
        filesByWaybill(ids),
        printMarksByWaybill(ids),
      ]);
      return {
        items: rows.map((row) =>
          toDto(
            row,
            links.get(row.id) ?? [],
            cancelled.get(row.cancelledBy ?? '') ?? null,
            attachments.get(row.id) ?? [],
            marks.get(row.id),
          ),
        ),
        total: Number(totalRows[0]!.c),
        page: pg.page,
        pageSize: pg.pageSize,
      };
    },
  );

  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const [row] = await loadRows(and(eq(waybills.id, req.params.id)));
      if (!row) throw err.notFound('Путевой лист не найден');
      const [links, cancelled, attachments, marks] = await Promise.all([
        linksByWaybill([row.id]),
        cancelledByNames([row]),
        filesByWaybill([row.id]),
        printMarksByWaybill([row.id]),
      ]);
      return toDto(
        row,
        links.get(row.id) ?? [],
        cancelled.get(row.cancelledBy ?? '') ?? null,
        attachments.get(row.id) ?? [],
        marks.get(row.id),
      );
    },
  );

  /**
   * Заполненный бланк листа (ADR 0037 п. 10). Собирается из снимка значений, а не из
   * справочников: переименование объекта или уточнение госномера задним числом уже выданный лист
   * не меняет.
   *
   * Аннулированный лист бумагой больше не отдаётся никому: напечатанный, он неотличим от
   * действующего и, попав к водителю, ездит документом, которого нет (`canPrintWaybill`). Чем
   * кончился номер, отвечает строка журнала, а пришедший скан подшивают вложением.
   */
  async function renderWaybill(id: string, templates?: Map<string, Uint8Array>) {
    const [row] = await db
      .select({
        id: waybills.id,
        formCode: waybills.formCode,
        status: waybills.status,
        number: waybills.number,
        prefix: waybillSeries.prefix,
        numberWidth: waybillSeries.numberWidth,
        data: waybills.data,
      })
      .from(waybills)
      .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
      .where(eq(waybills.id, id));
    if (!row) throw err.notFound('Путевой лист не найден');
    if (!canPrintWaybill(row.status)) throw err.conflict(WAYBILL_CANCELLED_PRINT_MESSAGE);

    const rendered = renderOfficeTemplate(
      readTemplate(row.formCode, templates),
      snapshotForPrint(row.data as Record<string, string>),
    );
    return {
      rendered,
      id: row.id,
      displayNumber: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
    };
  }

  /** Выгрузка бланка файлом: его правят в редакторе таблиц и печатают оттуда. */
  r.get(
    '/:id/export',
    {
      preHandler: [app.authenticate, canRead],
      schema: { params: idParams },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { rendered, id, displayNumber } = await renderWaybill(req.params.id);

      // Выгрузка уносит персональные данные водителя из портала — это учётное событие.
      await writeAudit({
        actorUserId: p.id,
        action: 'waybill.export',
        entityType: 'waybill',
        entityId: id,
        metadata: { missing: rendered.missing },
      });

      const name = `Путевой лист ${displayNumber}.xlsx`;
      return reply
        .type(XLSX_TYPE)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(Buffer.from(rendered.bytes));
    },
  );

  /**
   * Тот же бланк, но готовым к печати (ADR 0041): PDF отдаётся инлайном, браузер показывает его
   * сам и печатает своим диалогом. Лист при этом не оседает файлом на машине диспетчера — а его
   * незачем там держать: документ живёт в журнале, а на руки нужен бумажный.
   *
   * Печать — учётное событие наравне с выгрузкой: из портала уходят СНИЛС и номер удостоверения,
   * и по журналу должно быть видно, кто и когда их печатал.
   */
  r.get(
    '/:id/print',
    {
      preHandler: [app.authenticate, canRead],
      schema: { params: idParams },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { rendered, id, displayNumber } = await renderWaybill(req.params.id);
      const pdf = await renderPdf(rendered.bytes);

      await writeAudit({
        actorUserId: p.id,
        action: 'waybill.print',
        entityType: 'waybill',
        entityId: id,
        metadata: { missing: rendered.missing },
      });

      const name = `Путевой лист ${displayNumber}.pdf`;
      return reply
        .type(PDF_TYPE)
        .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(Buffer.from(pdf));
    },
  );

  /**
   * Пачка листов одним документом.
   *
   * Диспетчер печатает день машины или день всей колонны разом, и до сих пор это означало
   * «открыть лист, напечатать, закрыть» столько раз, сколько листов, — с отдельным диалогом
   * печати на каждый. Здесь бланки собираются в один PDF, и диалог остаётся один.
   *
   * `POST`, а не `GET` со списком в адресе: полсотни идентификаторов в строке запроса упираются в
   * её длину, а печать пачки — действие, а не адресуемая страница.
   *
   * Порядок задаёт портал (тот же, что в журнале), и сервер его не пересобирает: пачку разбирают
   * по столу в том виде, в каком её видели на экране. Аннулированные отсеиваются с называнием
   * номеров — молча пропустить лист значило бы отдать пачку, в которой не хватает бумаги, о чём
   * узнают уже у принтера.
   *
   * Каждый лист получает свою запись в журнале аудита — такую же, как при одиночной печати: отметка
   * «печатали» не должна зависеть от того, каким способом бумага ушла.
   */
  r.post(
    '/print-batch',
    {
      preHandler: [app.authenticate, canRead],
      schema: { body: printWaybillsBatchSchema },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      // Повторы убираются, а порядок первого появления сохраняется: дважды выбранный лист дал бы
      // лишнюю страницу в пачке, вторую запись в аудит и съел бы место в пределе.
      const ids = [...new Set(req.body.ids)];

      const rows = await db
        .select({
          id: waybills.id,
          status: waybills.status,
          number: waybills.number,
          prefix: waybillSeries.prefix,
          numberWidth: waybillSeries.numberWidth,
        })
        .from(waybills)
        .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
        .where(inArray(waybills.id, ids));

      const byId = new Map(rows.map((row) => [row.id, row]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) throw err.notFound('Часть листов не найдена — обновите журнал');
      const cancelled = rows.filter((row) => !canPrintWaybill(row.status));
      if (cancelled.length > 0) {
        // Номера перечисляются в том же порядке, в каком листы стоят в пачке: выборка их порядка
        // не гарантирует, а человек сверяет перечень со своим выбором на экране.
        const numbers = ids
          .map((id) => cancelled.find((row) => row.id === id))
          .filter((row) => row !== undefined)
          .map((row) => waybillDisplayNumber(row.prefix, row.number, row.numberWidth))
          .join(', ');
        throw err.conflict(`${WAYBILL_CANCELLED_PRINT_MESSAGE}. Уберите из выбора: ${numbers}`);
      }

      // Бланки собираются по одному (снимок у каждого свой), а в PDF переводятся разом: запуск
      // конвертера дороже самой конвертации. Сам файл бланка на всю пачку читается по разу на
      // форму — их в пачке две-три, а листов до полусотни.
      const templates = new Map<string, Uint8Array>();
      const rendered = [];
      for (const id of ids) rendered.push(await renderWaybill(id, templates));
      const pdfs = await renderPdfBatch(rendered.map((item) => item.rendered.bytes));
      const pdf = await mergePdfs(pdfs);

      await Promise.all(
        rendered.map((item) =>
          writeAudit({
            actorUserId: p.id,
            action: 'waybill.print',
            entityType: 'waybill',
            entityId: item.id,
            metadata: { missing: item.rendered.missing, batch: ids.length },
          }),
        ),
      );

      const name =
        rendered.length === 1
          ? `Путевой лист ${rendered[0]!.displayNumber}.pdf`
          : `Путевые листы (${rendered.length}).pdf`;
      return reply
        .type(PDF_TYPE)
        .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(Buffer.from(pdf));
    },
  );

  /**
   * Аннулирование испорченного бланка (ADR 0037 п. 9 в редакции ADR 0052). По последний день
   * листа включительно: лист на рейс выписывают утром того же дня, и запрет в этот день оставлял
   * бы испорченный бланк несписанным, а рейс — навсегда замороженным. У ЭСМ-2 последний день —
   * конец недели работ: она ещё идёт, бланк ещё у машиниста. Со следующего дня нельзя: работа
   * состоялась, и лист стал историей.
   *
   * Номер при этом сгорает — для бланка строгой отчётности это норма, а дыра в журнале честнее
   * переиспользованного номера.
   */
  r.post(
    '/:id/cancel',
    {
      preHandler: [app.authenticate, canCancel],
      schema: { params: idParams, body: cancelWaybillSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const [row] = await loadRows(and(eq(waybills.id, req.params.id)));
      if (!row) throw err.notFound('Путевой лист не найден');
      if (row.status === 'cancelled') throw err.conflict('Лист уже аннулирован');
      if (!canCancelWaybill(row, today())) throw err.conflict(WAYBILL_LOCKED_MESSAGE);

      await db
        .update(waybills)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: p.id,
          cancelReason: req.body.reason,
          updatedAt: new Date(),
        })
        .where(and(eq(waybills.id, row.id), ne(waybills.status, 'cancelled')));

      await writeAudit({
        actorUserId: p.id,
        action: 'waybill.cancel',
        entityType: 'waybill',
        entityId: row.id,
        metadata: { number: row.number, reason: req.body.reason },
      });

      const [updated] = await loadRows(and(eq(waybills.id, row.id)));
      const [links, cancelled, attachments] = await Promise.all([
        linksByWaybill([row.id]),
        cancelledByNames([updated!]),
        filesByWaybill([row.id]),
      ]);
      return toDto(
        updated!,
        links.get(row.id) ?? [],
        cancelled.get(p.id) ?? null,
        attachments.get(row.id) ?? [],
      );
    },
  );

  // ── Вложения к бланку (миграция 0087) ──
  /**
   * Лист уходит на объект бумагой и возвращается заполненным: у ЭСМ-2 заказчик пишет на обороте
   * часы, простои и стоимость машино-часа и ставит штамп, у 4-П — отметки о выполнении. Портал
   * этих значений не разбирает и разбирать не собирается: журнал учёта отвечает, чем кончился
   * выданный номер, — и скан подшивается к номеру.
   *
   * Право своё (`waybills.files`): смотреть журнал может и тот, кто документы к нему не подшивает.
   */
  async function waybillOr404(id: string): Promise<{ id: string; number: number }> {
    const [row] = await db
      .select({ id: waybills.id, number: waybills.number })
      .from(waybills)
      .where(eq(waybills.id, id));
    if (!row) throw err.notFound('Путевой лист не найден');
    return row;
  }

  r.post(
    '/:id/files',
    {
      preHandler: [app.authenticate, app.requirePermission('waybills.files')],
      schema: { params: idParams, body: attachWaybillFilesSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const waybill = await waybillOr404(req.params.id);
      const { addFileIds } = req.body;

      await db.transaction(async (tx) => {
        // Аннулированный лист вложения принимает наравне с выданным: испорченный бланк подшивают
        // к журналу вместе с тем, что к нему пришло, а скан приходит после аннулирования чаще,
        // чем до.
        const existing = await tx
          .select({ fileId: waybillFiles.fileId })
          .from(waybillFiles)
          .where(eq(waybillFiles.waybillId, waybill.id));
        assertTotalWithinLimit(existing.length, addFileIds.length);
        await assertFilesAttachable(tx, addFileIds, p.id);
        await tx
          .insert(waybillFiles)
          .values(addFileIds.map((fileId) => ({ waybillId: waybill.id, fileId })));
        await markFilesActive(tx, addFileIds);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'waybill.files_attach',
        entityType: 'waybill',
        entityId: waybill.id,
        metadata: { number: waybill.number, fileIds: addFileIds },
      });

      const attachments = await filesByWaybill([waybill.id]);
      return attachments.get(waybill.id) ?? [];
    },
  );

  r.delete(
    '/:id/files/:fileId',
    {
      preHandler: [app.authenticate, app.requirePermission('waybills.files')],
      schema: { params: idParams.extend({ fileId: z.string().uuid() }) },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const waybill = await waybillOr404(req.params.id);
      const { fileId } = req.params;

      await db.transaction(async (tx) => {
        const [linked] = await tx
          .select({ id: files.id, objectKey: files.objectKey })
          .from(waybillFiles)
          .innerJoin(files, eq(files.id, waybillFiles.fileId))
          .where(and(eq(waybillFiles.waybillId, waybill.id), eq(waybillFiles.fileId, fileId)));
        if (!linked) throw err.notFound('Файл не прикреплён к этому листу');
        await tx
          .delete(waybillFiles)
          .where(and(eq(waybillFiles.waybillId, waybill.id), eq(waybillFiles.fileId, fileId)));
        // Из хранилища объект уходит отложенно — той же задачей и с той же отсрочкой, что у
        // вложений заявок: ошибочно откреплённый файл успевают вернуть.
        await scheduleFilesDeletion(tx, [linked], false);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'waybill.files_detach',
        entityType: 'waybill',
        entityId: waybill.id,
        metadata: { number: waybill.number, fileIds: [fileId] },
      });

      const attachments = await filesByWaybill([waybill.id]);
      return attachments.get(waybill.id) ?? [];
    },
  );
}
