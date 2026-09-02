import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  autoPartReceiptListQuerySchema,
  autoPartReceiptSummaryQuerySchema,
  createReceiptSchema,
  moscowDateKeyOf,
  receiptDeletionMarkSchema,
  receiptVersionQuerySchema,
  updateReceiptSchema,
  uuidSchema,
  vehiclePartsSpendQuerySchema,
  vehiclePartsSpendSnapshotQuerySchema,
  type AutoPartReceiptDto,
  type AutoPartReceiptListItemDto,
  type AutoPartReceiptsSummaryDto,
  type ListResult,
  type VehiclePartsSpendDto,
  type VehiclePartsSpendSnapshotDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import { err } from '../lib/errors';
import {
  createReceipt,
  clearReceiptDeletionMark,
  deleteReceipt,
  markReceiptForDeletion,
  updateReceipt,
} from '../services/auto-part-receipts';
import {
  listReceipts,
  loadReceiptDto,
  loadReceiptsSummary,
  loadVehiclePartsSpend,
  loadVehiclePartsSnapshot,
} from '../services/auto-part-receipts-read';
import { db } from '../db/client';

/**
 * Чеки на автозапчасти (план `docs/auto-part-receipts-plan.md`, §7; миграция `0243`) — раздел
 * отвечает на один вопрос: «сколько вложено в эту машину».
 *
 * **Права разведены надвое, и третьего нет** (Р5, Р12, Р4а):
 *
 * · читают — под `garage.read`. Вопрос «сколько вложено в эту машину» задаёт всякий, кому виден
 *   гараж: и механик, и диспетчер, и менеджер. Персональных данных в чеке нет, а деньги портал
 *   этой же аудитории показывает давно (тарифы вывоза, сметы заявок). Отсюда и правило колонки:
 *   сумма по машине видна во вкладке «Техника» БЕЗ права на показания;
 * · ведут — под `autoParts.manage`: заведение, правка, пометка на удаление и её снятие;
 * · удаляет — только держатель `autoParts.delete`, то есть администратор: право неназначаемо
 *   (`NON_GRANTABLE_PERMISSIONS`), и «только администратор» здесь выражено САМИМ ПРАВОМ, а не
 *   условием в манифесте.
 *
 * **Условных прав в модуле нет ни одного**, и это упрощение против замороженного склада: там право
 * зависело от эффекта запроса (двинул ли акт остаток), здесь ведение чеков не делится на
 * «реквизиты» и «движение» — чек не двигает ничего.
 *
 * **Пометка стоит двумя ручками, а не полем в `PATCH`** (Р12, §2.3): правка чека её не трогает, а
 * поле внутри общей формы означало бы обратное — что пометку ставят и снимают заодно с
 * реквизитами. Обе спрашивают версию: пометить чек, который тем временем переписали, — то же
 * расхождение, что и правка.
 *
 * **Области видимости у ручек нет вовсе**: парк у портала один, своей оси области у службы
 * механика не заведено — та же граница, что у журнала ТО, и другой в этом разделе не будет.
 *
 * Чего в этом файле НЕТ: расчётов. Итог чека, «не отнесено», цена за единицу и суммы по машинам
 * считаются в сервисе одной формулой на все ответы (`services/auto-part-receipts-read.ts`) —
 * второго места, где портал узнаёт сумму, в модуле не заводится.
 */

/** `:id` — сам чек: карточку, правку, пометку и удаление адресуют документом. */
const receiptParams = z.object({ id: uuidSchema });
/** `:id` — машина: окно «Запчасти машины» адресуется техникой, а не чеком. */
const vehicleParams = z.object({ id: uuidSchema });

/**
 * День среза сумм по машинам (Р14): присланный либо сегодняшний московский — тем же приёмом, что
 * день гаража и снапшот ТО (`dayOf` в routes/garage.ts). Часы браузера бывают сбиты, а восточнее
 * Москвы сутки начинаются раньше, и «сегодня» клиента показало бы покупку, сделанную завтра.
 */
function dayOf(on: string | undefined): string {
  return on ?? moscowDateKeyOf(new Date());
}

export default async function autoPartReceiptsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: [app.authenticate, app.requirePermission('garage.read')] };
  const manage = { preHandler: [app.authenticate, app.requirePermission('autoParts.manage')] };
  const remove = { preHandler: [app.authenticate, app.requirePermission('autoParts.delete')] };

  /**
   * Лента чеков: период по дате чека, машина, поиск, «помеченные к удалению», страницы, сортировка.
   *
   * Помеченные к удалению из ленты не исчезают никогда (Р12): пометка — просьба к администратору,
   * а не изъятие документа из учёта. `deletionMarked=true` показывает его очередь, и это
   * фильтр, а не режим.
   */
  r.get(
    '/',
    { ...read, schema: { querystring: autoPartReceiptListQuerySchema } },
    async (req): Promise<ListResult<AutoPartReceiptListItemDto>> => listReceipts(req.query),
  );

  /**
   * Сводка вкладки: чеков, сумма, «не отнесено» и «к удалению» (§8).
   *
   * Отбор у неё тот же, что у ленты, и параметров страницы нет вовсе: сводка отвечает про то, что
   * видно целиком, а не про текущую страницу. «Сумма», посчитанная по другому набору строк, чем
   * показанный список, вводила бы в заблуждение вернее, чем её отсутствие.
   */
  r.get(
    '/summary',
    { ...read, schema: { querystring: autoPartReceiptSummaryQuerySchema } },
    async (req): Promise<AutoPartReceiptsSummaryDto> => loadReceiptsSummary(req.query),
  );

  /**
   * Суммы по машинам пакетом — колонка «Запчасти, ₽» видимой страницы гаража (Р14).
   *
   * День среза возвращается в ответе, потому что его мог посчитать сервер: подпись колонки обязана
   * называть тот же день, по которому шёл отбор. Машина без чеков из ответа просто выпадает —
   * колонка рисует прочерк, а не «0 ₽»: ноль был бы утверждением «на машину не тратили», а машина
   * без покупок и машина, по которой чеков ещё не завели, — одно и то же незнание.
   *
   * Порядок ответа — порядок запрошенных машин: колонка ставится против строк страницы.
   *
   * Стоит ВЫШЕ `/:id` намеренно: `vehicles` — не идентификатор чека, и статический путь обязан
   * разбираться раньше параметрического.
   */
  r.get(
    '/vehicles/snapshot',
    { ...read, schema: { querystring: vehiclePartsSpendSnapshotQuerySchema } },
    async (req): Promise<{ to: string; items: VehiclePartsSpendSnapshotDto[] }> => {
      const to = dayOf(req.query.to);
      const ids = req.query.ids;
      // Пустая страница спрашивать базу не должна: `ids=` — законное значение, а не отказ.
      if (ids.length === 0) return { to, items: [] };
      const found = await loadVehiclePartsSnapshot(ids, to);
      return {
        to,
        items: ids.flatMap((id) => {
          const item = found.get(id);
          return item ? [item] : [];
        }),
      };
    },
  );

  /**
   * Окно «Запчасти машины» (Р15): итог за период, итог за всё время и строки с реквизитами чеков.
   *
   * 404 приходит ровно на одно — машины нет в справочнике. Машина без единой покупки отвечает
   * пустым перечнем и нулями: «чеков не заводили» и «машины не существует» это разные ответы, и
   * окно обязано их различать.
   */
  r.get(
    '/vehicles/:id',
    { ...read, schema: { params: vehicleParams, querystring: vehiclePartsSpendQuerySchema } },
    async (req): Promise<VehiclePartsSpendDto> => {
      const spend = await loadVehiclePartsSpend(req.params.id, req.query);
      if (!spend) throw err.notFound('Машина не найдена');
      return spend;
    },
  );

  /** Карточка чека: шапка, строки, сканы, оба итога и пометка. */
  r.get(
    '/:id',
    { ...read, schema: { params: receiptParams } },
    async (req): Promise<AutoPartReceiptDto> => loadReceiptDto(db, req.params.id),
  );

  /**
   * Принять чек: шапка, строки и сканы одним телом (Р6, Р12).
   *
   * Ни итога, ни `seq` в теле нет вовсе, и присланные они получают 400 с именем поля (`.strict()`
   * схем): сумму чека считает сервер по строкам (Р11), а порядок строк задаёт сам массив (§6).
   * Дату чека в будущем отбивает схема — тоже полем (Р13, ADR 0094).
   */
  r.post(
    '/',
    { ...manage, schema: { body: createReceiptSchema } },
    async (req, reply): Promise<AutoPartReceiptDto> => {
      const p = requirePrincipal(req);
      const created = await createReceipt(req.body, p);
      reply.code(201);
      return created;
    },
  );

  /**
   * Правка целиком — с версией (Р12): два механика, открывшие один чек, не затирают друг друга
   * молча. Расхождение версий — 409 из сервиса, где чек взят под блокировку.
   *
   * Строки и сканы обязательны так же, как при заведении: правка — это переписанный документ
   * целиком, и «файлы не прислали» означало бы чек без бумаги ровно с той же вероятностью, что и
   * «прислали пустой список». Отсюда правило Р6 на правке — снять последний скан нельзя, и отказ
   * приходит схемой.
   */
  r.patch(
    '/:id',
    { ...manage, schema: { params: receiptParams, body: updateReceiptSchema } },
    async (req): Promise<AutoPartReceiptDto> => {
      const p = requirePrincipal(req);
      const { version, ...input } = req.body;
      return updateReceipt(req.params.id, input, version, p);
    },
  );

  /**
   * Пометить чек к удалению: причина и версия в теле (Р12).
   *
   * Причина обязательна: пометка — просьба к администратору, и «предлагаю удалить, а зачем не
   * скажу» это не просьба, а загадка. Ни одной цифры пометка не меняет: помеченный чек виден в
   * ленте, входит в суммы и правится как прежде.
   */
  r.post(
    '/:id/deletion-mark',
    { ...manage, schema: { params: receiptParams, body: receiptDeletionMarkSchema } },
    async (req): Promise<AutoPartReceiptDto> => {
      const p = requirePrincipal(req);
      return markReceiptForDeletion(req.params.id, req.body, p);
    },
  );

  /**
   * Снять пометку; версия — в адресе, тела у DELETE нет.
   *
   * Версия обязательна и здесь: снятие вслепую сняло бы пометку, поставленную уже после того, как
   * экран был открыт, — то есть ответило бы не на ту просьбу.
   */
  r.delete(
    '/:id/deletion-mark',
    { ...manage, schema: { params: receiptParams, querystring: receiptVersionQuerySchema } },
    async (req): Promise<AutoPartReceiptDto> => {
      const p = requirePrincipal(req);
      return clearReceiptDeletionMark(req.params.id, req.query.version, p);
    },
  );

  /**
   * Удалить чек — насовсем, вместе со строками, и только держателю `autoParts.delete` (Р4а).
   *
   * Право неназначаемо и достаётся одному администратору, потому что после удаления от денежного
   * документа в портале не остаётся ничего, кроме строки аудита с его реквизитами. Сканы
   * отвязываются явно и уезжают на отложенное удаление — не каскадом (Р6): иначе файл остался бы
   * в хранилище сиротой.
   *
   * Версия в адресе: удалять чужую правку вслепую нельзя ровно по той же причине, по которой её
   * нельзя вслепую переписывать.
   */
  r.delete(
    '/:id',
    { ...remove, schema: { params: receiptParams, querystring: receiptVersionQuerySchema } },
    async (req): Promise<{ ok: true }> => {
      const p = requirePrincipal(req);
      await deleteReceipt(req.params.id, req.query.version, p);
      return { ok: true };
    },
  );
}
