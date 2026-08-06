import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import {
  formatMoscowDateTime,
  formatPhone,
  isRelocationPurpose,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
} from '@technic/contracts';
import { db } from '../../db/client';
import {
  freightTransportRequestDetails,
  persons,
  specialEquipmentRequestDetails,
  vehicleRequests,
  vehicleRoutes,
} from '../../db/schema';
import { loadRouteDtos, routeQuery } from '../vehicle-routes';
import type { MailBlock, MailContent } from '../mail-templates';

/**
 * Плановое задание водителю: его рейсы на дату (или на несколько дат) одним письмом.
 *
 * Одно письмо на человека, а не на рейс: водитель читает его перед выездом, и три отдельных
 * письма про один день он разложит по порядку сам — или не разложит.
 *
 * Ссылок на портал в письме нет намеренно: у водителя может не быть учётной записи вовсе
 * (`persons`, а не `users`), и письмо обязано читаться целиком в почте, в том числе с телефона.
 * По той же причине здесь нет ни цен, ни данных чужих рейсов.
 */

/** Контакты и комментарий заявки: в DTO состава рейса их нет, а водителю звонить именно им. */
interface RequestExtra {
  comment: string;
  /** Кого набирать: у грузоперевозки — на погрузке и на выгрузке, у объекта — встречающий. */
  contacts: { label: string; name: string; phone: string }[];
}

async function requestExtras(requestIds: string[]): Promise<Map<string, RequestExtra>> {
  const map = new Map<string, RequestExtra>();
  if (requestIds.length === 0) return map;

  // Обе detail-таблицы разом: тип заявки заранее неизвестен, а join'ы левые — у заявки заполнена
  // ровно одна из них.
  const rows = await db
    .select({
      id: vehicleRequests.id,
      comment: vehicleRequests.comment,
      loadingName: freightTransportRequestDetails.loadingResponsibleName,
      loadingPhone: freightTransportRequestDetails.loadingResponsiblePhone,
      unloadingName: freightTransportRequestDetails.unloadingResponsibleName,
      unloadingPhone: freightTransportRequestDetails.unloadingResponsiblePhone,
      siteName: specialEquipmentRequestDetails.responsibleName,
      sitePhone: specialEquipmentRequestDetails.responsiblePhone,
    })
    .from(vehicleRequests)
    .leftJoin(
      freightTransportRequestDetails,
      eq(freightTransportRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .where(inArray(vehicleRequests.id, requestIds));

  for (const row of rows) {
    const contacts = [
      { label: 'Погрузка', name: row.loadingName ?? '', phone: row.loadingPhone ?? '' },
      { label: 'Выгрузка', name: row.unloadingName ?? '', phone: row.unloadingPhone ?? '' },
      { label: 'На месте', name: row.siteName ?? '', phone: row.sitePhone ?? '' },
      // Контакт без имени и без телефона печатать нечем: у заявок, заведённых до появления этих
      // полей, они пустые.
    ].filter((c) => c.name !== '' || c.phone !== '');
    map.set(row.id, { comment: row.comment, contacts });
  }
  return map;
}

/** «08:30» или пусто, если у заявки время не задано: тогда значима только дата. */
function timeOf(request: VehicleRouteRequestDto): string {
  if (request.scheduledTimeUnspecified) return '';
  return formatMoscowDateTime(new Date(request.scheduledAt)).slice(-5);
}

/**
 * Контакт с указанием, где этого человека ждать. Без метки строки «Иванов И., +7…» и
 * «Петров П., +7…» выглядят одинаково, и кому из них звонить с погрузки, водитель угадывает по
 * порядку строк.
 */
function contactLines(extra: RequestExtra | undefined): string[] {
  if (!extra) return [];
  return extra.contacts.map((c) => {
    const who = [c.name, c.phone ? formatPhone(c.phone) : ''].filter(Boolean).join(', ');
    return `${c.label}: ${who}`;
  });
}

function freightBlocks(route: VehicleRouteDto, extras: Map<string, RequestExtra>): MailBlock[] {
  const blocks: MailBlock[] = [];
  for (const request of route.requests) {
    const extra = extras.get(request.requestId);
    const time = timeOf(request);
    const lines = [
      `${request.displayNumber} · ${request.customerName}`,
      `Погрузка: ${request.loadingLocation}${time ? `, ${time}` : ''}`,
      `Выгрузка: ${request.unloadingLocation}`,
    ];
    if (request.cargoLabel) lines.push(`Груз: ${request.cargoLabel}`);
    lines.push(...contactLines(extra));
    // Комментарий заявки печатается целиком: в бланке он режется по ширине графы, а в письме
    // резать его нечем и незачем — «звонить за час до выезда» важнее аккуратной колонки.
    if (extra?.comment) lines.push(`Примечание: ${extra.comment}`);
    blocks.push({ kind: 'lines', lines });
  }
  return blocks;
}

function relocationBlocks(route: VehicleRouteDto): MailBlock[] {
  const lines = [`Откуда: ${route.moveFrom}`, `Куда: ${route.moveTo}`];
  if (route.sourceRequest) {
    lines.push(
      `Основание: ${route.sourceRequest.displayNumber} · ${route.sourceRequest.customerName}`,
    );
  }
  return [{ kind: 'lines', lines }];
}

function routeBlocks(route: VehicleRouteDto, extras: Map<string, RequestExtra>): MailBlock[] {
  const purpose = isRelocationPurpose(route.purpose) ? 'Перегон техники' : 'Грузоперевозка';
  const head = [`Машина: ${route.vehicleLabel}`];
  if (route.garageNumber) head.push(`Гаражный номер: ${route.garageNumber}`);
  if (route.withTrailer && route.trailerLabel) head.push(`Прицеп: ${route.trailerLabel}`);

  const blocks: MailBlock[] = [
    { kind: 'heading', text: `Рейс ${route.displayNumber} · ${purpose}` },
    { kind: 'lines', lines: head },
  ];
  blocks.push(
    ...(isRelocationPurpose(route.purpose)
      ? relocationBlocks(route)
      : freightBlocks(route, extras)),
  );
  // Комментарий рейса — это то, что диспетчер написал водителю, а не заказчику: он идёт последним,
  // после состава, потому что относится ко всему рейсу.
  if (route.comment) blocks.push({ kind: 'paragraph', text: `Комментарий: ${route.comment}` });
  return blocks;
}

/** «7 августа (четверг)» — как дату называют вслух, а не «2026-08-07». */
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
const WEEKDAYS = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
];

export function humanDate(dateOnly: string, withWeekday = true): string {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const head = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return withWeekday ? `${head} (${WEEKDAYS[date.getUTCDay()]})` : head;
}

export interface DriverRoutesMail {
  subject: string;
  content: MailContent;
  /** Сколько рейсов вошло в письмо: по нему считается статистика запуска. */
  routeCount: number;
}

/**
 * Собирает письмо с заданием. `null` — рейсов в окне нет: пустое письмо не отправляется, потому
 * что «сегодня заданий нет» водителю сообщает диспетчер, а не рассылка.
 *
 * Отменённые и удалённые заявки в письмо не попадают: они остаются в маршруте историей рейса
 * (лист уже выписан), но ехать по ним не надо, и печатать их — вводить водителя в заблуждение.
 */
export async function buildDriverRoutesMail(input: {
  personId: string;
  driverName: string;
  /** Окно дат включительно: обычно «завтра — завтра+N». */
  dateFrom: string;
  dateTo: string;
  /** Даты рейсов, которые в письмо не включаются: выходные объекта, остановка работ. */
  excludedRouteDates?: string[];
}): Promise<DriverRoutesMail | null> {
  const rows = await routeQuery(db)
    .where(
      and(
        eq(vehicleRoutes.driverPersonId, input.personId),
        gte(vehicleRoutes.routeDate, input.dateFrom),
        lte(vehicleRoutes.routeDate, input.dateTo),
      ),
    )
    .orderBy(asc(vehicleRoutes.routeDate), asc(vehicleRoutes.num));
  if (rows.length === 0) return null;

  const routes = await loadRouteDtos(db, rows);
  // Живые заявки состава: `requestsByRoute` их не фильтрует — там состав как история рейса.
  const requestIds = routes.flatMap((r) => r.requests.map((q) => q.requestId));
  const alive = new Set(
    requestIds.length === 0
      ? []
      : (
          await db
            .select({ id: vehicleRequests.id })
            .from(vehicleRequests)
            .where(and(inArray(vehicleRequests.id, requestIds), isNull(vehicleRequests.deletedAt)))
        ).map((r) => r.id),
  );
  const visible = routes
    .map((route) => ({
      ...route,
      requests: route.requests.filter((q) => alive.has(q.requestId) && q.status !== 'cancelled'),
    }))
    // Грузовой рейс, у которого не осталось ни одной живой заявки, в письмо не идёт: ехать по нему
    // некуда, а строка «Машина: …» без задания сообщает водителю ровно ничего. Перегон остаётся
    // всегда — у него задание не в составе, а в «откуда/куда».
    .filter((route) => isRelocationPurpose(route.purpose) || route.requests.length > 0)
    // Исключённая дата рейса — не то же самое, что исключённая дата запуска: рассылка уходит, но
    // рейсы этого дня в неё не входят (объект закрыт, работы остановлены).
    .filter((route) => !input.excludedRouteDates?.includes(route.routeDate));
  if (visible.length === 0) return null;

  const extras = await requestExtras([...alive]);

  const blocks: MailBlock[] = [];
  const dates = [...new Set(visible.map((r) => r.routeDate))];
  for (const date of dates) {
    const ofDate = visible.filter((r) => r.routeDate === date);
    // Заголовок даты нужен, только когда окно шире суток: у письма «на завтра» дата уже в теме.
    if (dates.length > 1) blocks.push({ kind: 'heading', text: humanDate(date) });
    for (const route of ofDate) blocks.push(...routeBlocks(route, extras));
  }

  const first = dates[0]!;
  const count = `${visible.length} ${plural(visible.length)}`;
  const subject =
    dates.length > 1
      ? `Задание на ${humanDate(first, false)} — ${humanDate(dates[dates.length - 1]!, false)}: ${count}`
      : `Задание на ${humanDate(first, false)}: ${count}`;

  return {
    subject,
    content: {
      title: `${input.driverName}, задание на ${humanDate(first)}`,
      blocks,
      footer: 'Письмо отправлено порталом «Техник». Вопросы по заданию — диспетчеру.',
    },
    routeCount: visible.length,
  };
}

function plural(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'рейс';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'рейса';
  return 'рейсов';
}

/** Водители с рейсами в окне: по ним рассылка выбирает получателей, а отладка — образец. */
export async function driversWithRoutes(
  dateFrom: string,
  dateTo: string,
): Promise<{ personId: string; fullName: string; email: string }[]> {
  const rows = await db
    .selectDistinct({
      personId: vehicleRoutes.driverPersonId,
      fullName: persons.fullName,
      email: persons.email,
    })
    .from(vehicleRoutes)
    .innerJoin(persons, eq(persons.id, vehicleRoutes.driverPersonId))
    .where(
      and(
        gte(vehicleRoutes.routeDate, dateFrom),
        lte(vehicleRoutes.routeDate, dateTo),
        isNull(persons.deletedAt),
      ),
    )
    .orderBy(asc(persons.fullName));
  return rows.filter((r): r is { personId: string; fullName: string; email: string } =>
    Boolean(r.personId),
  );
}
