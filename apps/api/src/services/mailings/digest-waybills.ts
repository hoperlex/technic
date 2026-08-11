import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import {
  formatMoscowDateTime,
  formatPhone,
  formatVehicleRequestNumber,
  isRelocationPurpose,
  requestCustomerName,
  routePurposeLabels,
  VEHICLE_ON_SITE_PATH,
  VEHICLE_ROUTES_PATH,
  vehicleLabel,
  vehicleRequestPath,
  vehicleRoutePath,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  waybillDisplayNumber,
  waybillPath,
} from '@technic/contracts';
import { config } from '../../config';
import { db } from '../../db/client';
import {
  constructionObjects,
  freightTransportRequestDetails,
  persons,
  specialEquipmentRequestDetails,
  vehicleCategories,
  vehicleModels,
  vehicleRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
} from '../../db/schema';
import { assertOwnOrigin, type MailTableCell } from '../mail-templates';
import { loadRouteDtos, routeQuery } from '../vehicle-routes';
import { type DigestContext, limitRows, vehicleRequestScope } from './digest-context';

/**
 * Содержание ролевой сводки (ADR 0093): что оформлено на дни окна.
 *
 * Отбор идёт по действующим путевым листам, а не по заявкам, и это главное свойство письма. Лист —
 * признак того, что работа не только заказана, но и оформлена: заявка без листа может ещё двадцать
 * раз переехать, а сводка, показывающая намерения, читается как план и подводит ровно там, где на
 * неё положились.
 *
 * Отсюда же две таблицы вместо одной: по бланку расходится привязка листа. 4-П и форма № 3 висят на
 * рейсе — это перевозки, у них есть день, машина и состав заявок. ЭСМ-2 висит на заявке и неделе
 * работы — это техника на объектах, дня у неё нет вовсе, есть период.
 *
 * Следствие, которое надо помнить: на арендную технику лист выписывает арендодатель, и в сводку
 * такие рейсы не попадают никак. Сводка отвечает на вопрос «что оформлено», а не «что запланировано».
 */

/** Готовая таблица письма: заголовок со счётчиком, шапка, строки и ссылка на полный список. */
export interface DigestTable {
  title: string;
  /** Сколько строк всего — печатается даже когда строк больше лимита. */
  total: number;
  head: string[];
  rows: MailTableCell[][];
  /** Куда идти за остальным, когда строк больше лимита. */
  link: string;
}

/** Перевозки одного дня окна: у окна шире суток заголовок дня стоит над своей таблицей. */
export interface DigestTripsDay {
  date: string;
  table: DigestTable;
}

const TRIPS_HEAD = [
  'Рейс',
  'Заявка · заказчик',
  'Машина',
  'Водитель',
  'Погрузка',
  'Выгрузка',
  'Примечание',
];

const ONSITE_HEAD = [
  'Лист ЭСМ-2 · период',
  'Заявка · объект',
  'Машина',
  'Машинист',
  'Место работ',
  'Ответственный',
  'Примечание',
];

/**
 * Ссылка письма. Origin проверяется тем же правилом, что и у писем про доступ: ссылка от имени
 * портала, ведущая наружу, — это фишинг с нашей подписью.
 */
function portalLink(path: string): string {
  const href = `${config.publicOrigin}${path}`;
  assertOwnOrigin(href, config.publicOrigin);
  return href;
}

/** Ячейка «есть что показать или прочерк»: пустая графа в таблице читается как потерянные данные. */
function cell(text: string, extra?: { href?: string; sub?: string }): MailTableCell {
  return {
    text: text || '—',
    ...(extra?.href ? { href: extra.href } : {}),
    ...(extra?.sub ? { sub: extra.sub } : {}),
  };
}

/** Графа, названная строкой выше: у второй заявки того же рейса машина и водитель те же. */
const CONTINUED: MailTableCell = { text: '' };

/** Человек и его телефон: две строки одной ячейки — звонить по номеру, спрашивать по имени. */
function personCell(fullName: string, phone: string, fallback: string): MailTableCell {
  if (!fullName && !phone) return cell(fallback);
  return { text: fullName || fallback, ...(phone ? { sub: formatPhone(phone) } : {}) };
}

/** «08:30» или пусто, если у заявки время не задано: тогда значима только дата. */
function timeOf(request: VehicleRouteRequestDto): string {
  if (request.scheduledTimeUnspecified) return '';
  return formatMoscowDateTime(new Date(request.scheduledAt)).slice(-5);
}

/** Живые заявки окна вместе с тем, чего нет в составе рейса: комментарий и контакты на концах. */
interface RequestExtra {
  comment: string;
  loadingName: string;
  loadingPhone: string;
  unloadingName: string;
  unloadingPhone: string;
}

/**
 * Заявки, которые получателю положено видеть, вместе с их контактами.
 *
 * Один запрос отвечает сразу на два вопроса — «видно ли» и «что печатать», — и это не экономия:
 * область здесь та же самая функция, которой список заявок ограничен в портале
 * (`vehicleRequestScope`). Разойдись эти два места, письмо стало бы каналом, через который наружу
 * уходит то, чего человеку не показывают.
 */
async function visibleRequests(
  ctx: DigestContext,
  requestIds: string[],
): Promise<Map<string, RequestExtra>> {
  const map = new Map<string, RequestExtra>();
  if (requestIds.length === 0) return map;

  const rows = await db
    .select({
      id: vehicleRequests.id,
      comment: vehicleRequests.comment,
      loadingName: freightTransportRequestDetails.loadingResponsibleName,
      loadingPhone: freightTransportRequestDetails.loadingResponsiblePhone,
      unloadingName: freightTransportRequestDetails.unloadingResponsibleName,
      unloadingPhone: freightTransportRequestDetails.unloadingResponsiblePhone,
    })
    .from(vehicleRequests)
    .leftJoin(
      freightTransportRequestDetails,
      eq(freightTransportRequestDetails.requestId, vehicleRequests.id),
    )
    .where(
      and(
        inArray(vehicleRequests.id, requestIds),
        // Отменённая заявка остаётся в маршруте историей рейса — лист по ней уже выписан, — но
        // ехать по ней не надо, и печатать её значит вводить в заблуждение.
        ne(vehicleRequests.status, 'cancelled'),
        vehicleRequestScope(ctx),
      ),
    );

  for (const row of rows) {
    map.set(row.id, {
      comment: row.comment,
      loadingName: row.loadingName ?? '',
      loadingPhone: row.loadingPhone ?? '',
      unloadingName: row.unloadingName ?? '',
      unloadingPhone: row.unloadingPhone ?? '',
    });
  }
  return map;
}

/** Телефоны водителей пачкой: в выборке рейса их нет, а звонить в сводке именно по ним. */
async function phonesOf(personIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (personIds.length === 0) return map;
  const rows = await db
    .select({ id: persons.id, phone: persons.phone })
    .from(persons)
    .where(inArray(persons.id, personIds));
  for (const row of rows) map.set(row.id, row.phone);
  return map;
}

/** Строка перевозки: одна заявка состава грузового рейса. Номер рейса печатается только у первой. */
function freightRow(input: {
  route: VehicleRouteDto;
  request: VehicleRouteRequestDto;
  extra: RequestExtra;
  driverPhone: string;
  first: boolean;
}): MailTableCell[] {
  const { route, request, extra } = input;
  const time = timeOf(request);
  // Комментарий рейса идёт после комментария заявки: он относится ко всему выезду, а не к этой
  // строке, — но и потерять его нельзя, диспетчер пишет туда то, что не влезло в заявку.
  const note = [extra.comment, route.comment && `Рейс: ${route.comment}`]
    .filter(Boolean)
    .join('. ');
  return [
    // Продолжающие строки рейса оставляют графы рейса, машины и водителя пустыми, а не прочерком:
    // прочерк читается как «водителя нет», хотя он назван строкой выше.
    input.first
      ? cell(`${route.displayNumber} · ${routePurposeLabels[route.purpose]}`, {
          href: portalLink(vehicleRoutePath(route.id)),
        })
      : CONTINUED,
    cell(`${request.displayNumber} · ${request.customerName}`, {
      href: portalLink(
        vehicleRequestPath({ id: request.requestId, status: request.status, deleted: false }),
      ),
    }),
    input.first ? cell(route.vehicleLabel) : CONTINUED,
    input.first
      ? personCell(route.driverName, input.driverPhone, 'водитель не назначен')
      : CONTINUED,
    cell(time ? `${request.loadingLocation}, ${time}` : request.loadingLocation, {
      sub: contact(extra.loadingName, extra.loadingPhone),
    }),
    cell(request.unloadingLocation, { sub: contact(extra.unloadingName, extra.unloadingPhone) }),
    cell(note),
  ];
}

/** Перегон техники: состава у него нет, задание — «откуда» и «куда», основание — заявка. */
function relocationRow(input: { route: VehicleRouteDto; driverPhone: string }): MailTableCell[] {
  const { route } = input;
  const source = route.sourceRequest;
  return [
    cell(`${route.displayNumber} · ${routePurposeLabels[route.purpose]}`, {
      href: portalLink(vehicleRoutePath(route.id)),
    }),
    source
      ? cell(`${source.displayNumber} · ${source.customerName}`, {
          href: portalLink(
            vehicleRequestPath({ id: source.requestId, status: source.status, deleted: false }),
          ),
        })
      : cell(''),
    cell(route.vehicleLabel),
    personCell(route.driverName, input.driverPhone, 'водитель не назначен'),
    cell(route.moveFrom),
    cell(route.moveTo),
    cell(route.comment),
  ];
}

/** «Петров П. П., +7 (916) 222 33 44» — контакт на конце маршрута; пусто, если его не заводили. */
function contact(name: string, phone: string): string {
  return [name, phone ? formatPhone(phone) : ''].filter(Boolean).join(', ');
}

/**
 * Перевозки по дням окна: листы 4-П и формы № 3, выписанные на рейсы этих дней.
 *
 * Рейс без действующего листа не попадает сюда вовсе — в том числе арендный, которому лист
 * выписывает арендодатель. Это решение заказчика, а не упущение: отбор строго по оформленному.
 */
export async function digestTripsDays(ctx: DigestContext): Promise<DigestTripsDay[]> {
  const rows = await routeQuery(db)
    .where(
      and(
        gte(vehicleRoutes.routeDate, ctx.windowFrom),
        lte(vehicleRoutes.routeDate, ctx.windowTo),
        // Действующий лист рейса. `EXISTS`, а не join: листов у рейса за его жизнь бывает
        // несколько (аннулировали и выписали заново), а строка нужна одна.
        sql`EXISTS (
          SELECT 1 FROM waybills w
          WHERE w.route_id = ${vehicleRoutes.id} AND w.status <> 'cancelled'
        )`,
      ),
    )
    .orderBy(asc(vehicleRoutes.routeDate), asc(vehicleRoutes.num));
  if (rows.length === 0) return [];

  const routes = await loadRouteDtos(db, rows);
  const requestIds = [
    ...new Set([
      ...routes.flatMap((r) => r.requests.map((q) => q.requestId)),
      ...routes.flatMap((r) => (r.sourceRequest ? [r.sourceRequest.requestId] : [])),
    ]),
  ];
  const [extras, phones] = await Promise.all([
    visibleRequests(ctx, requestIds),
    phonesOf([...new Set(routes.flatMap((r) => (r.driverPersonId ? [r.driverPersonId] : [])))]),
  ]);

  const days: DigestTripsDay[] = [];
  for (const date of [...new Set(routes.map((r) => r.routeDate))]) {
    const built: MailTableCell[][] = [];
    for (const route of routes.filter((r) => r.routeDate === date)) {
      const driverPhone = route.driverPersonId ? (phones.get(route.driverPersonId) ?? '') : '';
      if (isRelocationPurpose(route.purpose)) {
        // У перегона основание — заявка-источник, и видимость решает она же. Нет её в разрешённых
        // — рейса в письме нет: перегон чужой площадки не должен просвечивать «откуда и куда».
        const source = route.sourceRequest;
        if (!source || !extras.has(source.requestId)) continue;
        built.push(relocationRow({ route, driverPhone }));
        continue;
      }
      const visible = route.requests.filter((q) => extras.has(q.requestId));
      visible.forEach((request, i) => {
        built.push(
          freightRow({
            route,
            request,
            extra: extras.get(request.requestId)!,
            driverPhone,
            first: i === 0,
          }),
        );
      });
    }
    if (built.length === 0) continue;
    days.push({
      date,
      table: {
        title: 'Перевозки',
        total: built.length,
        head: TRIPS_HEAD,
        rows: limitRows(built),
        link: portalLink(VEHICLE_ROUTES_PATH),
      },
    });
  }
  return days;
}

/**
 * Техника на объектах: листы ЭСМ-2, чья неделя работы пересекается с окном.
 *
 * Пересечением, а не датой выписки: лист живёт неделю, и машина, начавшая работать в понедельник,
 * стоит на площадке и в среду. Тем же условием считает занятость гараж — разойтись им нельзя,
 * иначе «занята» и «показана в сводке» перестанут совпадать.
 */
export async function digestOnsiteTable(ctx: DigestContext): Promise<DigestTable | null> {
  const rows = await db
    .select({
      waybillId: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
      requestId: vehicleRequests.id,
      requestNum: vehicleRequests.num,
      requestStatus: vehicleRequests.status,
      comment: vehicleRequests.comment,
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      responsibleName: specialEquipmentRequestDetails.responsibleName,
      responsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
      driverName: persons.fullName,
      driverPhone: persons.phone,
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      modelName: vehicleModels.name,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, waybills.sourceRequestId))
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .innerJoin(persons, eq(persons.id, waybills.driverPersonId))
    .innerJoin(vehicles, eq(vehicles.id, waybills.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(
      and(
        eq(waybills.formCode, 'esm2'),
        ne(waybills.status, 'cancelled'),
        // Пересечение недели листа с окном. У ЭСМ-2 обе границы заполнены всегда
        // (`waybills_form_source_check`), поэтому проверять их на NULL не нужно.
        lte(waybills.periodFrom, ctx.windowTo),
        gte(waybills.periodTo, ctx.windowFrom),
        ne(vehicleRequests.status, 'cancelled'),
        vehicleRequestScope(ctx),
      ),
    )
    .orderBy(asc(constructionObjects.name), asc(waybills.periodFrom));
  if (rows.length === 0) return null;

  const built = rows.map((r): MailTableCell[] => {
    // Период печатается пересечённым с окном: лист выписан на неделю, а письмо говорит про свои
    // дни, и «10–16 августа» в сводке на среду отвечает не на тот вопрос, который задан.
    const from = r.periodFrom && r.periodFrom > ctx.windowFrom ? r.periodFrom : ctx.windowFrom;
    const to = r.periodTo && r.periodTo < ctx.windowTo ? r.periodTo : ctx.windowTo;
    return [
      cell(waybillDisplayNumber(r.prefix, r.number, r.numberWidth), {
        href: portalLink(waybillPath(waybillDisplayNumber(r.prefix, r.number, r.numberWidth))),
        sub: humanRange(from, to),
      }),
      cell(
        `${formatVehicleRequestNumber(r.requestNum)} · ${requestCustomerName({ objectName: r.objectName, departmentName: null })}`,
        {
          href: portalLink(
            vehicleRequestPath({ id: r.requestId, status: r.requestStatus, deleted: false }),
          ),
        },
      ),
      cell(
        [r.modelName, r.registrationNumber].filter(Boolean).join(' · ') ||
          vehicleLabel({
            ownership: r.ownership,
            description: r.description,
            categoryName: r.categoryName,
            typeName: r.typeName,
            registrationNumber: r.registrationNumber,
            modelName: r.modelName,
          }),
      ),
      personCell(r.driverName, r.driverPhone, 'машинист не назначен'),
      cell(r.objectAddress ?? ''),
      personCell(r.responsibleName ?? '', r.responsiblePhone ?? '', ''),
      cell(r.comment),
    ];
  });

  return {
    title: 'Техника на объектах',
    total: built.length,
    head: ONSITE_HEAD,
    rows: limitRows(built),
    link: portalLink(VEHICLE_ON_SITE_PATH),
  };
}

/** «10–16 августа» либо «12 августа»: период работ читается диапазоном, а не парой дат. */
function humanRange(from: string, to: string): string {
  return from === to ? humanDay(from) : `${dayNumber(from)}–${humanDay(to)}`;
}

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

function dayNumber(dateOnly: string): string {
  return String(Number(dateOnly.slice(8, 10)));
}

function humanDay(dateOnly: string): string {
  const month = MONTHS[Number(dateOnly.slice(5, 7)) - 1];
  return `${dayNumber(dateOnly)} ${month}`;
}
