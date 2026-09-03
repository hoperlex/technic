import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  maintenanceInputSchema,
  maintenanceSnapshotQuerySchema,
  maintenanceSummaryQuerySchema,
  maintenanceUpdateSchema,
  maintenanceVersionQuerySchema,
  maintenanceVoidSchema,
  moscowDateKeyOf,
  uuidSchema,
  type VehicleMaintenanceDto,
  type VehicleMaintenanceSummaryDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import { err } from '../lib/errors';
import {
  createMaintenance,
  deleteMaintenance,
  loadMaintenanceHistory,
  loadMaintenanceSnapshot,
  loadMaintenanceSummary,
  updateMaintenance,
  voidMaintenance,
} from '../services/vehicle-maintenance';

/**
 * Техобслуживание техники по пробегу (план «Показания техники», §6): сводка по машине, пакетное
 * состояние для колонки гаража, история записей и их ведение.
 *
 * Свой префикс и свои два права, а не ветка `/vehicle-readings`, — это и есть решение Р14. Служба
 * главного механика ведёт ТО и больше в модуле показаний не делает ничего; выдай ей
 * `vehicleReadings.read` ради одной формы — и вместе с формой откроются приёмка, журналы, выгрузки
 * и фотографии приборных панелей.
 *
 * Обратная сторона того же решения — обязательство этих ручек (Р14а, Р14б): **сводка
 * самодостаточна**. Она отдаёт всё, что нужно про обслуживание, включая последний одометр с датой
 * снятия, — без него «8 340 км с ТО» нечем проверить. И ровно на этом граница закрывается: DTO
 * показаний, журнала, приростов, аномалий и фотографий здесь нет и быть не должно. Понадобится
 * полная карточка диспетчера — портал соберёт её композицией двух ответов, а не полем, исчезающим
 * по чужому праву.
 *
 * Области видимости у ручек нет: парк у портала один, и обе роли службы механика смотрят его
 * целиком — своей оси области у них не заведено (`ACCESS_PROFILES`).
 *
 * **Второго права у пишущих ручек больше нет** (план `docs/auto-part-receipts-plan.md`, Р2, Р3).
 * Пока акт был основанием складского расхода, три из них стояли под условием по ЭФФЕКТУ:
 * `autoParts.stock` спрашивался по фактической разнице строк под блокировкой. Строк у акта нет —
 * склад заморожен, — и `vehicleMaintenance.write` стража снова единственное право всех ручек, как
 * и записано в манифесте.
 */

/** `:id` — машина: сводка и история адресуются техникой, а не записью ТО. */
const vehicleParams = z.object({ id: uuidSchema });
/** `:id` — сама запись ТО: правят и удаляют акт, машина у него уже своя. */
const maintenanceParams = z.object({ id: uuidSchema });

/**
 * День среза (Р16): и записи ТО, и последний одометр берутся не позже него. Присланный либо
 * сегодняшний московский — тем же приёмом, что и день гаража (`dayOf` в routes/garage.ts): часы
 * браузера бывают сбиты, а восточнее Москвы сутки начинаются раньше, и «сегодня» клиента показало
 * бы ТО, проведённое завтра.
 */
function dayOf(on: string | undefined): string {
  return on ?? moscowDateKeyOf(new Date());
}

export default async function vehicleMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: [app.authenticate, app.requirePermission('vehicleMaintenance.read')] };
  const write = {
    preHandler: [app.authenticate, app.requirePermission('vehicleMaintenance.write')],
  };

  /**
   * Сводка по машине на день среза: основание расчёта, последний одометр, последнее ТО, пробег с
   * него и два флага доверия к этому числу (Р11в). Состояние приходит посчитанным — портал зовёт
   * `maintenanceState` только для того, чтобы покрасить, а не чтобы решить.
   *
   * `null` из расчёта означает ровно одно: такой машины в справочнике нет. Машина без единой
   * записи ТО — законная сводка с пустым `lastMaintenance` и `kmSince: null`.
   */
  r.get(
    '/vehicles/:id/summary',
    { ...read, schema: { params: vehicleParams, querystring: maintenanceSummaryQuerySchema } },
    async (req): Promise<VehicleMaintenanceSummaryDto> => {
      const summary = await loadMaintenanceSummary(req.params.id, dayOf(req.query.on));
      if (!summary) throw err.notFound('Машина не найдена');
      return summary;
    },
  );

  /**
   * То же состояние пакетом — колонка «ТО» страницы гаража (§5). Ручка существует затем, чтобы
   * колонка списка не превращалась в запрос на строку: сотня машин страницы — один расчёт.
   *
   * День среза возвращается в ответе, потому что его мог посчитать сервер: подпись колонки обязана
   * называть тот же день, по которому шёл отбор. Порядок ответа — порядок запрошенных машин, а не
   * порядок расчёта: колонка ставится против строк страницы. Машина, которой в справочнике нет, из
   * ответа просто выпадает — пакетный запрос не место для отказа из-за одной строки.
   */
  r.get(
    '/snapshot',
    { ...read, schema: { querystring: maintenanceSnapshotQuerySchema } },
    async (req): Promise<{ on: string; items: VehicleMaintenanceSummaryDto[] }> => {
      const on = dayOf(req.query.on);
      const ids = req.query.ids;
      // Пустая страница спрашивать базу не должна: `ids=` — законное значение, а не отказ.
      if (ids.length === 0) return { on, items: [] };

      const found = await loadMaintenanceSnapshot(ids, on);
      return {
        on,
        items: ids.flatMap((id) => {
          const s = found.get(id);
          return s ? [s] : [];
        }),
      };
    },
  );

  /**
   * История записей машины целиком, порядком Р30 (свежее сверху). Страниц у неё нет намеренно:
   * записей ТО у машины десятки за всю жизнь, и режут такие списки только там, где счёт идёт на
   * тысячи.
   *
   * Отсутствие машины здесь неотличимо от отсутствия записей, и 404 отсюда не приходит: пустая
   * история — законный ответ про машину, которую ещё не обслуживали. Проверяет существование
   * сводка, с которой этот блок и открывают.
   */
  r.get(
    '/vehicles/:id/history',
    { ...read, schema: { params: vehicleParams } },
    async (req): Promise<{ items: VehicleMaintenanceDto[] }> => ({
      items: await loadMaintenanceHistory(req.params.id),
    }),
  );

  /**
   * Завести запись ТО. Машина — в адресе, и в теле её нет: два места, где названа одна и та же
   * машина, — это возможность их рассогласовать.
   *
   * Принципал уходит в сервис целиком, а не одним идентификатором: им подписывается аудит, и
   * пишется он внутри той же транзакции.
   */
  r.post(
    '/vehicles/:id',
    { ...write, schema: { params: vehicleParams, body: maintenanceInputSchema } },
    async (req, reply): Promise<VehicleMaintenanceDto> => {
      const p = requirePrincipal(req);
      const created = await createMaintenance(req.params.id, req.body, p);
      reply.code(201);
      return created;
    },
  );

  /**
   * Правка записи. Версия обязательна (Р30): правка в середине истории меняет интервалы соседних
   * записей, и два механика не должны молча переписывать её друг у друга — разошедшаяся версия
   * означает, что правили другое. Отказ по ней — 409 из сервиса, где запись взята под блокировку.
   *
   * Аннулированный акт правку отбивает 409 (Р6): исправление — новый акт.
   */
  r.patch(
    '/:id',
    { ...write, schema: { params: maintenanceParams, body: maintenanceUpdateSchema } },
    async (req): Promise<VehicleMaintenanceDto> => {
      const p = requirePrincipal(req);
      const { version, ...input } = req.body;
      return updateMaintenance(req.params.id, input, version, p);
    },
  );

  /**
   * Аннулировать акт — с версией и причиной (Р6).
   *
   * Ручка заведена ради РАСЧЁТА, а не ради интерфейса: ошибочный акт, оставленный в журнале,
   * остался бы последним обслуживанием машины — «пробег с ТО» считался бы от ложного якоря, и
   * машина, которую пора обслуживать, показывала бы «в норме». А просто удалить его выходит не
   * всегда: акт со старыми движениями замороженного склада держит `RESTRICT` журнала.
   *
   * Одной транзакцией: три поля аннулирования и аудит. Склада аннулирование больше не касается
   * вовсе (план чеков, Р3). Повторное аннулирование — 409.
   */
  r.post(
    '/:id/void',
    { ...write, schema: { params: maintenanceParams, body: maintenanceVoidSchema } },
    async (req): Promise<VehicleMaintenanceDto> => {
      const p = requirePrincipal(req);
      return voidMaintenance(req.params.id, req.body, p);
    },
  );

  /**
   * Удаление записи — насовсем, вместе со связью скана: акт ТО не заявка, архива у него нет, а
   * ошибочно заведённую строку иначе не убрать (уникальности по «машина + дата» у таблицы нет
   * именно поэтому). Версия приходит в адресе: тела у DELETE нет, а удалять чужую правку вслепую
   * нельзя — правило то же, что у правки (Р30).
   *
   * **Акт, по которому прошёл расход автозапчастей, не удаляется** (Р6) — 409 словами про
   * автозапчасти и про выход (аннулирование), а не именем ограничения. Портал знает это заранее по
   * `hasPartMovements` DTO и показывает «Аннулировать» вместо «Удалить», а не узнаёт правило из
   * отказа после нажатия.
   */
  r.delete(
    '/:id',
    { ...write, schema: { params: maintenanceParams, querystring: maintenanceVersionQuerySchema } },
    async (req): Promise<{ ok: true }> => {
      const p = requirePrincipal(req);
      await deleteMaintenance(req.params.id, req.query.version, p);
      return { ok: true };
    },
  );
}
