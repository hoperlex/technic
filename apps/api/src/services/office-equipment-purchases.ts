import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  formatOfficeEquipmentPurchaseNumber,
  OFFICE_EQUIPMENT_PURCHASE_OPEN_STATUSES,
  type CreateOfficeEquipmentPurchaseInput,
  type OfficeEquipmentPurchaseDetailDto,
  type OfficeEquipmentPurchaseDto,
  type OfficeEquipmentPurchaseItemDto,
  type OfficeEquipmentPurchaseItemInput,
  type OfficeEquipmentPurchaseRefDto,
  type OfficeEquipmentPurchaseSnapshotRowDto,
  type OfficeEquipmentPurchaseStatus,
} from '@technic/contracts';
// Только типом: сам клиент модулю не нужен — все загрузчики берут исполнителя аргументом
// (`Tx | typeof db`), чтобы одна и та же выборка работала и внутри транзакции протокола, и
// снаружи, при обычном чтении карточки.
import type { db } from '../db/client';
import {
  officeEquipmentConsumables,
  officeEquipmentPurchaseItems,
  officeEquipmentPurchases,
  users,
} from '../db/schema';
import { sha256hex } from '../lib/crypto';
import { err } from '../lib/errors';

/**
 * Счётная часть плановой закупки (ADR 0146, план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р13, Р15, Р17, Р18).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ДВА МАРШРУТА. «Уже заказано» и дефицит спрашивают ДВА разных
 * маршрута: перечень расходников показывает их столбцами (и сортирует, и отбирает по ним), а
 * закупка считает их предзаполнением и пересчитывает под блокировкой при сохранении. Р15 требует
 * ровно одного вычислителя: «два места, считающие дефицит, разойдутся, а по этому числу
 * заказывают». Значит формула обязана лежать в одном месте, а не в двух файлах маршрутов.
 *
 * ДВЕ ЗАПИСИ ОДНОЙ ФОРМУЛЫ ЗДЕСЬ ВСЁ-ТАКИ ЕСТЬ, и это надо назвать честно: `deficitExpr` считает
 * дефицит на стороне базы, `deficitOf` — на стороне Node. Обойтись одной нельзя ни в ту, ни в
 * другую сторону: сортировать и отбирать перечень постранично умеет только база, а протокол
 * сохранения (Р17) считает под блокировкой уже прочитанные строки, и гонять ради арифметики третий
 * запрос незачем. Лежат они СОСЕДНИМИ объявлениями нарочно — правка одной без второй видна в
 * диффе сразу.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Имя ограничения, по которому маршрут узнаёт гонку ключа идемпотентности (Р17, шаг 8). */
export const PURCHASE_IDEMPOTENCY_CONSTRAINT = 'office_equipment_purchases_idempotency_unique';

export const PURCHASE_NOT_FOUND = 'Плановая закупка не найдена';

/**
 * Перечень открытых состояний ЛИТЕРАЛАМИ В ТЕКСТЕ ЗАПРОСА, а не параметрами.
 *
 * Это не стиль и не микрооптимизация, а условие применимости частичного индекса
 * `office_equipment_purchases_open_idx` (`WHERE status IN ('new', 'in_work')`, миграция 0227).
 * Планировщик берёт частичный индекс, только ДОКАЗАВ, что предикат запроса влечёт предикат
 * индекса, а доказывает он это по константам. Уедь список параметрами (`= ANY($1)`), доказательство
 * держалось бы на подстановке значений в custom plan — то есть работало бы через раз, а в generic
 * plan не работало бы вовсе, и вопрос «сколько уже заказано», который задают на каждой странице
 * перечня, уходил бы в seq scan по всему архиву закупок.
 *
 * ЗАМЕРЕНО, А НЕ ПРЕДПОЛОЖЕНО. Копия схемы, 3008 закупок (из них открытых шесть), 60 тысяч строк,
 * 1218 позиций справочника; вопрос «уже заказано» на странице в сто строк:
 *
 *   литеральный `IN ('new', 'in_work')`  → `Bitmap Index Scan … open_idx`, 2132 буфера,  1.0 мс
 *   параметрами, generic plan            → `Seq Scan on office_equipment_purchases`,     31.2 мс
 *   отрицанием `<> 'closed' AND <> 'cancelled'` → тот же seq scan, 8532 буфера,          14.9 мс
 *
 * У обоих проигравших планов в отказе одно и то же: `Rows Removed by Filter: 3002` на КАЖДУЮ из
 * ста строк страницы. Ответ при этом верен у всех трёх — тем и опасно.
 *
 * Подстановки чужого текста здесь нет по построению: значения берутся из закрытого перечня
 * контрактов, а не из запроса, — и тот же перечень стоит в `CHECK` статуса.
 */
const OPEN_STATUS_LITERALS = sql.raw(
  OFFICE_EQUIPMENT_PURCHASE_OPEN_STATUSES.map((s) => `'${s}'`).join(', '),
);

/** «Закупка открыта» — тем же `IN`-списком, каким записан частичный индекс. */
export const openPurchaseWhere = sql`${officeEquipmentPurchases.status} IN (${OPEN_STATUS_LITERALS})`;

/**
 * Ссылка на строку расходника ИЗВНЕ коррелированного подзапроса — отдельным `sql`-объектом.
 *
 * Правило то же и по той же причине, что у `consumableIdRef` в
 * `routes/office-equipment-consumables.ts`: там оно разобрано подробно, с замерами `toSQL()`. Здесь
 * коротко: собирая список столбцов односоставного запроса, drizzle переписывает колоночные чанки
 * ВЕРХНЕГО УРОВНЯ в голые идентификаторы, а голое имя Postgres разрешает в самый внутренний
 * `FROM` — то есть в таблицу подзапроса. Отказа при этом не бывает, обе колонки существуют, и
 * `consumable_id = id` строки закупки просто всегда ложно: «уже заказано» стало бы нулём у КАЖДОЙ
 * позиции, а дефицит — завышенным на всё, что уже везут. Заказали бы дважды.
 *
 * Своя константа в этом файле, а не импорт из маршрута, — потому что правило «ссылка наружу
 * выносится отдельным `sql`-объектом» обязано быть видно в том файле, где стоит подзапрос: искать
 * его в соседнем модуле никто не станет.
 */
const consumableIdRef = sql`${officeEquipmentConsumables}."id"`;

/**
 * Сколько этой позиции уже заказано ОТКРЫТЫМИ закупками (Р15).
 *
 * СЧИТАЕТСЯ ПО СТРОКАМ, А НЕ ПО ШАПКАМ: одна закупка берёт разные позиции разными строками, и
 * складывать надо именно их. Соединение идёт от строк к шапкам ради статуса — сам статус лежит в
 * шапке, а количество в строке.
 *
 * `::int` обязателен: `sum(integer)` в Postgres даёт `bigint`, а его драйвер отдаёт СТРОКОЙ (иначе
 * потерялась бы точность за пределами 2^53). Без приведения `alreadyOrdered` приезжал бы «12»
 * вместо 12, и арифметика дефицита на стороне Node молча превратилась бы в склейку строк. Столько
 * штук на складе не бывает по определению — верхняя граница схемы миллион, — поэтому приведение
 * здесь безопасно, а не «на глазок».
 *
 * `coalesce(…, 0)`: у позиции без единой открытой закупки сумма пуста, и `NULL` в этом месте
 * означал бы «неизвестно», тогда как ответ известен и равен нулю.
 *
 * `exceptPurchaseId` — собственный вклад ПРАВИМОЙ закупки (Р18). Без него черновик конфликтовал бы
 * сам с собой: его же строки лежат в «уже заказано», снимок формы их не содержит, и первая же
 * правка получала бы 409 на ровном месте.
 */
export function alreadyOrderedExpr(
  consumableRef: SQL = consumableIdRef,
  exceptPurchaseId?: string,
): SQL<number> {
  const body = sql`
    SELECT coalesce(sum(${officeEquipmentPurchaseItems.quantity}), 0)::int
      FROM ${officeEquipmentPurchaseItems}
      JOIN ${officeEquipmentPurchases}
        ON ${officeEquipmentPurchases.id} = ${officeEquipmentPurchaseItems.purchaseId}
     WHERE ${officeEquipmentPurchaseItems.consumableId} = ${consumableRef}
       AND ${openPurchaseWhere}
       ${
         exceptPurchaseId === undefined
           ? sql.empty()
           : sql`AND ${officeEquipmentPurchases.id} <> ${exceptPurchaseId}`
       }
  `;
  /*
   * ЛИШНИЙ СЛОЙ `sql` — ЭТО НЕ УКРАШЕНИЕ, А ЕДИНСТВЕННОЕ, ЧТО ДЕЛАЕТ ВЫРАЖЕНИЕ РАБОЧИМ, и стоит он
   * здесь после того, как без него на прогоне db-тестов легли тридцать случаев из тридцати восьми.
   *
   * Разбор. Выражение уходит ПРЯМО В СПИСОК СТОЛБЦОВ односоставного запроса (столбец «уже
   * заказано» в перечне расходников), а там drizzle переписывает колоночные чанки ВЕРХНЕГО УРОВНЯ
   * в голые идентификаторы. У соседних подзапросов этого файла и маршрута расходников беда от
   * такого переписывания МОЛЧАЛИВАЯ: у них одна таблица во `FROM`, голое имя разрешается в неё же,
   * и запрос остаётся законным, просто отвечает не то. Здесь таблиц ДВЕ, и потому то же самое
   * переписывание бьёт громко: `ON ${'"'}id${'"'} = ${'"'}purchase_id${'"'}` и `sum(${'"'}quantity${'"'})` становятся
   * неоднозначными — `quantity` и `id` есть у обеих, — и Postgres отвечает `42702`, то есть 500 на
   * каждой странице справочника.
   *
   * Внутрь ВЛОЖЕННОГО `sql`-объекта переписывание не заходит вовсе (замер `toSQL()` в
   * `routes/office-equipment-consumables.ts`, у `consumableIdRef`). Значит достаточно одного слоя:
   * на верхнем уровне остаётся единственный чанк — сам `body`, — а всё, что внутри него, доезжает
   * до базы квалифицированным.
   *
   * Через `deficitExpr` то же выражение проходило целым и без этого слоя (там оно уже вложено), —
   * поэтому дефицит считался верно, а «уже заказано» ронял запрос. Разница ровно в одном уровне
   * вложенности, и полагаться на неё нельзя: выражение обязано быть верным само по себе, а не
   * из-за того, куда его подставили.
   */
  return sql<number>`(${body})`;
}

/**
 * Дефицит на стороне базы: `max(0, потребность − остаток − уже заказанное)` (Р15).
 *
 * `GREATEST(0, …)`, а не `CASE`: перепроданной позиции (заказали больше, чем не хватало) дефицита
 * нет, и отрицательное число здесь означало бы «нам должны вернуть» — новость, которой у склада не
 * бывает.
 *
 * Слагаемые приходят аргументами, а не берутся из таблицы прямо здесь, ровно по правилу
 * корреляции выше: маршрут перечня подставляет свои квалифицированные ссылки, и выражение остаётся
 * верным в списке столбцов односоставного запроса.
 */
export function deficitExpr(required: SQL, stock: SQL, alreadyOrdered: SQL): SQL<number> {
  return sql<number>`GREATEST(0, ${required} - ${stock} - ${alreadyOrdered})`;
}

/** Тот же дефицит на стороне Node — вторая запись той же формулы (см. шапку модуля). */
export function deficitOf(required: number, stock: number, alreadyOrdered: number): number {
  return Math.max(0, required - stock - alreadyOrdered);
}

// ── Снимок расчёта под блокировкой (Р17, шаги 3 и 5) ──

/** Позиция со всем, из чего складывается её «к закупке». */
export interface ConsumableCalcRow {
  id: string;
  code: string;
  name: string;
  color: string | null;
  isActive: boolean;
  required: number;
  stock: number;
  alreadyOrdered: number;
  suggested: number;
}

/**
 * Взять строки расходников `FOR UPDATE` и пересчитать по ним «к закупке» (Р17, шаги 3 и 5).
 *
 * ПОРЯДОК ЗАХВАТА — ПО ВОЗРАСТАНИЮ `id`, И ОН ОБЯЗАТЕЛЕН. Тот же порядок берут правка остатка и
 * выдача по заявке; встречный порядок захвата двух ручек даёт взаимную блокировку (`40P01`) на
 * ровном месте — этот модуль уже ловил такое у переименования модели. `ORDER BY` при этом стоит
 * ВНУТРИ блокирующего запроса нарочно: узел `LockRows` планировщик ставит НАД сортировкой, поэтому
 * строки запираются в том же порядке, в каком выходят из `ORDER BY`, а не в порядке физического
 * чтения.
 *
 * ДВА ЗАПРОСА, А НЕ ОДИН С ПОДЗАПРОСОМ В СПИСКЕ СТОЛБЦОВ, и это не оплошность. Спрашивать «уже
 * заказано» надо ПОСЛЕ того, как блокировки взяты: соседнее заведение обязано пройти те же
 * блокировки (шаг 3), значит, дождавшись нас, оно уже не вставит свои строки, а всё, что оно
 * закоммитило до нас, второй запрос увидит своим снимком READ COMMITTED. Слепи мы это в один
 * запрос — порядок «сначала запереть, потом сложить» держался бы устройством плана, то есть ничем.
 *
 * ПОГАШЕННЫЕ И НЕСУЩЕСТВУЮЩИЕ ПОЗИЦИИ ЗДЕСЬ НЕ ОТБИРАЮТСЯ: их проверяет вызывающий и отвечает
 * словами. Функция обязана вернуть ровно то, что есть в базе, — иначе «позиции нет» и «позиция
 * погашена» стали бы одним и тем же молчанием.
 */
export async function lockAndCalcConsumables(
  tx: Tx,
  ids: readonly string[],
  exceptPurchaseId?: string,
): Promise<Map<string, ConsumableCalcRow>> {
  const map = new Map<string, ConsumableCalcRow>();
  if (ids.length === 0) return map;
  const unique = [...new Set(ids)];
  const locked = await tx
    .select({
      id: officeEquipmentConsumables.id,
      code: officeEquipmentConsumables.code,
      name: officeEquipmentConsumables.name,
      color: officeEquipmentConsumables.color,
      isActive: officeEquipmentConsumables.isActive,
      required: officeEquipmentConsumables.requiredQuantity,
      stock: officeEquipmentConsumables.quantity,
    })
    .from(officeEquipmentConsumables)
    .where(inArray(officeEquipmentConsumables.id, unique))
    .orderBy(officeEquipmentConsumables.id)
    .for('update');
  const ordered = await alreadyOrderedByConsumable(tx, unique, exceptPurchaseId);
  for (const row of locked) {
    const alreadyOrdered = ordered.get(row.id) ?? 0;
    map.set(row.id, {
      ...row,
      alreadyOrdered,
      suggested: deficitOf(row.required, row.stock, alreadyOrdered),
    });
  }
  return map;
}

/**
 * «Уже заказано» сразу по набору позиций — одним группирующим запросом, а не коррелированным
 * подзапросом на строку. Форма здесь другая, чем у столбца перечня, а слагаемое то же: там строк
 * страница и вопрос задаётся на каждую, здесь строк единицы и они известны заранее.
 *
 * Условие открытости — тот же `IN`-список, и по той же причине (см. `OPEN_STATUS_LITERALS`).
 */
async function alreadyOrderedByConsumable(
  tx: Tx,
  ids: readonly string[],
  exceptPurchaseId?: string,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      consumableId: officeEquipmentPurchaseItems.consumableId,
      total: sql<number>`coalesce(sum(${officeEquipmentPurchaseItems.quantity}), 0)::int`,
    })
    .from(officeEquipmentPurchaseItems)
    .innerJoin(
      officeEquipmentPurchases,
      eq(officeEquipmentPurchases.id, officeEquipmentPurchaseItems.purchaseId),
    )
    .where(
      and(
        inArray(officeEquipmentPurchaseItems.consumableId, [...ids]),
        openPurchaseWhere,
        exceptPurchaseId === undefined
          ? undefined
          : sql`${officeEquipmentPurchases.id} <> ${exceptPurchaseId}`,
      ),
    )
    .groupBy(officeEquipmentPurchaseItems.consumableId);
  return new Map(rows.map((r) => [r.consumableId, Number(r.total)]));
}

/**
 * Открытая закупка по позиции — ради отказа в гашении (Р18) и ради подсказки формы (Р15).
 *
 * Порядок по номеру: закупок по одной позиции бывает несколько, и назвать в отказе надо ту, что
 * человек найдёт первой, а не случайную. Берётся вся выборка, а не `LIMIT 1`: тот же вызов
 * обслуживает подсказку «по позиции уже есть открытые» со ссылками на них.
 */
export async function openPurchasesByConsumable(
  runner: Tx | typeof db,
  ids: readonly string[],
): Promise<Map<string, OfficeEquipmentPurchaseRefDto[]>> {
  const map = new Map<string, OfficeEquipmentPurchaseRefDto[]>();
  if (ids.length === 0) return map;
  const rows = await runner
    .select({
      consumableId: officeEquipmentPurchaseItems.consumableId,
      id: officeEquipmentPurchases.id,
      num: officeEquipmentPurchases.num,
      status: officeEquipmentPurchases.status,
      quantity: officeEquipmentPurchaseItems.quantity,
    })
    .from(officeEquipmentPurchaseItems)
    .innerJoin(
      officeEquipmentPurchases,
      eq(officeEquipmentPurchases.id, officeEquipmentPurchaseItems.purchaseId),
    )
    .where(and(inArray(officeEquipmentPurchaseItems.consumableId, [...ids]), openPurchaseWhere))
    .orderBy(officeEquipmentPurchases.num);
  for (const row of rows) {
    const list = map.get(row.consumableId) ?? [];
    list.push({
      id: row.id,
      displayNumber: formatOfficeEquipmentPurchaseNumber(row.num),
      status: row.status,
      quantity: row.quantity,
    });
    map.set(row.consumableId, list);
  }
  return map;
}

/**
 * Гашение позиции, попавшей в открытую закупку, отбивается СЛОВАМИ С НОМЕРОМ (Р18).
 *
 * Противоречие здесь прямое: гашение означает «больше не покупаем», а открытая закупка — «уже
 * заказали и ждём». Портал обязан назвать его в момент действия, а не оставить в данных, где его
 * разберут через месяц по расхождению счёта со справочником.
 *
 * НОМЕР В ТЕКСТЕ — ЭТО И ЕСТЬ ОТВЕТ. «Позиция участвует в закупке» человеку делать нечего: ему
 * надо открыть ЗК-14 и решить, закрыть её или отменить. Без номера он пошёл бы искать её по списку
 * закупок, перебирая состав каждой.
 *
 * Ссылка строки (`RESTRICT`) при этом запирает только УДАЛЕНИЕ позиции, а гашение — обычная правка
 * флага, и базой оно не запрещено вовсе: проверка нужна именно здесь.
 */
export async function assertNoOpenPurchaseForConsumable(tx: Tx, id: string): Promise<void> {
  const open = await openPurchasesByConsumable(tx, [id]);
  const first = open.get(id)?.[0];
  if (first) {
    throw err.conflict(
      `По позиции открыта закупка ${first.displayNumber} — закройте или отмените её`,
      { fields: { isActive: `Открыта закупка ${first.displayNumber}` } },
    );
  }
}

/**
 * Удаление позиции, стоящей в ЛЮБОЙ закупке, отбивается словами — как и удаление позиции с движением
 * остатка по соседству.
 *
 * ОТЛИЧИЕ ОТ ГАШЕНИЯ ВЫШЕ — В СТАТУСАХ, И ОНО НЕ МЕЛОЧЬ. Гашение спорит только с ОТКРЫТОЙ закупкой:
 * «больше не покупаем» против «уже заказали и ждём». Удаление же запирает ссылка строки
 * (`RESTRICT`), а она не знает статусов вовсе: закрытая и отменённая закупки держат позицию так же
 * крепко, как открытая, — и правильно держат, потому что закупка это документ, а документ не должен
 * уметь показывать на пустоту.
 *
 * ПОЧЕМУ ПРОВЕРКА ЗДЕСЬ, А НЕ НА ОТКАЗЕ БАЗЫ. Без неё наружу летит `internal_error` от нарушения
 * ключа — то есть человек видит 500 там, где соседнее гашение той же позиции честно называет номер.
 * Данные при этом целы, и потому дефект тихий: он не ломает учёт, он ломает объяснение. Нашли его
 * тесты гонок выпуска 3, а не работа портала, — сам портал такую позицию удалять и не предлагает.
 *
 * Номер называется по той же причине, что и у гашения: «позиция участвует в закупке» человеку делать
 * нечего, ему нужен документ, в который идти смотреть.
 */
export async function assertNoPurchaseLinesForConsumable(tx: Tx, id: string): Promise<void> {
  const [first] = await tx
    .select({ num: officeEquipmentPurchases.num, status: officeEquipmentPurchases.status })
    .from(officeEquipmentPurchaseItems)
    .innerJoin(
      officeEquipmentPurchases,
      eq(officeEquipmentPurchases.id, officeEquipmentPurchaseItems.purchaseId),
    )
    .where(eq(officeEquipmentPurchaseItems.consumableId, id))
    .orderBy(officeEquipmentPurchases.num)
    .limit(1);
  if (first) {
    const displayNumber = formatOfficeEquipmentPurchaseNumber(first.num);
    throw err.conflict(
      `Позиция стоит в закупке ${displayNumber} — удалить её нельзя; снимите «Активен», если больше не покупаете`,
    );
  }
}

// ── Идемпотентность заведения (Р17, шаги 1 и 2) ──

/**
 * Нормализованное тело команды — то, по чему считается отпечаток.
 *
 * НОРМАЛИЗАЦИЯ ОБЯЗАТЕЛЬНА ДО ОТПЕЧАТКА (шаг 1). Строки формы приходят в том порядке, в каком их
 * набрал человек, и переставленные местами строки ТОЙ ЖЕ закупки дали бы другой отпечаток — то
 * есть честный повтор потерянного ответа получил бы 409 «этот ключ занят другой командой». Порядок
 * задаётся по идентификатору позиции: он у строки один и не зависит ни от формы, ни от языка
 * сравнения.
 *
 * В ОТПЕЧАТОК ВХОДИТ И СНИМОК, а не только позиция с количеством, и это осознанно: ключ описывает
 * ПОПЫТКУ ОТПРАВКИ, а не документ. Повтор после 409 по снимку — это уже другая попытка с другими
 * числами, и портал берёт для неё новый ключ; совпади отпечатки, сервер вернул бы на неё старую
 * закупку, то есть подтвердил бы команду, которой не было.
 */
function normalizedBody(input: CreateOfficeEquipmentPurchaseInput): unknown {
  return {
    comment: input.comment.trim(),
    items: [...input.items]
      .sort((a, b) => a.consumableId.localeCompare(b.consumableId))
      .map((i) => ({
        consumableId: i.consumableId,
        quantity: i.quantity,
        expectedRequired: i.expectedRequired,
        expectedStock: i.expectedStock,
        expectedAlreadyOrdered: i.expectedAlreadyOrdered,
      })),
  };
}

/**
 * Отпечаток тела отправки. Приём и запись — те же, что у кабинета водителя (`services/readings.ts`,
 * `submitFingerprint`): версия впереди, чтобы смена состава полей однажды не выдала старый
 * отпечаток за новый.
 */
export function purchaseFingerprint(input: CreateOfficeEquipmentPurchaseInput): string {
  return `v1:${sha256hex(JSON.stringify(normalizedBody(input)))}`;
}

// ── Сверка снимка (Р17, шаг 6) ──

/**
 * Что в форме разошлось с сегодняшними числами.
 *
 * ВОЗВРАЩАЮТСЯ ТОЛЬКО РАЗОШЕДШИЕСЯ СТРОКИ: сошедшиеся человеку перепроверять незачем, а окно,
 * получившее весь состав, показало бы правку там, где ничего не менялось.
 *
 * СРАВНИВАЮТСЯ ТРИ СЛАГАЕМЫХ, А НЕ ИТОГ. Потребность 20 при остатке 5 и потребность 25 при остатке
 * 10 дают одно и то же «к закупке 15»: сойдись у нас только итог, человек, решавший по первой паре,
 * молча подтвердил бы вторую.
 */
export function snapshotMismatches(
  items: readonly OfficeEquipmentPurchaseItemInput[],
  calc: Map<string, ConsumableCalcRow>,
): OfficeEquipmentPurchaseSnapshotRowDto[] {
  const rows: OfficeEquipmentPurchaseSnapshotRowDto[] = [];
  for (const item of items) {
    const now = calc.get(item.consumableId);
    // Позиции нет вовсе — это не расхождение снимка, а отказ по составу, и отвечает на него
    // вызывающий: 409 «числа изменились» на выдуманный идентификатор был бы враньём.
    if (!now) continue;
    if (
      item.expectedRequired === now.required &&
      item.expectedStock === now.stock &&
      item.expectedAlreadyOrdered === now.alreadyOrdered
    ) {
      continue;
    }
    rows.push({
      consumableId: now.id,
      code: now.code,
      name: now.name,
      expectedRequired: item.expectedRequired,
      expectedStock: item.expectedStock,
      expectedAlreadyOrdered: item.expectedAlreadyOrdered,
      actualRequired: now.required,
      actualStock: now.stock,
      actualAlreadyOrdered: now.alreadyOrdered,
      actualSuggested: now.suggested,
    });
  }
  return rows;
}

// ── Чтение документа ──

/*
 * Четыре роли одной и той же таблицы учёток. Псевдонимами, а не четырьмя запросами: имена автора,
 * проводившего, закрывшего и отменившего нужны карточке сразу, а «кто» у закупки — это четыре
 * РАЗНЫХ человека, и один `join` на всех тут не годится.
 *
 * Автор соединяется внутренним `join`, остальные — левым, и это следствие схемы, а не осторожность:
 * `created_by` объявлен `NOT NULL` и стоит с `RESTRICT` (учётку, заведшую закупку, из портала не
 * удалить), а пары переходов пусты ровно у тех состояний, где перехода ещё не было.
 */
const purchaseAuthors = alias(users, 'purchase_authors');
const purchaseSubmitters = alias(users, 'purchase_submitters');
const purchaseClosers = alias(users, 'purchase_closers');
const purchaseCancellers = alias(users, 'purchase_cancellers');

/**
 * Столбцы шапки. Счётчики строк — коррелированными подзапросами, а не соединением с группировкой:
 * соединение размножило бы шапку по числу строк, и постраничный `total` перестал бы быть числом
 * документов.
 *
 * Ссылка наружу — тем же правилом, что и везде в файле: отдельным `sql`-объектом. Здесь она даже
 * важнее, чем у расходников: колонка `id` есть у обеих таблиц, и потерявшая квалификацию ссылка
 * дала бы `purchase_id = id` строки — сравнение двух её собственных колонок, всегда ложное. Счётчик
 * молча стал бы нулём у каждой закупки, а список показал бы «позиций 0» у документа с полным
 * составом.
 */
const purchaseIdRef = sql`${officeEquipmentPurchases}."id"`;

/*
 * Оба счётчика завёрнуты в лишний слой `sql` — по тому же правилу, что и «уже заказано» выше.
 * Сегодня запрос шапки многосоставный (четыре соединения по ролям учётки), и переписывание списка
 * столбцов его не касается вовсе; но правило обязано держаться само по себе, а не благодаря
 * внешнему обстоятельству — уйди эти столбцы однажды в односоставный запрос, `purchase_id = id`
 * стало бы сравнением двух колонок строки закупки, и «позиций 0» показалось бы у документа с
 * полным составом.
 */
const itemCountExpr = sql<number>`(${sql`
  SELECT count(*)::int FROM ${officeEquipmentPurchaseItems}
   WHERE ${officeEquipmentPurchaseItems.purchaseId} = ${purchaseIdRef}
`})`;

const totalQuantityExpr = sql<number>`(${sql`
  SELECT coalesce(sum(${officeEquipmentPurchaseItems.quantity}), 0)::int
    FROM ${officeEquipmentPurchaseItems}
   WHERE ${officeEquipmentPurchaseItems.purchaseId} = ${purchaseIdRef}
`})`;

export function purchaseColumns() {
  return {
    id: officeEquipmentPurchases.id,
    num: officeEquipmentPurchases.num,
    status: officeEquipmentPurchases.status,
    comment: officeEquipmentPurchases.comment,
    contentVersion: officeEquipmentPurchases.contentVersion,
    itemCount: itemCountExpr,
    totalQuantity: totalQuantityExpr,
    createdById: officeEquipmentPurchases.createdBy,
    createdByName: purchaseAuthors.fullName,
    createdAt: officeEquipmentPurchases.createdAt,
    submittedByName: purchaseSubmitters.fullName,
    submittedAt: officeEquipmentPurchases.submittedAt,
    closedByName: purchaseClosers.fullName,
    closedAt: officeEquipmentPurchases.closedAt,
    cancelledByName: purchaseCancellers.fullName,
    cancelledAt: officeEquipmentPurchases.cancelledAt,
    cancelReason: officeEquipmentPurchases.cancelReason,
    updatedAt: officeEquipmentPurchases.updatedAt,
  };
}

interface PurchaseRow {
  id: string;
  num: number;
  status: OfficeEquipmentPurchaseStatus;
  comment: string;
  contentVersion: number;
  itemCount: number;
  totalQuantity: number;
  createdById: string;
  createdByName: string;
  createdAt: Date;
  submittedByName: string | null;
  submittedAt: Date | null;
  closedByName: string | null;
  closedAt: Date | null;
  cancelledByName: string | null;
  cancelledAt: Date | null;
  cancelReason: string;
  updatedAt: Date;
}

export function toPurchaseDto(r: PurchaseRow): OfficeEquipmentPurchaseDto {
  return {
    id: r.id,
    num: r.num,
    displayNumber: formatOfficeEquipmentPurchaseNumber(r.num),
    status: r.status,
    comment: r.comment,
    contentVersion: r.contentVersion,
    itemCount: Number(r.itemCount),
    totalQuantity: Number(r.totalQuantity),
    createdById: r.createdById,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    submittedByName: r.submittedByName,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    closedByName: r.closedByName,
    closedAt: r.closedAt?.toISOString() ?? null,
    cancelledByName: r.cancelledByName,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Общее для списка и карточки соединение по четырём ролям учётки. */
export function purchaseQuery(runner: Tx | typeof db) {
  return runner
    .select(purchaseColumns())
    .from(officeEquipmentPurchases)
    .innerJoin(purchaseAuthors, eq(purchaseAuthors.id, officeEquipmentPurchases.createdBy))
    .leftJoin(purchaseSubmitters, eq(purchaseSubmitters.id, officeEquipmentPurchases.submittedBy))
    .leftJoin(purchaseClosers, eq(purchaseClosers.id, officeEquipmentPurchases.closedBy))
    .leftJoin(purchaseCancellers, eq(purchaseCancellers.id, officeEquipmentPurchases.cancelledBy));
}

/**
 * Строки карточки. `currentStock` — СЕГОДНЯШНИЙ остаток позиции рядом со снимком: его показывает
 * форма закрытия (Р11), где человек утверждает, что приход занесён. Берётся соединением со
 * справочником, а не вторым запросом: позиция у строки всегда существует (`RESTRICT`), и второй
 * запрос отвечал бы на то же самое.
 *
 * Порядок — по наименованию позиции: состав документа читают глазами, и порядок вставки в нём
 * выглядел бы случайным.
 */
export async function loadPurchaseItems(
  runner: Tx | typeof db,
  purchaseIds: readonly string[],
): Promise<Map<string, OfficeEquipmentPurchaseItemDto[]>> {
  const map = new Map<string, OfficeEquipmentPurchaseItemDto[]>();
  if (purchaseIds.length === 0) return map;
  const rows = await runner
    .select({
      purchaseId: officeEquipmentPurchaseItems.purchaseId,
      id: officeEquipmentPurchaseItems.id,
      consumableId: officeEquipmentPurchaseItems.consumableId,
      code: officeEquipmentConsumables.code,
      name: officeEquipmentConsumables.name,
      color: officeEquipmentConsumables.color,
      quantity: officeEquipmentPurchaseItems.quantity,
      requiredSnapshot: officeEquipmentPurchaseItems.requiredSnapshot,
      stockSnapshot: officeEquipmentPurchaseItems.stockSnapshot,
      alreadyOrderedSnapshot: officeEquipmentPurchaseItems.alreadyOrderedSnapshot,
      suggestedQuantity: officeEquipmentPurchaseItems.suggestedQuantity,
      currentStock: officeEquipmentConsumables.quantity,
    })
    .from(officeEquipmentPurchaseItems)
    .innerJoin(
      officeEquipmentConsumables,
      eq(officeEquipmentConsumables.id, officeEquipmentPurchaseItems.consumableId),
    )
    .where(inArray(officeEquipmentPurchaseItems.purchaseId, [...purchaseIds]))
    .orderBy(officeEquipmentConsumables.name);
  for (const row of rows) {
    const { purchaseId, ...item } = row;
    const list = map.get(purchaseId) ?? [];
    list.push(item);
    map.set(purchaseId, list);
  }
  return map;
}

/**
 * Карточка целиком. Читается тем же запросом, что и строка списка, — расхождению негде взяться (тот
 * же приём, что у `getDto` справочника расходников).
 */
export async function loadPurchaseDetail(
  runner: Tx | typeof db,
  id: string,
): Promise<OfficeEquipmentPurchaseDetailDto> {
  const [row] = await purchaseQuery(runner).where(eq(officeEquipmentPurchases.id, id));
  if (!row) throw err.notFound(PURCHASE_NOT_FOUND);
  const items = await loadPurchaseItems(runner, [id]);
  return { ...toPurchaseDto(row), items: items.get(id) ?? [] };
}
