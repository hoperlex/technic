import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  autoPartListQuerySchema,
  autoPartStockSchema,
  createAutoPartSchema,
  updateAutoPartSchema,
  vehicleLabel,
  type AutoPartApplicabilityDto,
  type AutoPartApplicabilityInput,
  type AutoPartApplicabilityRank,
  type AutoPartDetailDto,
  type AutoPartDto,
  type AutoPartStockEntryDto,
  type AutoPartStockResultDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  autoPartApplicability,
  autoPartStockEntries,
  autoParts,
  users,
  vehicleCategories,
  vehicleMaintenance,
  vehicleModels,
  vehicleTypes,
  vehicles,
} from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import { assertCan } from '../lib/access';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import { orderByFrom, pageParams } from '../lib/pagination';

/**
 * Склад автозапчастей гаража (план `docs/auto-parts-plan.md`, Р2, Р3, Р7—Р13, Р21; миграции `0187`
 * и `0188`, этап 2). Отвечает на вопрос, на который портал сегодня не отвечает вовсе: «есть ли у
 * нас этот фильтр и сколько». Расход отсюда никуда не «выдаётся» — его пишет акт обслуживания
 * (Р4), и в журнале остатка от него остаётся след со ссылкой на акт.
 *
 * Права разведены на три, и разведены по работам, а не по ролям (Р10):
 *
 *   · `garage.read` — чтение перечня и карточки: подобрать позицию при заведении акта должен
 *     каждый, кому виден гараж;
 *   · `autoParts.manage` — ведение номенклатуры: заведение, правка, гашение, удаление позиции
 *     вместе с её применимостью;
 *   · `autoParts.stock` — движение склада: ручка `POST /:id/stock` и **ненулевой начальный
 *     остаток при заведении** (см. `POST /`; заведение с нулём — работа `manage`).
 *
 * **Область у справочника отсутствует намеренно.** Склад один на компанию: деталь лежит на полке
 * и для машины, которой смотрящий не видит. Сузить перечень площадкой значило бы спрятать от
 * механика строку, которую он сам же и завёл.
 *
 * **Написание артикула нормализует БАЗА.** На таблице стоит
 * `auto_parts_code_normalized_check (code = auto_part_code_key(code))`, и та же функция стоит в
 * частичном уникальном индексе `auto_parts_code_unique` и первой половиной пары
 * `auto_parts_name_code_unique` (миграция `0187`). Отсюда правило маршрута: всякий присланный код
 * уезжает в базу выражением `auto_part_code_key(...)`, а не строкой из TypeScript. Своя
 * нормализация была бы второй копией правила — и «mann w914/2» с маленькой буквы дало бы не
 * «артикул занят», а 500 по `CHECK`.
 *
 * **Остаток правится только ручкой `POST /:id/stock`** (Р3). Ни заведение с ненулевым числом, ни
 * эта ручка не пишут количество в одиночку: карточка и строка журнала идут одной транзакцией и в
 * жёстком порядке «сначала карточка, потом событие». Порядок задан не вкусом, а тремя триггерами
 * `0187` — они описаны у самой ручки.
 *
 * **ПОЧЕМУ АУДИТ ЗДЕСЬ `writeAudit`, А НЕ `writeAuditTx`.** Строгая запись нужна там, где журнал
 * аудита — единственный след операции; область строгой записи перечислена поимённо в
 * doc-комментарии `writeAuditTx` (`lib/audit.ts`), и молча расширять её нельзя (Р22). У склада
 * такого места нет ни одного: всякое движение остатка оставляет строку в
 * `auto_part_stock_entries` — с автором, причиной, обоими концами и временем, — и строка эта
 * живёт и умирает вместе с транзакцией по построению (её обязательность держат триггеры цепочки и
 * покрытия, а не вежливость маршрута). Аудит здесь — вторая, более бедная копия того же события, и
 * ронять из-за неё правку остатка не за что. Ровно по этой же причине повторное нажатие тем же
 * числом в аудит не пишется вовсе: события не было. Обратный выбор сделан у акта обслуживания —
 * там реквизиты правятся без всякого движения склада, и кроме аудита следа не остаётся.
 */

const idParams = z.object({ id: z.string().uuid() });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const NOT_FOUND = 'Автозапчасть не найдена';

/**
 * Один текст и одна пометка поля на обе двери отказа — проверку до вставки и разбор `23505` из
 * гонки. Человеку всё равно, какая из них сработала: он видит одно и то же положение дел, и в
 * форме подсвечивается то же самое поле.
 *
 * Пометка обязательна, а не «приятна»: без пути поля портал показывает 409 тостом поверх формы
 * (ADR 0094), то есть мимо того единственного поля, которое человеку и надо исправить.
 */
const CODE_TAKEN = 'Автозапчасть с таким артикулом уже заведена';
const CODE_TAKEN_FIELDS = { code: 'Такой артикул уже заведён' };

/**
 * Второй отказ идентичности — по ПАРЕ «наименование + артикул» (Р12). Достижим он ровно в одном
 * случае: у обеих позиций артикула нет, а наименования совпадают («Ремень генератора» дважды).
 * Когда артикул есть, дубль пары означает и дубль артикула, и первым отвечает отказ выше.
 *
 * Поэтому текст говорит не «дубль», а что делать: два одинаковых по названию ремня — законные
 * разные позиции, если у них разные артикулы, и назвать этот выход обязан сам отказ.
 */
const NAME_TAKEN = 'Автозапчасть с таким наименованием уже заведена';
const NAME_TAKEN_FIELDS = {
  name: 'Такое наименование уже заведено без артикула — укажите артикул, если это разные позиции',
};

/**
 * Причину первого события составляет маршрут, а не человек (см. контракт): спрашивать «почему у
 * вас на складе 12 штук» в форме заведения не за что — это не движение, а перенос уже известного
 * остатка в портал (Р17). Текст постоянный нарочно: по нему в ленте журнала видно, что число
 * пришло из формы заведения, а не из расхода по акту или ручной правки.
 */
const FIRST_ENTRY_REASON = 'Заведение карточки: начальный остаток';

const APPLICABILITY_NOT_FOUND_FIELDS = {
  applicability: 'Одна из выбранных моделей или один из типов техники не найдены',
};

/**
 * Как артикул ПИШЕТСЯ — функцией базы, а не выражением на месте: пробельные символы (включая
 * неразрывные из Word и Excel) удаляются, регистр поднимается. Ровно эта функция стоит в `CHECK`
 * таблицы и в уникальных индексах, поэтому нормализовать ввод по-своему маршруту нечем и незачем:
 * любое расхождение с ней — либо отказ ограничения на ровном месте, либо двойник в справочнике.
 */
function normalizedCode(code: string | null): SQL | null {
  return code === null ? null : sql`auto_part_code_key(${code})`;
}

/**
 * Ссылка на строку автозапчасти ИЗВНЕ коррелированного подзапроса — ОТДЕЛЬНЫМ `sql`-объектом, а не
 * колонкой, вписанной прямо в выражение. Приём и его обоснование перенесены из соседнего
 * справочника расходников оргтехники (`office-equipment-consumables.ts`), где он замерен
 * `toSQL()`: собирая СПИСОК СТОЛБЦОВ односоставного запроса, drizzle переписывает колоночные чанки
 * в голые идентификаторы, но внутрь вложенного `sql`-объекта не заходит.
 *
 * Здесь это не предосторожность на будущее, а условие правильности двух выражений сразу: и признак
 * движения, и ранг применимости стоят именно в списке столбцов. Потеряв квалификацию, условие
 * «событие моей позиции» стало бы `auto_part_id = id` самой строки журнала — сравнением двух её
 * собственных колонок: отказа нет, запрос законен, `EXISTS` всегда ложь. Портал предлагал бы
 * удаление карточки с непустым журналом, а `RESTRICT` отвечал бы на это 500 вместо слов.
 *
 * У ранга цена ошибки другая и хуже: `auto_part_id = auto_part_id` внутри разметки истинно всегда,
 * и подходящей машине оказался бы размечен ВЕСЬ справочник — подбор в форме акта перестал бы
 * отличать нужное от всего остального, не сломавшись ни одним запросом.
 */
const autoPartIdRef = sql`${autoParts}."id"`;

/**
 * Есть ли по позиции хоть одно движение остатка — ответ на «удаляема ли карточка» (Р11). Пока
 * журнал пуст, запись удаляется совсем (так убирают опечатку первого дня); появилось событие —
 * только гашение флагом «Активна».
 *
 * Признак булев намеренно: сколько именно было движений, вопросу об удалении безразлично, а лента
 * журнала отвечает на «сколько» подробнее и в карточке.
 */
const hasStockHistoryExpr = sql<boolean>`EXISTS (
  SELECT 1 FROM ${autoPartStockEntries}
   WHERE ${autoPartStockEntries.autoPartId} = ${autoPartIdRef}
)`;

/**
 * Ранг подбора под машину (Р21): 0 — позиция размечена МОДЕЛЬЮ этой машины, 1 — её ТИПОМ, 2 — не
 * размечена ни тем, ни другим.
 *
 * **`EXISTS`, а не соединение с разметкой.** Позиция, размеченная и моделью, и типом (масло, годное
 * всем самосвалам, и отдельно отмеченное у этой модели), при соединении пришла бы ДВУМЯ строками —
 * и `total` в ответе перестал бы быть числом карточек, а страница показала бы двойника. `EXISTS`
 * отвечает «да или нет» и строку не размножает; на это в плане заведён отдельный db-тест.
 *
 * **Ветки модели может не быть вовсе.** `vehicles.vehicleModelId` необязателен (в источнике есть
 * машины без марки), и у такой машины первое условие не пишется в запрос: `= NULL` не ложь, а
 * неопределённость, и `CASE` с ним читался бы как «ранга по модели не бывает» ровно там, где его и
 * правда не бывает, — но платой был бы лишний подзапрос на каждую строку страницы.
 *
 * Ранг — не фильтр: неразмеченная позиция остаётся в перечне с рангом 2. Разметка неполна по
 * построению (её ведут руками по ходу работы), и отрезать по ней значило бы запретить списать
 * деталь, пока справочник не доведён, — то есть остановить работу ради справочника.
 */
function applicabilityRankExpr(modelId: string | null, typeId: string): SQL<number> {
  const byModel = modelId
    ? sql`WHEN EXISTS (
        SELECT 1 FROM ${autoPartApplicability}
         WHERE ${autoPartApplicability.autoPartId} = ${autoPartIdRef}
           AND ${autoPartApplicability.vehicleModelId} = ${modelId}
      ) THEN 0 `
    : sql.empty();
  return sql<number>`CASE ${byModel}WHEN EXISTS (
      SELECT 1 FROM ${autoPartApplicability}
       WHERE ${autoPartApplicability.autoPartId} = ${autoPartIdRef}
         AND ${autoPartApplicability.vehicleTypeId} = ${typeId}
    ) THEN 1 ELSE 2 END`;
}

/**
 * Столбцы ответа. Ранг приходит параметром, а не считается здесь: он есть только у запроса с
 * `vehicleId`, и в остальных случаях в его колонке стоит `NULL` — из которого DTO получает
 * ОТСУТСТВИЕ поля, а не ноль. Ноль означал бы «подходит по модели» и раскрасил бы весь справочник
 * подходящим первой попавшейся машине.
 */
function dtoColumns(rank: SQL<number> | null) {
  return {
    id: autoParts.id,
    code: autoParts.code,
    name: autoParts.name,
    unit: autoParts.unit,
    quantity: autoParts.quantity,
    isActive: autoParts.isActive,
    comment: autoParts.comment,
    hasStockHistory: hasStockHistoryExpr,
    applicabilityRank: rank ?? sql<number | null>`NULL::int`,
    createdAt: autoParts.createdAt,
    updatedAt: autoParts.updatedAt,
  };
}

interface DtoRow {
  id: string;
  code: string | null;
  name: string;
  unit: string;
  quantity: number;
  isActive: boolean;
  comment: string;
  hasStockHistory: boolean;
  applicabilityRank: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(r: DtoRow, applicability: AutoPartApplicabilityDto[]): AutoPartDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    unit: r.unit,
    quantity: r.quantity,
    isActive: r.isActive,
    comment: r.comment,
    applicability,
    // Поля нет вовсе, когда о машине не спрашивали (Р21): `undefined` в объекте ответа Fastify не
    // сериализует, и клиент отличает «не спрашивали» от «не подходит» самим фактом отсутствия.
    ...(r.applicabilityRank === null
      ? {}
      : { applicabilityRank: Number(r.applicabilityRank) as AutoPartApplicabilityRank }),
    hasStockHistory: r.hasStockHistory,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Тип модели читается ВТОРЫМ псевдонимом той же таблицы: у строки разметки по модели он свой (имя
 * модели уникально лишь в пределах типа — `vehicle_models_type_name_unique`, и одинокое «65115» не
 * отвечает, чей это самосвал), а у строки разметки по типу — это сам предмет разметки. Одним
 * соединением их не выразить: это два разных вопроса к одной таблице.
 */
const applicabilityModelType = alias(vehicleTypes, 'auto_part_applicability_model_type');

/**
 * Применимость для целой страницы списка — ОДНИМ запросом, а не запросом на строку: теги «к чему
 * подходит» стоят у каждой строки перечня (приём соседнего справочника расходников).
 *
 * Порядок — модели, затем типы, и внутри каждой половины по имени. Не «порядок вставки»: разметка
 * показывается перечислением с «+N», и случайный порядок означал бы, что за «+N» прячется каждый
 * раз другое. Модели впереди потому, что они точнее: сперва «эта машина», потом «все такие».
 */
async function applicabilityByPartIds(
  ids: string[],
): Promise<Map<string, AutoPartApplicabilityDto[]>> {
  const map = new Map<string, AutoPartApplicabilityDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      autoPartId: autoPartApplicability.autoPartId,
      id: autoPartApplicability.id,
      modelId: vehicleModels.id,
      modelName: vehicleModels.name,
      modelTypeId: applicabilityModelType.id,
      modelTypeName: applicabilityModelType.name,
      typeId: vehicleTypes.id,
      typeName: vehicleTypes.name,
    })
    .from(autoPartApplicability)
    .leftJoin(vehicleModels, eq(autoPartApplicability.vehicleModelId, vehicleModels.id))
    .leftJoin(applicabilityModelType, eq(vehicleModels.vehicleTypeId, applicabilityModelType.id))
    .leftJoin(vehicleTypes, eq(autoPartApplicability.vehicleTypeId, vehicleTypes.id))
    .where(inArray(autoPartApplicability.autoPartId, ids))
    .orderBy(
      sql`CASE WHEN ${autoPartApplicability.vehicleModelId} IS NULL THEN 1 ELSE 0 END`,
      sql`coalesce(${vehicleModels.name}, ${vehicleTypes.name})`,
    );
  for (const row of rows) {
    const list = map.get(row.autoPartId) ?? [];
    /*
     * Ровно одно поле из двух заполнено — это держит `CHECK auto_part_applicability_target_check`,
     * и порознь они не бывают. Ссылки при этом `restrict`, поэтому строка разметки без своей модели
     * или без своего типа не существует: соединения левые лишь потому, что вторая половина у
     * каждой строки законно пуста.
     */
    list.push(
      row.modelId !== null
        ? {
            id: row.id,
            vehicleModel: {
              id: row.modelId,
              name: row.modelName!,
              vehicleTypeId: row.modelTypeId!,
              vehicleTypeName: row.modelTypeName!,
            },
            vehicleType: null,
          }
        : {
            id: row.id,
            vehicleModel: null,
            vehicleType: { id: row.typeId!, name: row.typeName! },
          },
    );
    map.set(row.autoPartId, list);
  }
  return map;
}

/** Карточка после записи читается тем же запросом, что и строка списка: расхождению негде взяться. */
async function getDto(id: string): Promise<AutoPartDto> {
  const [row] = await db.select(dtoColumns(null)).from(autoParts).where(eq(autoParts.id, id));
  if (!row) throw err.notFound(NOT_FOUND);
  const applicability = await applicabilityByPartIds([id]);
  return toDto(row, applicability.get(id) ?? []);
}

/**
 * Лента журнала (Р3). Порядок — по `seq` вниз, а не по времени: две правки одной секунды по
 * `created_at` неразличимы, и цепочка «было — стало» в такой ленте читалась бы задом наперёд через
 * раз.
 *
 * Страниц у ленты нет намеренно: карточка обязана показывать историю целиком — «куда делись
 * двенадцать фильтров» отвечает только весь журнал, а не его хвост.
 *
 * `innerJoin` по автору законен: `changed_by` объявлен `NOT NULL` и стоит с `RESTRICT` — учётку,
 * менявшую остаток, из портала не удалить, поэтому строка без автора не существует.
 *
 * **Реквизиты акта читаются соединением с ТЕКУЩИМ актом, а не снимком** (Р5): дату, номер и машину
 * правят после списания, и застывший «12.08.2026, В613ВУ197» разошёлся бы с документом, на который
 * сам же и ссылается. Соединения левые: у ручной правки ссылки на акт нет вовсе.
 */
async function stockEntriesOf(id: string): Promise<AutoPartStockEntryDto[]> {
  const rows = await db
    .select({
      id: autoPartStockEntries.id,
      seq: autoPartStockEntries.seq,
      entryKind: autoPartStockEntries.entryKind,
      maintenanceId: autoPartStockEntries.maintenanceId,
      maintenanceVehicleId: vehicleMaintenance.vehicleId,
      maintenancePerformedOn: vehicleMaintenance.performedOn,
      ownership: vehicles.ownership,
      description: vehicles.description,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
      registrationNumber: vehicles.registrationNumber,
      modelName: vehicleModels.name,
      quantityBefore: autoPartStockEntries.quantityBefore,
      quantityAfter: autoPartStockEntries.quantityAfter,
      reason: autoPartStockEntries.reason,
      changedByName: users.fullName,
      createdAt: autoPartStockEntries.createdAt,
    })
    .from(autoPartStockEntries)
    .innerJoin(users, eq(autoPartStockEntries.changedBy, users.id))
    .leftJoin(vehicleMaintenance, eq(autoPartStockEntries.maintenanceId, vehicleMaintenance.id))
    .leftJoin(vehicles, eq(vehicleMaintenance.vehicleId, vehicles.id))
    .leftJoin(vehicleTypes, eq(vehicles.vehicleTypeId, vehicleTypes.id))
    .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
    .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
    .where(eq(autoPartStockEntries.autoPartId, id))
    .orderBy(desc(autoPartStockEntries.seq));
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    entryKind: r.entryKind,
    maintenanceId: r.maintenanceId,
    maintenanceVehicleId: r.maintenanceVehicleId,
    // Подпись машины — общим правилом портала (`vehicleLabel`), а не своим написанием в этом
    // модуле: лента журнала и история обслуживания называют одну и ту же машину, и разные слова на
    // неё читались бы как разные машины.
    maintenanceVehicleLabel:
      r.maintenanceVehicleId === null
        ? null
        : vehicleLabel({
            ownership: r.ownership!,
            description: r.description!,
            categoryName: r.categoryName,
            typeName: r.typeName!,
            registrationNumber: r.registrationNumber,
            modelName: r.modelName,
          }),
    maintenancePerformedOn: r.maintenancePerformedOn,
    quantityBefore: r.quantityBefore,
    quantityAfter: r.quantityAfter,
    reason: r.reason,
    changedByName: r.changedByName,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Две оси разметки порознь: набор приходит одним перечнем, а хранится и сверяется по ссылкам. */
function applicabilityAxes(rows: AutoPartApplicabilityInput[]): {
  modelIds: string[];
  typeIds: string[];
} {
  return {
    modelIds: rows.flatMap((r) => (r.vehicleModelId === null ? [] : [r.vehicleModelId])),
    typeIds: rows.flatMap((r) => (r.vehicleTypeId === null ? [] : [r.vehicleTypeId])),
  };
}

/**
 * Все присланные модели и типы существуют. Проверка до записи, потому что иначе выдуманный
 * идентификатор превратился бы в нарушение внешнего ключа — 500 с именем ограничения вместо ответа
 * про поле (Р8).
 *
 * Активность модели здесь НЕ требуется: погашенная модель означает «новых таких машин не заводим»,
 * а запчасти для уже стоящих в гараже покупать по-прежнему нужно.
 */
async function assertApplicabilityExists(
  tx: Tx,
  modelIds: string[],
  typeIds: string[],
): Promise<void> {
  if (modelIds.length > 0) {
    const found = await tx
      .select({ id: vehicleModels.id })
      .from(vehicleModels)
      .where(inArray(vehicleModels.id, modelIds));
    if (found.length !== modelIds.length) {
      throw err.badRequest('Модель техники не найдена', APPLICABILITY_NOT_FOUND_FIELDS);
    }
  }
  if (typeIds.length > 0) {
    const found = await tx
      .select({ id: vehicleTypes.id })
      .from(vehicleTypes)
      .where(inArray(vehicleTypes.id, typeIds));
    if (found.length !== typeIds.length) {
      throw err.badRequest('Тип техники не найден', APPLICABILITY_NOT_FOUND_FIELDS);
    }
  }
}

/**
 * Свести разметку к присланному набору: снять лишнее, добавить недостающее. Именно свести, а не
 * «снести и записать заново»: `created_at` строки — единственный след того, когда применимость
 * разметили, и переписывать его при каждой правке комментария незачем.
 *
 * Условие снятия записано ПО ОСЯМ, а не одним `NOT (… OR …)`: у строки заполнена ровно одна ссылка,
 * вторая `NULL`, и `vehicle_model_id NOT IN (…)` для строки по типу дало бы неопределённость —
 * то есть строка не удалилась бы и не осталась бы, а просто не попала бы ни под одно условие.
 * Каждая половина сначала спрашивает «это строка моей оси», и только потом — «её прислали».
 *
 * `onConflictDoNothing` — не про гонку двух вкладок (её пара уникальных индексов и так переживёт),
 * а про то же сведение: строка, которая уже есть, повторной вставкой не считается.
 */
async function syncApplicability(
  tx: Tx,
  autoPartId: string,
  rows: AutoPartApplicabilityInput[],
): Promise<void> {
  const { modelIds, typeIds } = applicabilityAxes(rows);
  await tx
    .delete(autoPartApplicability)
    .where(
      and(
        eq(autoPartApplicability.autoPartId, autoPartId),
        or(
          and(
            sql`${autoPartApplicability.vehicleModelId} IS NOT NULL`,
            modelIds.length > 0
              ? notInArray(autoPartApplicability.vehicleModelId, modelIds)
              : undefined,
          ),
          and(
            sql`${autoPartApplicability.vehicleTypeId} IS NOT NULL`,
            typeIds.length > 0
              ? notInArray(autoPartApplicability.vehicleTypeId, typeIds)
              : undefined,
          ),
        ),
      ),
    );
  if (rows.length > 0) {
    await tx
      .insert(autoPartApplicability)
      .values(
        rows.map((r) => ({
          autoPartId,
          vehicleModelId: r.vehicleModelId,
          vehicleTypeId: r.vehicleTypeId,
        })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Артикул свободен — проверяем до вставки. Уникальный индекс держит то же самое, но его нарушение
 * стало бы 500 с именем индекса, а человеку нужно знать, что такая позиция уже заведена.
 *
 * Сравнение — той же функцией, что в индексе, и на ОБЕИХ сторонах: «MANN W914/2», «mann w914/2» и
 * «MANN W914 /2» с неразрывным пробелом из письма — это один и тот же артикул. Хранимая сторона
 * сегодня и так нормализована (`CHECK`), но записывать эту равносильность в запрос нельзя: она
 * следствие соседнего ограничения, а не свойство ключа, и первая же миграция, ослабившая `CHECK`,
 * молча увела бы проверку в сторону от индекса.
 *
 * Индекс частичный (`WHERE code IS NOT NULL`), и проверка повторяет это условие: у позиций без
 * артикула идентичность держит пара, а не он (Р12).
 */
async function assertCodeFree(tx: Tx, code: string, exceptId?: string): Promise<void> {
  const dup = await tx
    .select({ id: autoParts.id })
    .from(autoParts)
    .where(
      and(
        sql`${autoParts.code} IS NOT NULL`,
        sql`auto_part_code_key(${autoParts.code}) = auto_part_code_key(${code})`,
        exceptId ? ne(autoParts.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (dup.length > 0) throw err.conflict(CODE_TAKEN, { fields: CODE_TAKEN_FIELDS });
}

/**
 * Пара «наименование + артикул» свободна — второй ключ идентичности (Р12). Сравнение повторяет
 * выражение индекса дословно, включая `coalesce(…, '')`: без него безартикульные строки не
 * конфликтовали бы между собой (`NULL` не равен `NULL`), и правило пары не работало бы ровно там,
 * ради чего заведено — на позициях, у которых артикула ещё нет.
 */
async function assertNameCodeFree(
  tx: Tx,
  name: string,
  code: string | null,
  exceptId?: string,
): Promise<void> {
  const dup = await tx
    .select({ id: autoParts.id })
    .from(autoParts)
    .where(
      and(
        sql`auto_part_name_key(${autoParts.name}) = auto_part_name_key(${name})`,
        sql`coalesce(auto_part_code_key(${autoParts.code}), '') = coalesce(${normalizedCode(code)}, '')`,
        exceptId ? ne(autoParts.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (dup.length > 0) throw err.conflict(NAME_TAKEN, { fields: NAME_TAKEN_FIELDS });
}

/**
 * Вторая дверь тех же отказов. Гонка с соседним заведением доходит до уникального индекса: чужая
 * незакоммиченная строка проверкам выше не видна, обе транзакции их проходят, и вторая падает на
 * `23505`. Без разбора это 500 — «внутренняя ошибка» там, где человеку нужно то же самое слово,
 * что и при обычном дубле.
 *
 * Опознаётся кодом и именем индекса, а не текстом сообщения: текст зависит от версии и локали
 * сервера, а имена заданы миграцией `0187`. Через `pgErrorOf`, потому что drizzle оборачивает
 * ошибку драйвера в свою и на верхнем объекте кода уже нет — прямая проверка молчала бы.
 */
function asWriteConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'auto_parts_code_unique') {
    return err.conflict(CODE_TAKEN, { fields: CODE_TAKEN_FIELDS });
  }
  if (pg?.code === '23505' && pg.constraint === 'auto_parts_name_code_unique') {
    return err.conflict(NAME_TAKEN, { fields: NAME_TAKEN_FIELDS });
  }
  /*
   * Та же щель у разметки: модель или тип, свободные от автозапчастей, сосед вправе удалить прямо
   * между проверкой и вставкой — `assertApplicabilityExists` этого не видит. Наружу это уходит
   * нарушением внешнего ключа и опознаётся по таблице-источнику: имя ключа Postgres собирает сам и
   * обрезает до 63 символов, то есть держать его константой значило бы держать длину усечения.
   */
  if (pg?.code === '23503' && pg.table === 'auto_part_applicability') {
    return err.badRequest('Модель или тип техники не найдены', APPLICABILITY_NOT_FOUND_FIELDS);
  }
  return e;
}

/**
 * Поиск идёт по обеим половинам карточки (Р13): «фильтр масл» помнят на слух, артикул спрашивают у
 * счёта, и обе половины обязаны находить одну строку.
 *
 * Половины ищутся ПО-РАЗНОМУ, и это следует из предмета. Наименование хранится дословно, и его
 * ищут подстрокой без учёта регистра (`ILIKE`, под ним индекс `auto_parts_name_trgm`). Артикул
 * хранится ключом — в верхнем регистре и без пробелов, — поэтому и запрос по нему прогоняется той
 * же функцией базы: набранное «mann w914» иначе не нашло бы «MANNW914/2», хотя это тот же самый
 * фильтр, а вторая копия правила написания на TypeScript снова развела бы маршрут с индексом.
 */
function searchWhere(term: string | undefined): SQL | undefined {
  if (!term) return undefined;
  return or(
    ilike(autoParts.name, `%${term}%`),
    sql`${autoParts.code} IS NOT NULL
        AND auto_part_code_key(${autoParts.code}) LIKE '%' || auto_part_code_key(${term}) || '%'`,
  );
}

export default async function autoPartsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Чтение — правом гаража: подобрать позицию в форме акта должен каждый, кому виден гараж (Р10).
  const canRead = app.requirePermission('garage.read');
  // Ведение номенклатуры и движение склада — разные права, поэтому и стражей двое: ручка остатка не
  // открывается тем, кто заводит позиции, и наоборот.
  const canManage = app.requirePermission(
    'autoParts.manage',
    'Справочник автозапчастей ведут механики',
  );
  const canStock = app.requirePermission(
    'autoParts.stock',
    'Остаток автозапчасти правит тот, кому доверен склад',
  );

  r.get(
    '/',
    { preHandler: [app.authenticate, canRead], schema: { querystring: autoPartListQuerySchema } },
    async (req) => {
      const q = req.query;
      /*
       * Подбор под машину (Р21): сервер читает её модель и тип и считает ими ранг. Машина читается
       * ОДНИМ запросом до списка, а не подзапросом внутри ранга: тот выполнялся бы на каждую строку
       * страницы ради двух значений, одинаковых для всего запроса.
       *
       * Архивную машину (`deleted_at`) отдельно не отбиваем: подбор нужен и при правке старого
       * акта, машина которого уже выведена из парка, — а ранг ничего не открывает, он только
       * упорядочивает то, что смотрящий и так вправе видеть.
       */
      let rank: SQL<number> | null = null;
      if (q.vehicleId) {
        const [vehicle] = await db
          .select({ modelId: vehicles.vehicleModelId, typeId: vehicles.vehicleTypeId })
          .from(vehicles)
          .where(eq(vehicles.id, q.vehicleId));
        if (!vehicle) {
          throw err.badRequest('Машина не найдена', { vehicleId: 'Машина не найдена' });
        }
        rank = applicabilityRankExpr(vehicle.modelId, vehicle.typeId);
      }
      const where = and(
        /*
         * «Что размечено этой моделью» — вопрос со стороны справочника, а не подбор. Через
         * `EXISTS`, как и ранг, и по той же причине: соединение размножило бы строку позиции по
         * числу строк её разметки.
         */
        q.vehicleModelId
          ? sql`EXISTS (
              SELECT 1 FROM ${autoPartApplicability}
               WHERE ${autoPartApplicability.autoPartId} = ${autoPartIdRef}
                 AND ${autoPartApplicability.vehicleModelId} = ${q.vehicleModelId}
            )`
          : undefined,
        q.vehicleTypeId
          ? sql`EXISTS (
              SELECT 1 FROM ${autoPartApplicability}
               WHERE ${autoPartApplicability.autoPartId} = ${autoPartIdRef}
                 AND ${autoPartApplicability.vehicleTypeId} = ${q.vehicleTypeId}
            )`
          : undefined,
        // «Нет в наличии» — тот срез, ради которого во вкладку заходят перед заказом. Ноль, а не
        // «меньше единицы»: отрицательного остатка не бывает (`CHECK`), и писать неравенство
        // значило бы намекать, что бывает.
        q.stock === undefined
          ? undefined
          : q.stock === 'in_stock'
            ? sql`${autoParts.quantity} > 0`
            : eq(autoParts.quantity, 0),
        q.isActive === undefined ? undefined : eq(autoParts.isActive, q.isActive),
        searchWhere(q.search),
      );
      const sortCols = {
        name: autoParts.name,
        code: autoParts.code,
        quantity: autoParts.quantity,
        updatedAt: autoParts.updatedAt,
      };
      /*
       * Порядок при подборе — `(ранг, наименование)`: ранг идёт ПЕРВЫМ и просимую сортировку не
       * отменяет, а предваряет. Иначе подходящая деталь осталась бы на седьмой странице — ровно то,
       * ради чего ранг и считается на сервере, а не досортировкой пришедшей страницы.
       *
       * Умолчание сортировки — наименование по возрастанию (Р13): справочник читают алфавитом.
       * Направление задаёт контракт (`sortOrder.default('asc')`), поле — четвёртый аргумент.
       */
      const order = orderByFrom(sortCols, q.sortBy, q.sortOrder, 'name');
      const p2 = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns(rank))
          .from(autoParts)
          .where(where)
          .orderBy(...(rank ? [asc(rank), order] : [order]))
          .limit(p2.limit)
          .offset(p2.offset),
        db.select({ c: count() }).from(autoParts).where(where),
      ]);
      const applicability = await applicabilityByPartIds(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, applicability.get(row.id) ?? [])),
        total: Number(totalRows[0]!.c),
        page: p2.page,
        pageSize: p2.pageSize,
      };
    },
  );

  /** Карточка целиком: сама запись и лента её журнала (§6, Р14). */
  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req): Promise<AutoPartDetailDto> => {
      const { id } = req.params;
      const part = await getDto(id);
      return { ...part, stockEntries: await stockEntriesOf(id) };
    },
  );

  /**
   * Заведение. Начальный остаток — не поле карточки, а ПЕРВОЕ СОБЫТИЕ ЖУРНАЛА, и записывается оно
   * в той же транзакции: цепочка `0187` считает, что до первого события позиции не было ничего,
   * поэтому строка выходит «0 → N». Без неё отложенный триггер покрытия отменил бы транзакцию на
   * коммите — «остаток есть, а в журнале пусто» он и ловит.
   *
   * Заведение с нулём событий не пишет вовсе: «0 → 0» это не событие, а его отсутствие, и `CHECK`
   * `auto_part_stock_change_check` такую строку не пропустит (Р3).
   *
   * Порядок внутри транзакции — карточка, потом событие: цепочка сверяет «стало» с фактическим
   * остатком карточки, и обратный порядок она же и отобьёт.
   */
  r.post(
    '/',
    { preHandler: [app.authenticate, canManage], schema: { body: createAutoPartSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const b = req.body;
      /*
       * НЕНУЛЕВОЙ НАЧАЛЬНЫЙ ОСТАТОК ТРЕБУЕТ `stock` СВЕРХ `manage` (Р10, Р19). Без этой проверки
       * разделение прав держалось бы только у уже заведённых позиций: ручка остатка закрыта, а то
       * же число ставится заведением — «завёл ремень, а на складе их сразу 900».
       *
       * Отказ, а не молчаливое обнуление: приняв число и записав ноль, портал соврал бы человеку
       * «сохранено» — тот же довод, по которому `quantity` не принимает и правка карточки.
       *
       * Граница проведена по НУЛЮ, а не по «полю в теле»: `quantity` приезжает умолчанием схемы и
       * в теле есть всегда, а ноль — это отсутствие утверждения о складе (позицию номенклатуры
       * завели, деталей пока не считали). Довод сильнее, чем кажется: ошибившись числом, держатель
       * одного `manage` свою ошибку НЕ ИСПРАВИТ — у карточки уже есть строка журнала, значит
       * `DELETE` отобьёт `RESTRICT`, а правка остатка потребует того самого права, которого у него
       * нет. Человек остался бы с неверным числом и без выхода.
       *
       * Проверка стоит ДО транзакции: она ничего не читает и не должна занимать соединение.
       */
      if (b.quantity > 0) {
        assertCan(
          p,
          'autoParts.stock',
          'Заведите позицию с нулевым остатком: начальное число проставит тот, кому доверен склад',
        );
      }
      const { modelIds, typeIds } = applicabilityAxes(b.applicability);
      const created = await db
        .transaction(async (tx) => {
          if (b.code !== null) await assertCodeFree(tx, b.code);
          await assertNameCodeFree(tx, b.name, b.code);
          await assertApplicabilityExists(tx, modelIds, typeIds);
          const [row] = await tx
            .insert(autoParts)
            .values({
              // Нормализация — выражением базы, а не строкой из TypeScript: см. преамбулу.
              code: normalizedCode(b.code),
              // Наименование, наоборот, ложится ДОСЛОВНО: его сверяют глазами с прайсом и счётом, и
              // «причёсанное» имя эту сверку ломает. Нормализуется только ключ (Р12).
              name: b.name,
              unit: b.unit,
              quantity: b.quantity,
              isActive: b.isActive,
              comment: b.comment,
              createdBy: p.id,
              updatedBy: p.id,
            })
            .returning({ id: autoParts.id, code: autoParts.code });
          const part = row!;
          await syncApplicability(tx, part.id, b.applicability);
          if (b.quantity > 0) {
            await tx.insert(autoPartStockEntries).values({
              autoPartId: part.id,
              // Вид события проставляет сервер, а не клиент: заведение карточки — ручная работа
              // механика, и выдать её за расход по акту нельзя даже подделанным телом (`CHECK`
              // связок в базе — второй рубеж: у `issue` обязана быть ссылка на акт).
              entryKind: 'manual',
              quantityBefore: 0,
              quantityAfter: b.quantity,
              reason: FIRST_ENTRY_REASON,
              changedBy: p.id,
            });
          }
          return part;
        })
        // Гонка с соседним заведением приходит сюда нарушением уникального индекса — и уходит тем
        // же 409, что и обычный дубль.
        .catch((e: unknown) => {
          throw asWriteConflict(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'autoPart.create',
        entityType: 'autoPart',
        entityId: created.id,
        // Артикул пишется нормализованным — тем видом, в котором он лёг в справочник, а не тем,
        // который набрали в форме: по журналу ищут заведённую строку, а не ввод.
        metadata: { code: created.code, name: b.name, unit: b.unit, quantity: b.quantity },
      });
      reply.code(201);
      return await getDto(created.id);
    },
  );

  /**
   * Правка реквизитов и применимости. Количества здесь нет вовсе (Р3): схема его не принимает, и
   * приняв — маршрут соврал бы человеку «сохранено» там, где остаток остался прежним и в журнал
   * ничего не легло. Остаток правит только `POST /:id/stock`.
   *
   * Строка читается `FOR UPDATE` не ради остатка, а ради самой карточки: правка артикула двумя
   * людьми и правка артикула против гашения обязаны увидеть результат друг друга, а не разойтись по
   * своим снимкам. Под этой же блокировкой стоят обе проверки идентичности — и они сверяют ИТОГ
   * правки, а не присланные поля: пара «наименование + артикул» состоит из двух половин, и
   * присланное наименование конфликтует с уже лежащим в карточке артикулом ничуть не реже.
   */
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canManage],
      schema: { params: idParams, body: updateAutoPartSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      await db
        .transaction(async (tx) => {
          const [row] = await tx
            .select({ id: autoParts.id, name: autoParts.name, code: autoParts.code })
            .from(autoParts)
            .where(eq(autoParts.id, id))
            .for('update');
          if (!row) throw err.notFound(NOT_FOUND);
          const name = b.name ?? row.name;
          const code = b.code === undefined ? row.code : b.code;
          // С исключением себя: правка «mann w914/2» → «MANN W914/2» — это исправление написания, а
          // не двойник. Сама запись всё равно уедет нормализованной: базе безразлично, изменилось
          // написание или нет.
          if (b.code !== undefined && code !== null) await assertCodeFree(tx, code, id);
          if (b.name !== undefined || b.code !== undefined) {
            await assertNameCodeFree(tx, name, code, id);
          }
          if (b.applicability !== undefined) {
            const { modelIds, typeIds } = applicabilityAxes(b.applicability);
            await assertApplicabilityExists(tx, modelIds, typeIds);
            await syncApplicability(tx, id, b.applicability);
          }
          await tx
            .update(autoParts)
            .set({
              ...(b.code === undefined ? {} : { code: normalizedCode(b.code) }),
              ...(b.name === undefined ? {} : { name: b.name }),
              ...(b.unit === undefined ? {} : { unit: b.unit }),
              ...(b.isActive === undefined ? {} : { isActive: b.isActive }),
              ...(b.comment === undefined ? {} : { comment: b.comment }),
              updatedBy: p.id,
              updatedAt: new Date(),
            })
            .where(eq(autoParts.id, id));
        })
        .catch((e: unknown) => {
          throw asWriteConflict(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'autoPart.update',
        entityType: 'autoPart',
        entityId: id,
        // Только присланное: журнал правки обязан показывать, что именно просили изменить, а не всю
        // карточку — иначе непонятно, тронули поле или оно просто приехало формой.
        metadata: {
          ...(b.code === undefined ? {} : { code: b.code }),
          ...(b.name === undefined ? {} : { name: b.name }),
          ...(b.unit === undefined ? {} : { unit: b.unit }),
          ...(b.isActive === undefined ? {} : { isActive: b.isActive }),
          ...(b.comment === undefined ? {} : { comment: b.comment }),
          // Разметка — такое же присланное поле, и «пусто» у неё значащее: пустой набор снимает всю
          // применимость, а отсутствие поля её не трогает (см. контракт).
          ...(b.applicability === undefined ? {} : { applicability: b.applicability }),
        },
      });
      return await getDto(id);
    },
  );

  /**
   * Правка остатка (Р3). Порядок шагов обязателен и держится тремя триггерами `0187`, а не
   * вежливостью маршрута:
   *
   *   1. `SELECT … FOR UPDATE` строки позиции — первым шагом транзакции. Без блокировки два
   *      механика прочитали бы 12, записали «12 → 10» и «12 → 8», и цепочка журнала стала бы
   *      враньём при верном итоге;
   *   2. сверка с `expectedQuantity` — тем числом, которое человек видел в форме. Разошлось — 409 с
   *      текущим значением: молчаливая перезапись превращается в понятный отказ. Блокировку это не
   *      заменяет, а дополняет — она сериализует, а сверка объясняет;
   *   3. новое значение равно текущему — выход БЕЗ записи. Это не ошибка ввода, а повторное нажатие
   *      кнопки, и журнал не должен пухнуть от таких событий; в ответе это `entry: null`;
   *   4. `UPDATE` карточки, затем `INSERT` события — и только в таком порядке: триггер цепочки
   *      сверяет «стало» события с ФАКТИЧЕСКИМ остатком карточки, поэтому событие, вставленное
   *      раньше правки, будет отбито.
   *
   * `quantity_before` маршрут берёт из прочитанной строки, а не из тела: `expectedQuantity` — это
   * то, что человек ВИДЕЛ, и в шаге 2 оно уже сверено, а в журнал обязано лечь то, что было на
   * самом деле. Совпадают они всегда — но совпадают потому, что проверены, а не по построению.
   *
   * Гашение позиции этой ручке не мешает: правило Р24 («погашенную нельзя списать больше») адресовано
   * строкам акта, а ручная правка погашенной позиции — это инвентаризация, и запрещать её незачем.
   */
  r.post(
    '/:id/stock',
    {
      preHandler: [app.authenticate, canStock],
      schema: { params: idParams, body: autoPartStockSchema },
    },
    async (req): Promise<AutoPartStockResultDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      const written = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ code: autoParts.code, name: autoParts.name, quantity: autoParts.quantity })
          .from(autoParts)
          .where(eq(autoParts.id, id))
          .for('update');
        if (!row) throw err.notFound(NOT_FOUND);
        if (row.quantity !== b.expectedQuantity) {
          /*
           * Пометки поля здесь нет намеренно, в отличие от занятого артикула: исправлять человеку
           * нечего — число в форме не ошибочно, оно устарело. Ответ обязан назвать текущее значение
           * прямо в тексте, иначе окно правки предложит переспросить то же самое.
           */
          throw err.conflict(`Остаток изменил другой человек, сейчас ${row.quantity}`);
        }
        // Шаг 3: повторное нажатие. Выход до всякой записи — карточку не трогаем вовсе, поэтому и
        // `updated_at` у неё не сдвигается: правки не было.
        if (row.quantity === b.quantity) return null;
        await tx
          .update(autoParts)
          .set({ quantity: b.quantity, updatedBy: p.id, updatedAt: new Date() })
          .where(eq(autoParts.id, id));
        const [entry] = await tx
          .insert(autoPartStockEntries)
          .values({
            autoPartId: id,
            // Ручная правка — всегда `manual`, и ссылка на акт пуста. Пишет это сервер, а не
            // клиент: вид события в теле ручки не принимается вовсе, иначе расход по акту можно
            // было бы изготовить запросом мимо обслуживания (`CHECK` связок в базе — второй рубеж).
            entryKind: 'manual',
            maintenanceId: null,
            quantityBefore: row.quantity,
            quantityAfter: b.quantity,
            reason: b.reason,
            changedBy: p.id,
          })
          .returning({
            id: autoPartStockEntries.id,
            seq: autoPartStockEntries.seq,
            entryKind: autoPartStockEntries.entryKind,
            maintenanceId: autoPartStockEntries.maintenanceId,
            quantityBefore: autoPartStockEntries.quantityBefore,
            quantityAfter: autoPartStockEntries.quantityAfter,
            reason: autoPartStockEntries.reason,
            createdAt: autoPartStockEntries.createdAt,
          });
        return { code: row.code, name: row.name, entry: entry! };
      });
      // Событие не записано — записывать в аудит нечего: повторное нажатие ничего не изменило, а
      // журнал остатка и без того подробнее аудита (Р3).
      if (written) {
        await writeAudit({
          actorUserId: p.id,
          action: 'autoPart.stock',
          entityType: 'autoPart',
          entityId: id,
          metadata: {
            code: written.code,
            name: written.name,
            quantityBefore: written.entry.quantityBefore,
            quantityAfter: written.entry.quantityAfter,
            reason: written.entry.reason,
          },
        });
      }
      return {
        part: await getDto(id),
        entry: written
          ? {
              ...written.entry,
              // Ручная правка акта не знает: ссылка пуста, и все четыре реквизита ленты пусты
              // вместе с ней — порознь они не бывают (`CHECK auto_part_stock_links_check`).
              maintenanceVehicleId: null,
              maintenanceVehicleLabel: null,
              maintenancePerformedOn: null,
              // Автор события — тот, кто его только что записал, и второй запрос за его ФИО был бы
              // запросом к самому себе.
              changedByName: p.fullName,
              createdAt: written.entry.createdAt.toISOString(),
            }
          : null,
      };
    },
  );

  /**
   * Удаление по правилу Р11: пока журнал остатка пуст, запись удаляется совсем — так убирают
   * опечатку первого дня; появилось хоть одно движение — только гашение флагом «Активна».
   *
   * Держит это `ON DELETE RESTRICT` журнала, а не маршрут; проверка здесь стоит лишь затем, чтобы
   * человек прочитал слова, а не имя ограничения.
   *
   * Проверка ВНУТРИ транзакции и после `FOR UPDATE` по строке позиции — не для красоты: триггер
   * цепочки сам берёт эту строку `FOR UPDATE` перед вставкой события, значит между проверкой и
   * удалением чужое событие не проскочит — либо оно успело до нас и мы его увидим, либо ждёт нас и
   * упрётся в отсутствие карточки. Проверка до транзакции такого не обещает вовсе.
   *
   * Разметка применимости удалению не мешает: это свойство живой позиции, а не история, и уходит
   * она каскадом (Р8). Строки актов обслуживания мешают — но не сами по себе, а через журнал: акт
   * без движения строк не имеет вовсе (инвариант расхода `0188`).
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canManage], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const removed = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ code: autoParts.code, name: autoParts.name })
          .from(autoParts)
          .where(eq(autoParts.id, id))
          .for('update');
        if (!row) throw err.notFound(NOT_FOUND);
        const moved = await tx
          .select({ id: autoPartStockEntries.id })
          .from(autoPartStockEntries)
          .where(eq(autoPartStockEntries.autoPartId, id))
          .limit(1);
        if (moved.length > 0) {
          throw err.conflict('По автозапчасти есть движение, снимите „Активна“ вместо удаления');
        }
        await tx.delete(autoParts).where(eq(autoParts.id, id));
        return row;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'autoPart.delete',
        entityType: 'autoPart',
        entityId: id,
        // Строки больше нет — в журнале остаётся то, чем её называли.
        metadata: { code: removed.code, name: removed.name },
      });
      return { ok: true };
    },
  );
}
