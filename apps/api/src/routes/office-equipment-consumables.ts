import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, desc, eq, inArray, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  createOfficeEquipmentConsumableSchema,
  formatServiceRequestNumber,
  officeEquipmentConsumableListQuerySchema,
  officeEquipmentConsumableStockSchema,
  officeEquipmentConsumableUsageQuerySchema,
  type OfficeEquipmentConsumableDetailDto,
  type OfficeEquipmentConsumableDto,
  type OfficeEquipmentConsumableStockEntryDto,
  type OfficeEquipmentConsumableStockResultDto,
  type OfficeEquipmentConsumableUsageDto,
  type OfficeEquipmentModelRefDto,
  updateOfficeEquipmentConsumableSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  officeEquipment,
  officeEquipmentConsumableModels,
  officeEquipmentConsumableStockEntries,
  officeEquipmentConsumables,
  officeEquipmentModels,
  serviceRequests,
  users,
} from '../db/schema';
import type { Principal } from '../auth/principal';
import { requirePrincipal } from '../auth/plugin';
import { assertCan, officeEquipmentScopeWhere } from '../lib/access';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  consumableUsageWorkbook,
  loadConsumableUsage,
} from '../services/office-equipment-consumable-usage';

/**
 * Справочник расходников оргтехники — картриджей и тонеров (план
 * `docs/office-equipment-consumables-plan.md`, Р5–Р7, Р9–Р11; миграция `0172`, выпуск A). Отвечает
 * на два вопроса, на которые портал сегодня не отвечает вовсе: «чем заправить вот этот аппарат» и
 * «сколько таких картриджей на складе». Ведут его окном из вкладки «Оргтехника» (Р8), рядом с
 * окнами типов и моделей: расходник существует только при технике, и своей вкладки в
 * «Справочниках» не заводит.
 *
 * Права разведены на три (Р10). Чтение — широкое `officeEquipment.read`: подобрать позицию при
 * заведении заявки должен каждый, кому видна оргтехника. Запись — своя пара, отдельная от
 * `officeEquipment.write`, потому что то право открывает **весь парк**: карточки техники, модели,
 * перемещения. Человеку, который ведёт номенклатуру картриджей, парк править незачем, и наоборот.
 *
 *   · `officeEquipmentConsumables.manage` — заведение, правка, гашение и удаление позиции вместе с
 *     её совместимостью с моделями;
 *   · `officeEquipmentConsumables.stock` — правка остатка: `POST /:id/stock` и **ненулевой
 *     начальный остаток при заведении** (см. `POST /`; заведение с нулём — работа `manage`).
 *
 * Разведены между собой потому, что это разные работы: завести позицию в справочнике и пересчитать
 * коробки на полке делают не обязательно одни руки. Оба права выдаются набором «Оргтехника:
 * номенклатура» и ролям не раздаются.
 *
 * **Области у справочника нет** — по той же причине, что у моделей: расходник лежит на складе один
 * на компанию (остаток по местам хранения — граница §10), и сузить перечень площадкой значило бы
 * спрятать от человека строку, которую он сам же и завёл. Область появится ровно в одном месте — в
 * счётчике «сколько таких аппаратов в парке» у привязанной модели (Р12), и это отдельный срез
 * следующей волны.
 *
 * **Написание кода нормализует БАЗА.** На таблице стоит
 * `office_equipment_consumables_code_normalized_check (code = office_equipment_consumable_code_key(code))`,
 * и та же функция стоит в уникальном индексе (миграция `0172`). Отсюда правило маршрута: всякий
 * присланный код уезжает в базу выражением `office_equipment_consumable_code_key(...)`, а не
 * строкой из TypeScript. Своя нормализация была бы второй копией правила — и «б0000014256» с
 * маленькой буквы дало бы не «код занят», а 500 по `CHECK`, то есть ровно ту пятисотку, ради
 * которой правило и вынесено в функцию (урок моделей, Р4).
 *
 * **Остаток правится только ручкой `POST /:id/stock`** (Р7). Ни заведение с ненулевым числом, ни
 * эта ручка не пишут количество в одиночку: карточка и строка журнала идут одной транзакцией и в
 * жёстком порядке «сначала карточка, потом событие». Порядок задан не вкусом, а тремя триггерами
 * `0172` — они описаны у самой ручки.
 */

const idParams = z.object({ id: z.string().uuid() });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const NOT_FOUND = 'Расходник не найден';
/**
 * Один текст и одна пометка поля на обе двери отказа — проверку до вставки и разбор `23505` из
 * гонки (приём соседнего справочника моделей). Человеку всё равно, какая из них сработала: он видит
 * одно и то же положение дел, и в форме подсвечивается то же самое поле.
 *
 * Пометка обязательна, а не «приятна»: без пути поля портал показывает 409 тостом поверх формы
 * (ADR 0094), то есть мимо того единственного поля, которое человеку и надо исправить.
 */
const CODE_TAKEN = 'Расходник с таким кодом уже заведён';
const CODE_TAKEN_FIELDS = { code: 'Такой код уже заведён' };

/**
 * Причину первого события составляет маршрут, а не человек (см. контракт): спрашивать «почему у вас
 * на складе 12 штук» в форме заведения не за что — это не движение, а перенос уже известного
 * остатка в портал. Текст постоянный нарочно: по нему в ленте журнала видно, что число пришло из
 * формы заведения, а не из выдачи или прихода.
 */
const FIRST_ENTRY_REASON = 'Заведение карточки: начальный остаток';

/**
 * Как код ПИШЕТСЯ — функцией базы, а не выражением на месте: пробельные символы (включая
 * неразрывные из Word и Excel) удаляются, регистр поднимается. Ровно эта функция стоит в `CHECK`
 * таблицы и в уникальном индексе, поэтому нормализовать ввод по-своему маршруту нечем и незачем:
 * любое расхождение с ней — либо отказ ограничения на ровном месте, либо двойник в справочнике.
 */
function normalizedCode(code: string): SQL {
  return sql`office_equipment_consumable_code_key(${code})`;
}

/**
 * Ссылка на строку расходника ИЗВНЕ коррелированного подзапроса — ОТДЕЛЬНЫМ `sql`-объектом, а не
 * колонкой, вписанной прямо в выражение. Это не стиль, а условие правильности, и замерено оно
 * `toSQL()` (drizzle 0.45.2, `SELECT` с одной таблицей во `FROM`):
 *
 *   колонка на месте   `${officeEquipmentConsumables.id}`           → `WHERE "consumable_id" = "id"`
 *   отдельным объектом `${sql`${officeEquipmentConsumables.id}`}`   → `… = "office_equipment_consumables"."id"`
 *   чанком таблицы     `${sql`${officeEquipmentConsumables}."id"`}` → то же самое, символ в символ
 *
 * Собирая СПИСОК СТОЛБЦОВ односоставного запроса (`isSingleTable` в `pg-core/dialect.js`), drizzle
 * переписывает колоночные чанки в голые идентификаторы — но достаёт при этом лишь до выражения
 * верхнего уровня и внутрь вложенного `sql`-объекта не заходит. Значит, спасает сам факт выноса, а
 * не форма записи: колонка и чанк таблицы тут равноценны, и выбор между ними — вкус, а не защита.
 *
 * Без выноса голое имя Postgres разрешает в самом внутреннем `FROM`, то есть в таблице подзапроса:
 * условие «событие моего расходника» становится `consumable_id = id` самой строки журнала —
 * сравнением двух её собственных колонок. Отказа не бывает, обе колонки существуют, запрос
 * законен, и `EXISTS` просто всегда `false`. Портал предлагал бы удаление карточки с непустым
 * журналом, а `RESTRICT` отвечал бы на это 500 вместо слов.
 *
 * Две оговорки, чтобы правило не пересказали шире, чем оно есть. Первая: переписывание живёт только
 * в списке столбцов односоставного запроса — в `WHERE` и в запросе с соединением колонка сохраняет
 * квалификацию и вписанная на месте (замерено там же). Вторая: подмена ЭТОЙ константы на
 * `sql`${officeEquipmentConsumables.id}`` не меняет собранный SQL ни на символ, поэтому ждать, что
 * такую замену покраснением поймает тест, нечего — тест краснеет на колонке, вписанной В ВЫРАЖЕНИЕ.
 * Та же ловушка есть и в соседнем маршруте моделей, и поймана она там тем же выносом, но объяснена
 * прежней догадкой — «спасает чанк таблицы». Замер выше её уточняет: дело не в чанке, а в выносе.
 */
const consumableIdRef = sql`${officeEquipmentConsumables}."id"`;

/**
 * Есть ли по расходнику хоть одно движение остатка — ответ на «удаляема ли карточка» (Р11). Пока
 * журнал пуст, запись удаляется совсем (так убирают опечатку первого дня); появилось событие —
 * только гашение флагом.
 *
 * Признак булев намеренно: сколько именно было правок, вопросу об удалении безразлично, а лента
 * журнала отвечает на «сколько» подробнее и в карточке.
 *
 * Области у него нет — как у `isUsed` соседнего справочника моделей: остаток и его история одни на
 * компанию, и «есть движение» не зависит от того, кто смотрит.
 */
const hasStockHistoryExpr = sql<boolean>`EXISTS (
  SELECT 1 FROM ${officeEquipmentConsumableStockEntries}
   WHERE ${officeEquipmentConsumableStockEntries.consumableId} = ${consumableIdRef}
)`;

/**
 * Ссылка на модель КАРТОЧКИ ТЕХНИКИ изнутри счётчика — тем же приёмом, что выше (отдельный
 * `sql`-объект). Но сказать про неё надо ровно то, что замерено, и не больше.
 *
 * СЕГОДНЯ ОНА НИЧЕГО НЕ СПАСАЕТ, и это честнее скрыть невозможно: у формы `IN (…)`, которой счётчик
 * и написан, два `model_id` стоят на РАЗНЫХ уровнях запроса — левый в `WHERE` подзапроса по технике,
 * правый в списке столбцов вложенного `SELECT`, — и каждый разрешается в свой ближайший `FROM`.
 * Замер на копии парка (`toSQL()` + счёт): вынесенная сторона даёт 68, вписанная на месте — те же
 * 68, символ в символ те же таблицы. Константа стоит здесь не как защита, а как одно правило на
 * файл: перепиши кто-нибудь `IN` через `EXISTS` (естественный ход мысли) — и защита понадобится
 * сразу же, а вспоминать про неё в этот момент будет негде.
 *
 * КОГДА ЖЕ ОНА ПОНАДОБИТСЯ. Тавтология выходит при совпадении двух условий: обе стороны корреляции
 * оказались на ОДНОМ уровне И колонка одноимённа в обеих его таблицах. Ровно это и есть форма
 * `EXISTS (SELECT 1 FROM cm WHERE cm.consumable_id = … AND cm.model_id = oe.model_id)`: потеряв
 * квалификацию, оба конца достаются связи, `"model_id" = "model_id"` истинно всегда, и счётчик
 * отдаёт весь живой активный парк в области — у всякого расходника, к которому привязана хоть одна
 * модель. Замерено там же: 359 вместо 68.
 *
 * ЧЕМ ЭТО ХУЖЕ СОСЕДНЕЙ ОШИБКИ. У `consumableIdRef` колонки разноимённы (`consumable_id` и `id`),
 * поэтому та же потеря даёт не тавтологию, а сравнение двух чужих колонок — ответ пуст. Пустой
 * ответ хоть немного подозрителен: «движения нет» у карточки, которую вчера правили, кто-нибудь да
 * заметит. Правдоподобно полный не заметит никто — его прочитают как «нам нужно много картриджей»
 * и составят по нему заказ. Отказа не бывает ни в том, ни в другом случае: колонки существуют,
 * запрос законен.
 */
const equipmentModelIdRef = sql`${officeEquipment}."model_id"`;

/**
 * Сколько аппаратов кормит расходник — **в области смотрящего** (Р12, Р15). Второе число заказа:
 * остаток 12 при 68 аппаратах и при 2 аппаратах означает разное.
 *
 * ОБЛАСТЬ — ТЕМ ЖЕ ПРЕДИКАТОМ `officeEquipmentScopeWhere`, что и список техники, а не похожим на
 * него: право `officeEquipment.read` сквозной видимости не даёт, и роль одной площадки, увидев
 * сквозные 68, узнала бы масштаб чужого парка. У роли отдела предикат отдаёт её отделы **и всю
 * неразмеченную технику** — это его правило целиком, и своей копии у счётчика нет и быть не должно.
 *
 * СЧИТАЮТСЯ АППАРАТЫ, А НЕ ПАРЫ. Соединение с таблицей связи размножило бы карточку по числу
 * подходящих ей моделей расходника, поэтому связь спрашивается подзапросом: `model_id` карточки
 * ищется среди моделей расходника. Сегодня у карточки модель одна и утроиться она не может, но
 * правило обязано быть верным само по себе, а не благодаря внешнему обстоятельству, — иначе первая
 * же вторая модель у аппарата молча утроила бы парк.
 *
 * `IN (…)`, а не `EXISTS`, ровно по этой же причине читаемости, и заодно оно естественно молчит о
 * карточках без модели: `NULL IN (…)` — не истина, а таких карточек в окне выката A ещё полно (Р2).
 *
 * Живые и активные: вопрос счётчика — «сколько аппаратов надо кормить», а архив и выведенная из
 * эксплуатации техника картриджей не просят.
 *
 * Коррелированным подзапросом, как счётчик парка у моделей: это ОДИН запрос на страницу, а не
 * запрос на строку — план считает подзапрос по индексу `office_equipment_consumable_models` и
 * ссылке карточки на модель. Показывается он и в списке, и в карточке нарочно: заказ идут
 * составлять по списку («остаток 4 — а сколько их у нас?»), и уводить это число в карточку значило
 * бы заставлять открывать пятнадцать окон подряд.
 */
function equipmentCountExpr(p: Principal): SQL<number> {
  const scope = officeEquipmentScopeWhere(
    p,
    officeEquipment.objectId,
    officeEquipment.ownerDepartmentId,
  );
  return sql<number>`(
    SELECT count(*) FROM ${officeEquipment}
     WHERE ${officeEquipment.deletedAt} IS NULL
       AND ${officeEquipment.isActive}
       AND ${equipmentModelIdRef} IN (
         SELECT ${officeEquipmentConsumableModels.modelId}
           FROM ${officeEquipmentConsumableModels}
          WHERE ${officeEquipmentConsumableModels.consumableId} = ${consumableIdRef}
       )
       ${scope ? sql`AND (${scope})` : sql.empty()}
  )`;
}

/**
 * Столбцы ответа. Функцией, а не константой: счётчик парка зависит от смотрящего (Р12), и вынести
 * его в общее выражение значило бы посчитать чью-то чужую область — ровно то, чего право
 * `officeEquipment.read` не даёт.
 */
function dtoColumns(p: Principal) {
  return {
    id: officeEquipmentConsumables.id,
    code: officeEquipmentConsumables.code,
    name: officeEquipmentConsumables.name,
    quantity: officeEquipmentConsumables.quantity,
    isActive: officeEquipmentConsumables.isActive,
    color: officeEquipmentConsumables.color,
    comment: officeEquipmentConsumables.comment,
    hasStockHistory: hasStockHistoryExpr,
    equipmentCount: equipmentCountExpr(p),
    createdAt: officeEquipmentConsumables.createdAt,
    updatedAt: officeEquipmentConsumables.updatedAt,
  };
}

interface DtoRow {
  id: string;
  code: string;
  name: string;
  quantity: number;
  isActive: boolean;
  color: string | null;
  comment: string;
  hasStockHistory: boolean;
  equipmentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(r: DtoRow, models: OfficeEquipmentModelRefDto[]): OfficeEquipmentConsumableDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    quantity: r.quantity,
    isActive: r.isActive,
    color: r.color,
    comment: r.comment,
    models,
    hasStockHistory: r.hasStockHistory,
    // `count(*)` приезжает из pg строкой (bigint), как у счётчиков моделей и типов ТС.
    equipmentCount: Number(r.equipmentCount),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * «К чему подходит» для целой страницы списка — одним запросом, а не запросом на строку: колонка
 * «Модели» есть у каждой строки перечня, и связь читается сразу для всех показанных карточек
 * (приём синонимов контрагентов). Порядок — по имени модели: набор показывается перечислением, и
 * порядок вставки в нём читался бы как случайный.
 */
async function modelsByConsumableIds(
  ids: string[],
): Promise<Map<string, OfficeEquipmentModelRefDto[]>> {
  const map = new Map<string, OfficeEquipmentModelRefDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      consumableId: officeEquipmentConsumableModels.consumableId,
      id: officeEquipmentModels.id,
      name: officeEquipmentModels.name,
    })
    .from(officeEquipmentConsumableModels)
    .innerJoin(
      officeEquipmentModels,
      eq(officeEquipmentConsumableModels.modelId, officeEquipmentModels.id),
    )
    .where(inArray(officeEquipmentConsumableModels.consumableId, ids))
    .orderBy(officeEquipmentModels.name);
  for (const row of rows) {
    const list = map.get(row.consumableId) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.consumableId, list);
  }
  return map;
}

/** Карточка после записи читается тем же запросом, что и строка списка: расхождению негде взяться. */
async function getDto(id: string, p: Principal): Promise<OfficeEquipmentConsumableDto> {
  const [row] = await db
    .select(dtoColumns(p))
    .from(officeEquipmentConsumables)
    .where(eq(officeEquipmentConsumables.id, id));
  if (!row) throw err.notFound(NOT_FOUND);
  const models = await modelsByConsumableIds([id]);
  return toDto(row, models.get(id) ?? []);
}

/**
 * Лента журнала (Р7). Порядок — по `seq` вниз, а не по времени: две правки одной секунды по
 * `created_at` неразличимы, и цепочка «было — стало» в такой ленте читалась бы задом наперёд через
 * раз.
 *
 * Страниц у ленты нет намеренно: остаток правят руками и редко (склад ИТ-службы — полтора десятка
 * позиций), а карточка обязана показывать историю целиком — «куда делись двенадцать картриджей»
 * отвечает только весь журнал, а не его хвост.
 *
 * `innerJoin` по автору законен: `changed_by` объявлен `NOT NULL` и стоит с `RESTRICT` — учётку,
 * менявшую остаток, из портала не удалить (Р11), поэтому строка без автора не существует.
 *
 * А вот заявка присоединяется ЛЕВЫМ соединением, и это не осторожность: у ручной правки обе ссылки
 * пусты по `CHECK`у связок, и внутреннее соединение выбросило бы из ленты ровно те строки, ради
 * которых журнал и заводили первым выпуском. Номер собирается здесь же, а не на клиенте, — тем же
 * `formatServiceRequestNumber`, каким его пишет в причину маршрут заявки: разойдись они, лента
 * показала бы «выдано по СО-1234» рядом с причиной «Выдано по заявке 1234».
 */
async function stockEntriesOf(id: string): Promise<OfficeEquipmentConsumableStockEntryDto[]> {
  const rows = await db
    .select({
      id: officeEquipmentConsumableStockEntries.id,
      seq: officeEquipmentConsumableStockEntries.seq,
      entryKind: officeEquipmentConsumableStockEntries.entryKind,
      serviceRequestId: officeEquipmentConsumableStockEntries.serviceRequestId,
      serviceRequestConsumableId: officeEquipmentConsumableStockEntries.serviceRequestConsumableId,
      requestNum: serviceRequests.num,
      quantityBefore: officeEquipmentConsumableStockEntries.quantityBefore,
      quantityAfter: officeEquipmentConsumableStockEntries.quantityAfter,
      reason: officeEquipmentConsumableStockEntries.reason,
      changedByName: users.fullName,
      createdAt: officeEquipmentConsumableStockEntries.createdAt,
    })
    .from(officeEquipmentConsumableStockEntries)
    .innerJoin(users, eq(officeEquipmentConsumableStockEntries.changedBy, users.id))
    .leftJoin(
      serviceRequests,
      eq(officeEquipmentConsumableStockEntries.serviceRequestId, serviceRequests.id),
    )
    .where(eq(officeEquipmentConsumableStockEntries.consumableId, id))
    .orderBy(desc(officeEquipmentConsumableStockEntries.seq));
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    entryKind: r.entryKind,
    serviceRequestId: r.serviceRequestId,
    serviceRequestConsumableId: r.serviceRequestConsumableId,
    serviceRequestNumber: r.requestNum === null ? null : formatServiceRequestNumber(r.requestNum),
    quantityBefore: r.quantityBefore,
    quantityAfter: r.quantityAfter,
    reason: r.reason,
    changedByName: r.changedByName,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Набор моделей приходит полным (Р6), поэтому повтор внутри него — не просьба завести две
 * одинаковые привязки, а мусор формы или файла. Свести его надо до записи: пара «расходник +
 * модель» уникальна, и второй такой же элемент дал бы `23505` по чужому ограничению — то есть 500
 * там, где человек ничего дурного не просил.
 */
function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Все присланные модели существуют. Проверка до записи, потому что иначе выдуманный идентификатор
 * превратился бы в нарушение внешнего ключа — 500 с именем ограничения вместо ответа про поле.
 *
 * Активность модели здесь НЕ требуется: погашенная модель означает «новых таких аппаратов не
 * заводим», а картриджи для уже стоящих в кабинетах покупать по-прежнему нужно.
 */
async function assertModelsExist(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: officeEquipmentModels.id })
    .from(officeEquipmentModels)
    .where(inArray(officeEquipmentModels.id, ids));
  if (rows.length !== ids.length) {
    throw err.badRequest('Модель аппарата не найдена', {
      modelIds: 'Одна из выбранных моделей не найдена',
    });
  }
}

/**
 * Свести привязки к присланному набору: снять лишние, добавить недостающие. Именно свести, а не
 * «снести и записать заново»: `created_at` привязки — единственный след того, когда совместимость
 * разметили, и переписывать его при каждой правке комментария незачем.
 *
 * `onConflictDoNothing` — не про гонку двух вкладок (её эта пара и так переживёт), а про то же
 * самое сведение: строка, которая уже есть, повторной вставкой не считается.
 */
async function syncModels(tx: Tx, consumableId: string, ids: string[]): Promise<void> {
  await tx.delete(officeEquipmentConsumableModels).where(
    and(
      eq(officeEquipmentConsumableModels.consumableId, consumableId),
      // Пустой набор — «снять все», и условия по модели у такого удаления нет вовсе: `notInArray`
      // с пустым списком выражает не «ни одна не подходит», а неопределённость.
      ids.length > 0 ? notInArray(officeEquipmentConsumableModels.modelId, ids) : undefined,
    ),
  );
  if (ids.length > 0) {
    await tx
      .insert(officeEquipmentConsumableModels)
      .values(ids.map((modelId) => ({ consumableId, modelId })))
      .onConflictDoNothing();
  }
}

/**
 * Код свободен — проверяем до вставки, как занятость наименования у моделей. Уникальный индекс
 * держит то же самое, но его нарушение стало бы 500 с именем индекса, а человеку нужно знать, что
 * такой расходник уже заведён.
 *
 * Сравнение — той же функцией, что в индексе, и на ОБЕИХ сторонах: «Д0000337741», «д0000337741» и
 * «Д000 0337741» с неразрывным пробелом из письма — это один и тот же код. Хранимая сторона сегодня
 * и так нормализована (`CHECK`), но записывать эту равносильность в запрос нельзя: она следствие
 * соседнего ограничения, а не свойство ключа, и первая же миграция, ослабившая `CHECK`, молча увела
 * бы проверку в сторону от индекса.
 */
async function assertCodeFree(tx: Tx, code: string, exceptId?: string): Promise<void> {
  const dup = await tx
    .select({ id: officeEquipmentConsumables.id })
    .from(officeEquipmentConsumables)
    .where(
      and(
        sql`office_equipment_consumable_code_key(${officeEquipmentConsumables.code}) = office_equipment_consumable_code_key(${code})`,
        exceptId ? ne(officeEquipmentConsumables.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (dup.length > 0) throw err.conflict(CODE_TAKEN, { fields: CODE_TAKEN_FIELDS });
}

/**
 * Вторая дверь того же отказа. Гонка с соседним заведением доходит до уникального индекса: чужая
 * незакоммиченная строка проверке выше не видна, обе транзакции её проходят, и вторая падает на
 * `23505`. Без разбора это 500 — «внутренняя ошибка» там, где человеку нужно ровно то же слово, что
 * и при обычном дубле.
 *
 * Щель одна и та же у обеих записывающих дверей, поэтому разбор общий: и заведение, и правка кода
 * приходят сюда.
 *
 * Опознаётся кодом и именем индекса, а не текстом сообщения: текст зависит от версии и локали
 * сервера, а имя задано миграцией `0172`. Через `pgErrorOf`, потому что drizzle оборачивает ошибку
 * драйвера в свою и на верхнем объекте кода уже нет — прямая проверка молчала бы.
 */
function asCodeConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'office_equipment_consumables_code_unique') {
    return err.conflict(CODE_TAKEN, { fields: CODE_TAKEN_FIELDS });
  }
  /*
   * Та же щель у привязок: модель, свободную от расходников, сосед вправе удалить прямо между
   * проверкой и вставкой — `assertModelsExist` этого не видит. Наружу это уходит нарушением
   * внешнего ключа, и опознаётся оно по таблице-источнику: имя ключа Postgres собирает сам и
   * обрезает до 63 символов, то есть держать его константой значило бы держать длину усечения.
   */
  if (pg?.code === '23503' && pg.table === 'office_equipment_consumable_models') {
    return err.badRequest('Модель аппарата не найдена', {
      modelIds: 'Одна из выбранных моделей не найдена',
    });
  }
  return e;
}

export default async function officeEquipmentConsumablesRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('officeEquipment.read');
  // Ведение номенклатуры и правка остатка — разные права (Р10), поэтому и стражей двое: ручка
  // остатка не открывается тем, кто заводит позиции, и наоборот.
  const canManage = app.requirePermission(
    'officeEquipmentConsumables.manage',
    'Номенклатуру расходников ведёт ответственный за неё',
  );
  const canStock = app.requirePermission(
    'officeEquipmentConsumables.stock',
    'Остаток расходника правит ответственный за склад',
  );

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: officeEquipmentConsumableListQuerySchema },
    },
    async (req) => {
      // Субъект нужен списку не ради доступа (его уже проверил страж), а ради счётчика парка: он
      // считается в области смотрящего (Р12).
      const p = requirePrincipal(req);
      const q = req.query;
      const where = and(
        // «Что подходит к Ricoh IM 350» — вопрос из окна моделей и из карточки аппарата. Через
        // `EXISTS`, а не соединением: соединение по связи много-ко-многим размножило бы строку
        // расходника по числу его моделей, и `total` в ответе перестал бы быть числом карточек.
        //
        // Корреляция — тем же `consumableIdRef`, что и у признака движения. Здесь он, строго
        // говоря, не нужен: в `WHERE` колонка сохраняет квалификацию и вписанная на месте
        // (замерено `toSQL()`), переписывается только список столбцов односоставного запроса. Но
        // правило «ссылка наружу выносится отдельным `sql`-объектом» обязано быть одним на файл:
        // первое же перемещение этого выражения в `select` вернуло бы молчаливый `false`.
        q.modelId
          ? sql`EXISTS (
              SELECT 1 FROM ${officeEquipmentConsumableModels}
               WHERE ${officeEquipmentConsumableModels.consumableId} = ${consumableIdRef}
                 AND ${officeEquipmentConsumableModels.modelId} = ${q.modelId}
            )`
          : undefined,
        // «Нет в наличии» — тот срез, ради которого в справочник заходят перед заказом. Ноль, а не
        // «меньше единицы»: отрицательного остатка не бывает (`CHECK`), и писать неравенство
        // значило бы намекать, что бывает.
        q.stock === undefined
          ? undefined
          : q.stock === 'in_stock'
            ? sql`${officeEquipmentConsumables.quantity} > 0`
            : eq(officeEquipmentConsumables.quantity, 0),
        q.isActive === undefined ? undefined : eq(officeEquipmentConsumables.isActive, q.isActive),
        // Ищут обеими половинами карточки (Р9): «Pantum» и «Д0000337733» обязаны находить одну и ту
        // же строку — код спрашивают у счёта, наименование помнят на слух.
        searchCondition(q.search, [
          officeEquipmentConsumables.name,
          officeEquipmentConsumables.code,
        ]),
      );
      const sortCols = {
        name: officeEquipmentConsumables.name,
        code: officeEquipmentConsumables.code,
        quantity: officeEquipmentConsumables.quantity,
        updatedAt: officeEquipmentConsumables.updatedAt,
      };
      // Умолчание — наименование по возрастанию (Р9): справочник читают алфавитом, а не «последнее
      // заведённое сверху», как перечень техники. Направление по умолчанию задаёт контракт
      // (`sortOrder.default('asc')`), поле — четвёртый аргумент.
      const p2 = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns(p))
          .from(officeEquipmentConsumables)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'name'))
          .limit(p2.limit)
          .offset(p2.offset),
        db.select({ c: count() }).from(officeEquipmentConsumables).where(where),
      ]);
      const models = await modelsByConsumableIds(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, models.get(row.id) ?? [])),
        total: Number(totalRows[0]!.c),
        page: p2.page,
        pageSize: p2.pageSize,
      };
    },
  );

  /**
   * Расход за период (Р10, опрос В18): кто, сколько, на какие аппараты и по каким заявкам.
   *
   * ПРАВО — `officeEquipment.read`, то же, что у самого справочника. Отдельного права у отчёта нет
   * намеренно: он не показывает ничего, чего не показывает лента журнала в карточке позиции, —
   * те же события, те же имена, те же номера заявок, только собранные за отрезок времени и с
   * добавленным аппаратом. Заводить под ту же правду второе право значило бы выдать человеку
   * карточку, но запретить сводку по ней.
   *
   * СЧИТАЕТСЯ ПО ЖУРНАЛУ, тем же источником, что и остаток, — почему именно так, объяснено у
   * загрузчика (`services/office-equipment-consumable-usage.ts`).
   *
   * СТАТИЧЕСКИЙ ПУТЬ РЯДОМ С `/:id` — это не конфликт: маршрутизатор Fastify предпочитает
   * статический сегмент параметру, и `usage-report` до карточки не доедет. Порядок объявления на
   * это не влияет вовсе, но объявлен он выше карточки, чтобы читалось так же, как работает.
   */
  r.get(
    '/usage-report',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: officeEquipmentConsumableUsageQuerySchema },
    },
    async (req): Promise<OfficeEquipmentConsumableUsageDto> => loadConsumableUsage(req.query),
  );

  /**
   * Он же файлом (В18: «выгрузка в файл»). Тем же способом, что и соседние выгрузки модуля:
   * книга .xlsx собирается на сервере (`lib/xlsx`) и отдаётся телом ответа с именем в заголовке —
   * портал забирает её `apiDownload`, под тем же токеном, что и обычные запросы.
   *
   * Отдельной ручкой, а не параметром `format` у первой: у ответов разные типы содержимого и
   * разные схемы, и ручка, отвечающая то JSON, то байтами, ломает типизацию обеим сторонам.
   *
   * Данные — тем же самым вызовом, что у экрана: строки, порядок и итог у файла и у портала обязаны
   * совпадать, иначе спор о числах разбирают, сверяя два места вместо одного.
   */
  r.get(
    '/usage-report.xlsx',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: officeEquipmentConsumableUsageQuerySchema },
    },
    async (req, reply) => {
      const book = consumableUsageWorkbook(await loadConsumableUsage(req.query));
      return reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(book.filename)}`,
        )
        .send(Buffer.from(book.bytes));
    },
  );

  /** Карточка целиком: сама запись и лента её журнала (§6). */
  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req): Promise<OfficeEquipmentConsumableDetailDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const consumable = await getDto(id, p);
      return { ...consumable, stockEntries: await stockEntriesOf(id) };
    },
  );

  /**
   * Заведение. Начальный остаток — не поле карточки, а ПЕРВОЕ СОБЫТИЕ ЖУРНАЛА, и записывается оно
   * в той же транзакции: цепочка `0172` считает, что до первого события расходник был нулём,
   * поэтому строка выходит «0 → N». Без неё отложенный триггер покрытия отменил бы транзакцию на
   * коммите — «остаток есть, а в журнале пусто» он и ловит.
   *
   * Заведение с нулём событий не пишет вовсе: «0 → 0» это не событие, а его отсутствие, и `CHECK`
   * `quantity_after <> quantity_before` такую строку не пропустит (Р7).
   *
   * Порядок внутри транзакции — карточка, потом событие: цепочка сверяет «стало» с фактическим
   * остатком карточки, и обратный порядок она же и отобьёт.
   */
  r.post(
    '/',
    {
      preHandler: [app.authenticate, canManage],
      schema: { body: createOfficeEquipmentConsumableSchema },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const b = req.body;
      /*
       * НЕНУЛЕВОЙ НАЧАЛЬНЫЙ ОСТАТОК ТРЕБУЕТ `stock` СВЕРХ `manage`. Без этой проверки разделение
       * прав держалось бы только у уже заведённых позиций: ручка остатка закрыта, а то же число
       * ставится заведением — «завёл картридж, а на складе их сразу 900». Портал такую дверь у
       * себя прикрыл типом формы, но это правило его собственного клиента, и запрос мимо портала
       * о нём не знает.
       *
       * Отказ, а не молчаливое обнуление: приняв число и записав ноль, портал соврал бы человеку
       * «сохранено» — тот же довод, по которому `quantity` не принимает и правка карточки.
       *
       * Проверка стоит ДО транзакции: она ничего не читает и не должна занимать соединение.
       *
       * Граница проведена по «нулю», а не по «полю в теле», потому что смысл у них разный. Ноль —
       * это отсутствие утверждения о складе: заведена новая позиция номенклатуры, коробок пока не
       * считали. Любое другое число — уже утверждение, и делает его тот, кому доверена правка
       * остатка. Довод сильнее, чем кажется: ошибившись числом, держатель одного `manage` свою
       * ошибку НЕ ИСПРАВИТ — у карточки уже есть строка журнала, значит `DELETE` отобьёт
       * `RESTRICT`, а правка остатка потребует того самого права, которого у него нет. Человек
       * остался бы с неверным числом и без выхода.
       *
       * У кого есть оба права — проходит и то и другое, одним запросом: разводить его на два шага
       * незачем, право у него ровно то, которого требует операция.
       */
      if (b.quantity > 0) {
        assertCan(
          p,
          'officeEquipmentConsumables.stock',
          'Заведите позицию с нулевым остатком: начальное число проставит тот, кому доверена правка остатка',
        );
      }
      const modelIds = uniqueIds(b.modelIds);
      const created = await db
        .transaction(async (tx) => {
          await assertCodeFree(tx, b.code);
          await assertModelsExist(tx, modelIds);
          const [row] = await tx
            .insert(officeEquipmentConsumables)
            .values({
              // Нормализация — выражением базы, а не строкой из TypeScript: см. преамбулу.
              code: normalizedCode(b.code),
              // Наименование, наоборот, ложится ДОСЛОВНО, вместе с хвостом «(шт)»: справочник
              // сверяют глазами со счётом, и «причёсанное» имя эту сверку ломает (Р5).
              name: b.name,
              quantity: b.quantity,
              isActive: b.isActive,
              color: b.color,
              comment: b.comment,
              createdBy: p.id,
              updatedBy: p.id,
            })
            .returning({
              id: officeEquipmentConsumables.id,
              code: officeEquipmentConsumables.code,
            });
          const consumable = row!;
          await syncModels(tx, consumable.id, modelIds);
          if (b.quantity > 0) {
            await tx.insert(officeEquipmentConsumableStockEntries).values({
              consumableId: consumable.id,
              // Вид события проставляет сервер, а не клиент: заведение карточки — ручная работа
              // кладовщика, и выдать её за списание по заявке нельзя даже подделанным телом.
              entryKind: 'manual',
              quantityBefore: 0,
              quantityAfter: b.quantity,
              reason: FIRST_ENTRY_REASON,
              changedBy: p.id,
            });
          }
          return consumable;
        })
        // Гонка с соседним заведением приходит сюда нарушением уникального индекса — и уходит тем
        // же 409, что и обычный дубль.
        .catch((e: unknown) => {
          throw asCodeConflict(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentConsumable.create',
        entityType: 'officeEquipmentConsumable',
        entityId: created.id,
        // Код пишется нормализованным — тем видом, в котором он лёг в справочник, а не тем, который
        // набрали в форме: по журналу ищут заведённую строку, а не ввод.
        metadata: { code: created.code, name: b.name, quantity: b.quantity },
      });
      reply.code(201);
      return await getDto(created.id, p);
    },
  );

  /**
   * Правка карточки. Количества здесь нет вовсе (Р7): схема его не принимает, и приняв — маршрут
   * соврал бы человеку «сохранено» там, где остаток остался прежним и в журнал ничего не легло.
   * Остаток правит только `POST /:id/stock`.
   *
   * Строка читается `FOR UPDATE` не ради остатка, а ради самой карточки: правка кода двумя людьми
   * и правка кода против гашения обязаны увидеть результат друг друга, а не разойтись по своим
   * снимкам. Заодно под этой же блокировкой стоит проверка занятости кода.
   */
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canManage],
      schema: { params: idParams, body: updateOfficeEquipmentConsumableSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      const modelIds = b.modelIds === undefined ? undefined : uniqueIds(b.modelIds);
      await db
        .transaction(async (tx) => {
          const [row] = await tx
            .select({ id: officeEquipmentConsumables.id })
            .from(officeEquipmentConsumables)
            .where(eq(officeEquipmentConsumables.id, id))
            .for('update');
          if (!row) throw err.notFound(NOT_FOUND);
          // С исключением себя: правка «д0000337741» → «Д0000337741» — это исправление написания,
          // а не двойник. Сама запись при этом всё равно уедет нормализованной — базе безразлично,
          // изменилось написание или нет.
          if (b.code !== undefined) await assertCodeFree(tx, b.code, id);
          if (modelIds !== undefined) {
            await assertModelsExist(tx, modelIds);
            await syncModels(tx, id, modelIds);
          }
          await tx
            .update(officeEquipmentConsumables)
            .set({
              ...(b.code === undefined ? {} : { code: normalizedCode(b.code) }),
              ...(b.name === undefined ? {} : { name: b.name }),
              ...(b.isActive === undefined ? {} : { isActive: b.isActive }),
              ...(b.color === undefined ? {} : { color: b.color }),
              ...(b.comment === undefined ? {} : { comment: b.comment }),
              updatedBy: p.id,
              updatedAt: new Date(),
            })
            .where(eq(officeEquipmentConsumables.id, id));
        })
        .catch((e: unknown) => {
          throw asCodeConflict(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentConsumable.update',
        entityType: 'officeEquipmentConsumable',
        entityId: id,
        // Только присланное: журнал правки обязан показывать, что именно просили изменить, а не
        // всю карточку — иначе непонятно, тронули поле или оно просто приехало формой.
        metadata: {
          ...(b.code === undefined ? {} : { code: b.code }),
          ...(b.name === undefined ? {} : { name: b.name }),
          ...(b.isActive === undefined ? {} : { isActive: b.isActive }),
          // Цвет и комментарий — такие же присланные поля: обещание «показываем, что именно
          // просили изменить» не выполняется выборочно, а смена цвета у позиции меняет то, какую
          // тубу по ней выдадут.
          ...(b.color === undefined ? {} : { color: b.color }),
          ...(b.comment === undefined ? {} : { comment: b.comment }),
          ...(modelIds === undefined ? {} : { modelIds }),
        },
      });
      return await getDto(id, p);
    },
  );

  /**
   * Правка остатка (Р7). Порядок шагов обязателен и держится тремя триггерами `0172`, а не
   * вежливостью маршрута:
   *
   *   1. `SELECT … FOR UPDATE` строки расходника — первым шагом транзакции. Без блокировки два
   *      кладовщика прочитали бы 12, записали «12 → 10» и «12 → 8», и цепочка журнала стала бы
   *      враньём при верном итоге;
   *   2. сверка с `expectedQuantity` — тем числом, которое человек видел в форме. Разошлось — 409
   *      с текущим значением: молчаливая перезапись превращается в понятный отказ. Блокировку это
   *      не заменяет, а дополняет — она сериализует, а сверка объясняет;
   *   3. новое значение равно текущему — выход БЕЗ записи. Это не ошибка ввода, а повторное
   *      нажатие кнопки, и журнал не должен пухнуть от таких событий; в ответе это `entry: null`;
   *   4. `UPDATE` карточки, затем `INSERT` события — и только в таком порядке: триггер цепочки
   *      сверяет «стало» события с ФАКТИЧЕСКИМ остатком карточки, поэтому событие, вставленное
   *      раньше правки, будет отбито.
   *
   * `quantity_before` маршрут берёт из прочитанной строки, а не из тела: `expectedQuantity` — это
   * то, что человек ВИДЕЛ, и в шаге 2 оно уже сверено, а в журнал обязано лечь то, что было на
   * самом деле. Совпадают они всегда — но совпадают потому, что проверены, а не по построению.
   */
  r.post(
    '/:id/stock',
    {
      preHandler: [app.authenticate, canStock],
      schema: { params: idParams, body: officeEquipmentConsumableStockSchema },
    },
    async (req): Promise<OfficeEquipmentConsumableStockResultDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      const written = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            code: officeEquipmentConsumables.code,
            quantity: officeEquipmentConsumables.quantity,
          })
          .from(officeEquipmentConsumables)
          .where(eq(officeEquipmentConsumables.id, id))
          .for('update');
        if (!row) throw err.notFound(NOT_FOUND);
        if (row.quantity !== b.expectedQuantity) {
          /*
           * Пометки поля здесь нет намеренно, в отличие от занятого кода: исправлять человеку
           * нечего — число в форме не ошибочно, оно устарело. Ответ обязан назвать текущее
           * значение прямо в тексте, иначе окно правки предложит переспросить то же самое.
           */
          throw err.conflict(`Остаток изменил другой человек, сейчас ${row.quantity}`);
        }
        // Шаг 3: повторное нажатие. Выход до всякой записи — карточку не трогаем вовсе, поэтому и
        // `updated_at` у неё не сдвигается: правки не было.
        if (row.quantity === b.quantity) return null;
        await tx
          .update(officeEquipmentConsumables)
          .set({ quantity: b.quantity, updatedBy: p.id, updatedAt: new Date() })
          .where(eq(officeEquipmentConsumables.id, id));
        const [entry] = await tx
          .insert(officeEquipmentConsumableStockEntries)
          .values({
            consumableId: id,
            // Ручная правка — всегда `manual`, и обе ссылки на заявку пусты. Пишет это сервер, а не
            // клиент: тип события в теле ручки не принимается вовсе, иначе выдачу по заявке можно
            // было бы изготовить запросом мимо цикла заявки (`CHECK` связок в базе — второй рубеж).
            entryKind: 'manual',
            serviceRequestId: null,
            serviceRequestConsumableId: null,
            quantityBefore: row.quantity,
            quantityAfter: b.quantity,
            reason: b.reason,
            changedBy: p.id,
          })
          .returning({
            id: officeEquipmentConsumableStockEntries.id,
            seq: officeEquipmentConsumableStockEntries.seq,
            entryKind: officeEquipmentConsumableStockEntries.entryKind,
            serviceRequestId: officeEquipmentConsumableStockEntries.serviceRequestId,
            serviceRequestConsumableId:
              officeEquipmentConsumableStockEntries.serviceRequestConsumableId,
            quantityBefore: officeEquipmentConsumableStockEntries.quantityBefore,
            quantityAfter: officeEquipmentConsumableStockEntries.quantityAfter,
            reason: officeEquipmentConsumableStockEntries.reason,
            createdAt: officeEquipmentConsumableStockEntries.createdAt,
          });
        return { code: row.code, entry: entry! };
      });
      // Событие не записано — записывать в аудит нечего: повторное нажатие ничего не изменило, а
      // журнал остатка и без того подробнее аудита (Р7).
      if (written) {
        await writeAudit({
          actorUserId: p.id,
          action: 'officeEquipmentConsumable.stock',
          entityType: 'officeEquipmentConsumable',
          entityId: id,
          metadata: {
            code: written.code,
            quantityBefore: written.entry.quantityBefore,
            quantityAfter: written.entry.quantityAfter,
            reason: written.entry.reason,
          },
        });
      }
      return {
        consumable: await getDto(id, p),
        // Автор события — тот, кто его только что записал, и второй запрос за его ФИО был бы
        // запросом к самому себе.
        entry: written
          ? {
              ...written.entry,
              changedByName: p.fullName,
              // Номер заявки у ручной правки пуст по построению: обе ссылки на заявку она пишет
              // пустыми, и брать его неоткуда — не «пока неизвестен», а «его нет».
              serviceRequestNumber: null,
              createdAt: written.entry.createdAt.toISOString(),
            }
          : null,
      };
    },
  );

  /**
   * Удаление по правилу Р11: пока журнал остатка пуст, запись удаляется совсем — так убирают
   * опечатку первого дня; появилось хоть одно движение — только гашение флагом «Активен».
   *
   * Держит это `ON DELETE RESTRICT` журнала, а не маршрут; проверка здесь стоит лишь затем, чтобы
   * человек прочитал слова, а не имя ограничения.
   *
   * Проверка ВНУТРИ транзакции и после `FOR UPDATE` по строке расходника — не для красоты: триггер
   * цепочки сам берёт эту строку `FOR UPDATE` перед вставкой события, значит между проверкой и
   * удалением чужое событие не проскочит — либо оно успело до нас и мы его увидим, либо ждёт нас и
   * упрётся в отсутствие карточки. Проверка до транзакции такого не обещает вовсе.
   *
   * Привязки к моделям удалению не мешают: это разметка совместимости, а не история, и уходит она
   * каскадом (Р6).
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canManage], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const removed = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            code: officeEquipmentConsumables.code,
            name: officeEquipmentConsumables.name,
          })
          .from(officeEquipmentConsumables)
          .where(eq(officeEquipmentConsumables.id, id))
          .for('update');
        if (!row) throw err.notFound(NOT_FOUND);
        const moved = await tx
          .select({ id: officeEquipmentConsumableStockEntries.id })
          .from(officeEquipmentConsumableStockEntries)
          .where(eq(officeEquipmentConsumableStockEntries.consumableId, id))
          .limit(1);
        if (moved.length > 0) {
          throw err.conflict('По расходнику есть движение, снимите «Активен» вместо удаления');
        }
        await tx.delete(officeEquipmentConsumables).where(eq(officeEquipmentConsumables.id, id));
        return row;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentConsumable.delete',
        entityType: 'officeEquipmentConsumable',
        entityId: id,
        // Строки больше нет — в журнале остаётся то, чем её называли.
        metadata: { code: removed.code, name: removed.name },
      });
      return { ok: true };
    },
  );
}
