import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  formatMoscowDateTime,
  formatPhone,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRelocationPurpose,
  requestCustomerName,
  routePurposeLabels,
  VEHICLE_ON_SITE_PATH,
  VEHICLE_ROUTES_PATH,
  vehicleLabel,
  type VehicleOwnership,
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
  persons,
  specialEquipmentRequestDetails,
  vehicleCategories,
  vehicleModels,
  vehicleRequests,
  vehicleRequestTrips,
  vehicleRouteRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
} from '../../db/schema';
import { requestIsLinearSql } from '../../db/linear-mode';
import { assertOwnOrigin, type MailTableCell } from '../mail-templates';
import { firstLiveTripJoin, loadRouteDtos, routeQuery } from '../vehicle-routes';
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
 *
 * Исключение ровно одно, и оно оговорено решением: линейный заказ (ADR 0100 §12). Недельного листа
 * у него может не быть вовсе — ЭСМ-2 такому заказу выписывают по требованию, — а работа идёт днями,
 * и отбор по листам потерял бы его целиком и молча. Поэтому у таблицы «Техника на объектах» два
 * источника, и во втором строка стоит в том числе без документа: день, на который лист ещё не
 * выписан, печатается номером рейса с пометкой. Это не отмена правила выше, а его цена — молчаливая
 * потеря в сводке хуже лишней строки: несделанная работа выглядит как несуществующая.
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
  // «Документ», а не «Лист ЭСМ-2»: с линейной техникой в графу приходят и номера дневных 4-П, и
  // номер рейса, которому листа ещё не выписали (ADR 0100 §12).
  'Документ · период',
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

/**
 * Живые заявки окна вместе с тем, чего нет в составе рейса: комментарий и контакты на концах.
 *
 * Контакты пришли с **ездки** (Р2, миграция 0136) — у заявки их больше нет. Берётся первая живая,
 * той же парой граф, что и адреса в составе рейса (`requestsByRoute`): строка письма показывает
 * одну перевозку, и контакт в ней обязан относиться к тому адресу, который в ней же напечатан.
 */
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
      loadingName: vehicleRequestTrips.fromResponsibleName,
      loadingPhone: vehicleRequestTrips.fromResponsiblePhone,
      unloadingName: vehicleRequestTrips.toResponsibleName,
      unloadingPhone: vehicleRequestTrips.toResponsiblePhone,
    })
    .from(vehicleRequests)
    .leftJoin(vehicleRequestTrips, firstLiveTripJoin)
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
 * Строка «Техники на объектах» вместе с тем, чем строки двух источников выстраиваются в одну
 * таблицу. Порядок общий — объект, потом первый день строки: недельный лист и дни линейных заказов
 * рассказывают про одни и те же площадки, и разложить их двумя кучами значило бы заставить
 * читателя искать свой объект дважды.
 */
interface OnsiteRow {
  objectName: string;
  /** Первый день строки внутри окна: им строки одного объекта идут в порядке работ. */
  from: string;
  cells: MailTableCell[];
}

/** Машина строки: «Камаз 65115 · В123АА777», а у безномерной — то, чем её называют в реестре. */
function machineCell(v: {
  ownership: VehicleOwnership;
  description: string;
  categoryName: string | null;
  typeName: string;
  registrationNumber: string | null;
  modelName: string | null;
}): MailTableCell {
  return cell([v.modelName, v.registrationNumber].filter(Boolean).join(' · ') || vehicleLabel(v));
}

/**
 * Заказчик строки «Техники на объектах» — объектом затрат (Р25), то есть по идентификатору.
 *
 * Пара отдела здесь пуста не по недосмотру и не ради компиляции: отдела у этих строк не бывает
 * вовсе. CHECK `vehicle_requests_department_freight_check` разрешает заказчика-отдел только
 * грузоперевозке, а в обе половины таблицы приходит заказ техники на объект — недельный лист ЭСМ-2
 * выписывается только по нему (`waybill-esm2.ts`), а день строки состава (`work_date`) заводится
 * только у линейного заказа (ADR 0100 §2). Второй CHECK, `vehicle_requests_customer_check`, при
 * этом гарантирует, что объект у такой заявки заполнен всегда, — поэтому и `leftJoin` на
 * справочник объектов промахнуться не может.
 *
 * Отсюда и отсутствие join'а на отделы: он был бы запросом за строкой, которой не существует.
 */
function onsiteCustomerName(r: {
  objectId: string | null;
  objectCode: string | null;
  objectName: string | null;
}): string {
  return requestCustomerName({
    ...r,
    departmentId: null,
    departmentCode: null,
    departmentName: null,
  });
}

/**
 * Техника на объектах: недельные листы ЭСМ-2 и дни линейных заказов, попавшие в окно.
 *
 * Два источника, а не один, потому что в портале два способа вести заказ на объект: машина стоит
 * на площадке неделю (недельный лист) либо приезжает днями и вечером возвращается на базу
 * (ADR 0100). Ни один из них не отвечает за другой, и таблица собирается из обоих — иначе половина
 * парка исчезает из письма молча.
 */
export async function digestOnsiteTable(ctx: DigestContext): Promise<DigestTable | null> {
  const [weekly, linear] = await Promise.all([esm2Rows(ctx), linearDayRows(ctx)]);
  const rows = [...weekly, ...linear].sort(
    (a, b) => a.objectName.localeCompare(b.objectName, 'ru') || a.from.localeCompare(b.from),
  );
  if (rows.length === 0) return null;

  return {
    title: 'Техника на объектах',
    total: rows.length,
    head: ONSITE_HEAD,
    rows: limitRows(rows.map((row) => row.cells)),
    link: portalLink(VEHICLE_ON_SITE_PATH),
  };
}

/**
 * Первый источник: листы ЭСМ-2, чья неделя работы пересекается с окном.
 *
 * Пересечением, а не датой выписки: лист живёт неделю, и машина, начавшая работать в понедельник,
 * стоит на площадке и в среду. Тем же условием считает занятость гараж — разойтись им нельзя,
 * иначе «занята» и «показана в сводке» перестанут совпадать.
 */
async function esm2Rows(ctx: DigestContext): Promise<OnsiteRow[]> {
  // Заказанный тип заявки — не тип машины листа, который уже join'ится ниже ради названия единицы.
  // Разные вопросы: один про то, как ведётся заказ, другой про то, чем его закрыли.
  const orderedType = alias(vehicleTypes, 'ordered_vehicle_type');
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
      // Объект — идентификатором и кодом наравне с наименованием: заказчика выводит объект затрат
      // (Р25), а он спрашивает `object_id`, а не заполненность подписи.
      objectId: vehicleRequests.objectId,
      objectCode: constructionObjects.code,
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
    .innerJoin(orderedType, eq(orderedType.id, vehicleRequests.vehicleTypeId))
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
        // Линейный заказ этой половиной не показывается (ADR 0100 §12). Его неделя на площадке —
        // не стояние машины, а набор выездов: строка «7–11 сентября» сказала бы ровно то, что
        // решение 12 из портала и убрало, — и встала бы вторым разом рядом с днями того же заказа,
        // пришедшими вторым источником. Признак читается у **заказанного** типа (ADR 0100 §1), а
        // не у типа машины листа: как ведётся заказ, решает заказ, а не подобранная под него
        // единица.
        //
        // Плата названа прямо: номер выписанного по требованию ЭСМ-2 в письме не печатается вовсе.
        // Он про моточасы недели, а сводка отвечает на вопрос «кто и чем работает в эти дни», и
        // ответ на него уже дали дни; за номером идут в журнал листов или в карточку заявки —
        // ссылка на неё стоит в той же строке.
        //
        // Режим спрашивается у заявки, а не у справочника: заявку могло застать переключение
        // (миграция 0137), и вести её до конца работы полагается прежним режимом.
        eq(requestIsLinearSql(vehicleRequests.isLinearFrozen, orderedType.isLinear), false),
        vehicleRequestScope(ctx),
      ),
    )
    .orderBy(asc(constructionObjects.name), asc(waybills.periodFrom));

  return rows.map((r): OnsiteRow => {
    // Период печатается пересечённым с окном: лист выписан на неделю, а письмо говорит про свои
    // дни, и «10–16 августа» в сводке на среду отвечает не на тот вопрос, который задан.
    const from = r.periodFrom && r.periodFrom > ctx.windowFrom ? r.periodFrom : ctx.windowFrom;
    const to = r.periodTo && r.periodTo < ctx.windowTo ? r.periodTo : ctx.windowTo;
    return {
      objectName: r.objectName ?? '',
      from,
      cells: [
        cell(waybillDisplayNumber(r.prefix, r.number, r.numberWidth), {
          href: portalLink(waybillPath(waybillDisplayNumber(r.prefix, r.number, r.numberWidth))),
          sub: humanRange(from, to),
        }),
        cell(`${formatVehicleRequestNumber(r.requestNum)} · ${onsiteCustomerName(r)}`, {
          href: portalLink(
            vehicleRequestPath({ id: r.requestId, status: r.requestStatus, deleted: false }),
          ),
        }),
        machineCell(r),
        personCell(r.driverName, r.driverPhone, 'машинист не назначен'),
        cell(r.objectAddress ?? ''),
        personCell(r.responsibleName ?? '', r.responsiblePhone ?? '', ''),
        cell(r.comment),
      ],
    };
  });
}

/**
 * Второй источник: дни линейных заказов, попавшие в окно (ADR 0100 §12).
 *
 * Единственное место письма, где строка стоит без документа, и это осознанная плата. У линейного
 * заказа недельного листа может не быть вовсе — ЭСМ-2 ему выписывают по требованию, — а работа
 * идёт днями: день кладётся в маршрут дня (`vehicle_route_requests.work_date`, миграция 0127) и
 * печатается в 4-П этого рейса. Отбор по листам потерял бы такой заказ целиком и молча; день, на
 * который лист ещё не выписан, показывается номером рейса с пометкой — в этом и польза сводки,
 * видно, что машина завтра выйдет без бумаги.
 *
 * **Область видимости считается по заявке** (`vehicleRequestScope`), а не по документу, как во
 * всём остальном письме. Иначе никак: документа у дня может не быть, и «область по листу» дала бы
 * выбор из двух неправд — потерять день без бумаги или показать площадку, которой человек не
 * видит. Заявка отвечает на этот вопрос всегда и тем же условием, каким ограничен список в портале.
 */
async function linearDayRows(ctx: DigestContext): Promise<OnsiteRow[]> {
  const rows = await db
    .select({
      workDate: vehicleRouteRequests.workDate,
      routeId: vehicleRoutes.id,
      routeNum: vehicleRoutes.num,
      waybillNumber: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      requestId: vehicleRequests.id,
      requestNum: vehicleRequests.num,
      requestStatus: vehicleRequests.status,
      comment: vehicleRequests.comment,
      // Объект — идентификатором и кодом наравне с наименованием (Р25), как и у недельных листов.
      objectId: vehicleRequests.objectId,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      responsibleName: specialEquipmentRequestDetails.responsibleName,
      responsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
      driverPersonId: vehicleRoutes.driverPersonId,
      driverName: persons.fullName,
      driverPhone: persons.phone,
      vehicleId: vehicles.id,
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      modelName: vehicleModels.name,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
    })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRoutes, eq(vehicleRoutes.id, vehicleRouteRequests.routeId))
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    // Машина и водитель — рейса, а не назначения (ADR 0100 §4): назначение у линейного заказа это
    // машина по умолчанию, а на объект во вторник выехала та, что стоит в рейсе вторника.
    // Водителя может не быть вовсе — рейс собирают заранее, человека ставят утром.
    .leftJoin(persons, eq(persons.id, vehicleRoutes.driverPersonId))
    .innerJoin(vehicles, eq(vehicles.id, vehicleRoutes.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    // Действующий лист дня. Join, а не `EXISTS`, как у перевозок: там строка нужна одна и лишь бы
    // лист был, здесь в графу печатается его номер. Задвоить строку join не может — действующий
    // лист на рейс один (`waybills_route_unique`), аннулированные отсеяны условием.
    .leftJoin(
      waybills,
      and(eq(waybills.routeId, vehicleRoutes.id), ne(waybills.status, 'cancelled')),
    )
    .leftJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(
      and(
        // Дни окна. Строки грузоперевозок отсеиваются самим сравнением: `work_date` у них NULL, и
        // отдельного «день заполнен» не требуется.
        gte(vehicleRouteRequests.workDate, ctx.windowFrom),
        lte(vehicleRouteRequests.workDate, ctx.windowTo),
        // Отменённая заявка остаётся в рейсе, пока её день держит выписанный лист (сверка дней его
        // не снимает — бланк уже у водителя), но ехать по ней не надо: то же правило, что и в
        // таблице перевозок.
        ne(vehicleRequests.status, 'cancelled'),
        vehicleRequestScope(ctx),
      ),
    )
    .orderBy(asc(constructionObjects.name), asc(vehicleRouteRequests.workDate));

  /*
   * Строка — пара «заявка + машина дня» (ADR 0100 §4). Не строка на день: неделя одной машины на
   * одной площадке это одна работа, и пять строк подряд с одинаковыми объектом, машиной и
   * ответственным читаются как пять разных заказов. И не строка на заявку: дни закрывают разные
   * единицы, а склеив их, письмо назвало бы машину, которой во вторник на объекте не было.
   */
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.requestId}|${row.vehicleId}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.values()].map((days): OnsiteRow => {
    const first = days[0]!;
    // Документы идут тем же порядком, что и дни в подписи под ними: читатель складывает номер с
    // датой глазами, и разойдись эти два перечня — сложил бы неверно.
    const documents = days.map((day) =>
      day.waybillNumber === null
        ? // Лист дня ещё не выписан. Номер рейса вместо прочерка — по нему день и находят в
          // портале, а пометка называет то, ради чего сводку и читают накануне выезда.
          `${formatVehicleRouteNumber(day.routeNum)} (лист не выписан)`
        : waybillDisplayNumber(day.prefix!, day.waybillNumber, day.numberWidth!),
    );
    // Ссылка — только у строки одного дня: у нескольких дней документов несколько, а адрес у ячейки
    // один, и «какой-нибудь» из них увёл бы читателя не в тот документ. Заявка при этом остаётся
    // ссылкой в соседней графе — из её карточки видны все дни.
    const href =
      days.length > 1
        ? undefined
        : first.waybillNumber === null
          ? portalLink(vehicleRoutePath(first.routeId))
          : portalLink(waybillPath(documents[0]!));

    return {
      objectName: first.objectName ?? '',
      from: first.workDate!,
      cells: [
        cell(documents.join(', '), { href, sub: humanDays(days.map((day) => day.workDate!)) }),
        cell(`${formatVehicleRequestNumber(first.requestNum)} · ${onsiteCustomerName(first)}`, {
          href: portalLink(
            vehicleRequestPath({
              id: first.requestId,
              status: first.requestStatus,
              deleted: false,
            }),
          ),
        }),
        machineCell(first),
        driversCell(days),
        cell(first.objectAddress ?? ''),
        personCell(first.responsibleName ?? '', first.responsiblePhone ?? '', ''),
        cell(first.comment),
      ],
    };
  });
}

/**
 * Машинисты строки дней. У линейного заказа водитель у каждого дня свой (ADR 0100 §6), и на паре
 * «заявка + машина» их бывает несколько: тогда печатаются имена без телефона — номер, приписанный
 * к списку из двух человек, читается как номер обоих сразу.
 */
function driversCell(
  days: { driverPersonId: string | null; driverName: string | null; driverPhone: string | null }[],
): MailTableCell {
  const drivers = new Map<string, { name: string; phone: string }>();
  for (const day of days) {
    if (!day.driverPersonId) continue;
    drivers.set(day.driverPersonId, { name: day.driverName ?? '', phone: day.driverPhone ?? '' });
  }
  const names = [...drivers.values()];
  // Один на все дни — с телефоном: звонить в сводке именно по нему. Пусто — человека на день ещё
  // не поставили: рейс собирают заранее, водителя называют утром.
  if (names.length === 1) {
    return personCell(names[0]!.name, names[0]!.phone, 'машинист не назначен');
  }
  return cell(names.map((driver) => driver.name).join(', ') || 'машинист не назначен');
}

/** «10–16 августа» либо «12 августа»: период работ читается диапазоном, а не парой дат. */
function humanRange(from: string, to: string): string {
  return from === to ? humanDay(from) : `${dayNumber(from)}–${humanDay(to)}`;
}

/**
 * «21, 22 сентября» — дни линейного заказа перечнем, а не диапазоном: между вторником и четвергом
 * машина работает в другом месте, и «21–24 сентября» сказало бы про площадку неправду. Месяц
 * называется у последнего дня и у всякого, за которым следующий день уже в другом месяце: иначе
 * «31, 1 октября» прочиталось бы как тридцать первое октября.
 */
function humanDays(dates: string[]): string {
  return dates
    .map((date, i) => {
      const next = dates[i + 1];
      return next && next.slice(0, 7) === date.slice(0, 7) ? dayNumber(date) : humanDay(date);
    })
    .join(', ');
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
