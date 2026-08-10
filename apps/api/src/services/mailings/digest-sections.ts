import { and, asc, count, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  DIGEST_SECTION_ROW_LIMIT,
  type DigestSection,
  digestSectionLabels,
  formatServiceRequestNumber,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  formatWasteRequestNumber,
  isWaitingOn,
  type RequestStatus,
  type RequestType,
  requestCustomerName,
  requestStatusLabels,
  requestTypeLabels,
  SERVICE_REQUEST_STATUSES,
  serviceRequestStatusLabels,
  serviceWaitingOn,
  vehicleLabel,
  waybillDisplayNumber,
} from '@technic/contracts';
import { config } from '../../config';
import { db } from '../../db/client';
import {
  constructionObjects,
  containerTypes,
  departments,
  freightTransportRequestDetails,
  persons,
  requestStatusHistory,
  serviceRequests,
  specialEquipmentRequestDetails,
  vehicleCategories,
  vehicleModels,
  vehicleRequests,
  vehicleRequestStatusHistory,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  wasteRequests,
  wasteTypes,
  waybills,
  waybillSeries,
} from '../../db/schema';
import { assertOwnOrigin } from '../mail-templates';
import {
  dayBounds,
  type DigestContext,
  type DigestRow,
  type DigestSectionProvider,
  type DigestSectionResult,
  limitRows,
  openStatuses,
  realStatusChange,
  serviceRequestScope,
  vehicleRequestScope,
  wasteRequestScope,
} from './digest-context';
import { humanDate } from './driver-routes';
import { localDate } from './schedule';

/**
 * Разделы ролевого дайджеста (ADR 0078): по провайдеру на каждую строку реестра `DIGEST_SECTIONS`.
 *
 * Что здесь общего у всех девяти:
 *
 * 1. Область видимости не выбирается разделом, а берётся у получателя: любая выборка заявок идёт
 *    через `vehicleRequestScope`/`wasteRequestScope`/`serviceRequestScope`. Забыть их — значит
 *    положить в письмо чужие площадки, и никакой фильтр строкой этого потом не исправит.
 * 2. Раздел, в котором нет ни одной записи, возвращает `null`: пустой блок в письме читается как
 *    «данные не собрались», а не как «событий не было».
 * 3. Печатается не больше `DIGEST_SECTION_ROW_LIMIT` строк, но `total` всегда полный: письмо — это
 *    повод открыть портал, а не выгрузка, и счётчик отвечает на «сколько там всего».
 * 4. Номера собираются только контрактными функциями. У заявок вывоза есть legacy-формат, у
 *    путевого листа номер осмыслен лишь вместе с префиксом серии — собранный руками номер разошёлся
 *    бы с тем, что человек видит в портале и в бумаге.
 */

/** Часовой пояс портала: границы суток и подписи дат считаются в нём, а не в UTC. */
function timeZone(): string {
  return config.mail.timezone;
}

/** Период событий моментами: от начала первого дня окна до конца последнего. */
function periodBounds(ctx: DigestContext): { from: Date; to: Date } {
  return {
    from: dayBounds(ctx.periodStart, timeZone()).from,
    to: dayBounds(ctx.periodEnd, timeZone()).to,
  };
}

/** Окно «ближайших» моментами — для колонок `timestamptz`, где датой не сравнить. */
function upcomingBounds(ctx: DigestContext): { from: Date; to: Date } {
  return {
    from: dayBounds(ctx.upcomingFrom, timeZone()).from,
    to: dayBounds(ctx.upcomingTo, timeZone()).to,
  };
}

/**
 * Ссылка раздела. Ведёт на экран, а не на отфильтрованный список: параметров отбора портал из
 * адреса сейчас не читает, и ссылка «покажи мне эти пять заявок» открыла бы обычный список — то
 * есть соврала бы. Origin проверяется тем же правилом, что и у писем про доступ: ссылка от имени
 * портала, ведущая наружу, — это фишинг с нашей подписью.
 */
function portalLink(path: string): string {
  const href = `${config.publicOrigin}${path}`;
  assertOwnOrigin(href, config.publicOrigin);
  return href;
}

/** Части строки через « · »; пустые выбрасываются — прочерков посреди строки не бывает. */
function line(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(' · ');
}

/** Итог раздела: `null`, если записей нет вовсе. */
function section(input: {
  section: DigestSection;
  total: number;
  rows: DigestRow[];
  link?: string;
}): DigestSectionResult | null {
  if (input.total === 0) return null;
  return {
    title: digestSectionLabels[input.section],
    total: input.total,
    rows: input.rows,
    link: input.link,
  };
}

/** Первое число из `count()`: у агрегата строка ровно одна, но тип этого не знает. */
function firstCount(rows: { total: number }[]): number {
  return rows[0]?.total ?? 0;
}

function dayWord(days: number): string {
  const mod10 = days % 10;
  const mod100 = days % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

// ── Заявки на технику ──

interface VehicleRequestRow {
  num: number;
  status: RequestStatus;
  createdAt: Date;
  objectName: string | null;
  departmentName: string | null;
  typeName: string;
  categoryName: string | null;
  dateFrom: string | null;
  scheduledAt: Date | null;
}

/**
 * Выборка заявки для строки письма.
 *
 * Обе detail-таблицы присоединены `leftJoin`'ами: тип заявки заранее неизвестен, а заполнена у неё
 * ровно одна из них — `innerJoin` любой из двух вычеркнул бы из письма половину заявок. По той же
 * причине левый join у объекта и отдела: заказчик — либо площадка, либо отдел (ADR 0040).
 */
function vehicleRequestQuery() {
  return (
    db
      .select({
        num: vehicleRequests.num,
        status: vehicleRequests.status,
        createdAt: vehicleRequests.createdAt,
        objectName: constructionObjects.name,
        departmentName: departments.name,
        typeName: vehicleTypes.name,
        categoryName: vehicleCategories.name,
        dateFrom: specialEquipmentRequestDetails.dateFrom,
        scheduledAt: freightTransportRequestDetails.scheduledAt,
      })
      .from(vehicleRequests)
      .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
      .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
      .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicleRequests.vehicleTypeId))
      // Заказанная категория (ADR 0028): её нет у типа без ТТХ и у заявок старше миграции 0052.
      .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicleRequests.vehicleCategoryId))
      .leftJoin(
        specialEquipmentRequestDetails,
        eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
      )
      .leftJoin(
        freightTransportRequestDetails,
        eq(freightTransportRequestDetails.requestId, vehicleRequests.id),
      )
  );
}

/**
 * Срок заявки одной датой: у заказа спецтехники это день выхода на площадку, у грузоперевозки —
 * момент подачи. Колонки разные, потому что и величины разные, — сводятся тем же `coalesce`,
 * которым их сводит список заявок.
 */
function vehicleRequestTerm(
  row: Pick<VehicleRequestRow, 'dateFrom' | 'scheduledAt'>,
): string | null {
  if (row.dateFrom) return row.dateFrom;
  if (row.scheduledAt) return localDate(row.scheduledAt, timeZone());
  return null;
}

/** Тот же `coalesce` в SQL: им разделы сортируются по сроку — ближайшее сверху. */
const vehicleRequestTermOrder = sql`coalesce(${freightTransportRequestDetails.scheduledAt}, ${specialEquipmentRequestDetails.dateFrom}::timestamptz)`;

/** Заказчик в кавычках: «Северный», «ПТО». Без обеих сторон печатается прочерк — кавычить нечего. */
function customerPart(row: Pick<VehicleRequestRow, 'objectName' | 'departmentName'>): string {
  const name = requestCustomerName(row);
  return row.objectName || row.departmentName ? `«${name}»` : name;
}

/**
 * Строка заявки: «ТС-461 · «Северный» · Самосвал · на 7 августа · Новая».
 *
 * `tail` заменяет статус там, где статус в разделе один и тот же на все строки и потому ничего не
 * сообщает, — например, в разделе ждущих визы.
 */
function vehicleRequestText(row: VehicleRequestRow, tail?: string): string {
  const term = vehicleRequestTerm(row);
  return line([
    formatVehicleRequestNumber(row.num),
    customerPart(row),
    // Наименование категории уже начинается с типа (ADR 0028) — второй раз тип не печатается.
    row.categoryName ?? row.typeName,
    term ? `на ${humanDate(term, false)}` : null,
    tail ?? requestStatusLabels[row.status],
  ]);
}

/** Раздел «Заявки на технику: заведено и сменило статус» — события периода, а не снимок. */
const vehicleRequestsChanges: DigestSectionProvider = async (ctx) => {
  const period = periodBounds(ctx);
  const scope = vehicleRequestScope(ctx);

  const createdWhere = and(
    scope,
    gte(vehicleRequests.createdAt, period.from),
    lte(vehicleRequests.createdAt, period.to),
  );
  /**
   * Только настоящие переходы. При заведении заявки в историю пишется «— → Новая», и без
   * `realStatusChange` каждая заведённая за период заявка попала бы в раздел дважды: сначала как
   * новая, потом как сменившая статус на ту же «Новую».
   */
  const changedWhere = and(
    scope,
    gte(vehicleRequestStatusHistory.changedAt, period.from),
    lte(vehicleRequestStatusHistory.changedAt, period.to),
    realStatusChange(vehicleRequestStatusHistory.fromStatus),
  );

  const [createdTotal, changedTotal, createdRows, changedRows] = await Promise.all([
    db.select({ total: count() }).from(vehicleRequests).where(createdWhere).then(firstCount),
    db
      .select({ total: count() })
      .from(vehicleRequestStatusHistory)
      .innerJoin(
        vehicleRequests,
        eq(vehicleRequests.id, vehicleRequestStatusHistory.vehicleRequestId),
      )
      .where(changedWhere)
      .then(firstCount),
    vehicleRequestQuery()
      .where(createdWhere)
      .orderBy(asc(vehicleRequests.createdAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
    db
      .select({
        num: vehicleRequests.num,
        fromStatus: vehicleRequestStatusHistory.fromStatus,
        toStatus: vehicleRequestStatusHistory.toStatus,
      })
      .from(vehicleRequestStatusHistory)
      .innerJoin(
        vehicleRequests,
        eq(vehicleRequests.id, vehicleRequestStatusHistory.vehicleRequestId),
      )
      .where(changedWhere)
      .orderBy(asc(vehicleRequestStatusHistory.changedAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  // Заведённые идут первыми: это то, что читателю дайджеста надо взять в работу, а переходы —
  // отчёт о том, что уже сделано. Каждый переход своей строкой: за неделю заявка успевает пройти
  // и «Новая → В работе», и «В работе → Выполнена», и оба события настоящие.
  const rows = limitRows<DigestRow>([
    ...createdRows.map((r) => ({ text: vehicleRequestText(r) })),
    ...changedRows.map((r) => ({
      text: line([
        formatVehicleRequestNumber(r.num),
        `${r.fromStatus ? requestStatusLabels[r.fromStatus] : '—'} → ${requestStatusLabels[r.toStatus]}`,
      ]),
    })),
  ]);

  return section({
    section: 'vehicle_requests_changes',
    total: createdTotal + changedTotal,
    rows,
    link: portalLink('/vehicle-requests?tab=requests'),
  });
};

/** Раздел «Заявки на технику: незакрытые» — снимок на момент рассылки, без периода. */
const vehicleRequestsOpen: DigestSectionProvider = async (ctx) => {
  const where = and(vehicleRequestScope(ctx), openStatuses(vehicleRequests.status));

  const [total, rows] = await Promise.all([
    db.select({ total: count() }).from(vehicleRequests).where(where).then(firstCount),
    vehicleRequestQuery()
      .where(where)
      .orderBy(asc(vehicleRequestTermOrder))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  return section({
    section: 'vehicle_requests_open',
    total,
    rows: rows.map((r) => ({ text: vehicleRequestText(r) })),
    link: portalLink('/vehicle-requests?tab=requests'),
  });
};

/**
 * Раздел «Заявки на технику: ждут визы» (ADR 0025). Статус в строке не печатается: он у всех
 * «Новая» — вместо него стоит то, ради чего раздел и заведён, сколько заявка ждёт.
 */
const vehicleRequestsAwaitingApproval: DigestSectionProvider = async (ctx) => {
  const where = and(
    vehicleRequestScope(ctx),
    isNull(vehicleRequests.approvedAt),
    eq(vehicleRequests.status, 'new'),
  );

  const [total, rows] = await Promise.all([
    db.select({ total: count() }).from(vehicleRequests).where(where).then(firstCount),
    vehicleRequestQuery()
      .where(where)
      // Самые давние сверху: срочность здесь измеряется ожиданием, а не сроком выхода техники.
      .orderBy(asc(vehicleRequests.createdAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  const now = Date.now();
  return section({
    section: 'vehicle_requests_awaiting_approval',
    total,
    rows: rows.map((r) => {
      const days = Math.floor((now - r.createdAt.getTime()) / 86_400_000);
      // Сутки ещё не прошли — «ждёт 0 дней» читалось бы как «не ждёт вовсе».
      const waiting = days < 1 ? 'ждёт визы' : `ждёт визы ${days} ${dayWord(days)}`;
      return { text: vehicleRequestText(r, waiting) };
    }),
    link: portalLink('/vehicle-requests?tab=requests'),
  });
};

// ── Рейсы и путевые листы ──
//
// Области видимости у этих двух разделов нет вовсе: ни у рейса, ни у листа нет площадки, к которой
// их можно было бы отнести, — доступ к модулю закрыт правом, а не набором объектов. Поэтому здесь
// нет ни `vehicleRequestScope`, ни исключённых площадок: сузить нечем. Отсекает эти разделы
// `sectionAllowed` — в письмо роли с объектной или отделовой осью они не попадают целиком
// (`GLOBAL_ONLY_DIGEST_SECTIONS`).

/** Реквизиты подписи машины: правило одно на портал и сервер — `vehicleLabel`. */
const vehicleLabelColumns = {
  ownership: vehicles.ownership,
  description: vehicles.description,
  categoryName: vehicleCategories.name,
  typeName: vehicleTypes.name,
  registrationNumber: vehicles.registrationNumber,
  modelName: vehicleModels.name,
};

/** Раздел «Рейсы на ближайшие дни»: что выедет в окно `upcomingFrom…upcomingTo`. */
const vehicleRoutesUpcoming: DigestSectionProvider = async (ctx) => {
  const where = and(
    gte(vehicleRoutes.routeDate, ctx.upcomingFrom),
    lte(vehicleRoutes.routeDate, ctx.upcomingTo),
  );

  const [total, withoutDriver, rows] = await Promise.all([
    db.select({ total: count() }).from(vehicleRoutes).where(where).then(firstCount),
    // Рейс без водителя — не ошибка, а незаконченная работа диспетчера: маршрут собирают заранее,
    // человека ставят перед выездом. Счёт отдельный, потому что именно он и есть повод к действию.
    db
      .select({ total: count() })
      .from(vehicleRoutes)
      .where(and(where, isNull(vehicleRoutes.driverPersonId)))
      .then(firstCount),
    db
      .select({
        num: vehicleRoutes.num,
        routeDate: vehicleRoutes.routeDate,
        driverName: persons.fullName,
        ...vehicleLabelColumns,
      })
      .from(vehicleRoutes)
      .innerJoin(vehicles, eq(vehicles.id, vehicleRoutes.vehicleId))
      .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
      .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
      .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
      // Водителя может не быть — `innerJoin` спрятал бы из письма ровно те рейсы, которые надо
      // доукомплектовать.
      .leftJoin(persons, eq(persons.id, vehicleRoutes.driverPersonId))
      .where(where)
      .orderBy(asc(vehicleRoutes.routeDate), asc(vehicleRoutes.num))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  const printed: DigestRow[] = limitRows(
    rows.map((r) => ({
      text: line([
        formatVehicleRouteNumber(r.num),
        humanDate(r.routeDate, false),
        vehicleLabel(r),
        r.driverName ?? 'водитель не назначен',
      ]),
    })),
  );
  // Счётчик стоит после строк и в лимит не входит: это итог раздела, а не ещё один рейс.
  if (withoutDriver > 0) printed.push({ text: `Без водителя: ${withoutDriver}` });

  return section({
    section: 'vehicle_routes_upcoming',
    total,
    rows: printed,
    link: portalLink('/vehicle-requests?tab=routes'),
  });
};

/** Раздел «Выписанные путевые листы»: что выдано за период. */
const waybillsIssued: DigestSectionProvider = async (ctx) => {
  const period = periodBounds(ctx);
  const where = and(
    gte(waybills.issuedAt, period.from),
    lte(waybills.issuedAt, period.to),
    // Аннулированный бланк списан: «выписано за день» — это документы, по которым ездят.
    ne(waybills.status, 'cancelled'),
  );

  const [total, rows] = await Promise.all([
    db.select({ total: count() }).from(waybills).where(where).then(firstCount),
    db
      .select({
        number: waybills.number,
        prefix: waybillSeries.prefix,
        numberWidth: waybillSeries.numberWidth,
        issuedForDate: waybills.issuedForDate,
        driverName: persons.fullName,
        ...vehicleLabelColumns,
      })
      .from(waybills)
      .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
      .innerJoin(vehicles, eq(vehicles.id, waybills.vehicleId))
      .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
      .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
      .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
      .innerJoin(persons, eq(persons.id, waybills.driverPersonId))
      .where(where)
      .orderBy(asc(waybills.issuedAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  return section({
    section: 'waybills_issued',
    total,
    rows: rows.map((r) => ({
      text: line([
        // Номер только вместе с серией: голое число повторяется у каждой серии своей, и по нему
        // лист в журнале не найти.
        waybillDisplayNumber(r.prefix, r.number, r.numberWidth),
        `на ${humanDate(r.issuedForDate, false)}`,
        vehicleLabel(r),
        r.driverName,
      ]),
    })),
    link: portalLink('/waybills'),
  });
};

// ── Заявки на вывоз мусора ──

interface WasteRequestRow {
  num: number;
  legacyNumFormat: boolean;
  requestType: RequestType;
  status: RequestStatus;
  objectName: string;
  containerTypeName: string | null;
  wasteTypeName: string | null;
  deliveryAt: Date;
}

/**
 * Выборка заявки вывоза для строки письма. Объект присоединён `innerJoin`'ом, в отличие от заявок
 * ТС: у вывоза площадка обязательна — отдел мусор не заказывает.
 */
function wasteRequestQuery() {
  return (
    db
      .select({
        num: wasteRequests.num,
        legacyNumFormat: wasteRequests.legacyNumFormat,
        requestType: wasteRequests.requestType,
        status: wasteRequests.status,
        objectName: constructionObjects.name,
        containerTypeName: containerTypes.name,
        wasteTypeName: wasteTypes.name,
        deliveryAt: wasteRequests.deliveryAt,
      })
      .from(wasteRequests)
      .innerJoin(constructionObjects, eq(constructionObjects.id, wasteRequests.objectId))
      // Предмет заявки: контейнер у контейнерных операций, вид отходов у вывоза самосвалами. У
      // вывоза металлолома нет ни того, ни другого (ADR 0067) — оба join'а левые.
      .leftJoin(containerTypes, eq(containerTypes.id, wasteRequests.containerTypeId))
      .leftJoin(wasteTypes, eq(wasteTypes.id, wasteRequests.wasteTypeId))
  );
}

/** Строка заявки вывоза: «М-128 · «Северный» · Замена полного контейнера · 8 м³ · на 7 августа · Новая». */
function wasteRequestText(row: WasteRequestRow): string {
  return line([
    // Номер только через контракт: у заявок до миграции 0064 он показывается прежним «128-ВМ».
    formatWasteRequestNumber(row.num, row.requestType, row.legacyNumFormat),
    `«${row.objectName}»`,
    requestTypeLabels[row.requestType],
    row.containerTypeName ?? row.wasteTypeName,
    `на ${humanDate(localDate(row.deliveryAt, timeZone()), false)}`,
    requestStatusLabels[row.status],
  ]);
}

/** Раздел «Вывоз мусора: заведено и сменило статус» — тот же счёт событий, что у заявок ТС. */
const wasteRequestsChanges: DigestSectionProvider = async (ctx) => {
  const period = periodBounds(ctx);
  const scope = wasteRequestScope(ctx);

  const createdWhere = and(
    scope,
    gte(wasteRequests.createdAt, period.from),
    lte(wasteRequests.createdAt, period.to),
  );
  // `realStatusChange` — по той же причине, что и у заявок ТС: «— → Новая» пишется при заведении
  // заявки, и без этого условия заведённые за период посчитались бы дважды.
  const changedWhere = and(
    scope,
    gte(requestStatusHistory.changedAt, period.from),
    lte(requestStatusHistory.changedAt, period.to),
    realStatusChange(requestStatusHistory.fromStatus),
  );

  const [createdTotal, changedTotal, createdRows, changedRows] = await Promise.all([
    db.select({ total: count() }).from(wasteRequests).where(createdWhere).then(firstCount),
    db
      .select({ total: count() })
      .from(requestStatusHistory)
      .innerJoin(wasteRequests, eq(wasteRequests.id, requestStatusHistory.requestId))
      .where(changedWhere)
      .then(firstCount),
    wasteRequestQuery()
      .where(createdWhere)
      .orderBy(asc(wasteRequests.createdAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
    db
      .select({
        num: wasteRequests.num,
        legacyNumFormat: wasteRequests.legacyNumFormat,
        requestType: wasteRequests.requestType,
        fromStatus: requestStatusHistory.fromStatus,
        toStatus: requestStatusHistory.toStatus,
      })
      .from(requestStatusHistory)
      .innerJoin(wasteRequests, eq(wasteRequests.id, requestStatusHistory.requestId))
      .where(changedWhere)
      .orderBy(asc(requestStatusHistory.changedAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  const rows = limitRows<DigestRow>([
    ...createdRows.map((r) => ({ text: wasteRequestText(r) })),
    ...changedRows.map((r) => ({
      text: line([
        formatWasteRequestNumber(r.num, r.requestType, r.legacyNumFormat),
        `${r.fromStatus ? requestStatusLabels[r.fromStatus] : '—'} → ${requestStatusLabels[r.toStatus]}`,
      ]),
    })),
  ]);

  return section({
    section: 'waste_requests_changes',
    total: createdTotal + changedTotal,
    rows,
    link: portalLink('/waste?tab=requests'),
  });
};

/** Раздел «Вывоз мусора: незакрытые» — снимок на момент рассылки. */
const wasteRequestsOpen: DigestSectionProvider = async (ctx) => {
  const where = and(wasteRequestScope(ctx), openStatuses(wasteRequests.status));

  const [total, rows] = await Promise.all([
    db.select({ total: count() }).from(wasteRequests).where(where).then(firstCount),
    wasteRequestQuery()
      .where(where)
      .orderBy(asc(wasteRequests.deliveryAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  return section({
    section: 'waste_requests_open',
    total,
    rows: rows.map((r) => ({ text: wasteRequestText(r) })),
    link: portalLink('/waste?tab=requests'),
  });
};

/**
 * Раздел «Вывоз мусора: ожидают подачи» — что подадут в ближайшие дни. Только незакрытые: у
 * выполненной и отменённой заявки плановая дата осталась в прошлом её ведения, а не в планах.
 */
const wasteRequestsUpcoming: DigestSectionProvider = async (ctx) => {
  const upcoming = upcomingBounds(ctx);
  const where = and(
    wasteRequestScope(ctx),
    openStatuses(wasteRequests.status),
    gte(wasteRequests.deliveryAt, upcoming.from),
    lte(wasteRequests.deliveryAt, upcoming.to),
  );

  const [total, rows] = await Promise.all([
    db.select({ total: count() }).from(wasteRequests).where(where).then(firstCount),
    wasteRequestQuery()
      .where(where)
      .orderBy(asc(wasteRequests.deliveryAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  return section({
    section: 'waste_requests_upcoming',
    total,
    rows: rows.map((r) => ({ text: wasteRequestText(r) })),
    link: portalLink('/waste?tab=requests'),
  });
};

// ── Заявки на обслуживание оргтехники ──

/**
 * Раздел «Заявки на обслуживание: ждут вас» (ADR 0085, план оргтехники Р38).
 *
 * Модуль межорганизационный: половина шагов цикла за сервисной компанией, у которой нет служебной
 * причины заходить в портал, пока её не позвали. Очередь «Требуют решения» и бейдж работают только
 * для того, кто уже вошёл, — письмо и есть тот единственный канал, которым назначенную заявку
 * замечают в тот же день, а не через неделю.
 *
 * Сторона получателя определяется правами и типом контрагента, а не именем роли: у оператора
 * оргтехники роль — «Штаб» или «Отдел» (сторону задаёт надстройка, ADR 0086), у сервиса — «Внешний
 * исполнитель» (сторону задаёт тип контрагента). Отсюда `isWaitingOn` — тот же предикат, которым
 * очередь собирает список в портале: сравнение с ролью разошлось бы с ним на первой же надстройке.
 *
 * У заказчика — штаба и ролей отдела — шага в цикле нет вовсе (Р35): приёмку делает оператор, и
 * статусов, в которых ждут заказчика, не бывает. Раздел ему возвращает `null`, и письмо его не
 * печатает — это не «сегодня пусто», а «в цикле его не ждут».
 */
const serviceRequestsWaiting: DigestSectionProvider = async (ctx) => {
  const statuses = SERVICE_REQUEST_STATUSES.filter((status) =>
    isWaitingOn(ctx.principal, serviceWaitingOn(status)),
  );
  // Своих статусов нет — субъект решений в цикле не принимает: запроса не делаем вовсе. Условие
  // «ни один статус не подходит» иначе пришлось бы выражать заведомо ложным предикатом.
  if (statuses.length === 0) return null;

  const where = and(serviceRequestScope(ctx), inArray(serviceRequests.status, statuses));

  const [total, rows] = await Promise.all([
    db.select({ total: count() }).from(serviceRequests).where(where).then(firstCount),
    db
      .select({
        num: serviceRequests.num,
        status: serviceRequests.status,
        // Реквизиты предмета — из снимка заявки, а не из справочника: единицу переносят и
        // переименовывают, а письмо обязано называть её так же, как карточка заявки (ADR 0085 §7).
        equipmentName: serviceRequests.equipmentName,
        objectName: constructionObjects.name,
        statusChangedAt: serviceRequests.statusChangedAt,
      })
      .from(serviceRequests)
      // Площадка у заявки есть всегда (`NOT NULL`): техника где-то стоит, даже когда заказчик —
      // отдел. Поэтому `innerJoin`, в отличие от заявок ТС, где площадки может не быть вовсе.
      .innerJoin(constructionObjects, eq(constructionObjects.id, serviceRequests.equipmentObjectId))
      .where(where)
      // Дольше всех стоящее — сверху: раздел заведён ради зависших заявок, и письмо, начинающееся
      // со вчерашней, отвечает не на тот вопрос.
      .orderBy(asc(serviceRequests.statusChangedAt))
      .limit(DIGEST_SECTION_ROW_LIMIT),
  ]);

  const now = Date.now();
  return section({
    section: 'service_requests_waiting',
    total,
    rows: rows.map((r) => {
      // Возраст в текущем статусе — то, ради чего раздел и читают: «Назначен сервис» четвёртый
      // день значит, что исполнитель заявку не открывал.
      const days = Math.floor((now - r.statusChangedAt.getTime()) / 86_400_000);
      return {
        text: line([
          formatServiceRequestNumber(r.num),
          serviceRequestStatusLabels[r.status],
          r.equipmentName,
          `«${r.objectName}»`,
          // Сутки ещё не прошли — «ждёт 0 дней» читалось бы как «не ждёт вовсе».
          days < 1 ? 'ждёт меньше суток' : `ждёт ${days} ${dayWord(days)}`,
        ]),
      };
    }),
    link: portalLink('/office-equipment?tab=requests'),
  });
};

/**
 * Реестр провайдеров: ключи те же, что в `DIGEST_SECTIONS`. `Record` по типу раздела, а не
 * словарь-«как получится»: раздел, добавленный в контракты и забытый здесь, обязан валить сборку —
 * иначе он тихо пропадёт из письма, а администратор в настройке его увидит.
 */
export const DIGEST_PROVIDERS: Record<DigestSection, DigestSectionProvider> = {
  vehicle_requests_changes: vehicleRequestsChanges,
  vehicle_requests_open: vehicleRequestsOpen,
  vehicle_requests_awaiting_approval: vehicleRequestsAwaitingApproval,
  vehicle_routes_upcoming: vehicleRoutesUpcoming,
  waybills_issued: waybillsIssued,
  waste_requests_changes: wasteRequestsChanges,
  waste_requests_open: wasteRequestsOpen,
  waste_requests_upcoming: wasteRequestsUpcoming,
  service_requests_waiting: serviceRequestsWaiting,
};
