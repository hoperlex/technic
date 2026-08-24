import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../db/client';
import { requirePrincipal } from '../auth/plugin';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';

/**
 * Окончательное удаление записи справочника (ADR 0060) — общая механика на все вкладки.
 *
 * Справочники не удаляют, а гасят: где-то `is_active = false`, где-то уход в архив по
 * `deleted_at`. Заведённую по ошибке строку это оставляет в базе навсегда, поэтому у
 * администратора есть второй шаг — снести погашенное насовсем (право `records.purge`, ADR 0021).
 *
 * Один модуль, а не десять одинаковых обработчиков: правило «удаляется только погашенное»,
 * перевод отказа БД и запись в журнал обязаны совпадать во всех справочниках дословно, иначе
 * очередная вкладка тихо разойдётся с остальными.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const purgeParams = z.object({ id: z.string().uuid() });

/**
 * Как назвать таблицу, из-за которой запись не удалить. Ключ — имя таблицы-источника ссылки,
 * его сообщает сама БД в ошибке внешнего ключа.
 *
 * Карта названий, а не реестр «кто на кого ссылается»: список связей в коде разошёлся бы со
 * схемой на первом же новом внешнем ключе, а имя таблицы БД называет всегда — незнакомое просто
 * не попадёт в текст.
 */
const REFERENCING_TABLE_LABELS: Record<string, string> = {
  construction_object_operators: 'привязки операторов вывоза к объектам',
  counterparty_synonyms: 'синонимы контрагентов',
  office_equipment: 'карточки оргтехники',
  // Журнал остатка расходников: `changed_by` стоит с `RESTRICT`, поэтому учётка, когда-либо
  // правившая наличие, без этой строки объяснялась бы человеку общим «на запись ссылаются другие
  // данные». Событие без автора не отвечает на свой единственный вопрос — потому ссылка и
  // неразрывна.
  office_equipment_consumable_stock_entries: 'движения остатка расходников',
  office_equipment_movements: 'перемещения оргтехники',
  person_credentials: 'документы работников',
  person_employments: 'записи о работе',
  person_specializations: 'специализации работников',
  request_files: 'вложения заявок вывоза',
  request_status_history: 'история статусов заявок вывоза',
  user_construction_objects: 'объекты учётных записей',
  user_departments: 'отделы учётных записей',
  users: 'учётные записи',
  vehicle_categories: 'категории типов ТС',
  vehicle_category_spec_values: 'значения ТТХ категорий',
  vehicle_models: 'модели техники',
  vehicle_request_assignments: 'назначения техники на заявки',
  vehicle_request_completions: 'закрытые заказы техники',
  vehicle_request_early_endings: 'досрочные завершения заказов техники',
  vehicle_request_shifts: 'смены в заказах техники',
  vehicle_request_status_history: 'история статусов заказов техники',
  vehicle_requests: 'заказы техники',
  // Строки неприменённых недельных заявок уборка снимает сама (ADR 0085), поэтому досюда доходят
  // только применённые: там строка — уже не намерение, а объяснение, откуда взялось продление.
  weekly_vehicle_request_items: 'строки применённых недельных заявок',
  // Сама заявка ссылается на площадку: неприменённые уборка сносит целиком, а применённую площадка
  // пережить не может — это её документ-основание.
  weekly_vehicle_requests: 'применённые недельные заявки',
  vehicle_route_requests: 'состав рейсов',
  vehicle_routes: 'рейсы',
  vehicle_type_specs: 'привязки ТТХ к типам',
  vehicles: 'техника',
  warehouses: 'склады',
  waste_request_completions: 'закрытые заявки вывоза',
  waste_request_vehicles: 'машины в заявках вывоза',
  waste_requests: 'заявки на вывоз мусора',
  waste_tariffs: 'цены вывоза мусора',
  waste_types: 'типы мусора',
  waybill_requests: 'заявки в путевых листах',
  waybills: 'путевые листы',
};

/**
 * Отказ БД по внешнему ключу (23503) — не поломка, а обычный ответ «на запись ссылаются».
 * Без перевода он превратился бы в 500 с текстом про constraint, хотя человеку нужно знать
 * ровно одно: где эта запись ещё используется.
 *
 * Имя таблицы-источника БД кладёт в поле `table`: в сообщении «update or delete on table … violates
 * foreign key constraint … on table X» ошибка помечена именно ссылающейся таблицей X.
 */
export function asReferenceConflict(e: unknown, subject: string): unknown {
  // Через `pgErrorOf`, а не с самой ошибки: drizzle оборачивает ошибку драйвера в свою, и на
  // верхнем объекте ни кода, ни таблицы уже нет — проверка молчала бы, а человек получал 500.
  const pg = pgErrorOf(e);
  if (pg?.code !== '23503') return e;
  const label = pg.table ? REFERENCING_TABLE_LABELS[pg.table] : undefined;
  return err.conflict(
    label
      ? `Удалить ${subject} насовсем нельзя: на запись ссылаются ${label}`
      : `Удалить ${subject} насовсем нельзя: на запись ссылаются другие данные`,
  );
}

export interface PurgeRouteConfig<Row> {
  /** Строка справочника: нужна и для проверки «погашена», и для реквизитов в журнале. */
  load: (id: string) => Promise<Row | undefined>;
  /** Погашена ли запись — неактивна или в архиве. Активную насовсем не удаляют. */
  isDown: (row: Row) => boolean;
  /**
   * Что снести внутри транзакции: саму строку и её собственные подчинённые записи.
   *
   * Возвращённый объект попадает в журнал вместе с реквизитами строки. Это нужно там, где
   * удаление не только сносит запись, но и **убирает следы из чужих незавершённых документов**:
   * строки недельных заявок, ссылавшиеся на удаляемый заказ или тип техники (ADR 0085), находятся
   * уже внутри транзакции, и снятыми до неё реквизитами их не назовёшь. Молчать о такой уборке
   * нельзя: состав чужого документа изменился, и в журнале должно быть видно, чей и на что.
   *
   * Ничего не убиравшая реализация возвращает `void` — тогда в журнале только реквизиты строки.
   *
   * Третьим аргументом идёт тот, кто удаляет: у чужого документа своя транзакционная история, и
   * событие «строка снята» без автора там невозможно (`changed_by` объявлен `NOT NULL`).
   */
  remove: (tx: Tx, row: Row, actor: { id: string }) => Promise<Record<string, unknown> | void>;
  notFound: string;
  /** Отказ на живой записи: называет первый шаг, который человек не сделал. */
  stillLive: string;
  /** Предмет в родительном падеже для отказа по ссылкам: «объект», «тип контейнера». */
  subject: string;
  audit: {
    action: string;
    entityType: string;
    /** Реквизиты исчезающей строки: после удаления по entityId уже ничего не найти. */
    metadata: (row: Row) => Record<string, unknown>;
  };
}

/**
 * Регистрирует `DELETE /:id/purge` в справочнике. Право — `records.purge` (только администратор):
 * восстановить удалённое нечем, и это не часть ведения справочников.
 */
export function registerPurgeRoute<Row>(app: FastifyInstance, cfg: PurgeRouteConfig<Row>): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.delete(
    '/:id/purge',
    {
      preHandler: [app.authenticate, app.requirePermission('records.purge')],
      schema: { params: purgeParams },
    },
    async (req) => {
      const { id } = req.params;
      const actor = requirePrincipal(req);
      const row = await cfg.load(id);
      if (!row) throw err.notFound(cfg.notFound);
      if (!cfg.isDown(row)) throw err.conflict(cfg.stillLive);
      // Реквизиты снимаются до удаления: журнал — единственное, что останется от строки.
      const metadata = cfg.audit.metadata(row);
      let cleanup: Record<string, unknown> | void;
      try {
        cleanup = await db.transaction(async (tx) => {
          return cfg.remove(tx, row, { id: actor.id });
        });
      } catch (e) {
        throw asReferenceConflict(e, cfg.subject);
      }
      await writeAudit({
        actorUserId: actor.id,
        action: cfg.audit.action,
        entityType: cfg.audit.entityType,
        entityId: id,
        // Убранные следы — рядом с реквизитами, а не отдельным событием: удаление одно, и
        // «что снесли» с «что при этом задели» читаются вместе.
        metadata: cleanup ? { ...metadata, ...cleanup } : metadata,
      });
      return { ok: true };
    },
  );
}
