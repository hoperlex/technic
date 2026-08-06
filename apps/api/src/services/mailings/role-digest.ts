import { and, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import {
  DIGEST_UPCOMING_DAYS,
  type DigestSection,
  digestSectionLabels,
  type MailingPeriodicity,
} from '@technic/contracts';
import { db } from '../../db/client';
import {
  mailingScheduleExcludedScopes,
  mailingScheduleExcludedUsers,
  mailingScheduleRoles,
  mailingScheduleSections,
  users,
} from '../../db/schema';
import { loadPrincipal } from '../../auth/principal';
import type { MailBlock, MailContent } from '../mail-templates';
import { type DigestContext, sectionAllowed } from './digest-context';
import { DIGEST_PROVIDERS } from './digest-sections';
import { addDays, isoWeekday, localDate } from './schedule';
import { humanDate } from './driver-routes';

/**
 * Ролевой дайджест (ADR 0078): сводка о том, что произошло за период, каждому получателю — своя.
 *
 * Письмо у каждого разное, и это главное свойство: одни и те же разделы под разными людьми
 * возвращают разные строки, потому что собираются их собственной областью видимости. Роль в
 * расписании отвечает только на вопрос «кому отправлять», а «что показать» решает `Principal`.
 *
 * Пустое письмо не отправляется. «За вчера ничего не произошло» — это не новость, ради которой
 * стоит писать человеку каждый день: такие письма перестают читать, и вместе с ними перестают
 * читать непустые.
 */

/** Получатель сводки: адрес и имя нужны письму, id — сборке его области видимости. */
export interface DigestRecipient {
  userId: string;
  fullName: string;
  email: string;
}

/**
 * Кому уходит сводка по этому расписанию.
 *
 * Условие получателя: действующая учётка с ролью из набора и **подтверждённым адресом**. Адрес без
 * подтверждения (ADR 0072) означает, что за ним может не быть человека, а сводка — это рабочие
 * данные компании: слать их «куда-то» нельзя.
 */
export async function digestRecipients(scheduleId: string): Promise<DigestRecipient[]> {
  const roles = await db
    .select({ role: mailingScheduleRoles.role })
    .from(mailingScheduleRoles)
    .where(eq(mailingScheduleRoles.scheduleId, scheduleId));
  if (roles.length === 0) return [];

  const excluded = (
    await db
      .select({ userId: mailingScheduleExcludedUsers.userId })
      .from(mailingScheduleExcludedUsers)
      .where(eq(mailingScheduleExcludedUsers.scheduleId, scheduleId))
  ).map((r) => r.userId);

  const rows = await db
    .select({ userId: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(
      and(
        inArray(
          users.role,
          roles.map((r) => r.role),
        ),
        eq(users.isActive, true),
        isNull(users.deletedAt),
        isNotNull(users.emailVerifiedAt),
        excluded.length > 0 ? notInArray(users.id, excluded) : undefined,
      ),
    );
  return rows;
}

/** Разделы расписания в заданном администратором порядке. */
export async function digestSectionsOf(scheduleId: string): Promise<DigestSection[]> {
  const rows = await db
    .select({ section: mailingScheduleSections.section })
    .from(mailingScheduleSections)
    .where(eq(mailingScheduleSections.scheduleId, scheduleId))
    .orderBy(mailingScheduleSections.position);
  // Незнакомый ключ мог остаться от снятого раздела: реестр закрытый, и провайдера у него нет.
  return rows.map((r) => r.section).filter((s): s is DigestSection => s in DIGEST_PROVIDERS);
}

/** Исключённые администратором области: вычитаются из области каждого получателя. */
export async function digestExcludedScopes(
  scheduleId: string,
): Promise<{ objectIds: string[]; departmentIds: string[] }> {
  const rows = await db
    .select({
      objectId: mailingScheduleExcludedScopes.objectId,
      departmentId: mailingScheduleExcludedScopes.departmentId,
    })
    .from(mailingScheduleExcludedScopes)
    .where(eq(mailingScheduleExcludedScopes.scheduleId, scheduleId));
  return {
    objectIds: rows.flatMap((r) => (r.objectId ? [r.objectId] : [])),
    departmentIds: rows.flatMap((r) => (r.departmentId ? [r.departmentId] : [])),
  };
}

/**
 * Период событий запуска.
 *
 * Ежедневная сводка — за предыдущий полный день, недельная — за предыдущую полную неделю с
 * понедельника по воскресенье. Полный, а не «последние сутки»: письмо, отправленное в 8 утра,
 * говорит о вчерашнем дне целиком, а не о промежутке «вчера 8:00 — сегодня 8:00», который человек
 * не сможет соотнести ни с чем.
 */
export function digestPeriod(
  plannedAt: Date,
  periodicity: MailingPeriodicity,
  timeZone: string,
): { start: string; end: string } {
  const today = localDate(plannedAt, timeZone);
  if (periodicity === 'daily') {
    const yesterday = addDays(today, -1);
    return { start: yesterday, end: yesterday };
  }
  // Понедельник текущей недели минус семь дней — начало прошлой; конец — воскресенье перед ним.
  const mondayThisWeek = addDays(today, -(isoWeekday(today) - 1));
  const start = addDays(mondayThisWeek, -7);
  return { start, end: addDays(start, 6) };
}

/** Горизонт разделов «ближайшие»: от дня запуска вперёд, включая сам день. */
export function digestUpcoming(plannedAt: Date, timeZone: string): { from: string; to: string } {
  const today = localDate(plannedAt, timeZone);
  return { from: today, to: addDays(today, DIGEST_UPCOMING_DAYS) };
}

export interface RoleDigestMail {
  subject: string;
  content: MailContent;
  /** Сколько разделов оказалось непустыми: по нему видно, ради чего письмо отправлено. */
  sectionCount: number;
}

/**
 * Собирает сводку для одного получателя. `null` — показывать нечего: либо учётка не действует,
 * либо все разделы под его областью пусты.
 */
export async function buildRoleDigestMail(input: {
  recipient: DigestRecipient;
  sections: DigestSection[];
  periodStart: string;
  periodEnd: string;
  upcomingFrom: string;
  upcomingTo: string;
  excludedObjectIds: string[];
  excludedDepartmentIds: string[];
  periodicity: MailingPeriodicity;
}): Promise<RoleDigestMail | null> {
  // Principal читается в момент сборки, а не берётся из кэша: область видимости меняют правкой
  // учётки, и вчерашний набор объектов сегодня уже может быть другим.
  const principal = await loadPrincipal(input.recipient.userId);
  if (!principal) return null;

  const ctx: DigestContext = {
    principal,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    upcomingFrom: input.upcomingFrom,
    upcomingTo: input.upcomingTo,
    excludedObjectIds: input.excludedObjectIds,
    excludedDepartmentIds: input.excludedDepartmentIds,
  };

  const blocks: MailBlock[] = [];
  let sectionCount = 0;

  for (const section of input.sections) {
    // Раздел, который человеку не положен, не собирается вовсе: «пусто» и «нельзя» — разные вещи,
    // и путать их значит когда-нибудь показать чужие данные из-за одной забытой проверки.
    if (!sectionAllowed(section, principal)) continue;

    const result = await DIGEST_PROVIDERS[section](ctx);
    if (!result || result.total === 0) continue;

    sectionCount += 1;
    blocks.push({ kind: 'heading', text: `${result.title} — ${result.total}` });
    if (result.rows.length > 0) {
      blocks.push({ kind: 'list', items: result.rows.map((r) => r.text) });
    }
    // Строк в письме меньше, чем записей: остальное — счётчиком и ссылкой, иначе сводка
    // превращается в выгрузку всей базы.
    if (result.total > result.rows.length) {
      const rest = result.total - result.rows.length;
      blocks.push({ kind: 'paragraph', text: `…и ещё ${rest} — смотреть в портале` });
    }
    if (result.link) {
      blocks.push({ kind: 'link', href: result.link, label: digestSectionLabels[section] });
    }
  }

  if (sectionCount === 0) return null;

  const periodLabel =
    input.periodStart === input.periodEnd
      ? `за ${humanDate(input.periodStart, false)}`
      : `за неделю ${humanDate(input.periodStart, false)} — ${humanDate(input.periodEnd, false)}`;

  return {
    subject: `Сводка ${periodLabel}`,
    content: {
      title: `Сводка ${periodLabel}`,
      blocks,
      footer: 'Письмо отправлено порталом «Техник». Состав сводки настраивает администратор.',
    },
    sectionCount,
  };
}
