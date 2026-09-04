import { and, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { officeEquipmentTitle, type CreateOfficeEquipmentInput } from '@technic/contracts';
// Только типом: сам клиент модулю не нужен — обе двери зовут помощник уже изнутри своей
// транзакции и передают её сюда аргументом.
import type { db } from '../db/client';
import {
  constructionObjects,
  departments,
  officeEquipment,
  officeEquipmentModels,
  officeEquipmentTypes,
} from '../db/schema';
import type { Principal } from '../auth/principal';
import { assertOfficeEquipmentScope } from '../lib/access';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';

/**
 * ОДНА ТОЧКА ВСТАВКИ КАРТОЧКИ ПАРКА НА ДВА ВХОДА (план
 * `docs/office-equipment-candidate-plan.md`, Р14).
 *
 * До этого файла вставка жила инлайном в `POST /office-equipment` — и жила бы там дальше, если бы
 * вход остался один. Но подтверждение кандидата (Р13) заканчивается ровно тем же действием: в парке
 * появляется карточка, с теми же проверками типа, модели, номеров и области. Копия этих проверок
 * во второй ручке разошлась бы с оригиналом на первой же новой проверке — и разошлась бы МОЛЧА,
 * потому что тесты справочника про вторую дверь ничего не знают, а тесты кандидата про первую.
 * Цена такого расхождения названа в плане: справочник, у которого две двери с разными правилами,
 * перестаёт быть справочником.
 *
 * ЧТО СЮДА ПЕРЕЕХАЛО: проверки типа, модели, объекта, отдела и номеров, разбор гонки с удалением
 * модели, проверка области заведения и сама вставка вместе со сборкой метаданных аудита.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ — ЗАПИСИ АУДИТА, и это оговорено Р14 отдельной строкой. У двух входов
 * разная СЕМАНТИКА журнала: обычное заведение пишет `writeAudit` ПОСЛЕ транзакции (потерянная
 * запись не должна ронять заведённую карточку — сегодняшнее поведение, которое менять никто не
 * просил), а решение по кандидату пишет две строки строгим `writeAuditTx` ВНУТРИ своей транзакции:
 * там журнал — часть решения, и карточка без записи «откуда она взялась» хуже, чем незаведённая
 * карточка. Помощник, взявший аудит на себя, обязан был бы выбрать одну из двух семантик за оба
 * входа — то есть сломать один из них. Поэтому он возвращает готовые метаданные, а пишет их
 * вызывающий, своим способом.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Кто выполняет проверку справочников: транзакция вставки карточки — либо обычное соединение.
 *
 * Второй случай завела правка сообщения о технике (план кандидатов, Р12): её единственная запись
 * условная и атомарна сама по себе, транзакции ей не нужно, а проверить те же две ссылки она
 * обязана теми же помощниками (Р14) — иначе у двух дверей в один справочник разошлись бы ответы
 * на «типа нет» и «объекта нет». Тип, а не второй экземпляр помощников: копия проверок разошлась
 * бы с оригиналом на первой же новой.
 */
type Reader = Tx | typeof db;

/** Сравнение номеров — как в уникальных индексах: без регистра и без крайних пробелов. */
const sameNumber = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Номера уникальны среди живых карточек (Р32 ADR 0085): по ним технику опознают при приёмке из
 * ремонта, и два «инв. 0012345» в справочнике означают, что опознать её нечем. Проверяем до записи,
 * хотя частичные уникальные индексы держат то же самое: нарушение индекса стало бы 500, а человеку
 * нужно знать, какой именно номер занят и кем.
 *
 * Пустой номер не сравнивается: он разрешён, пока заполнен второй, и «пусто = пусто» запретило бы
 * заводить технику вовсе.
 */
export async function assertNumbersFree(
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
export async function assertTypeUsable(tx: Reader, typeId: string): Promise<void> {
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
 * Один текст на обе двери отказа «модели нет» — проверку ниже и гонку (`asMissingModelBadRequest`):
 * человеку всё равно, которая сработала, а разойдясь, две формулировки означали бы разные причины.
 */
const MODEL_NOT_FOUND = 'Модель аппарата не найдена';
const MODEL_NOT_FOUND_FIELDS = { modelId: 'Не найдена' };

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
export async function assertModelUsable(
  tx: Tx,
  modelId: string,
  equipmentTypeId: string,
): Promise<void> {
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
 *
 * ЗОВЁТ ЕГО ВЫЗЫВАЮЩИЙ, А НЕ САМ ПОМОЩНИК, и это осознанно: щель закрывается снаружи уже прерванной
 * транзакции — там, где она и разбирается сегодня, — а вставка кандидатом идёт внутри чужой
 * транзакции, у которой снаружи стоит своя обёртка. Один разбор на обе двери здесь достигается
 * общим кодом отказа, а не общим местом перехвата.
 */
export function asMissingModelBadRequest(e: unknown): unknown {
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
export async function assertObjectExists(tx: Reader, objectId: string): Promise<void> {
  const [row] = await tx
    .select({ id: constructionObjects.id })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, objectId));
  if (!row) throw err.badRequest('Объект не найден', { objectId: 'Не найден' });
}

export async function assertDepartmentExists(tx: Tx, departmentId: string): Promise<void> {
  const [row] = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.id, departmentId));
  if (!row) throw err.badRequest('Отдел не найден', { departmentId: 'Не найден' });
}

/**
 * Заведённая карточка и метаданные её аудита.
 *
 * Имя и ссылка — те, что ЛЕГЛИ В БАЗУ, а не те, что пришли в запросе: при заведении по модели
 * `name` в теле может отсутствовать вовсе (его пишет триггер зеркала, Р3), и `undefined` в журнале
 * означал бы карточку без названия там, где название есть.
 */
export interface InsertedEquipmentCard {
  id: string;
  name: string;
  modelId: string | null;
  /** Готовый `metadata` для журнала — пишет его вызывающий, своим способом (см. шапку файла). */
  auditMetadata: Record<string, unknown>;
}

/**
 * Завести карточку парка: проверки и вставка, общие для обеих дверей (Р14).
 *
 * Порядок проверок сохранён ровно тот, что был у `POST /office-equipment`, и это не косметика: он
 * определяет, ЧТО именно человек услышит, прислав сразу две ошибки. Сначала справочники по одной
 * ссылке (тип, модель, объект, отдел) — отказ называет конкретное поле формы; потом область — «на
 * чужой объект технику не ставят», и это ответ про право, а не про поле; и только потом номера,
 * самый дорогой запрос из четырёх и единственный, который ищет по всему парку.
 *
 * Область проверяется ПО МЕСТУ, КУДА ЕДИНИЦУ ЗАВОДЯТ: без этого роль со своим объектом ставила бы
 * технику на чужой. Для второй двери это же условие означает, что проверяющий заводит карточку
 * только в своей области, — область кандидата за него ничего не решает.
 */
export async function insertEquipmentCard(
  tx: Tx,
  p: Principal,
  b: CreateOfficeEquipmentInput,
): Promise<InsertedEquipmentCard> {
  await assertTypeUsable(tx, b.equipmentTypeId);
  // Модель сверяется, только если её прислали ссылкой. Старый клиент в окне выката шлёт одно имя, и
  // по нему модель найдёт или заведёт триггер (Р3) — это и есть совместимость выпуска A, а не
  // забытая проверка.
  if (b.modelId) await assertModelUsable(tx, b.modelId, b.equipmentTypeId);
  await assertObjectExists(tx, b.objectId);
  if (b.departmentId) await assertDepartmentExists(tx, b.departmentId);
  assertOfficeEquipmentScope(p, {
    objectId: b.objectId,
    ownerDepartmentId: b.departmentId ?? null,
  });
  await assertNumbersFree(tx, b);
  const [row] = await tx
    .insert(officeEquipment)
    .values({
      equipmentTypeId: b.equipmentTypeId,
      // Ссылка на модель — то, что шлёт новая форма. Пустой она остаётся только у старого клиента:
      // `BEFORE INSERT` проставит её сам, разобрав имя (Р3).
      modelId: b.modelId ?? null,
      // Пустое имя законно, когда пришла ссылка на модель: `BEFORE INSERT` перепишет его из модели
      // раньше, чем сработает `office_equipment_name_not_blank_check` (Р3). Старый клиент
      // по-прежнему шлёт имя и ссылки не знает — обе двери открыты до выпуска B.
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
  const created = row!;
  return {
    ...created,
    auditMetadata: {
      name: created.name,
      modelId: created.modelId,
      serialNumber: b.serialNumber,
      inventoryNumber: b.inventoryNumber,
      objectId: b.objectId,
    },
  };
}
