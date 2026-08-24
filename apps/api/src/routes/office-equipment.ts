import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  can,
  createOfficeEquipmentSchema,
  decodeEquipmentHistoryCursor,
  EQUIPMENT_HISTORY_EXPORT_LIMIT,
  type EquipmentHistoryPageDto,
  equipmentHistoryQuerySchema,
  formatServiceRequestNumber,
  moveOfficeEquipmentSchema,
  officeEquipmentListQuerySchema,
  officeEquipmentTitle,
  type OfficeEquipmentConsumableRefDto,
  type OfficeEquipmentDto,
  type OfficeEquipmentItemWarrantyDto,
  type OfficeEquipmentServiceEntryDto,
  type OfficeEquipmentWarrantyFilter,
  updateOfficeEquipmentSchema,
  WARRANTY_EXPIRING_DAYS,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  officeEquipment,
  officeEquipmentConsumableModels,
  officeEquipmentConsumables,
  officeEquipmentModels,
  officeEquipmentMovements,
  officeEquipmentTypes,
  serviceRequestItems,
  serviceRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import { writeAudit } from '../lib/audit';
import { officeEquipmentDiff } from '../services/office-equipment-diff';
import {
  loadEquipmentHistoryAll,
  loadEquipmentHistoryPage,
} from '../services/office-equipment-history';
import { equipmentHistoryWorkbook } from '../services/office-equipment-history-export';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import {
  archiveWhere,
  assertArchiveVisible,
  assertOfficeEquipmentScope,
  officeEquipmentScopeWhere,
  serviceRequestScopeWhere,
} from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';

/**
 * Справочник оргтехники (ADR 0085): что стоит по кабинетам и площадкам — МФУ, ноутбуки, мониторы.
 * Единица опознаётся серийным или инвентарным номером (Р32), стоит на объекте и числится за
 * отделом; гарантия поставщика — срок, за которым и приходят в этот справочник.
 *
 * Права свои — `officeEquipment.read` и `officeEquipment.write` (Р7): читать карточку, где видно
 * обслуживание техники, не должен каждый, у кого есть `directories.read`, а ведение справочника не
 * должно тянуть за собой весь раздел справочников.
 *
 * Список и карточка сужаются областью субъекта (`officeEquipmentScopeWhere`), а правка проверяет
 * область по обеим сторонам: перенос на чужой объект — тот же выход за область, что и правка чужой
 * карточки. Удаление мягкое (Р33): заявки на обслуживание будут ссылаться на единицу, и снесённая
 * строка оставила бы их без предмета.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

const typeRef = {
  id: officeEquipmentTypes.id,
  name: officeEquipmentTypes.name,
  isActive: officeEquipmentTypes.isActive,
};

/**
 * Модель в строке единицы (Р1): показать и выбрать заново — больше от неё в списке ничего не нужно.
 * Производитель, комментарий и признак «активна» живут в окне моделей, а не в каждой карточке парка.
 */
const modelRef = {
  id: officeEquipmentModels.id,
  name: officeEquipmentModels.name,
};

/** Код объекта различает одноимённые корпуса — без него «Стройка» в списке ничего не называет. */
const objectRef = {
  id: constructionObjects.id,
  code: constructionObjects.code,
  name: constructionObjects.name,
};

const departmentRef = {
  id: departments.id,
  code: departments.code,
  name: departments.name,
};

/**
 * Обе стороны перемещения join'ятся дважды — «откуда» и «куда», — поэтому каждой нужна своя копия
 * таблицы: без алиасов SQL сложил бы их в одно условие и вернул бы пустой журнал.
 */

/**
 * Сколько перемещений отдаётся в ленту карточки. Столько же, сколько событий у истории заявки
 * (`HISTORY_LIMIT`): карточку открывают вопросом «что было недавно», а полный журнал за пять лет —
 * это выгрузка, и заводится она отдельно, если понадобится.
 */

/**
 * Тип и объект у единицы есть всегда (`NOT NULL`), поэтому они `innerJoin`; отдел — необязателен,
 * и `leftJoin` здесь означает ровно «не размечена», а не потерянную ссылку.
 *
 * Модель — тоже `leftJoin`, и в выпуске A обязана им быть (Р2): колонка `model_id` весь выпуск
 * nullable, потому что в окне выката карточку заводит старый код, ничего о ней не знающий.
 * `innerJoin` вычеркнул бы такую карточку из списка и из карточки — то есть спрятал бы ровно ту
 * единицу, ради которой совместимость и делалась. В выпуске B, вместе с `NOT NULL`, join станет
 * внутренним.
 */
function baseQuery() {
  return db
    .select({
      e: officeEquipment,
      type: typeRef,
      model: modelRef,
      object: objectRef,
      department: departmentRef,
    })
    .from(officeEquipment)
    .innerJoin(officeEquipmentTypes, eq(officeEquipment.equipmentTypeId, officeEquipmentTypes.id))
    .leftJoin(officeEquipmentModels, eq(officeEquipment.modelId, officeEquipmentModels.id))
    .innerJoin(constructionObjects, eq(officeEquipment.objectId, constructionObjects.id))
    .leftJoin(departments, eq(officeEquipment.ownerDepartmentId, departments.id));
}

type EquipmentRow = Awaited<ReturnType<typeof baseQuery>>[number];

function toDto(r: EquipmentRow): OfficeEquipmentDto {
  return {
    id: r.e.id,
    type: r.type,
    // Модель отдаётся всегда, а не «когда получилось»: необязательной в контракте она стоит только
    // на время выпуска A (Р2) — ради фикстур портала и ещё не переведённых читателей. Отсюда
    // `null` означает «ссылки у карточки нет» (её завёл старый код в окне выката), а не «маршрут
    // не умеет»; в выпуске B оба переходных состояния уходят вместе с nullable-колонкой.
    model: r.model,
    // Имя — копия имени модели, которую ведёт база (Р3), а не то, что ввёл человек.
    name: r.e.name,
    serialNumber: r.e.serialNumber,
    inventoryNumber: r.e.inventoryNumber,
    object: r.object,
    department: r.department,
    location: r.e.location,
    purchasedOn: r.e.purchasedOn,
    warrantyUntil: r.e.warrantyUntil,
    state: r.e.state,
    stateNote: r.e.stateNote,
    comment: r.e.comment,
    isActive: r.e.isActive,
    createdAt: r.e.createdAt.toISOString(),
    updatedAt: r.e.updatedAt.toISOString(),
    deletedAt: r.e.deletedAt ? r.e.deletedAt.toISOString() : null,
  };
}

async function getDto(id: string): Promise<OfficeEquipmentDto | null> {
  const [row] = await baseQuery().where(eq(officeEquipment.id, id));
  return row ? toDto(row) : null;
}

/**
 * Три вопроса, которые задают гарантии в списке. Считает их БД, а не `warrantyState`: фильтр
 * отбирает строки до выдачи, и порог обязан быть выражен в SQL — тянуть весь справочник в память
 * ради сравнения дат нельзя. Общее с интерфейсом здесь одно и главное — сам порог
 * (`WARRANTY_EXPIRING_DAYS`), поэтому подсветка строки и её попадание в фильтр не разъедутся.
 *
 * «Действует» намеренно включает истекающие: вопрос звучит «есть ли сейчас гарантия», и техника с
 * неделей до конца ей всё ещё покрыта (тот же ответ даёт `isWarrantyActive`). «Истекает» — срез
 * внутри «действует», а не соседняя с ним корзина.
 *
 * Пустой срок (`NULL`) не попадает ни в один фильтр: «гарантия не заведена» — это не «гарантии
 * нет», и утверждать за портал то, чего он не знает, он не должен.
 */
function warrantyCondition(filter: OfficeEquipmentWarrantyFilter | undefined): SQL | undefined {
  if (!filter) return undefined;
  const until = officeEquipment.warrantyUntil;
  if (filter === 'expired') return and(isNotNull(until), sql`${until} < CURRENT_DATE`);
  if (filter === 'active') return and(isNotNull(until), sql`${until} >= CURRENT_DATE`);
  return and(
    isNotNull(until),
    // День окончания входит в гарантию, поэтому границы включающие — как в `warrantyState`.
    sql`${until} BETWEEN CURRENT_DATE AND CURRENT_DATE + CAST(${WARRANTY_EXPIRING_DAYS} AS integer)`,
  );
}

/** Сравнение номеров — как в уникальных индексах: без регистра и без крайних пробелов. */
const sameNumber = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Номера уникальны среди живых карточек (Р32): по ним технику опознают при приёмке из ремонта, и
 * два «инв. 0012345» в справочнике означают, что опознать её нечем. Проверяем до записи, хотя
 * частичные уникальные индексы держат то же самое: нарушение индекса стало бы 500, а человеку нужно
 * знать, какой именно номер занят и кем.
 *
 * Пустой номер не сравнивается: он разрешён, пока заполнен второй, и «пусто = пусто» запретило бы
 * заводить технику вовсе.
 */
async function assertNumbersFree(
  tx: Tx,
  numbers: { serialNumber: string; inventoryNumber: string },
  exceptId?: string,
): Promise<void> {
  const serial = numbers.serialNumber.trim();
  const inventory = numbers.inventoryNumber.trim();
  const matches = [
    serial
      ? sql`upper(btrim(${officeEquipment.serialNumber})) = upper(btrim(${serial}))`
      : undefined,
    inventory
      ? sql`upper(btrim(${officeEquipment.inventoryNumber})) = upper(btrim(${inventory}))`
      : undefined,
  ].filter((c): c is SQL => c !== undefined);
  if (matches.length === 0) return;
  const dups = await tx
    .select({
      name: officeEquipment.name,
      serialNumber: officeEquipment.serialNumber,
      inventoryNumber: officeEquipment.inventoryNumber,
    })
    .from(officeEquipment)
    .where(
      and(
        // Удалённая карточка номер не держит: тем же условием ограничены и сами индексы.
        isNull(officeEquipment.deletedAt),
        exceptId ? ne(officeEquipment.id, exceptId) : undefined,
        or(...matches),
      ),
    );
  for (const dup of dups) {
    if (serial && sameNumber(dup.serialNumber, serial)) {
      throw err.conflict(`Серийный номер ${serial} занят карточкой «${officeEquipmentTitle(dup)}»`);
    }
    if (inventory && sameNumber(dup.inventoryNumber, inventory)) {
      throw err.conflict(
        `Инвентарный номер ${inventory} занят карточкой «${officeEquipmentTitle(dup)}»`,
      );
    }
  }
}

/**
 * Тип единицы — живой и активный: неактивный тип остаётся у заведённых карточек, но выбрать его
 * заново нельзя, иначе выключение типа ничего бы не значило. 400, а не 422: ссылка на справочник
 * либо ведёт куда надо, либо нет, и поле в ответе называет, какая именно.
 */
async function assertTypeUsable(tx: Tx, typeId: string): Promise<void> {
  const [row] = await tx
    .select({ isActive: officeEquipmentTypes.isActive })
    .from(officeEquipmentTypes)
    .where(eq(officeEquipmentTypes.id, typeId));
  if (!row) throw err.badRequest('Тип оргтехники не найден', { equipmentTypeId: 'Не найден' });
  if (!row.isActive) {
    throw err.badRequest('Тип оргтехники неактивен', { equipmentTypeId: 'Тип неактивен' });
  }
}

/**
 * Модель существует, не погашена и заведена тем же типом, что и карточка (Р1).
 *
 * Проверяем до записи, хотя пару «модель — тип» держит и база: составной ключ
 * `office_equipment_model_type_fk` отобьёт попытку приписать МФУ модель принтера, но текстом про
 * ограничение — человек прочитал бы имя ключа вместо «это модель принтера». Тот же счёт, что у
 * номеров: нарушение ключа стало бы 500 там, где нужен ответ словами.
 *
 * Погашенная модель отбивается только на входе. У заведённых карточек она остаётся (Р11): гашение
 * означает «больше не предлагать», а не «переписать парк», — поэтому правка карточки, не трогающая
 * ссылку, сюда не заходит вовсе.
 *
 * Коды разные, и это не случайность. Ненайденная и погашенная модель — 400 полем `modelId`, как у
 * типа (`assertTypeUsable`): ссылка на справочник либо ведёт куда надо, либо нет. Чужой тип — 422:
 * запрос понятен и обе ссылки живые, недопустима их пара (тот же разбор, что у «оба номера пусты»).
 */
/**
 * Один текст на обе двери отказа «модели нет» — проверку ниже и гонку (`asMissingModelBadRequest`):
 * человеку всё равно, которая сработала, а разойдясь, две формулировки означали бы разные причины.
 */
const MODEL_NOT_FOUND = 'Модель аппарата не найдена';
const MODEL_NOT_FOUND_FIELDS = { modelId: 'Не найдена' };

async function assertModelUsable(tx: Tx, modelId: string, equipmentTypeId: string): Promise<void> {
  const [row] = await tx
    .select({
      name: officeEquipmentModels.name,
      isActive: officeEquipmentModels.isActive,
      equipmentTypeId: officeEquipmentModels.equipmentTypeId,
      typeName: officeEquipmentTypes.name,
    })
    .from(officeEquipmentModels)
    .innerJoin(
      officeEquipmentTypes,
      eq(officeEquipmentModels.equipmentTypeId, officeEquipmentTypes.id),
    )
    .where(eq(officeEquipmentModels.id, modelId));
  if (!row) throw err.badRequest(MODEL_NOT_FOUND, MODEL_NOT_FOUND_FIELDS);
  // Чужой тип проверяется раньше гашения: погашенную модель нужного типа человек хотя бы выбирал
  // осознанно, а модель другого типа — это вообще не тот аппарат, и говорить о ней «погашена»
  // значило бы отвечать не на тот вопрос.
  if (row.equipmentTypeId !== equipmentTypeId) {
    throw err.unprocessable(`Модель «${row.name}» заведена типом «${row.typeName}»`, {
      modelId: 'Модель другого типа',
    });
  }
  if (!row.isActive) {
    throw err.badRequest(`Модель «${row.name}» погашена`, { modelId: 'Модель погашена' });
  }
}

/**
 * Та же «модель не найдена», но пришедшая гонкой, а не проверкой.
 *
 * `assertModelUsable` отвечает по состоянию, которое видит транзакция, и эту щель закрыть не может:
 * соседняя транзакция держит `FOR UPDATE` на свободной модели и удаляет её; наша проверка модель ещё
 * видит — чужое удаление не закоммичено, — а `BEFORE`-триггер зеркала уже стоит на `FOR KEY SHARE`
 * и после чужого коммита перечитывает пустоту: `RAISE … USING ERRCODE = '23503'` (миграция 0171).
 * Без разбора это 500 `internal_error` с текстом SQL-запроса в теле — на тот самый вопрос, на
 * который проверка выше отвечает 400 словами.
 *
 * Отличается это от НАСТОЯЩЕГО нарушения внешнего ключа именем ограничения, а не текстом сообщения
 * (текст зависит от версии и локали сервера):
 *
 *   `RAISE` из триггера зеркала ..... `23503`, `constraint` пуст;
 *   `office_equipment_model_type_fk`  `23503`, `constraint` назван.
 *
 * Второй случай обязан остаться 500, и это не небрежность: модель чужого типа маршрут отбивает 422
 * сам, до записи, — и если отказ всё-таки дошёл до ключа, значит код разошёлся со схемой. Спрятав
 * его под человеческую формулировку, мы погасили бы единственный сигнал об этом.
 *
 * «`23503` без имени ограничения» читается как «бросил триггер» ровно потому, что такой триггер в
 * этой транзакции один: на `office_equipment` не висит ничего, кроме зеркала 0171, а во всём
 * каталоге миграций `ERRCODE = '23503'` встречается один раз — в нём же. Признак держится на этом,
 * и следующий триггер с тем же кодом обязан получить здесь свой разбор, а не приехать под чужой
 * вывеской: заводя такой, проверьте это место.
 *
 * Через `pgErrorOf`, а не по полям самой ошибки: drizzle оборачивает ошибку драйвера в свою, и на
 * верхнем объекте кода уже нет — прямая проверка молчала бы.
 */
function asMissingModelBadRequest(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23503' && !pg.constraint) {
    return err.badRequest(MODEL_NOT_FOUND, MODEL_NOT_FOUND_FIELDS);
  }
  return e;
}

/**
 * Объект существует. Активность не проверяется намеренно: техника стоит на площадке и после того,
 * как ту закрыли для новых заявок, — карточка должна оставаться заводимой, пока имущество не
 * перевезли.
 */
async function assertObjectExists(tx: Tx, objectId: string): Promise<void> {
  const [row] = await tx
    .select({ id: constructionObjects.id })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, objectId));
  if (!row) throw err.badRequest('Объект не найден', { objectId: 'Не найден' });
}

async function assertDepartmentExists(tx: Tx, departmentId: string): Promise<void> {
  const [row] = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.id, departmentId));
  if (!row) throw err.badRequest('Отдел не найден', { departmentId: 'Не найден' });
}

/**
 * Единицу с незакрытой заявкой на обслуживание не удаляют (ADR 0085 Р33): пока аппарат в сервисе,
 * его карточка — единственное, чем заявка объясняет, что именно чинят. Удалив её, диспетчер получил
 * бы заявку на исчезнувшую технику, а сервис — заявку без предмета.
 *
 * 409, а не мягкое «удалим вместе с заявкой»: заявку заводил другой человек и по другому поводу, и
 * уносить его работу побочным эффектом правки справочника нельзя (тот же довод, что у складов
 * поставщика, ADR 0051).
 */
async function assertNoOpenServiceRequest(equipmentId: string): Promise<void> {
  const [open] = await db
    .select({ num: serviceRequests.num })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.officeEquipmentId, equipmentId),
        isNull(serviceRequests.deletedAt),
        notInArray(serviceRequests.status, ['accepted', 'cancelled']),
      ),
    )
    .limit(1);
  if (open) {
    throw err.conflict(
      `По этой технике есть незакрытая заявка ${formatServiceRequestNumber(open.num)} — сначала закройте её`,
    );
  }
}

/**
 * Единица для ленты: та же проверка архива и области, что у карточки. Отдельной функцией, потому
 * что её задают обе ручки истории — страница и выгрузка, — и разойдись они, файл отдавал бы то,
 * чего человек не видит на экране.
 */
async function requireHistoryEquipment(p: Principal, id: string) {
  const [ex] = await db
    .select({
      id: officeEquipment.id,
      name: officeEquipment.name,
      serialNumber: officeEquipment.serialNumber,
      inventoryNumber: officeEquipment.inventoryNumber,
      warrantyUntil: officeEquipment.warrantyUntil,
      objectId: officeEquipment.objectId,
      ownerDepartmentId: officeEquipment.ownerDepartmentId,
      deletedAt: officeEquipment.deletedAt,
    })
    .from(officeEquipment)
    .where(eq(officeEquipment.id, id));
  if (!ex) throw err.notFound('Единица оргтехники не найдена');
  assertArchiveVisible(p, ex.deletedAt, 'Единица оргтехники не найдена');
  assertOfficeEquipmentScope(p, { objectId: ex.objectId, ownerDepartmentId: ex.ownerDepartmentId });
  return ex;
}

/**
 * Чем заправлять этот аппарат (Р15): расходники, привязанные к его МОДЕЛИ, а не к карточке.
 *
 * Права своего у среза нет — он отдаётся по `officeEquipment.read`, тому же, по которому открыта
 * сама карточка. Отдельное право означало бы, что человек видит аппарат, но не видит, что к нему
 * нужно: «чем заправлять» — часть эксплуатации техники, а не складская тайна, и спрашивают об этом
 * ровно те, кто у этой техники и стоит.
 *
 * С историей обслуживания ниже это не путать: та рассказывает про деньги и работы, поэтому просит
 * `serviceRequests.read` и сужается ОБЛАСТЬЮ ЗАЯВОК. Здесь ни того, ни другого нет — остаток на
 * складе один на компанию (области у справочника расходников нет вовсе), а сумм и исполнителей в
 * срезе не появляется.
 *
 * Карточка без модели отвечает пустым списком, а не отсутствием поля и не отказом: в окне выпуска A
 * ссылка у карточки может быть пуста (Р2), но вопрос «чем заправлять» законен и тогда — просто
 * ответа на него нет.
 *
 * Погашенные позиции (`is_active = false`) не показываются: их больше не покупают, и предлагать их
 * тому, кто пришёл за картриджем, значит звать к пустой полке. У самой карточки расходника они
 * остаются — гашение это «не предлагать новым», а не «стереть» (Р11).
 *
 * Соединением, а не коррелированным подзапросом — и это не вкусовщина: собирая столбцы
 * односоставного запроса, drizzle переписывает колоночные чанки внутри `sql`-выражений в голые
 * идентификаторы, и такой подзапрос молча отвечает пустотой (разобрано у `consumableIdRef` в
 * маршруте расходников). Здесь двухтабличный запрос, живущий отдельно от запроса карточки, — ловушке
 * не за что зацепиться.
 */
async function loadConsumables(modelId: string | null): Promise<OfficeEquipmentConsumableRefDto[]> {
  if (!modelId) return [];
  return (
    db
      .select({
        id: officeEquipmentConsumables.id,
        code: officeEquipmentConsumables.code,
        name: officeEquipmentConsumables.name,
        color: officeEquipmentConsumables.color,
        quantity: officeEquipmentConsumables.quantity,
      })
      .from(officeEquipmentConsumableModels)
      .innerJoin(
        officeEquipmentConsumables,
        eq(officeEquipmentConsumableModels.consumableId, officeEquipmentConsumables.id),
      )
      .where(
        and(
          eq(officeEquipmentConsumableModels.modelId, modelId),
          eq(officeEquipmentConsumables.isActive, true),
        ),
      )
      // По наименованию — им позицию и называют вслух. Код вторым ключом ради устойчивости порядка:
      // у цветной серии наименования совпадают до буквы, и без него две строки менялись бы местами
      // от запроса к запросу.
      .orderBy(officeEquipmentConsumables.name, officeEquipmentConsumables.code)
  );
}

/** Сколько ремонтов показывает карточка: срез, а не журнал — за полным списком идут в раздел. */
const SERVICE_HISTORY_LIMIT = 10;

/**
 * История обслуживания и действующие гарантии ремонтов для карточки единицы (§8.2).
 *
 * Отдаётся только при `serviceRequests.read` и **в области заявок**, а не справочника: у ролей
 * отдела это разные области (справочник — по владельцу техники, заявки — по заказчику заявки, Р5),
 * и показать здесь заявку соседнего отдела значило бы обойти область модуля через справочник.
 *
 * Область исполнителя (`serviceExecutorVisibilityWhere`) не повторяется намеренно: справочник
 * сервисной компании закрыт целиком (Р7), и до этого места её учётка не доходит.
 */
async function loadServiceHistory(
  p: Principal,
  equipmentId: string,
): Promise<OfficeEquipmentServiceEntryDto[]> {
  const rows = await db
    .select({
      id: serviceRequests.id,
      num: serviceRequests.num,
      status: serviceRequests.status,
      createdAt: serviceRequests.createdAt,
      completedAt: serviceRequests.completedAt,
      totalAmount: serviceRequests.finalTotalAmount,
      serviceName: counterparties.name,
    })
    .from(serviceRequests)
    .leftJoin(counterparties, eq(serviceRequests.serviceCounterpartyId, counterparties.id))
    .where(
      and(
        eq(serviceRequests.officeEquipmentId, equipmentId),
        isNull(serviceRequests.deletedAt),
        serviceRequestScopeWhere(
          p,
          serviceRequests.equipmentObjectId,
          serviceRequests.customerDepartmentId,
          serviceRequests.equipmentDepartmentId,
        ),
      ),
    )
    .orderBy(desc(serviceRequests.createdAt))
    .limit(SERVICE_HISTORY_LIMIT);
  if (rows.length === 0) return [];

  // Гарантии одним запросом на все показанные заявки: строка на заявку превратила бы карточку в
  // десять походов в базу ради двух строчек текста. Только выполненные и только действующие —
  // гарантия на невыполненную позицию невозможна (Р12), а истёкшая здесь уже история.
  const warrantyRows = await db
    .select({
      requestId: serviceRequestItems.requestId,
      itemId: serviceRequestItems.id,
      name: serviceRequestItems.name,
      warrantyUntil: serviceRequestItems.warrantyUntil,
    })
    .from(serviceRequestItems)
    .where(
      and(
        inArray(
          serviceRequestItems.requestId,
          rows.map((row) => row.id),
        ),
        eq(serviceRequestItems.performed, true),
        isNotNull(serviceRequestItems.warrantyUntil),
        sql`${serviceRequestItems.warrantyUntil} >= CURRENT_DATE`,
      ),
    )
    .orderBy(serviceRequestItems.sortOrder);

  const byRequest = new Map<string, OfficeEquipmentItemWarrantyDto[]>();
  for (const row of warrantyRows) {
    const list = byRequest.get(row.requestId) ?? [];
    list.push({ itemId: row.itemId, name: row.name, warrantyUntil: row.warrantyUntil! });
    byRequest.set(row.requestId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    displayNumber: formatServiceRequestNumber(row.num),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    serviceName: row.serviceName,
    totalAmount: row.totalAmount === null ? null : Number(row.totalAmount),
    warranties: byRequest.get(row.id) ?? [],
  }));
}

export default async function officeEquipmentRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('officeEquipment.read');
  const canWrite = app.requirePermission('officeEquipment.write');

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: officeEquipmentListQuerySchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      // Отдел и «без владельца» — два ответа на один вопрос, и вместе они означают пустой список.
      // Отказ вместо пустоты: параметры пришли из фильтра, и молча показанный ноль строк человек
      // прочитает как «такой техники нет».
      if (q.unassignedDepartment && q.departmentId) {
        throw err.badRequest('Фильтры «Отдел» и «Без владельца» не сочетаются', {
          departmentId: 'Уберите один из фильтров',
        });
      }
      const where = and(
        // Архив (ADR 0070): вкладка «Архив» просит `only`, обычный список — умолчание `exclude`.
        // Границы области архив не расширяет — они те же, что у живых карточек.
        archiveWhere(p, q.archive, officeEquipment.deletedAt),
        officeEquipmentScopeWhere(p, officeEquipment.objectId, officeEquipment.ownerDepartmentId),
        q.objectId ? eq(officeEquipment.objectId, q.objectId) : undefined,
        q.equipmentTypeId ? eq(officeEquipment.equipmentTypeId, q.equipmentTypeId) : undefined,
        // «Вся техника этой модели» — по ссылке, а не по наименованию: `name` карточки с выпуска A
        // зеркалит модель, и поиск по тексту нашёл бы сегодня то же самое, но разошёлся бы на
        // первом же переименовании. Условие идёт в общий `where`, поэтому строки и счётчик отбирают
        // одно и то же — разъехавшись, они дали бы «показано 20 из 68» на списке из двадцати.
        q.modelId ? eq(officeEquipment.modelId, q.modelId) : undefined,
        q.departmentId ? eq(officeEquipment.ownerDepartmentId, q.departmentId) : undefined,
        // Срез для разметки парка: что ещё ни за кем не числится.
        q.unassignedDepartment ? isNull(officeEquipment.ownerDepartmentId) : undefined,
        warrantyCondition(q.warranty),
        q.state ? eq(officeEquipment.state, q.state) : undefined,
        // «В ремонте, а заявок нет» (Р61): портал не знает, вернули ли аппарат, — он знает лишь
        // то, что ему сказали. Поэтому срез, а не запрет: строку показывают, чтобы спросили.
        q.strandedAtService
          ? and(
              eq(officeEquipment.state, 'at_service'),
              sql`NOT EXISTS (
                SELECT 1 FROM service_requests sr
                 WHERE sr.office_equipment_id = ${officeEquipment.id}
                   AND sr.deleted_at IS NULL
                   AND sr.status NOT IN ('accepted','cancelled'))`,
            )
          : undefined,
        q.isActive === undefined ? undefined : eq(officeEquipment.isActive, q.isActive),
        // Ищут единицу и по модели, и по любому из номеров, и по месту: как её называют в
        // разговоре, зависит от того, кто спрашивает — бухгалтерия по инвентарному, сервис по
        // серийному, а «принтер в 214-м» вообще по кабинету.
        searchCondition(q.search, [
          officeEquipment.name,
          officeEquipment.serialNumber,
          officeEquipment.inventoryNumber,
          officeEquipment.location,
        ]),
      );
      const sortCols = {
        name: officeEquipment.name,
        type: officeEquipmentTypes.name,
        object: constructionObjects.name,
        inventoryNumber: officeEquipment.inventoryNumber,
        serialNumber: officeEquipment.serialNumber,
        warrantyUntil: officeEquipment.warrantyUntil,
        isActive: officeEquipment.isActive,
        createdAt: officeEquipment.createdAt,
      };
      const p2 = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        baseQuery()
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
          .limit(p2.limit)
          .offset(p2.offset),
        db
          .select({ c: count() })
          .from(officeEquipment)
          .innerJoin(
            officeEquipmentTypes,
            eq(officeEquipment.equipmentTypeId, officeEquipmentTypes.id),
          )
          .innerJoin(constructionObjects, eq(officeEquipment.objectId, constructionObjects.id))
          .leftJoin(departments, eq(officeEquipment.ownerDepartmentId, departments.id))
          .where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p2.page,
        pageSize: p2.pageSize,
      };
    },
  );

  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const dto = await getDto(req.params.id);
      if (!dto) throw err.notFound('Единица оргтехники не найдена');
      // Карточка получает строку по id, минуя условия списка, поэтому оба ограничения выдачи
      // повторяются здесь: архив — 404 (о существовании удалённой карточки знать не нужно),
      // чужая область — 403.
      assertArchiveVisible(p, dto.deletedAt, 'Единица оргтехники не найдена');
      assertOfficeEquipmentScope(p, {
        objectId: dto.object.id,
        ownerDepartmentId: dto.department?.id ?? null,
      });
      // Расходники — тем же правом, что и сама карточка: см. `loadConsumables`. Поле есть в ответе
      // всегда, в том числе пустым списком у карточки без модели.
      const card = { ...dto, consumables: await loadConsumables(dto.model?.id ?? null) };
      // Секция обслуживания — по праву модуля, а не справочника (§8.2): менеджер и диспетчер ведут
      // карточки техники, но ремонтом не занимаются, и заявки с суммами им знать незачем. Поля
      // просто нет в ответе — пустой список означал бы «ремонтов не было».
      if (!can(p, 'serviceRequests.read')) return card;
      return { ...card, serviceHistory: await loadServiceHistory(p, dto.id) };
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createOfficeEquipmentSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const b = req.body;
      const created = await db
        .transaction(async (tx) => {
          await assertTypeUsable(tx, b.equipmentTypeId);
          // Модель сверяется, только если её прислали ссылкой. Старый клиент в окне выката шлёт одно
          // имя, и по нему модель найдёт или заведёт триггер (Р3) — это и есть совместимость
          // выпуска A, а не забытая проверка.
          if (b.modelId) await assertModelUsable(tx, b.modelId, b.equipmentTypeId);
          await assertObjectExists(tx, b.objectId);
          if (b.departmentId) await assertDepartmentExists(tx, b.departmentId);
          // Область — по месту, куда единицу заводят: без этой проверки роль со своим объектом
          // ставила бы технику на чужой.
          assertOfficeEquipmentScope(p, {
            objectId: b.objectId,
            ownerDepartmentId: b.departmentId ?? null,
          });
          await assertNumbersFree(tx, b);
          const [row] = await tx
            .insert(officeEquipment)
            .values({
              equipmentTypeId: b.equipmentTypeId,
              // Ссылка на модель — то, что шлёт новая форма. Пустой она остаётся только у старого
              // клиента: `BEFORE INSERT` проставит её сам, разобрав имя (Р3).
              modelId: b.modelId ?? null,
              // Пустое имя законно, когда пришла ссылка на модель: `BEFORE INSERT` перепишет его из
              // модели раньше, чем сработает `office_equipment_name_not_blank_check` (Р3). Старый
              // клиент по-прежнему шлёт имя и ссылки не знает — обе двери открыты до выпуска B.
              name: b.name ?? '',
              serialNumber: b.serialNumber,
              inventoryNumber: b.inventoryNumber,
              objectId: b.objectId,
              ownerDepartmentId: b.departmentId ?? null,
              location: b.location,
              purchasedOn: b.purchasedOn ?? null,
              warrantyUntil: b.warrantyUntil ?? null,
              comment: b.comment,
              isActive: b.isActive,
              createdBy: p.id,
              updatedBy: p.id,
            })
            .returning({
              id: officeEquipment.id,
              name: officeEquipment.name,
              modelId: officeEquipment.modelId,
            });
          return row!;
        })
        // Гонка с удалением модели приходит сюда отказом триггера зеркала — и уходит тем же 400,
        // что и ссылка в никуда: дверь другая, ответ обязан быть один.
        .catch((e: unknown) => {
          throw asMissingModelBadRequest(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipment.create',
        entityType: 'officeEquipment',
        entityId: created.id,
        metadata: {
          // Имя и ссылка — те, что легли в базу, а не те, что пришли в запросе: при заведении по
          // модели `name` в теле может отсутствовать вовсе (его пишет зеркало, Р3), и `undefined`
          // в журнале означал бы карточку без названия там, где название есть.
          name: created.name,
          modelId: created.modelId,
          serialNumber: b.serialNumber,
          inventoryNumber: b.inventoryNumber,
          objectId: b.objectId,
        },
      });
      reply.code(201);
      return (await getDto(created.id))!;
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateOfficeEquipmentSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      // Карточка «до» — снимком DTO, а не сырыми колонками: в историю идут названия справочников и
      // человеческие значения, а не идентификаторы (тот же приём, что у диффа заявок).
      const before = await getDto(id);
      await db
        .transaction(async (tx) => {
          const [ex] = await tx
            .select()
            .from(officeEquipment)
            .where(and(eq(officeEquipment.id, id), isNull(officeEquipment.deletedAt)));
          if (!ex) throw err.notFound('Единица оргтехники не найдена');
          // Область проверяется по обеим сторонам (Р7): сначала по нынешнему месту единицы — чужую
          // карточку не правят и не переносят, — а ниже по целевому: перенос на чужой объект это тот
          // же выход за область, только наружу.
          assertOfficeEquipmentScope(p, {
            objectId: ex.objectId,
            ownerDepartmentId: ex.ownerDepartmentId,
          });

          // PATCH присылает только изменившееся, поэтому все проверки идут по «склеенному»
          // состоянию: половина условий (оба номера пусты, чужой целевой отдел) видна лишь на нём.
          const equipmentTypeId = b.equipmentTypeId ?? ex.equipmentTypeId;
          // Объект правкой не меняется (Р59): переезд — своя ручка с датой, причиной и журналом.
          const objectId = ex.objectId;
          const ownerDepartmentId =
            b.departmentId !== undefined ? (b.departmentId ?? null) : ex.ownerDepartmentId;
          const serialNumber = b.serialNumber ?? ex.serialNumber;
          const inventoryNumber = b.inventoryNumber ?? ex.inventoryNumber;

          if (equipmentTypeId !== ex.equipmentTypeId) await assertTypeUsable(tx, equipmentTypeId);
          // Сменить тип, не назвав, чем карточку именовать, нельзя (Р1). Тип у модели неизменяем, и
          // такой запрос уходит в legacy-ветку триггера: та резолвит карточку по её нынешнему имени и
          // ЗАВОДИТ в справочнике новую модель нового типа. Справочник, который пополняется правкой
          // чужой карточки, — ровно то, ради чего модель и уводили из свободного текста: ИТ-служба
          // должна видеть перечень, который ведёт сама.
          //
          // Отбивает это маршрут, а не триггер, и это не вкусовщина: триггер обязан оставаться
          // терпимым — через него в окне выпуска A идёт старый код, не знающий о моделях вовсе, — а
          // маршрут видит, кто к нему пришёл, и вправе требовать явного выбора.
          //
          // Присланное имя запрет снимает: `{ equipmentTypeId, name }` — это и есть старый клиент
          // (и заливка файлом до перевода на модели), у него резолв по имени законен и является
          // единственным доступным способом сказать «эта карточка теперь вот такая». Ловим ровно
          // случай «тип меняют, а чем именовать — не сказали». Запрет уходит вместе с legacy-веткой в
          // выпуске C: резолвить будет нечего, и смена типа без модели станет отказом самой базы.
          if (
            equipmentTypeId !== ex.equipmentTypeId &&
            b.modelId === undefined &&
            b.name === undefined
          ) {
            throw err.unprocessable(
              'Смена типа требует выбрать модель нужного типа: у моделей тип неизменяем',
              { modelId: 'Выберите модель нового типа' },
            );
          }
          // Модель сверяется с типом, который получится ПОСЛЕ правки, и перепроверяется даже тогда,
          // когда ссылку прислали прежнюю: смена одного типа у карточки с моделью — это уже другая
          // пара. Оставить её базе нельзя дважды: составной ключ ответил бы именем ограничения, а до
          // него добралась бы legacy-ветка триггера и увела карточку на модель нового типа, найденную
          // по имени, — то есть не на ту, которую в запросе назвали ссылкой (Р3).
          //
          // Правка, ссылку не трогающая, сюда не заходит: у карточки может стоять погашенная модель,
          // и запрещать из-за неё смену кабинета было бы наказанием за чужое решение (Р11).
          if (
            b.modelId !== undefined &&
            (b.modelId !== ex.modelId || equipmentTypeId !== ex.equipmentTypeId)
          ) {
            await assertModelUsable(tx, b.modelId, equipmentTypeId);
          }
          if (ownerDepartmentId && ownerDepartmentId !== ex.ownerDepartmentId) {
            await assertDepartmentExists(tx, ownerDepartmentId);
          }
          if (ownerDepartmentId !== ex.ownerDepartmentId) {
            assertOfficeEquipmentScope(p, { objectId, ownerDepartmentId });
          }

          // Хотя бы один номер обязан остаться — это же держит CHECK в БД, но отказ ограничения
          // человеку ничего не объясняет. 422: запрос понятен, недопустимо получившееся состояние.
          if (!serialNumber.trim() && !inventoryNumber.trim()) {
            throw err.unprocessable('Укажите серийный или инвентарный номер', {
              inventoryNumber: 'Нужен хотя бы один номер',
            });
          }
          // Перепроверяем только изменившийся номер: неизменившийся занят самой этой карточкой, и
          // спрашивать про него означало бы искать конфликт с собой.
          const serialChanged = serialNumber !== ex.serialNumber;
          const inventoryChanged = inventoryNumber !== ex.inventoryNumber;
          if (serialChanged || inventoryChanged) {
            await assertNumbersFree(
              tx,
              {
                serialNumber: serialChanged ? serialNumber : '',
                inventoryNumber: inventoryChanged ? inventoryNumber : '',
              },
              id,
            );
          }

          const set: Partial<typeof officeEquipment.$inferInsert> = {
            updatedBy: p.id,
            updatedAt: new Date(),
          };
          if (b.equipmentTypeId !== undefined) set.equipmentTypeId = b.equipmentTypeId;
          if (b.modelId !== undefined) set.modelId = b.modelId;
          // Имя пишется, только когда ссылки в запросе нет. С выпуска A `name` — копия модели (Р3), и
          // у запроса, назвавшего модель ссылкой, оно ничего не решает; записав оба поля разом, мы
          // отдали бы выбор state-машине триггера, а та при неизменившейся ссылке считает главным
          // имя — и увела бы карточку на модель, найденную по тексту, вместо выбранной. Старый
          // клиент, шлющий одно имя, идёт этой веткой по-прежнему: он и есть её адресат.
          if (b.name !== undefined && b.modelId === undefined) set.name = b.name;
          if (b.serialNumber !== undefined) set.serialNumber = b.serialNumber;
          if (b.inventoryNumber !== undefined) set.inventoryNumber = b.inventoryNumber;
          if (b.departmentId !== undefined) set.ownerDepartmentId = b.departmentId ?? null;
          if (b.location !== undefined) set.location = b.location;
          if (b.purchasedOn !== undefined) set.purchasedOn = b.purchasedOn ?? null;
          if (b.warrantyUntil !== undefined) set.warrantyUntil = b.warrantyUntil ?? null;
          if (b.comment !== undefined) set.comment = b.comment;
          if (b.isActive !== undefined) set.isActive = b.isActive;
          await tx.update(officeEquipment).set(set).where(eq(officeEquipment.id, id));
        })
        // Смена модели правкой открывает ту же щель, что и заведение: проверка видит модель, а
        // зеркало — уже нет. Разбор поэтому стоит на обеих дверях, а не только на заведении.
        .catch((e: unknown) => {
          throw asMissingModelBadRequest(e);
        });
      const after = (await getDto(id))!;
      /**
       * Что именно изменила правка — снимком в метаданных (Р76). Без него лента показывала бы
       * «карточку правили» без ответа, что стало с моделью, номерами и владельцем, а «письма
       * перестали приходить»-подобные разборы упирались бы в память людей.
       *
       * Срок гарантии идёт отдельным полем: его изменение рисуется событием гарантии, и в общем
       * списке правок дало бы вторую строку про то же самое.
       */
      const diff = before ? officeEquipmentDiff(before, after) : { changes: [] };
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipment.update',
        entityType: 'officeEquipment',
        entityId: id,
        metadata: { ...diff },
      });
      return after;
    },
  );

  /**
   * Удаление мягкое (Р33): карточка уходит в архив, а не из базы. Заявки на обслуживание будут
   * ссылаться на единицу внешним ключом, и снесённая строка оставила бы их без предмета — снести
   * насовсем можно только вторым шагом, из архива (`registerPurgeRoute` ниже).
   *
   * Проверки открытых заявок здесь пока нет — самого модуля заявок ещё нет. С его появлением она
   * встанет ровно сюда: незакрытая заявка на удаляемую единицу — 409, как у остальных справочников
   * с живыми ссылками.
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const [ex] = await db
        .select()
        .from(officeEquipment)
        .where(and(eq(officeEquipment.id, id), isNull(officeEquipment.deletedAt)));
      if (!ex) throw err.notFound('Единица оргтехники не найдена');
      assertOfficeEquipmentScope(p, {
        objectId: ex.objectId,
        ownerDepartmentId: ex.ownerDepartmentId,
      });
      await assertNoOpenServiceRequest(id);
      const now = new Date();
      await db
        .update(officeEquipment)
        .set({ deletedAt: now, deletedBy: p.id, updatedAt: now })
        .where(and(eq(officeEquipment.id, id), isNull(officeEquipment.deletedAt)));
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipment.delete',
        entityType: 'officeEquipment',
        entityId: id,
        // Чем единицу называли: по этим реквизитам её узнают в журнале, когда карточки уже нет
        // в списках, а номера успели уйти новой технике.
        metadata: {
          name: ex.name,
          serialNumber: ex.serialNumber,
          inventoryNumber: ex.inventoryNumber,
        },
      });
      return { ok: true };
    },
  );

  // ── Перемещение единицы (Р59–Р63) ──
  /**
   * Переезд — событие, а не поле карточки. До этой ручки объект менялся тихой правкой: техника
   * оказывалась на другой площадке без даты, причины и следа, и вопрос «где этот аппарат стоял в
   * мае» отвечался только по заявкам, если они были.
   *
   * **Область проверяется по исходной стороне, а целевой объект — любой активный (Р60).** Прежнее
   * правило «обе стороны в области» делало штатный перенос между площадками невозможным именно
   * для того, кто технику отдаёт: у штаба своя площадка одна. Перемещение — утрата, а не захват:
   * отдающий ничего не получает на чужой площадке, он теряет единицу из своего списка. Кто отдал —
   * видно в журнале и в аудите.
   *
   * Открытая заявка переезду не мешает (Р63): именно при ремонте технику и возят. Заявка хранит
   * снимок объекта и остаётся у своего заказчика — иначе она уехала бы из его области вместе с
   * аппаратом.
   */
  r.post(
    '/:id/move',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: moveOfficeEquipmentSchema },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;

      const movement = await db.transaction(async (tx) => {
        const [ex] = await tx
          .select()
          .from(officeEquipment)
          .where(and(eq(officeEquipment.id, id), isNull(officeEquipment.deletedAt)));
        if (!ex) throw err.notFound('Единица оргтехники не найдена');
        // Только исходная сторона: см. Р60 выше.
        assertOfficeEquipmentScope(p, {
          objectId: ex.objectId,
          ownerDepartmentId: ex.ownerDepartmentId,
        });

        const toDepartmentId =
          b.departmentId !== undefined ? (b.departmentId ?? null) : ex.ownerDepartmentId;
        if (b.objectId !== ex.objectId) await assertObjectExists(tx, b.objectId);
        if (toDepartmentId && toDepartmentId !== ex.ownerDepartmentId) {
          await assertDepartmentExists(tx, toDepartmentId);
        }

        const unchanged =
          b.objectId === ex.objectId &&
          b.state === ex.state &&
          b.location === ex.location &&
          toDepartmentId === ex.ownerDepartmentId;
        // Перемещение, которое ничего не переместило, — запись ни о чём (то же держит CHECK).
        if (unchanged) {
          throw err.unprocessable('Ничего не изменилось: перемещение записывать нечего');
        }

        if (b.serviceRequestId) {
          // Ссылка на заявку принимается только по этой же единице: «увезли в сервис» относится к
          // конкретному ремонту, и чужой номер сделал бы журнал бесполезным.
          const [request] = await tx
            .select({ id: serviceRequests.id })
            .from(serviceRequests)
            .where(
              and(
                eq(serviceRequests.id, b.serviceRequestId),
                eq(serviceRequests.officeEquipmentId, id),
              ),
            );
          if (!request) {
            throw err.badRequest('Заявка не найдена или заведена не на эту технику', {
              serviceRequestId: 'Чужая заявка',
            });
          }
        }

        const now = new Date();
        const [row] = await tx
          .insert(officeEquipmentMovements)
          .values({
            equipmentId: id,
            fromObjectId: ex.objectId,
            toObjectId: b.objectId,
            fromDepartmentId: ex.ownerDepartmentId,
            toDepartmentId,
            fromLocation: ex.location,
            toLocation: b.location,
            fromState: ex.state,
            toState: b.state,
            movedOn: b.movedOn,
            reason: b.reason,
            comment: b.comment,
            serviceRequestId: b.serviceRequestId ?? null,
            movedBy: p.id,
          })
          .returning({ id: officeEquipmentMovements.id });

        await tx
          .update(officeEquipment)
          .set({
            objectId: b.objectId,
            ownerDepartmentId: toDepartmentId,
            location: b.location,
            state: b.state,
            stateNote: b.stateNote,
            updatedBy: p.id,
            updatedAt: now,
          })
          .where(eq(officeEquipment.id, id));

        return { id: row!.id, from: ex.objectId, to: b.objectId };
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipment.move',
        entityType: 'officeEquipment',
        entityId: id,
        metadata: {
          movementId: movement.id,
          fromObjectId: movement.from,
          toObjectId: movement.to,
          state: b.state,
          movedOn: b.movedOn,
          reason: b.reason,
        },
      });
      reply.code(201);
      return (await getDto(id))!;
    },
  );

  /**
   * История единицы одной лентой (Р62, Р75–Р79): шесть источников одним потоком с курсором.
   *
   * Раньше ответ был двумя массивами — перемещения и заявки, — и портал сшивал их сам. Событий с
   * тех пор стало шесть, у половины нет времени (перемещение датировано днём, истечение гарантии
   * тоже), и порядок, посчитанный на клиенте, разошёлся бы с порядком страницы. Теперь порядок,
   * курсор и область живут на сервере, а контракты дают обеим сторонам одно правило сравнения.
   */
  r.get(
    '/:id/history',
    {
      preHandler: [app.authenticate, canRead],
      schema: { params: idParams, querystring: equipmentHistoryQuerySchema },
    },
    async (req): Promise<EquipmentHistoryPageDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const equipment = await requireHistoryEquipment(p, id);

      // Кривой или чужой курсор — отказ словами, а не 500 и не молчаливая первая страница: человек
      // должен понять, что ссылка устарела, а не решить, что история опустела.
      const cursor = req.query.cursor ? decodeEquipmentHistoryCursor(req.query.cursor) : null;
      if (req.query.cursor && !cursor) {
        throw err.unprocessable('Ссылка на продолжение истории не читается — откройте её заново', {
          cursor: 'Некорректный курсор',
        });
      }

      return loadEquipmentHistoryPage(p, equipment, { cursor, pageSize: req.query.pageSize });
    },
  );

  /**
   * Выгрузка истории единицы (Р80): та же лента и та же область, но целиком и файлом.
   *
   * Страницами отчёт не собирают: инвентаризация и спор с подрядчиком требуют всей истории разом.
   * Потолок при этом есть, и упёршись в него, файл говорит об этом последней строкой — молча
   * обрезанный отчёт выглядит полным.
   */
  r.get(
    '/:id/history.xlsx',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const equipment = await requireHistoryEquipment(p, id);

      const { items, truncated } = await loadEquipmentHistoryAll(
        p,
        equipment,
        EQUIPMENT_HISTORY_EXPORT_LIMIT,
      );
      const workbook = equipmentHistoryWorkbook(equipment, items, truncated);

      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipment.historyExport',
        entityType: 'officeEquipment',
        entityId: id,
        metadata: { rows: items.length, truncated },
      });

      const filename = `history-${equipment.inventoryNumber || equipment.serialNumber || id}.xlsx`;
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
        .send(Buffer.from(workbook));
    },
  );

  /**
   * Восстановление из архива — работа с архивом (ADR 0021), а не обычная правка справочника:
   * удаление могло быть осознанным решением, и отменяет его администратор.
   *
   * Идемпотентно: живая карточка просто отдаётся. Повтор запроса — обычное дело при потерянном
   * ответе, и отказывать на нём значит требовать от человека знать, дошёл ли предыдущий.
   */
  r.post(
    '/:id/restore',
    {
      preHandler: [app.authenticate, app.requirePermission('archive.restore')],
      schema: { params: idParams },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const restored = await db.transaction(async (tx) => {
        const [ex] = await tx.select().from(officeEquipment).where(eq(officeEquipment.id, id));
        if (!ex) throw err.notFound('Единица оргтехники не найдена');
        // Область у восстановления та же, что у остальных действий: право `archive.restore` сейчас
        // есть только у администратора, но право и область выдаются по отдельности.
        //
        // До разбора состояния, а не внутри ветки возврата: живая карточка отдаётся отсюда целиком
        // (повтор запроса — обычное дело), и проверка после `if (!ex.deletedAt)` не мешала бы читать
        // чужую единицу в обход `officeEquipment.read`.
        assertOfficeEquipmentScope(p, {
          objectId: ex.objectId,
          ownerDepartmentId: ex.ownerDepartmentId,
        });
        if (!ex.deletedAt) return false;
        // Пока карточка лежала в архиве, её номера могли уйти новой технике: уникальность считается
        // только среди живых, и вернуть единицу молча означало бы завести второй «инв. 0012345».
        await assertNumbersFree(
          tx,
          { serialNumber: ex.serialNumber, inventoryNumber: ex.inventoryNumber },
          id,
        );
        await tx
          .update(officeEquipment)
          .set({ deletedAt: null, deletedBy: null, updatedBy: p.id, updatedAt: new Date() })
          .where(eq(officeEquipment.id, id));
        return true;
      });
      // Журнал пишется после транзакции и только на состоявшемся возврате: на повторе восстанавливать
      // было нечего, и событие в журнале означало бы действие, которого не было.
      if (restored) {
        await writeAudit({
          actorUserId: p.id,
          action: 'officeEquipment.restore',
          entityType: 'officeEquipment',
          entityId: id,
        });
      }
      return (await getDto(id))!;
    },
  );

  // Удаление насовсем (ADR 0060) — только из архива, вторым шагом после обычного удаления. Заявки
  // на обслуживание, когда появятся, будут держать единицу внешним ключом: снести ту, по которой
  // уже вызывали сервис, нельзя — иначе заявка потеряет свой предмет.
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(officeEquipment).where(eq(officeEquipment.id, id));
      return row;
    },
    isDown: (row) => !!row.deletedAt,
    remove: async (tx, row) => {
      await tx.delete(officeEquipment).where(eq(officeEquipment.id, row.id));
    },
    notFound: 'Единица оргтехники не найдена',
    stillLive: 'Единица оргтехники не в архиве — сначала удалите её',
    subject: 'единицу оргтехники',
    audit: {
      action: 'officeEquipment.purge',
      entityType: 'officeEquipment',
      metadata: (row) => ({
        name: row.name,
        serialNumber: row.serialNumber,
        inventoryNumber: row.inventoryNumber,
        objectId: row.objectId,
      }),
    },
  });
}
