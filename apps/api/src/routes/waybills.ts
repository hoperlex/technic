import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, desc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  cancelWaybillSchema,
  formatVehicleRequestNumber,
  requestCustomerName,
  isWaybillEditable,
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
  constructionObjects,
  departments,
  organizations,
  persons,
  users,
  vehicleModels,
  vehicleRequests,
  vehicles,
  waybillRequests,
  waybills,
  waybillSeries,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { pageParams } from '../lib/pagination';
import { renderPdf } from '../services/office-pdf';
import { renderOfficeTemplate } from '../services/office-template';

/**
 * Журнал учёта путевых листов (ADR 0037).
 *
 * Лист — бланк строгой отчётности: журнал отвечает, какие номера выданы, на какие машины и что с
 * ними стало. Аннулированные из него не исчезают — пропуск в нумерации означал бы утраченный
 * бланк, а не отменённый рейс.
 *
 * Выдачи здесь нет: лист рождается переводом заявки в работу (`vehicle-requests`), и отдельной
 * ручки «выписать» не существует — иначе появился бы лист, не связанный ни с одним рейсом.
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
 * Бланк читается с диска при каждой выгрузке, а не кэшируется: файл меняют редко, зато правку
 * подхватывает следующий же запрос, без перезапуска сервиса.
 */
function readTemplate(formCode: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(join(templatesDir, `waybill-${formCode}.xlsx`)));
  } catch {
    throw err.conflict(
      `Бланк ${formCode} не размечен: положите оригинал в templates/source и прогоните template:waybill`,
    );
  }
}

/** Кто выписал и кто аннулировал — два join'а на одну таблицу учёток. */
const issuers = users;

function today(): string {
  // По московскому времени: граница правки листа — календарные сутки, и UTC сдвинул бы её.
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const waybillSelect = {
  id: waybills.id,
  number: waybills.number,
  prefix: waybillSeries.prefix,
  numberWidth: waybillSeries.numberWidth,
  formCode: waybills.formCode,
  status: waybills.status,
  issuedForDate: waybills.issuedForDate,
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

async function loadRows(where: ReturnType<typeof and>, limit?: number, offset?: number) {
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
    .orderBy(desc(waybills.issuedForDate), desc(waybills.number));
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

function toDto(
  row: WaybillRow,
  links: WaybillRequestLinkDto[],
  cancelledByName: string | null,
): WaybillDto {
  const trailer = [row.trailer1Model, row.trailer1RegNumber].filter(Boolean).join(' ');
  return {
    id: row.id,
    number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
    formCode: row.formCode,
    status: row.status,
    issuedForDate: row.issuedForDate,
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
    requests: links,
  };
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
      );
      const pg = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        loadRows(where, pg.limit, pg.offset),
        db.select({ c: count() }).from(waybills).where(where),
      ]);
      const [links, cancelled] = await Promise.all([
        linksByWaybill(rows.map((row) => row.id)),
        cancelledByNames(rows),
      ]);
      return {
        items: rows.map((row) =>
          toDto(row, links.get(row.id) ?? [], cancelled.get(row.cancelledBy ?? '') ?? null),
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
      const [links, cancelled] = await Promise.all([
        linksByWaybill([row.id]),
        cancelledByNames([row]),
      ]);
      return toDto(row, links.get(row.id) ?? [], cancelled.get(row.cancelledBy ?? '') ?? null);
    },
  );

  /**
   * Заполненный бланк листа (ADR 0037 п. 10). Собирается из снимка значений, а не из
   * справочников: переименование объекта или уточнение госномера задним числом уже выданный лист
   * не меняет. Аннулированный лист отдаётся тоже — его подшивают к журналу как испорченный бланк.
   */
  async function renderWaybill(id: string) {
    const [row] = await db
      .select({
        id: waybills.id,
        formCode: waybills.formCode,
        number: waybills.number,
        prefix: waybillSeries.prefix,
        numberWidth: waybillSeries.numberWidth,
        data: waybills.data,
      })
      .from(waybills)
      .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
      .where(eq(waybills.id, id));
    if (!row) throw err.notFound('Путевой лист не найден');

    const rendered = renderOfficeTemplate(
      readTemplate(row.formCode),
      row.data as Record<string, string>,
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
   * Аннулирование испорченного бланка (ADR 0037 п. 9). Только до даты выезда: в день выезда и
   * позже лист уже у водителя, и запись, разошедшаяся с бумагой на руках, хуже отсутствия записи.
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
      if (!isWaybillEditable(row.issuedForDate, today())) {
        throw err.conflict(WAYBILL_LOCKED_MESSAGE);
      }

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
      const [links, cancelled] = await Promise.all([
        linksByWaybill([row.id]),
        cancelledByNames([updated!]),
      ]);
      return toDto(updated!, links.get(row.id) ?? [], cancelled.get(p.id) ?? null);
    },
  );
}
