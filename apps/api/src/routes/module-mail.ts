import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createModuleMailRecipientSchema,
  MODULE_MAIL_EVENTS,
  type ModuleMailEvent,
  type ModuleMailEventSettingDto,
  type ModuleMailRecipientDto,
  type RequestChangeDto,
  updateModuleMailEventSettingSchema,
  updateModuleMailRecipientSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { moduleMailEventSettings, moduleMailRecipients, users } from '../db/schema';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';

/**
 * Служебные адресаты писем модулей (план `docs/office-equipment-mail-and-history-plan.md`, Р64).
 *
 * Отдельно от расписаний (`admin-mailings.ts`) намеренно: там настраивают, кому из **учётных
 * записей** и когда уходит сводка, а здесь — на какой служебный ящик уходит письмо по событию.
 * Общего у них только раздел в администрировании и право доступа.
 *
 * Рабочих адресов ни миграция, ни сид не заводят: репозиторий публичный, а ящик службы — настройка
 * эксплуатации. Пока строк нет, событие отвечает исходом `no_recipients`, и это нормальное
 * состояние выкаченной, но не включённой функции.
 */

type Row = typeof moduleMailRecipients.$inferSelect;

const idParams = z.object({ id: z.string().uuid() });

function toDto(row: Row, updatedByName: string | null): ModuleMailRecipientDto {
  return {
    id: row.id,
    event: row.event,
    toEmail: row.toEmail,
    isEnabled: row.isEnabled,
    replyToMode: row.replyToMode,
    replyToEmail: row.replyToEmail,
    comment: row.comment,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedByName,
  };
}

/**
 * Что изменила правка — снимком в аудит, тем же форматом, что у истории заявок. Правка адресата это
 * правка правил доставки: «письма перестали приходить» разбирают через месяц, и ответ на вопрос
 * «кто и когда это выключил» должен лежать в журнале, а не восстанавливаться по памяти.
 */
function diffOf(before: Row, after: Row): RequestChangeDto[] {
  const fields: Array<[string, string, string]> = [
    ['toEmail', before.toEmail, after.toEmail],
    ['isEnabled', String(before.isEnabled), String(after.isEnabled)],
    ['replyToMode', before.replyToMode, after.replyToMode],
    ['replyToEmail', before.replyToEmail, after.replyToEmail],
    ['comment', before.comment, after.comment],
  ];
  return fields
    .filter(([, from, to]) => from !== to)
    .map(([field, from, to]) => ({ field, from, to }));
}

/**
 * Нарушение уникальности `(event, to_email)` — не «конфликт версий», а понятный отказ формы.
 *
 * Через `pgErrorOf`: drizzle оборачивает ошибку драйвера в свою, и на верхнем объекте кода уже нет
 * — проверка молчала бы, а повторный адрес давал бы 500 вместо подсказки.
 *
 * Обёртка общая для заведения и правки: в тот же индекс упирается вторая, а «поймали только на
 * создании» означало бы 500 там, где форма умеет показать поле, — правку адреса на уже занятый.
 */
async function withDuplicateMessage<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (e) {
    if (pgErrorOf(e)?.constraint === 'module_mail_recipients_event_email_unique') {
      throw err.unprocessable('Этот адрес уже настроен на это событие', {
        toEmail: 'Адрес уже в списке',
      });
    }
    throw e;
  }
}

// ── Рубильник события (план `docs/office-equipment-mail-expansion-plan.md`, §5.1; ADR 0159) ──
//
// Строки адресатов выше отвечают на вопрос «кому уходит копия», строка рубильника — на вопрос
// «уходит ли письмо по событию вообще». Настройка эксплуатационная, а не продуктовая: раздел
// модуля в портале ещё закрыт заплаткой, а API открыт (письма ушли бы наружу, подрядчику, раньше,
// чем люди увидят модуль); события включают по одному и смотрят, что приходит; зашумевшее событие
// гасят рубильником, не откатывая релиз.
//
// Строку на каждое событие заводит миграция (0258): новое событие приходит в портал вместе со
// своей строкой. Поэтому здесь строки не заводятся ни при чтении, ни при правке — см.
// `missingEventDto` и 404 в `PATCH /events/:event`.

type EventRow = typeof moduleMailEventSettings.$inferSelect;

/**
 * Событие приходит параметром пути строкой, а не `z.enum`: у несуществующего события ответ 404 с
 * текстом про сам путь, тогда как схема дала бы 400 «Ошибка валидации» — по нему не отличить
 * промах адресом от сломанного клиента.
 */
const eventParams = z.object({ event: z.string() });

function isKnownEvent(event: string): event is ModuleMailEvent {
  return (MODULE_MAIL_EVENTS as readonly string[]).includes(event);
}

function toEventDto(row: EventRow, updatedByName: string | null): ModuleMailEventSettingDto {
  return {
    event: row.event,
    isEnabled: row.isEnabled,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName,
  };
}

/**
 * Событие реестра, у которого в базе строки нет, — состояние fail-closed (§5.1): письма по нему не
 * пойдут, и список обязан показать его **выключенным**, а не пропустить молча. Пропуск оставил бы
 * администратора искать исчезнувший рубильник в базе, а показ «включено по умолчанию» обещал бы
 * письма, которых не будет.
 *
 * Строку при этом не выдумываем — ни ленивой вставкой в базу, ни правдоподобными значениями в
 * ответе. Пустой `updatedAt` и `null` в «кто правил» читаются как «настройки не было вовсе»:
 * `version` 0 здесь не обещание, что правка пройдёт, — правка такого события отвечает 404, и щелчок
 * по нему означает не «включить», а «выкат неполон, строка не накатана».
 */
function missingEventDto(event: ModuleMailEvent): ModuleMailEventSettingDto {
  return { event, isEnabled: false, version: 0, updatedAt: '', updatedByName: null };
}

export default async function moduleMailRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const readGuards = { preHandler: [app.authenticate, app.requirePermission('mailings.read')] };
  const manageGuards = { preHandler: [app.authenticate, app.requirePermission('mailings.manage')] };

  /**
   * Ответ на запись собирается из уже вставленной строки, а не вторым запросом: `updated_by` у
   * записи это всегда текущий актёр, и его имя известно из `Principal` — вторая выборка добавила бы
   * джойн ради того, что уже в руках.
   */
  function writtenDto(row: Row, actorName: string): ModuleMailRecipientDto {
    return toDto(row, actorName);
  }

  /**
   * Список целиком, без страниц: строк здесь единицы, и открывают вкладку, чтобы увидеть настройку
   * полностью — какие события кому уходят и какие из них сейчас выключены.
   */
  r.get('/recipients', readGuards, async (): Promise<ModuleMailRecipientDto[]> => {
    const rows = await db
      .select({ r: moduleMailRecipients, updatedByName: users.fullName })
      .from(moduleMailRecipients)
      .leftJoin(users, eq(moduleMailRecipients.updatedBy, users.id))
      // Порядок по событию, а не по времени заведения: список читают как перечень правил доставки.
      .orderBy(asc(moduleMailRecipients.event), asc(moduleMailRecipients.toEmail));
    return rows.map((row) => toDto(row.r, row.updatedByName));
  });

  r.post(
    '/recipients',
    { ...manageGuards, schema: { body: createModuleMailRecipientSchema } },
    async (req, reply) => {
      const actor = requirePrincipal(req);
      const b = req.body;

      const [created] = await withDuplicateMessage(() =>
        db
          .insert(moduleMailRecipients)
          .values({
            event: b.event,
            toEmail: b.toEmail,
            isEnabled: b.isEnabled,
            replyToMode: b.replyToMode,
            replyToEmail: b.replyToEmail,
            comment: b.comment,
            createdBy: actor.id,
            updatedBy: actor.id,
          })
          .returning(),
      );

      await writeAudit({
        actorUserId: actor.id,
        action: 'moduleMailRecipient.create',
        entityType: 'moduleMailRecipient',
        entityId: created!.id,
        metadata: { event: b.event, toEmail: b.toEmail, replyToMode: b.replyToMode },
      });
      reply.code(201);
      return writtenDto(created!, actor.fullName);
    },
  );

  /**
   * Правка идёт целиком и события не трогает: строка — это пара «событие + адрес», и смена события
   * превращает её в другую строку. Перенести адрес на другое событие значит завести новую строку и
   * выключить старую — тогда в аудите остаётся, что и когда перестало рассылаться.
   */
  r.patch(
    '/recipients/:id',
    {
      ...manageGuards,
      schema: { params: idParams, body: updateModuleMailRecipientSchema },
    },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;

      const { before, after } = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(moduleMailRecipients)
          .where(eq(moduleMailRecipients.id, id));
        if (!row) throw err.notFound('Адресат не найден');

        /**
         * Версия проверяется **условием самого UPDATE**, а не сравнением после чтения: между
         * `SELECT` и `UPDATE` соседнее окно успевает записать свою правку, и обе прошли бы проверку
         * `row.version === b.version`, а вторая молча затёрла бы первую. Приём общий для портала —
         * так же устроены заявки и недельный документ.
         */
        const [updated] = await withDuplicateMessage(() =>
          tx
            .update(moduleMailRecipients)
            .set({
              toEmail: b.toEmail,
              isEnabled: b.isEnabled,
              replyToMode: b.replyToMode,
              replyToEmail: b.replyToEmail,
              comment: b.comment,
              version: b.version + 1,
              updatedBy: actor.id,
              updatedAt: new Date(),
            })
            .where(
              and(eq(moduleMailRecipients.id, id), eq(moduleMailRecipients.version, b.version)),
            )
            .returning(),
        );
        if (!updated) throw err.conflict();
        return { before: row, after: updated };
      });

      await writeAudit({
        actorUserId: actor.id,
        action: 'moduleMailRecipient.update',
        entityType: 'moduleMailRecipient',
        entityId: id,
        metadata: { changes: diffOf(before, after) },
      });
      return writtenDto(after, actor.fullName);
    },
  );

  /**
   * Удаление настоящее, а не мягкое: строка настройки не предмет отчётности, а «пауза» выражается
   * выключателем. Что именно удалили — остаётся в аудите снимком.
   */
  r.delete(
    '/recipients/:id',
    { ...manageGuards, schema: { params: idParams } },
    async (req, reply) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const [row] = await db
        .delete(moduleMailRecipients)
        .where(eq(moduleMailRecipients.id, id))
        .returning();
      if (!row) throw err.notFound('Адресат не найден');

      await writeAudit({
        actorUserId: actor.id,
        action: 'moduleMailRecipient.delete',
        entityType: 'moduleMailRecipient',
        entityId: id,
        metadata: { event: row.event, toEmail: row.toEmail },
      });
      reply.code(204);
    },
  );

  /**
   * Рубильники всех событий реестра — по строке на событие, в порядке `MODULE_MAIL_EVENTS`.
   *
   * Порядок реестровый, а не алфавитный и не по времени правки: администратор читает список как
   * цикл заявки — ждёт визы, отменена, назначена, сменила состояние, объём работ, документы,
   * обсуждение. Сортировка по названию перемешала бы цикл и превратила бы список в набор
   * несвязанных выключателей, между которыми не видно, какое движение заявки уже покрыто почтой.
   *
   * Перечень ведёт код, а не выборка: `SELECT` отдаёт только заведённые строки, а событие без
   * строки обязано быть видно выключенным (§5.1). Обратное тоже верно — строка, которой в реестре
   * больше нет, в список не попадёт: писем по ней всё равно не будет.
   */
  r.get('/events', readGuards, async (req): Promise<ModuleMailEventSettingDto[]> => {
    const rows = await db
      .select({ s: moduleMailEventSettings, updatedByName: users.fullName })
      .from(moduleMailEventSettings)
      .leftJoin(users, eq(moduleMailEventSettings.updatedBy, users.id));
    const byEvent = new Map(rows.map((row) => [row.s.event, row]));

    const missing = MODULE_MAIL_EVENTS.filter((event) => !byEvent.has(event));
    if (missing.length) {
      // Не «пусто — и ладно»: строки заводит миграция, и их отсутствие означает недокаченный выкат.
      // Снаружи это выглядит как тишина по событию, и объяснить её можно только отсюда — из лога.
      req.log.error({ missing }, 'рубильник почты модуля: у события нет строки настройки');
    }

    return MODULE_MAIL_EVENTS.map((event) => {
      const row = byEvent.get(event);
      return row ? toEventDto(row.s, row.updatedByName) : missingEventDto(event);
    });
  });

  /**
   * Щелчок рубильником. В теле только включённость и версия: событие — ключ самой строки, а
   * «перенести включённость» на соседнее событие означает два щелчка, и каждый обязан остаться в
   * аудите своей строкой.
   */
  r.patch(
    '/events/:event',
    { ...manageGuards, schema: { params: eventParams, body: updateModuleMailEventSettingSchema } },
    async (req): Promise<ModuleMailEventSettingDto> => {
      const actor = requirePrincipal(req);
      const { event } = req.params;
      const b = req.body;

      if (!isKnownEvent(event)) throw err.notFound('Такого события почты в портале нет');

      const { before, after } = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(moduleMailEventSettings)
          .where(eq(moduleMailEventSettings.event, event));
        /**
         * Строки нет — 404, и строка **не заводится**. Отсутствие строки это fail-closed (§5.1):
         * база не знает о событии, и включать наружную рассылку с такого состояния нельзя. Тихая
         * вставка превратила бы дыру наполнения в рабочую настройку — событие оказалось бы
         * включённым по нажатию в форме, а не по накатанной миграции, и разбирать «почему письма
         * пошли» пришлось бы по одному аудиту.
         */
        if (!row) {
          throw err.notFound(
            'Рубильник этого события не заведён в базе: событие выключено, пока не накатана его миграция',
          );
        }

        // Версия — условием самого UPDATE, по той же причине, что у адресата выше: между `SELECT`
        // и `UPDATE` соседнее окно успевает записать свою правку.
        const [updated] = await tx
          .update(moduleMailEventSettings)
          .set({
            isEnabled: b.isEnabled,
            version: b.version + 1,
            updatedBy: actor.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(moduleMailEventSettings.event, event),
              eq(moduleMailEventSettings.version, b.version),
            ),
          )
          .returning();
        if (!updated) throw err.conflict();
        return { before: row, after: updated };
      });

      /**
       * Обычный `writeAudit`, а не `writeAuditTx`: строгая запись имеет закрытый перечень областей
       * (см. `lib/audit.ts`), и рубильник в него не входит — щелчок не единственный носитель факта,
       * текущее состояние видно строкой таблицы.
       *
       * Оба значения `isEnabled`, а не одно новое: «почему перестали приходить письма» разбирают
       * через месяц, и по одной строке журнала должно быть видно и то, что рубильник трогали, и в
       * какую сторону. Повторный щелчок в то же положение по такой записи тоже отличим — иначе он
       * читался бы как отключение, которого не было.
       */
      await writeAudit({
        actorUserId: actor.id,
        action: 'moduleMailEvent.update',
        entityType: 'moduleMailEvent',
        entityId: event,
        metadata: { event, isEnabledFrom: before.isEnabled, isEnabledTo: after.isEnabled },
      });
      // Имя правившего известно без второго запроса: `updated_by` — всегда текущий актёр.
      return toEventDto(after, actor.fullName);
    },
  );
}
