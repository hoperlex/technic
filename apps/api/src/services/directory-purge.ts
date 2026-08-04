import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../db/client';
import { requirePrincipal } from '../auth/plugin';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';

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
  person_credentials: 'документы работников',
  person_employments: 'записи о работе',
  person_specializations: 'специализации работников',
  request_files: 'вложения заявок вывоза',
  user_construction_objects: 'объекты учётных записей',
  user_departments: 'отделы учётных записей',
  users: 'учётные записи',
  vehicle_categories: 'категории типов ТС',
  vehicle_category_spec_values: 'значения ТТХ категорий',
  vehicle_models: 'модели техники',
  vehicle_request_assignments: 'назначения техники на заявки',
  vehicle_requests: 'заказы техники',
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
  const pg = e as { code?: string; table?: string };
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
  /** Что снести внутри транзакции: саму строку и её собственные подчинённые записи. */
  remove: (tx: Tx, row: Row) => Promise<void>;
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
      const row = await cfg.load(id);
      if (!row) throw err.notFound(cfg.notFound);
      if (!cfg.isDown(row)) throw err.conflict(cfg.stillLive);
      // Реквизиты снимаются до удаления: журнал — единственное, что останется от строки.
      const metadata = cfg.audit.metadata(row);
      try {
        await db.transaction(async (tx) => {
          await cfg.remove(tx, row);
        });
      } catch (e) {
        throw asReferenceConflict(e, cfg.subject);
      }
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: cfg.audit.action,
        entityType: cfg.audit.entityType,
        entityId: id,
        metadata,
      });
      return { ok: true };
    },
  );
}
