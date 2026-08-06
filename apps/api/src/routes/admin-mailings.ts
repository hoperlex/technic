import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  createMailingScheduleSchema,
  DIGEST_SECTIONS,
  type DigestSection,
  type MailingPeriodicity,
  type MailingRunDto,
  mailingRunListQuerySchema,
  type MailingScheduleDto,
  type Role,
  updateMailingScheduleSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  mailingRuns,
  mailingScheduleExcludedDates,
  mailingScheduleExcludedPersons,
  mailingScheduleExcludedScopes,
  mailingScheduleExcludedUsers,
  mailingScheduleRoles,
  mailingSchedules,
  mailingScheduleSections,
  persons,
  users,
} from '../db/schema';
import { config } from '../config';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams } from '../lib/pagination';
import { nextRunAt } from '../services/mailings/schedule';
import { createRun, performRun } from '../services/mailings/run';

/**
 * Расписания рассылок и их история (ADR 0075).
 *
 * Настройка живёт в БД, а не в `env`: время отправки, окно дат и исключения меняет администратор,
 * и правка `env` означала бы перезапуск сервиса руками того, у кого есть доступ к серверу.
 *
 * Отладочная отправка письма лежит рядом, но отдельно (`admin-mail.ts`): она отвечает на вопрос
 * «как письмо выглядит в почтовом клиенте», а здесь — «кому и когда оно уходит само».
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ScheduleRow = typeof mailingSchedules.$inferSelect;

const idParams = z.object({ id: z.string().uuid() });

/**
 * Всё, что хранится у расписания отдельными строками: исключения (ADR 0075) и настройки сводки
 * (ADR 0078). Собираются и заменяются вместе — расписание правится целиком, одной формой.
 */
interface ScheduleSettings {
  excludedRunDates: string[];
  excludedRouteDates: string[];
  excludedPersonIds: string[];
  roles: Role[];
  sections: DigestSection[];
  excludedUserIds: string[];
  excludedObjectIds: string[];
  excludedDepartmentIds: string[];
}

/** Повтор в присланном списке означает ровно то же, что одна запись; первичный ключ — отказ БД. */
function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Ключ раздела лежит текстом (реестр закрыт контрактами, а не типом в БД), и в старой строке мог
 * остаться раздел, снятый с поддержки. В настройку он не возвращается: показывать и отправлять по
 * нему всё равно нечего, а править расписание с непонятным пунктом в списке администратор не смог
 * бы — схема правки такой ключ отвергнет.
 */
const KNOWN_SECTIONS = new Set<string>(DIGEST_SECTIONS);
function isDigestSection(value: string): value is DigestSection {
  return KNOWN_SECTIONS.has(value);
}

/** Порядок дней смысла не несёт, а набор читают глазами — и в форме, и в списке расписаний. */
function sortedWeekdays(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Настройки сразу всех расписаний: наборов много, а самих расписаний в портале единицы. */
async function settingsByScheduleId(ids: string[]): Promise<Map<string, ScheduleSettings>> {
  const map = new Map<string, ScheduleSettings>();
  if (ids.length === 0) return map;

  const of = (scheduleId: string): ScheduleSettings => {
    const found = map.get(scheduleId) ?? {
      excludedRunDates: [],
      excludedRouteDates: [],
      excludedPersonIds: [],
      roles: [],
      sections: [],
      excludedUserIds: [],
      excludedObjectIds: [],
      excludedDepartmentIds: [],
    };
    map.set(scheduleId, found);
    return found;
  };

  const dates = await db
    .select({
      scheduleId: mailingScheduleExcludedDates.scheduleId,
      kind: mailingScheduleExcludedDates.kind,
      excludedOn: mailingScheduleExcludedDates.excludedOn,
    })
    .from(mailingScheduleExcludedDates)
    .where(inArray(mailingScheduleExcludedDates.scheduleId, ids))
    .orderBy(asc(mailingScheduleExcludedDates.excludedOn));
  for (const row of dates) {
    const target = of(row.scheduleId);
    if (row.kind === 'run') target.excludedRunDates.push(row.excludedOn);
    else target.excludedRouteDates.push(row.excludedOn);
  }

  const people = await db
    .select({
      scheduleId: mailingScheduleExcludedPersons.scheduleId,
      personId: mailingScheduleExcludedPersons.personId,
    })
    .from(mailingScheduleExcludedPersons)
    .where(inArray(mailingScheduleExcludedPersons.scheduleId, ids))
    .orderBy(asc(mailingScheduleExcludedPersons.personId));
  for (const row of people) of(row.scheduleId).excludedPersonIds.push(row.personId);

  // Роли — в порядке самого типа `role`: сортировка по enum-колонке идёт по объявлению значений, а
  // объявлены они от администратора к наблюдателю, то есть тем же порядком, каким их показывает
  // портал. Алфавит по коду роли такого порядка не дал бы.
  const roles = await db
    .select({ scheduleId: mailingScheduleRoles.scheduleId, role: mailingScheduleRoles.role })
    .from(mailingScheduleRoles)
    .where(inArray(mailingScheduleRoles.scheduleId, ids))
    .orderBy(asc(mailingScheduleRoles.role));
  for (const row of roles) of(row.scheduleId).roles.push(row.role);

  // Разделы — по `position`: порядок здесь и есть настройка, ею задан порядок печати в письме.
  const sections = await db
    .select({
      scheduleId: mailingScheduleSections.scheduleId,
      section: mailingScheduleSections.section,
    })
    .from(mailingScheduleSections)
    .where(inArray(mailingScheduleSections.scheduleId, ids))
    .orderBy(asc(mailingScheduleSections.position));
  for (const row of sections) {
    if (isDigestSection(row.section)) of(row.scheduleId).sections.push(row.section);
  }

  const excludedUsers = await db
    .select({
      scheduleId: mailingScheduleExcludedUsers.scheduleId,
      userId: mailingScheduleExcludedUsers.userId,
    })
    .from(mailingScheduleExcludedUsers)
    .where(inArray(mailingScheduleExcludedUsers.scheduleId, ids))
    .orderBy(asc(mailingScheduleExcludedUsers.userId));
  for (const row of excludedUsers) of(row.scheduleId).excludedUserIds.push(row.userId);

  // Площадки и отделы лежат одной таблицей (в строке заполнено ровно одно из полей), а в настройку
  // расходятся двумя наборами: в форме это два разных справочника.
  const scopes = await db
    .select({
      scheduleId: mailingScheduleExcludedScopes.scheduleId,
      objectId: mailingScheduleExcludedScopes.objectId,
      departmentId: mailingScheduleExcludedScopes.departmentId,
    })
    .from(mailingScheduleExcludedScopes)
    .where(inArray(mailingScheduleExcludedScopes.scheduleId, ids))
    .orderBy(
      asc(mailingScheduleExcludedScopes.objectId),
      asc(mailingScheduleExcludedScopes.departmentId),
    );
  for (const row of scopes) {
    const target = of(row.scheduleId);
    if (row.objectId) target.excludedObjectIds.push(row.objectId);
    else if (row.departmentId) target.excludedDepartmentIds.push(row.departmentId);
  }

  return map;
}

function toDto(row: ScheduleRow, settings: ScheduleSettings | undefined): MailingScheduleDto {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    isEnabled: row.isEnabled,
    periodicity: row.periodicity,
    // `time` отдаётся драйвером как «18:00:00», а правится тем же полем формы, которое схема
    // принимает в виде «ЧЧ:ММ»: отдай как есть — и сохранение вернуло бы ошибку формата.
    sendAt: row.sendAt.slice(0, 5),
    weekday: row.weekday,
    runWeekdays: row.runWeekdays,
    windowFromDays: row.windowFromDays,
    windowToDays: row.windowToDays,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    excludedRunDates: settings?.excludedRunDates ?? [],
    excludedRouteDates: settings?.excludedRouteDates ?? [],
    excludedPersonIds: settings?.excludedPersonIds ?? [],
    roles: settings?.roles ?? [],
    sections: settings?.sections ?? [],
    excludedUserIds: settings?.excludedUserIds ?? [],
    excludedObjectIds: settings?.excludedObjectIds ?? [],
    excludedDepartmentIds: settings?.excludedDepartmentIds ?? [],
  };
}

/** Итоги запуска приходят из `jsonb` нетипизированными: всё, что не объект, — пустые итоги. */
function statsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toRunDto(row: typeof mailingRuns.$inferSelect): MailingRunDto {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    plannedAt: row.plannedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    stats: statsOf(row.stats),
    error: row.error,
    isManual: row.isManual,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadSchedule(
  id: string,
): Promise<{ row: ScheduleRow; dto: MailingScheduleDto } | null> {
  const [row] = await db.select().from(mailingSchedules).where(eq(mailingSchedules.id, id));
  if (!row) return null;
  const settings = await settingsByScheduleId([row.id]);
  return { row, dto: toDto(row, settings.get(row.id)) };
}

/**
 * Когда расписание сработает в следующий раз. Считается на каждой записи, а не при пробуждении
 * планировщика: просроченные он ищет одним условием по `next_run_at`, и пересчитывать поле
 * перебором всех строк значило бы завести второй, медленный способ узнать то же самое.
 *
 * У выключенного расписания времени нет вовсе — иначе планировщик разбудил бы выключенную
 * рассылку. Даты-исключения запуска участвуют в расчёте: праздник переносит срабатывание вперёд.
 */
function nextRunFor(v: {
  isEnabled: boolean;
  periodicity: MailingPeriodicity;
  sendAt: string;
  weekday: number | null | undefined;
  runWeekdays: number[];
  excludedRunDates: string[];
}): Date | null {
  if (!v.isEnabled) return null;
  return nextRunAt(
    {
      periodicity: v.periodicity,
      sendAt: v.sendAt,
      weekday: v.weekday ?? null,
      runWeekdays: v.runWeekdays,
      excludedDates: v.excludedRunDates,
    },
    new Date(),
    config.mail.timezone,
  );
}

/**
 * Наборы настроек заменяются целиком: они приходят списками, и складывать разницу по строкам
 * незачем. Замена идёт той же транзакцией, что и само расписание, — иначе между удалением старых
 * строк и вставкой новых расписание успело бы сработать с половиной настроек: без части ролей, с
 * половиной разделов или уже без исключённой площадки.
 */
async function replaceSettings(
  tx: Tx,
  scheduleId: string,
  v: Pick<
    MailingScheduleDto,
    | 'excludedRunDates'
    | 'excludedRouteDates'
    | 'excludedPersonIds'
    | 'roles'
    | 'sections'
    | 'excludedUserIds'
    | 'excludedObjectIds'
    | 'excludedDepartmentIds'
  >,
): Promise<void> {
  await tx
    .delete(mailingScheduleExcludedDates)
    .where(eq(mailingScheduleExcludedDates.scheduleId, scheduleId));
  await tx
    .delete(mailingScheduleExcludedPersons)
    .where(eq(mailingScheduleExcludedPersons.scheduleId, scheduleId));
  await tx.delete(mailingScheduleRoles).where(eq(mailingScheduleRoles.scheduleId, scheduleId));
  await tx
    .delete(mailingScheduleSections)
    .where(eq(mailingScheduleSections.scheduleId, scheduleId));
  await tx
    .delete(mailingScheduleExcludedUsers)
    .where(eq(mailingScheduleExcludedUsers.scheduleId, scheduleId));
  await tx
    .delete(mailingScheduleExcludedScopes)
    .where(eq(mailingScheduleExcludedScopes.scheduleId, scheduleId));

  const dates = [
    ...unique(v.excludedRunDates).map((excludedOn) => ({
      scheduleId,
      kind: 'run' as const,
      excludedOn,
    })),
    ...unique(v.excludedRouteDates).map((excludedOn) => ({
      scheduleId,
      kind: 'route' as const,
      excludedOn,
    })),
  ];
  if (dates.length > 0) await tx.insert(mailingScheduleExcludedDates).values(dates);

  const people = unique(v.excludedPersonIds).map((personId) => ({ scheduleId, personId }));
  if (people.length > 0) await tx.insert(mailingScheduleExcludedPersons).values(people);

  const roles = unique(v.roles).map((role) => ({ scheduleId, role }));
  if (roles.length > 0) await tx.insert(mailingScheduleRoles).values(roles);

  // Порядок присланного массива и есть порядок разделов в письме: нумеруем 1..N по месту в нём.
  // Хранить порядок отдельным полем приходится потому, что строки таблицы порядка не имеют.
  const sections = unique(v.sections).map((section, index) => ({
    scheduleId,
    section,
    position: index + 1,
  }));
  if (sections.length > 0) await tx.insert(mailingScheduleSections).values(sections);

  const excludedUsers = unique(v.excludedUserIds).map((userId) => ({ scheduleId, userId }));
  if (excludedUsers.length > 0) await tx.insert(mailingScheduleExcludedUsers).values(excludedUsers);

  // Площадки и отделы — одна таблица с заполненным ровно одним полем: так же, как заказчик заявки.
  const scopes = [
    ...unique(v.excludedObjectIds).map((objectId) => ({
      scheduleId,
      objectId,
      departmentId: null,
    })),
    ...unique(v.excludedDepartmentIds).map((departmentId) => ({
      scheduleId,
      objectId: null,
      departmentId,
    })),
  ];
  if (scopes.length > 0) await tx.insert(mailingScheduleExcludedScopes).values(scopes);
}

/**
 * Ссылки в наборах обязаны существовать. Без проверки вставка упирается во внешний ключ, и человек
 * получает внутреннюю ошибку сервера вместо внятного «в списке неизвестная запись».
 */
async function assertRowsExist(
  table: PgTable,
  column: PgColumn,
  ids: string[],
  message: string,
): Promise<void> {
  const wanted = unique(ids);
  if (wanted.length === 0) return;
  const [found] = await db.select({ c: count() }).from(table).where(inArray(column, wanted));
  if (Number(found!.c) !== wanted.length) throw err.badRequest(message);
}

/** Все ссылочные наборы расписания разом: на создании и на правке проверяется одно и то же. */
async function assertScheduleRefs(
  v: Pick<
    MailingScheduleDto,
    'excludedPersonIds' | 'excludedUserIds' | 'excludedObjectIds' | 'excludedDepartmentIds'
  >,
): Promise<void> {
  await assertRowsExist(
    persons,
    persons.id,
    v.excludedPersonIds,
    'В списке исключённых водителей есть неизвестная карточка',
  );
  await assertRowsExist(
    users,
    users.id,
    v.excludedUserIds,
    'В списке исключённых получателей есть неизвестная учётная запись',
  );
  await assertRowsExist(
    constructionObjects,
    constructionObjects.id,
    v.excludedObjectIds,
    'В списке исключённых площадок есть неизвестный объект',
  );
  await assertRowsExist(
    departments,
    departments.id,
    v.excludedDepartmentIds,
    'В списке исключённых отделов есть неизвестный отдел',
  );
}

export default async function adminMailingsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const readGuards = { preHandler: [app.authenticate, app.requirePermission('mailings.read')] };
  const manageGuards = { preHandler: [app.authenticate, app.requirePermission('mailings.manage')] };

  /**
   * Список — целиком и вместе с исключениями: расписаний в портале единицы, а открывают их, чтобы
   * увидеть настройку полностью. Отдельная ручка на каждый набор дат заставила бы вкладку
   * дособирать одну карточку четырьмя запросами.
   */
  r.get('/schedules', readGuards, async (): Promise<MailingScheduleDto[]> => {
    const rows = await db
      .select()
      .from(mailingSchedules)
      // Порядок по названию, а не по времени заведения: список читают как перечень настроек.
      .orderBy(asc(mailingSchedules.name), asc(mailingSchedules.createdAt));
    const settings = await settingsByScheduleId(rows.map((row) => row.id));
    return rows.map((row) => toDto(row, settings.get(row.id)));
  });

  r.post(
    '/schedules',
    { ...manageGuards, schema: { body: createMailingScheduleSchema } },
    async (req, reply) => {
      const actor = requirePrincipal(req);
      const body = req.body;
      await assertScheduleRefs(body);
      const runWeekdays = sortedWeekdays(body.runWeekdays);

      const id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(mailingSchedules)
          .values({
            type: body.type,
            name: body.name,
            isEnabled: body.isEnabled,
            periodicity: body.periodicity,
            sendAt: body.sendAt,
            weekday: body.weekday ?? null,
            runWeekdays,
            windowFromDays: body.windowFromDays ?? null,
            windowToDays: body.windowToDays ?? null,
            nextRunAt: nextRunFor({
              isEnabled: body.isEnabled,
              periodicity: body.periodicity,
              sendAt: body.sendAt,
              weekday: body.weekday,
              runWeekdays,
              excludedRunDates: body.excludedRunDates,
            }),
            createdBy: actor.id,
            updatedBy: actor.id,
          })
          .returning({ id: mailingSchedules.id });
        await replaceSettings(tx, inserted!.id, body);
        return inserted!.id;
      });

      await writeAudit({
        actorUserId: actor.id,
        action: 'mailing.schedule_created',
        entityType: 'mailing_schedule',
        entityId: id,
        metadata: { type: body.type, name: body.name },
      });
      const created = await loadSchedule(id);
      return reply.code(201).send(created!.dto);
    },
  );

  r.patch(
    '/schedules/:id',
    { ...manageGuards, schema: { params: idParams, body: updateMailingScheduleSchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const body = req.body;
      const found = await loadSchedule(req.params.id);
      if (!found) throw err.notFound('Расписание не найдено');
      if (found.row.version !== body.version) {
        throw err.conflict('Расписание уже изменили — обновите страницу');
      }
      // Тип рассылки не меняется: на нём держатся и состав получателей, и история запусков —
      // «то же расписание, но теперь про другое» читалось бы как подмена прошлых рассылок.
      if (body.type !== found.row.type) {
        throw err.badRequest('Тип рассылки менять нельзя — заведите отдельное расписание');
      }
      await assertScheduleRefs(body);
      const runWeekdays = sortedWeekdays(body.runWeekdays);

      await db.transaction(async (tx) => {
        await tx
          .update(mailingSchedules)
          .set({
            name: body.name,
            isEnabled: body.isEnabled,
            periodicity: body.periodicity,
            sendAt: body.sendAt,
            weekday: body.weekday ?? null,
            runWeekdays,
            windowFromDays: body.windowFromDays ?? null,
            windowToDays: body.windowToDays ?? null,
            nextRunAt: nextRunFor({
              isEnabled: body.isEnabled,
              periodicity: body.periodicity,
              sendAt: body.sendAt,
              weekday: body.weekday,
              runWeekdays,
              excludedRunDates: body.excludedRunDates,
            }),
            updatedBy: actor.id,
            updatedAt: new Date(),
            version: found.row.version + 1,
          })
          .where(eq(mailingSchedules.id, found.row.id));
        await replaceSettings(tx, found.row.id, body);
      });

      await writeAudit({
        actorUserId: actor.id,
        action: 'mailing.schedule_updated',
        entityType: 'mailing_schedule',
        entityId: found.row.id,
        metadata: { name: body.name, isEnabled: body.isEnabled },
      });
      const updated = await loadSchedule(found.row.id);
      return updated!.dto;
    },
  );

  /**
   * Удаление уносит с собой историю запусков (каскад в БД): расписания нет — и спрашивать «что по
   * нему уходило» больше не у чего. Журнала писем это не касается: `mail_messages` ссылается на
   * запуск через `ON DELETE SET NULL`, и «кому что отправили» остаётся.
   */
  r.delete(
    '/schedules/:id',
    { ...manageGuards, schema: { params: idParams } },
    async (req, reply) => {
      const actor = requirePrincipal(req);
      const found = await loadSchedule(req.params.id);
      if (!found) throw err.notFound('Расписание не найдено');

      await db.delete(mailingSchedules).where(eq(mailingSchedules.id, found.row.id));

      await writeAudit({
        actorUserId: actor.id,
        action: 'mailing.schedule_deleted',
        entityType: 'mailing_schedule',
        entityId: found.row.id,
        metadata: { type: found.row.type, name: found.row.name },
      });
      return reply.code(204).send();
    },
  );

  /**
   * Запуск «сейчас» (ADR 0075). Не сдвигает расписание: это разовая рассылка, а не перенос
   * вечерней отправки, и в истории она видна отдельно по признаку ручного запуска.
   *
   * Выполняется тем же кодом, что и запуск по времени, — иначе «работает по кнопке, не работает по
   * расписанию» стало бы возможным состоянием.
   */
  r.post('/schedules/:id/run', { ...manageGuards, schema: { params: idParams } }, async (req) => {
    const actor = requirePrincipal(req);
    const found = await loadSchedule(req.params.id);
    if (!found) throw err.notFound('Расписание не найдено');

    // Момент запуска — «сейчас» с точностью до секунды: уникальность `(schedule_id, planned_at)`
    // заодно гасит второе нажатие кнопки подряд.
    const plannedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const runId = await createRun({ scheduleId: found.row.id, plannedAt, isManual: true });
    if (!runId) {
      throw err.conflict('Такой запуск уже создан — посмотрите историю');
    }

    const stats = await performRun(runId);
    await writeAudit({
      actorUserId: actor.id,
      action: 'mailing.run_manual',
      entityType: 'mailing_schedule',
      entityId: found.row.id,
      metadata: { runId, ...stats },
    });
    return { ok: true, runId, stats };
  });

  /** История запусков — с пагинацией, в отличие от расписаний: она прирастает каждый день. */
  r.get(
    '/runs',
    { ...readGuards, schema: { querystring: mailingRunListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = q.scheduleId ? eq(mailingRuns.scheduleId, q.scheduleId) : undefined;
      const sortCols = {
        plannedAt: mailingRuns.plannedAt,
        finishedAt: mailingRuns.finishedAt,
        createdAt: mailingRuns.createdAt,
      };
      const pg = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(mailingRuns)
          .where(where)
          // Свежие сначала и по времени записи: этим же порядком лежит индекс истории.
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
          .limit(pg.limit)
          .offset(pg.offset),
        db.select({ c: count() }).from(mailingRuns).where(where),
      ]);

      return {
        items: rows.map(toRunDto),
        total: Number(totalRows[0]!.c),
        page: pg.page,
        pageSize: pg.pageSize,
      };
    },
  );
}
