import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import {
  type DriverAssignmentContact,
  type DriverAssignmentRequest,
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
 */

/**
 * Контакт с указанием, где этого человека ждать. Без метки строки «Иванов И., +7…» и
 * «Петров П., +7…» выглядят одинаково, и кому из них звонить с погрузки, водитель угадывает по
 * порядку строк.
 */
function contactLines(contacts: DriverAssignmentContact[]): string[] {
  return contacts.map((c) => {
    const who = [c.name, c.phone ? formatPhone(c.phone) : ''].filter(Boolean).join(', ');
    return `${c.label}: ${who}`;
  });
}

function requestBlock(request: DriverAssignmentRequest): MailBlock {
  const lines = [
    `${request.displayNumber} · ${request.customerName}`,
    `Погрузка: ${request.loadingLocation}${request.time ? `, ${request.time}` : ''}`,
    `Выгрузка: ${request.unloadingLocation}`,
  ];
  if (request.cargoLabel) lines.push(`Груз: ${request.cargoLabel}`);
  lines.push(...contactLines(request.contacts));
  // Комментарий заявки печатается целиком: в бланке он режется по ширине графы, а в письме
  // резать его нечем и незачем — «звонить за час до выезда» важнее аккуратной колонки.
  if (request.comment) lines.push(`Примечание: ${request.comment}`);
  return { kind: 'lines', lines };
}

function relocationBlocks(entry: DriverRouteEntry): MailBlock[] {
  const lines = [`Откуда: ${entry.moveFrom}`, `Куда: ${entry.moveTo}`];
  if (entry.basisLabel) lines.push(`Основание: ${entry.basisLabel}`);
  return [{ kind: 'lines', lines }];
}

function routeBlocks(entry: DriverRouteEntry): MailBlock[] {
  const head = [`Машина: ${entry.vehicleLabel}`];
  if (entry.garageNumber) head.push(`Гаражный номер: ${entry.garageNumber}`);
  if (entry.trailerLabel) head.push(`Прицеп: ${entry.trailerLabel}`);

  const blocks: MailBlock[] = [
    { kind: 'heading', text: `Рейс ${entry.sourceLabel} · ${entry.purposeLabel}` },
    { kind: 'lines', lines: head },
  ];
  blocks.push(...(entry.relocation ? relocationBlocks(entry) : entry.requests.map(requestBlock)));
  // Комментарий рейса — это то, что диспетчер написал водителю, а не заказчику: он идёт последним,
  // после состава, потому что относится ко всему рейсу.
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
