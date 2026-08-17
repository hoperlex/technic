import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import {
  type DriverAssignmentAction,
  type DriverAssignmentContact,
  type DriverAssignmentPoint,
  formatPhone,
} from '@technic/contracts';
import { db } from '../../db/client';
import { persons, vehicleRoutes } from '../../db/schema';
import { type DriverRouteEntry, loadRouteEntries } from '../driver-assignment';
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
 *
 * Сами рейсы собирает общий слой задания (`services/driver-assignment.ts`, план Р12) — тот же, из
 * которого читает кабинет водителя: увидеть в письме и в кабинете разные задания на один день
 * человек не должен. Здесь остаётся только представление: блоки, порядок и слова письма. Недельные
 * листы ЭСМ-2 в него не идут — рассылка ходит к водителям рейсов, а не к машинистам.
 *
 * С этапа 8 плана `docs/route-trips-plan.md` рейс печатается **порядком объезда**: блок на
 * остановку, а не на заявку. Порядок берётся готовым — позициями точек, — и своего у письма нет:
 * разойдись оно с кабинетом, водитель поехал бы по одному маршруту, а сдавал по другому.
 */

/**
 * Кто встречает машину на остановке. Метки роли у контакта больше нет и быть не может: точка
 * дедуплицирует ответственных по телефону (Р9), и один человек законно отвечает и за погрузку
 * чужой ездки, и за выгрузку своей. Что здесь делают, сказано строкой выше — ролями точки, а
 * встречают приехавшего эти люди независимо от того, чью ездку он грузит.
 */
function contactLine(contacts: DriverAssignmentContact[]): string {
  return contacts
    .map((c) => [c.name, c.phone ? formatPhone(c.phone) : ''].filter(Boolean).join(', '))
    .join(' · ');
}

/** «Грузим: ТС-40/1 · ООО „Ромашка“ · 12 м³» — что на этой остановке делают с этой строкой. */
function actionLine(action: DriverAssignmentAction): string {
  const what = [action.displayNumber, action.customerName, action.cargoLabel]
    .filter(Boolean)
    .join(' · ');
  return `${action.roleLabel}: ${what}`;
}

/**
 * Остановка порядка объезда: куда приехать, во сколько, что здесь делать и кому звонить.
 *
 * Комментарии печатаются целиком — и строки, и точки. В бланке комментарий отбрасывается первым
 * при нехватке места (Р11а), и письмо есть ровно то место, где он обязан быть: «звонить за час до
 * выезда» важнее аккуратной колонки, а ширины колонки здесь и нет.
 *
 * Комментарий строки стоит **рядом со своей ролью**, а не общим списком под точкой: на совмещённой
 * остановке две ездки, и «песок, звонить за час» относится к одной из них. Своей строкой под своим
 * действием он адресован; сваленный в кучу — угадывается.
 */
function pointBlock(point: DriverAssignmentPoint): MailBlock {
  const head = [`Точка ${point.position}`, point.arrivalTime, point.location].filter(Boolean);
  const lines = [head.join(' · ')];
  for (const action of point.actions) {
    lines.push(actionLine(action));
    if (action.comment) lines.push(`Примечание: ${action.comment}`);
  }
  if (point.contacts.length > 0) lines.push(`Встречает: ${contactLine(point.contacts)}`);
  if (point.comment) lines.push(`На точке: ${point.comment}`);
  return { kind: 'lines', lines };
}

function relocationBlocks(entry: DriverRouteEntry): MailBlock[] {
  const lines = [`Откуда: ${entry.moveFrom}`, `Куда: ${entry.moveTo}`];
  if (entry.basisLabel) lines.push(`Основание: ${entry.basisLabel}`);
  return [{ kind: 'lines', lines }];
}

/**
 * Само задание: порядок объезда, а у перегона — «откуда/куда». Третьего исхода быть не должно, но
 * он бывает: заявки в рейсе есть, а точек им ещё не разложили. Письмо уходит вечером накануне,
 * когда диспетчер маршрут может и не дособрать, и промолчать здесь — худший из ходов: рейс с
 * машиной и без единого адреса водитель прочтёт как «адреса не прислали».
 *
 * Кабинету этой оговорки не нужно, и это не расхождение каналов: он показывает только рейсы с
 * выписанным листом (Р5), а лист по неразложенным строкам не выписывается вовсе (`rows_unplaced`).
 */
function taskBlocks(entry: DriverRouteEntry): MailBlock[] {
  if (entry.relocation) return relocationBlocks(entry);
  if (entry.points.length > 0) return entry.points.map(pointBlock);
  return [{ kind: 'paragraph', text: 'Порядок объезда ещё не собран — уточните у диспетчера.' }];
}

function routeBlocks(entry: DriverRouteEntry): MailBlock[] {
  const head = [`Машина: ${entry.vehicleLabel}`];
  if (entry.garageNumber) head.push(`Гаражный номер: ${entry.garageNumber}`);
  if (entry.trailerLabel) head.push(`Прицеп: ${entry.trailerLabel}`);

  const blocks: MailBlock[] = [
    { kind: 'heading', text: `Рейс ${entry.sourceLabel} · ${entry.purposeLabel}` },
    { kind: 'lines', lines: head },
  ];
  blocks.push(...taskBlocks(entry));
  // Комментарий рейса — это то, что диспетчер написал водителю, а не заказчику: он идёт последним,
  // после задания, потому что относится ко всему рейсу.
  if (entry.comment) blocks.push({ kind: 'paragraph', text: `Комментарий: ${entry.comment}` });
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
 * Какие рейсы и какие заявки в задание входят, решает общий слой: отменённые и удалённые заявки
 * туда не попадают, а грузовой рейс без единой живой заявки не показывается вовсе.
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
  const byDate = await loadRouteEntries(input.personId, input.dateFrom, input.dateTo);
  // Исключённая дата рейса — не то же самое, что исключённая дата запуска: рассылка уходит, но
  // рейсы этого дня в неё не входят (объект закрыт, работы остановлены).
  const dates = [...byDate.keys()].filter((date) => !input.excludedRouteDates?.includes(date));
  if (dates.length === 0) return null;

  const blocks: MailBlock[] = [];
  let routeCount = 0;
  for (const date of dates) {
    const ofDate = byDate.get(date) ?? [];
    routeCount += ofDate.length;
    // Заголовок даты нужен, только когда окно шире суток: у письма «на завтра» дата уже в теме.
    if (dates.length > 1) blocks.push({ kind: 'heading', text: humanDate(date) });
    for (const entry of ofDate) blocks.push(...routeBlocks(entry));
  }

  const first = dates[0]!;
  const count = `${routeCount} ${plural(routeCount)}`;
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
    routeCount,
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
