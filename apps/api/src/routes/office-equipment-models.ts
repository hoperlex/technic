import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, ne, not, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  createOfficeEquipmentModelSchema,
  officeEquipmentModelListQuerySchema,
  type OfficeEquipmentModelDto,
  updateOfficeEquipmentModelSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  officeEquipment,
  officeEquipmentConsumableModels,
  officeEquipmentModels,
  officeEquipmentTypes,
} from '../db/schema';
import type { Principal } from '../auth/principal';
import { requirePrincipal } from '../auth/plugin';
import { officeEquipmentScopeWhere } from '../lib/access';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

/**
 * Справочник моделей аппаратов оргтехники (план `docs/office-equipment-consumables-plan.md`, Р1;
 * миграция `0171`, выпуск A). Модель — это то, к чему подходит картридж: «Тонер Ricoh 201» одинаково
 * годится всем карточкам Ricoh Aficio MP 201SPF и любой следующей, которую заведут завтра. Ведётся
 * окном из вкладки «Оргтехника» (Р8), как перечень типов, — отдельной вкладки ради справочника, из
 * которого выбирают, не заводится.
 *
 * Права — справочника оргтехники (Р10): `officeEquipment.read` на чтение, `officeEquipment.write`
 * на запись. Своей пары не заводится: расходники и технику ведёт один и тот же человек, а отдельное
 * право означало бы, что модель заводит один, а привязывает к ней аппараты другой.
 *
 * **Области у самого справочника нет.** Модель существует независимо от парка: картридж лежит на
 * складе и для аппарата, которого в портале нет вовсе, и сузить перечень площадкой значило бы
 * спрятать от человека строку, которую он сам же и завёл. Область живёт ровно в одном месте — в
 * счётчике `equipmentCount` (Р12), и там она обязательна.
 *
 * **Написание имени нормализует БАЗА.** На таблице стоит
 * `office_equipment_models_name_normalized_check (name = office_equipment_model_name_normalize(name))`,
 * а уникальность считается по `office_equipment_model_key(name)` (миграция 0171). Обе функции
 * зовутся отсюда как есть: вторая копия правила на TypeScript разошлась бы с первой — и
 * «Ricoh␣␣IM 350» из формы либо упёрлось бы в CHECK пятисоткой, либо уехало бы зеркалом во все
 * карточки модели, то есть ровно тем разнописанием, ради которого справочник и заведён.
 */

const idParams = z.object({ id: z.string().uuid() });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const NOT_FOUND = 'Модель оргтехники не найдена';
/**
 * Один текст и одна пометка поля на обе двери отказа — проверку до вставки и разбор `23505` из
 * гонки. Человеку всё равно, какая из них сработала: он видит одно и то же положение дел, и в форме
 * подсвечивается то же самое поле.
 *
 * Пометка обязательна, а не «приятна»: без пути поля портал показывает 409 тостом поверх формы
 * (ADR 0094), то есть мимо того единственного поля, которое человеку и надо исправить.
 */
const NAME_TAKEN = 'Модель с таким наименованием уже заведена';
const NAME_TAKEN_FIELDS = { name: 'Такая модель уже заведена' };

/**
 * Как модель ПИШЕТСЯ — функцией базы, а не выражением на месте: края обрезаны, череда пробельных
 * символов свёрнута в один пробел, регистр не тронут («ECOSYS» и «i-Sensys» — фирменные написания).
 * Ровно эта функция стоит в CHECK таблицы, в уникальном индексе (через `..._key`) и в резолве
 * триггера зеркала (Р3), поэтому нормализовать ввод по-своему маршруту нечем и незачем: любое
 * расхождение с ней — либо отказ ограничения на ровном месте, либо испорченный справочник.
 */
function normalizedName(name: string): SQL {
  return sql`office_equipment_model_name_normalize(${name})`;
}

/**
 * Ссылка на строку модели во ВНЕШНЕМ запросе, вынесенная в отдельный `sql`-объект. Вынос здесь не
 * стиль: он единственное, что удерживает корреляцию.
 *
 * `buildSelection` у drizzle (pg-core/dialect.js), собирая список столбцов запроса с ОДНОЙ таблицей
 * в `FROM`, проходит по чанкам выражения и заменяет КОЛОНКИ голыми идентификаторами:
 * `"office_equipment_models"."id"` превращается в `"id"`. Проход однослойный — во вложенный
 * `sql`-объект он не заходит, — поэтому защищает сам вынос, а не то, из чего ссылка собрана:
 * колонка, положенная в отдельную константу, уцелела бы точно так же, как этот чанк таблицы.
 * Замерено `toSQL()` на drizzle 0.45.2:
 *
 *   список столбцов, одна таблица, колонка вписана на месте ... `"model_id" = "id"`   ← ломается
 *   она же, вынесенная в отдельный `sql`-объект ............... `"…"."model_id" = "…"."id"`
 *   список столбцов с `JOIN`, колонка вписана на месте ........ цела
 *   `WHERE` односоставного запроса, колонка вписана на месте ... цела
 *
 * Чем кончается вписанная на месте корреляция: голое имя разрешается в самом внутреннем `FROM`, то
 * есть в таблицу подзапроса, и условие `model_id = id` сравнивает две её собственные колонки.
 * Ошибки при этом нет — обе колонки существуют, запрос законен, — просто `EXISTS` вечно ложен.
 * Поймано это было так: список моделей (он с `JOIN`) считал модель занятой, а проверка перед
 * удалением (она односоставная) — свободной, и удаление улетало в 500 нарушением внешнего ключа.
 * Нашёл смоук, а не компилятор и не тест.
 *
 * Тестом это и не удержать: подмени константу на голую ссылку-колонку — SQL не изменится вовсе.
 * Краснеет только форма «колонка вписана в выражение».
 */
const modelIdRef = sql`${officeEquipmentModels}."id"`;

/**
 * Первая половина занятости: карточки техники. Считаются ВСЕ — и архивные
 * (`deleted_at IS NOT NULL`), и неактивные, и чужой области. Архивная возвращается `restore` и
 * обязана вернуться к своей модели, а чужая карточка запрещает удаление ровно так же, как своя, —
 * поэтому здесь нет ни фильтра по удалению, ни фильтра по активности, ни области.
 */
const usedByEquipmentExpr = sql<boolean>`EXISTS (
  SELECT 1 FROM ${officeEquipment}
   WHERE ${officeEquipment.modelId} = ${modelIdRef}
)`;

/**
 * Вторая половина: расходники (миграция `0172`). Модель, к которой привязан картридж, — такая же
 * занятая, как модель с карточкой в парке: удали её, и расходник молча потеряет половину ответа на
 * вопрос «к чему подходит», а заметить это будет нечем. Схема держит то же самое `ON DELETE
 * RESTRICT` на `office_equipment_consumable_models.model_id`.
 *
 * Гашение расходника здесь не смотрится намеренно: погашенный расходник — это «больше не
 * покупаем», а совместимость он не теряет, и аппараты, которые им заправляют, никуда не делись.
 */
const usedByConsumableExpr = sql<boolean>`EXISTS (
  SELECT 1 FROM ${officeEquipmentConsumableModels}
   WHERE ${officeEquipmentConsumableModels.modelId} = ${modelIdRef}
)`;

/**
 * Ссылается ли на модель хоть что-нибудь — ответ на «удаляема ли она» (Р11): ни расходников, ни
 * карточек техники, включая архивные. Ровно ИЛИ двух половин выше, чтобы признак в списке и запрет
 * при удалении считались одним и тем же правилом, а не двумя похожими.
 *
 * Признак булев намеренно: числом он раскрыл бы масштаб парка тому, кому видна одна площадка, а на
 * вопрос об удалении «сколько» и не отвечает — отвечает «хоть одна».
 */
const isUsedExpr = sql<boolean>`(${usedByEquipmentExpr} OR ${usedByConsumableExpr})`;

/**
 * Сколько карточек модели видит смотрящий (Р12): живые и активные, **в его области** — тем же
 * предикатом `officeEquipmentScopeWhere`, что и список техники, а не похожим на него. Право
 * `officeEquipment.read` сквозной видимости не даёт, и роль одной площадки, увидев сквозные 68,
 * узнала бы масштаб чужого парка.
 *
 * Живые и активные, потому что вопрос счётчика — «сколько аппаратов надо кормить»: архив и
 * выведенная из эксплуатации техника картриджей не просят.
 *
 * Это **не** `isUsed`: ноль здесь означает «у вас таких нет», а не «модель свободна». Подменять
 * один признак другим нельзя — удалить модель не даёт и чужая карточка.
 *
 * Коррелированным подзапросом, как счётчики ТТХ у типов ТС: иначе список моделей порождал бы запрос
 * на строку.
 */
function equipmentCountExpr(p: Principal): SQL<number> {
  const scope = officeEquipmentScopeWhere(
    p,
    officeEquipment.objectId,
    officeEquipment.ownerDepartmentId,
  );
  // Корреляция — тем же `modelIdRef` и по той же причине: считает счётчик по-прежнему только
  // технику в области смотрящего, но ссылка на внешнюю строку обязана пережить `buildSelection`.
  return sql<number>`(
    SELECT count(*) FROM ${officeEquipment}
     WHERE ${officeEquipment.modelId} = ${modelIdRef}
       AND ${officeEquipment.deletedAt} IS NULL
       AND ${officeEquipment.isActive}
       ${scope ? sql`AND (${scope})` : sql.empty()}
  )`;
}

/**
 * Столбцы ответа. Функцией, а не константой: счётчик парка зависит от смотрящего (Р12), и вынести
 * его в общее выражение значило бы посчитать чью-то чужую область.
 */
function dtoColumns(p: Principal) {
  return {
    id: officeEquipmentModels.id,
    typeId: officeEquipmentTypes.id,
    typeName: officeEquipmentTypes.name,
    typeIsActive: officeEquipmentTypes.isActive,
    name: officeEquipmentModels.name,
    manufacturer: officeEquipmentModels.manufacturer,
    isActive: officeEquipmentModels.isActive,
    comment: officeEquipmentModels.comment,
    isUsed: isUsedExpr,
    equipmentCount: equipmentCountExpr(p),
    createdAt: officeEquipmentModels.createdAt,
    updatedAt: officeEquipmentModels.updatedAt,
  };
}

interface DtoRow {
  id: string;
  typeId: string;
  typeName: string;
  typeIsActive: boolean;
  name: string;
  manufacturer: string;
  isActive: boolean;
  comment: string;
  isUsed: boolean;
  equipmentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(r: DtoRow): OfficeEquipmentModelDto {
  return {
    id: r.id,
    type: { id: r.typeId, name: r.typeName, isActive: r.typeIsActive },
    name: r.name,
    manufacturer: r.manufacturer,
    isActive: r.isActive,
    comment: r.comment,
    isUsed: r.isUsed,
    // `count(*)` приезжает из pg строкой (bigint), как у счётчиков типов ТС.
    equipmentCount: Number(r.equipmentCount),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Карточка после записи читается тем же запросом, что и строка списка: счётчики считает он. */
async function getDto(id: string, p: Principal): Promise<OfficeEquipmentModelDto> {
  const [row] = await db
    .select(dtoColumns(p))
    .from(officeEquipmentModels)
    .innerJoin(
      officeEquipmentTypes,
      eq(officeEquipmentModels.equipmentTypeId, officeEquipmentTypes.id),
    )
    .where(eq(officeEquipmentModels.id, id));
  if (!row) throw err.notFound(NOT_FOUND);
  return toDto(row);
}

/**
 * Тип модели существует. Проверка до вставки, потому что иначе несуществующий тип превратился бы в
 * нарушение внешнего ключа, то есть в 500 с именем ограничения вместо ответа про поле.
 *
 * Активность типа здесь НЕ требуется, в отличие от заведения карточки техники: погашенный тип
 * означает «новых аппаратов такого рода не заводим», а картриджи для уже стоящих в кабинетах
 * аппаратов вносить по-прежнему нужно. Гашение самой модели — отдельный переключатель.
 */
async function assertTypeExists(tx: Tx, typeId: string): Promise<void> {
  const [row] = await tx
    .select({ id: officeEquipmentTypes.id })
    .from(officeEquipmentTypes)
    .where(eq(officeEquipmentTypes.id, typeId));
  if (!row) throw err.badRequest('Тип оргтехники не найден', { equipmentTypeId: 'Не найден' });
}

/**
 * Наименование свободно — проверяем до вставки, как занятость кода у типов. Уникальный индекс
 * держит то же самое, но его нарушение стало бы 500 с текстом про индекс, а человеку нужно знать,
 * что такая модель уже заведена.
 *
 * Сравнение — `office_equipment_model_key`, той же функцией, что в индексе: «Ricoh IM 350»,
 * «RICOH IM 350» и «Ricoh␣␣IM 350» это одна модель. И только внутри своего типа — одноимённые
 * принтер и МФУ разные модели (Р1), и пара «тип + ключ» это ровно то, по чему построен индекс.
 */
async function assertNameFree(
  tx: Tx,
  equipmentTypeId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const dup = await tx
    .select({ id: officeEquipmentModels.id })
    .from(officeEquipmentModels)
    .where(
      and(
        eq(officeEquipmentModels.equipmentTypeId, equipmentTypeId),
        sql`office_equipment_model_key(${officeEquipmentModels.name}) = office_equipment_model_key(${name})`,
        exceptId ? ne(officeEquipmentModels.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (dup.length > 0) throw err.conflict(NAME_TAKEN, { fields: NAME_TAKEN_FIELDS });
}

/**
 * Гонка с соседним заведением доходит до уникального индекса: чужая незакоммиченная строка
 * проверке выше не видна, обе транзакции её проходят, и вторая падает на `23505`. Без разбора это
 * 500 — «внутренняя ошибка» там, где человеку нужно ровно то же слово, что и при обычном дубле.
 *
 * Щель одна и та же у ОБЕИХ записывающих дверей, поэтому разбор общий: и заведение, и
 * переименование в занятое имя приходят сюда. У переименования свой оттенок — его табличная
 * блокировка тут не спасает вовсе: сосед, заводящий модель, парк не трогает и на `LOCK TABLE`
 * не задерживается.
 *
 * Гонка не теоретическая, и в этом отличие от перечня типов, где такой разбор не заводили: модели
 * заводят из формы карточки техники — часто и параллельно, а не раз в год десятью строками.
 *
 * Проверки до записи при этом остаются: они отвечают быстрее, без исключения и без отката
 * транзакции, а этот разбор закрывает ровно ту щель, которую проверки закрыть не могут.
 *
 * Опознаётся кодом и именем ограничения, а не текстом сообщения: текст зависит от версии и локали
 * сервера, а имя индекса задано миграцией `0171`. Через `pgErrorOf`, потому что drizzle оборачивает
 * ошибку драйвера в свою и на верхнем объекте кода уже нет — прямая проверка молчала бы.
 */
/**
 * Настоящее ли это переименование. Присутствие `name` в теле само по себе не значит ничего: форма
 * правки шлёт карточку целиком, и «переименованием» оказалась бы каждая правка производителя — с
 * табличной блокировкой парка и проходом зеркала по всем карточкам модели (у самой ходовой их 68)
 * ради записи того же самого имени.
 *
 * Сравнивается **то, что ляжет в базу**, с тем, что в ней лежит: `office_equipment_model_name_normalize`
 * на присланной стороне и хранимое имя как есть. Ровно это сравнение делает и триггер раскладки
 * (`WHEN (OLD.name IS DISTINCT FROM NEW.name)`), поэтому решение маршрута и решение базы совпадают
 * по построению: не бывает ни пропущенной раскладки, ни блокировки впустую.
 *
 * Сравнивать `office_equipment_model_key` (то есть в верхнем регистре) здесь НЕЛЬЗЯ, хотя занятость
 * имени считается именно им: ключ отвечает на вопрос «та же ли это модель», а здесь вопрос другой —
 * «то же ли это написание». Правка регистра («PANTUM M6500NW» → «Pantum M6500NW») — законное
 * исправление написания, которое обязано доехать до всех карточек; ключ счёл бы его пустой правкой,
 * и портал молча вернул бы прежнее написание.
 *
 * Чтение идёт до транзакции и без блокировки — намеренно. Порядок захвата Р3 от этого не меняется
 * (обычный `SELECT` не берёт ни строчных блокировок, ни конфликтующих табличных), а соседнее
 * переименование, успевшее вклиниться между этим чтением и транзакцией, значит лишь то, что имя
 * задал сосед: версии у ручки нет, и последнее слово в любом случае за тем, кто пришёл вторым.
 */
async function renameOf(id: string, name: string): Promise<string | undefined> {
  const [row] = await db
    .select({
      same: sql<boolean>`${officeEquipmentModels.name} = office_equipment_model_name_normalize(${name})`,
    })
    .from(officeEquipmentModels)
    .where(eq(officeEquipmentModels.id, id));
  if (!row) throw err.notFound(NOT_FOUND);
  return row.same ? undefined : name;
}

function asModelNameConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'office_equipment_models_name_unique') {
    return err.conflict(NAME_TAKEN, { fields: NAME_TAKEN_FIELDS });
  }
  return e;
}

export default async function officeEquipmentModelsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('officeEquipment.read');
  const canWrite = app.requirePermission('officeEquipment.write');

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: officeEquipmentModelListQuerySchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const where = and(
        // «Модели МФУ»: тип задаёт вопрос целиком — одноимённые принтер и МФУ это разные модели.
        q.equipmentTypeId
          ? eq(officeEquipmentModels.equipmentTypeId, q.equipmentTypeId)
          : undefined,
        q.isActive === undefined ? undefined : eq(officeEquipmentModels.isActive, q.isActive),
        /*
         * Срез «чем это заправлять — неизвестно» (Р15): ни одного привязанного расходника. Тем же
         * выражением, что стоит за половиной `isUsed`, — вопрос один и тот же, и разойтись двум
         * ответам на него нельзя.
         *
         * Гашение расходника не смотрится: «больше не покупаем» модель непокрытой не делает.
         *
         * Условие идёт в общий `where` рядом с типом, активностью и поиском — то есть складывается
         * с ними пересечением и попадает в оба запроса разом, и в строки, и в `count`. Отдельным
         * условием только для строк оно дало бы «показано 20 из 68» на списке из двадцати.
         */
        q.coverage === 'uncovered' ? not(usedByConsumableExpr) : undefined,
        // Ищут обеими половинами названия (Р9): и «Ricoh», и «IM 350» обязаны находить одну строку,
        // а производитель отдельным полем именно затем, чтобы «все Ricoh» спрашивались списком.
        searchCondition(q.search, [officeEquipmentModels.name, officeEquipmentModels.manufacturer]),
      );
      const sortCols = {
        name: officeEquipmentModels.name,
        manufacturer: officeEquipmentModels.manufacturer,
        type: officeEquipmentTypes.name,
        isActive: officeEquipmentModels.isActive,
        createdAt: officeEquipmentModels.createdAt,
      };
      // Сортировки по счётчику парка в перечне нет намеренно (контракт её и не принимает): счётчик
      // считается в области смотрящего, и порядок строк зависел бы от того, кто смотрит.
      //
      // Умолчание — «последняя заведённая сверху», как у списка техники: `sortOrder` по умолчанию
      // `desc`, и алфавит умолчанием дал бы список задом наперёд. Алфавит окно просит явно.
      const p2 = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns(p))
          .from(officeEquipmentModels)
          .innerJoin(
            officeEquipmentTypes,
            eq(officeEquipmentModels.equipmentTypeId, officeEquipmentTypes.id),
          )
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
          .limit(p2.limit)
          .offset(p2.offset),
        db
          .select({ c: count() })
          .from(officeEquipmentModels)
          .innerJoin(
            officeEquipmentTypes,
            eq(officeEquipmentModels.equipmentTypeId, officeEquipmentTypes.id),
          )
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

  r.post(
    '/',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { body: createOfficeEquipmentModelSchema },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const b = req.body;
      const created = await db
        .transaction(async (tx) => {
          await assertTypeExists(tx, b.equipmentTypeId);
          await assertNameFree(tx, b.equipmentTypeId, b.name);
          const [row] = await tx
            .insert(officeEquipmentModels)
            .values({
              equipmentTypeId: b.equipmentTypeId,
              // Свёртка написания — выражением базы, а не строкой из TypeScript: см. преамбулу.
              name: normalizedName(b.name),
              manufacturer: b.manufacturer,
              isActive: b.isActive,
              comment: b.comment,
            })
            .returning({ id: officeEquipmentModels.id, name: officeEquipmentModels.name });
          return row!;
        })
        // Гонка с соседним заведением приходит сюда нарушением уникального индекса — и уходит тем
        // же 409, что и обычный дубль.
        .catch((e: unknown) => {
          throw asModelNameConflict(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentModel.create',
        entityType: 'officeEquipmentModel',
        entityId: created.id,
        metadata: { name: created.name, equipmentTypeId: b.equipmentTypeId },
      });
      reply.code(201);
      return await getDto(created.id, p);
    },
  );

  /**
   * Правка модели. Тип модели неизменяем by design (Р1): пару «модель + тип» держит составной ключ
   * карточки в режиме «замок», и смена типа у модели, на которую уже ссылаются аппараты, была бы
   * отказом целостности вместо слов сервера. Не тот тип — заводят модель заново.
   *
   * Схема тип при этом **принимает** — намеренно (см. контракт): отбей его zod, человек прочитал бы
   * «expected never» вместо ответа о предмете. Отвечает маршрут, 422 и словами.
   *
   * ПОРЯДОК БЛОКИРОВОК ПРИ ПЕРЕИМЕНОВАНИИ ОБЯЗАТЕЛЕН И ИМЕННО ТАКОЙ (Р3 плана):
   *
   *   1. `LOCK TABLE office_equipment IN SHARE ROW EXCLUSIVE MODE`;
   *   2. строка модели `FOR UPDATE`;
   *   3. `UPDATE`, дальше имя раскладывает по карточкам триггер `office_equipment_models_rename_mirror`.
   *
   * Табличная блокировка первой строкой закрывает гонку со вставкой карточки: `SHARE ROW EXCLUSIVE`
   * несовместим с `ROW EXCLUSIVE`, который берёт всякая запись в `office_equipment`, — вписаться со
   * старым именем после прохода триггера некому.
   *
   * Она же снимает **взаимную блокировку** со старой правкой карточки, и вот почему порядок нельзя
   * переставлять: правка карточки блокирует её строку ДО своего `BEFORE`-триггера, а внутри
   * триггера legacy-резолв идёт за моделью `FOR KEY SHARE`; переименование, взявшее сперва модель,
   * пошло бы за строками карточек — порядок захвата встречный, цикл замыкается, и Postgres убивает
   * одну из транзакций с `40P01`, причём с равной вероятностью правку оператора. `LOCK TABLE`
   * первой строкой делает порядок общим: переименование либо ждёт чужую правку ничего не держа,
   * либо запирает запись в парк на своё короткое время.
   *
   * `FOR UPDATE` остаётся ради другого — он сериализует операции над самой моделью (переименование
   * против гашения, переименование двумя людьми), чтобы второй увидел результат первого.
   *
   * Табличная блокировка берётся ТОЛЬКО при настоящей смене имени: правка производителя,
   * комментария и гашения карточек не касается (триггер зеркала стоит `AFTER UPDATE OF name`), и
   * запирать ради неё запись в парк было бы платой без покупки. «Настоящая» — потому что решает
   * сравнение с хранимым именем (`renameOf`), а не присутствие поля в теле: клиент вправе слать
   * карточку целиком, и это не повод запирать парк.
   */
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateOfficeEquipmentModelSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      // Присланное имя, если оно и вправду отличается от хранимого; иначе — `undefined`, и дальше
      // весь путь переименования (блокировки, проверка занятости, запись `name`) не берётся вовсе.
      const rename = b.name === undefined ? undefined : await renameOf(id, b.name);
      const updated = await db
        .transaction(async (tx) => {
          // Шаг 1 порядка Р3 — до чтения модели и только при настоящем переименовании.
          if (rename !== undefined) {
            await tx.execute(sql`LOCK TABLE office_equipment IN SHARE ROW EXCLUSIVE MODE`);
          }
          // Шаг 2: сама модель. Тип читается отсюда, а не из тела, — он неизменяем.
          const [row] = await tx
            .select({
              equipmentTypeId: officeEquipmentModels.equipmentTypeId,
              name: officeEquipmentModels.name,
            })
            .from(officeEquipmentModels)
            .where(eq(officeEquipmentModels.id, id))
            .for('update');
          if (!row) throw err.notFound(NOT_FOUND);
          /*
           * Тип сверяется с прочитанной строкой, а не отбивается по факту присутствия поля: тот же
           * тип — законный no-op. Форма вправе слать карточку целиком, и отказывать ей за то, что
           * поле не изменилось, значило бы требовать от неё знать, какие поля «менять нельзя».
           * Другой тип — 422 словами: молча проигнорированный `equipmentTypeId` означал бы «портал
           * сделал вид, что перенёс модель», а это худший из трёх исходов. В `SET` тип не попадает
           * ни в одном случае — менять нечего.
           *
           * Сравнение стоит под блокировкой просто потому, что до чтения строки сравнивать не с чем;
           * отказ откатывает транзакцию тут же, вместе с табличной блокировкой, если её брали.
           */
          if (b.equipmentTypeId !== undefined && b.equipmentTypeId !== row.equipmentTypeId) {
            throw err.unprocessable('Тип модели не меняется: заведите модель нужного типа', {
              equipmentTypeId: 'Тип модели неизменяем',
            });
          }
          // Занятость — под блокировкой и в своём типе, с исключением себя: переименование «RICOH IM
          // 350» → «Ricoh IM 350» это правка написания, а не двойник.
          if (rename !== undefined) await assertNameFree(tx, row.equipmentTypeId, rename, id);
          // Шаг 3. Имя попадает в `SET` только когда его правят: `AFTER UPDATE OF name` срабатывает
          // по списку столбцов, и лишняя запись имени в самоё себя гоняла бы триггер по всем
          // карточкам модели впустую.
          const [res] = await tx
            .update(officeEquipmentModels)
            .set({
              ...(rename === undefined ? {} : { name: normalizedName(rename) }),
              ...(b.manufacturer === undefined ? {} : { manufacturer: b.manufacturer }),
              ...(b.isActive === undefined ? {} : { isActive: b.isActive }),
              ...(b.comment === undefined ? {} : { comment: b.comment }),
              updatedAt: new Date(),
            })
            .where(eq(officeEquipmentModels.id, id))
            .returning({ name: officeEquipmentModels.name });
          return res!;
        })
        // Третья дверь того же отказа: переименование в имя, которое сосед завёл в
        // незакоммиченной транзакции, проверке не видно вовсе — ни `renameOf`, ни занятости.
        // `LOCK TABLE` здесь не помощник: заведение модели парк не трогает и этой блокировкой
        // не задерживается, поэтому `UPDATE` встаёт в очередь на самом индексе и получает
        // `23505` после чужого коммита. Отказ тот же самый — и текст, и пометка поля.
        .catch((e: unknown) => {
          throw asModelNameConflict(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentModel.update',
        entityType: 'officeEquipmentModel',
        entityId: id,
        // Имя пишется всегда: переименование модели переписывает его во всех её карточках, и по
        // журналу должно читаться, во что именно парк переименовали.
        metadata: { name: updated.name },
      });
      return await getDto(id, p);
    },
  );

  /**
   * Удаление строкой, а не гашением (приём перечня типов): справочник ведут руками, и заведённую по
   * ошибке модель нужно вычищать, а не держать в списках неактивным мусором. Пауза у модели
   * выражается переключателем «Активна» — это другое состояние: «такие аппараты есть, новых не
   * заводим» (Р11).
   *
   * Удаляется только та модель, на которую не ссылается НИЧЕГО — ни карточка техники, ни расходник
   * (Р11). Архивные карточки считаются наравне с живыми: карточка возвращается `restore` и обязана
   * вернуться к своей модели. `ON DELETE RESTRICT` держит оба конца сам (составной ключ карточки и
   * `office_equipment_consumable_models.model_id`), но проверка отвечает человеку словами, а не
   * нарушением ключа, — и словами РАЗНЫМИ, потому что делать ему в этих двух случаях тоже разное.
   *
   * Проверка стоит ВНУТРИ транзакции и после `FOR UPDATE` по строке модели — не для красоты:
   * заведение карточки берёт на модели `FOR KEY SHARE` (резолв триггера и сам внешний ключ), и это
   * несовместимо с `FOR UPDATE`. Значит, между проверкой и удалением новая карточка не появится:
   * либо она успела до нас — и мы её увидим, либо ждёт нас — и увидит уже отсутствие модели.
   * Проверка до транзакции такого не обещает вовсе. Привязка расходника берёт на модели тот же
   * `FOR KEY SHARE` своим внешним ключом, поэтому и она в это окно не пролезает.
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const removed = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            equipmentTypeId: officeEquipmentModels.equipmentTypeId,
            name: officeEquipmentModels.name,
          })
          .from(officeEquipmentModels)
          .where(eq(officeEquipmentModels.id, id))
          .for('update');
        if (!row) throw err.notFound(NOT_FOUND);
        /*
         * Занятость — теми же двумя выражениями, что стоят за `isUsed` в списке: список и запрет
         * обязаны отвечать одинаково, иначе окно предложит удалить то, что маршрут не отдаст.
         *
         * Отдельным запросом, а не столбцами того же `SELECT … FOR UPDATE`: в READ COMMITTED
         * снимок берётся на оператор, и подзапрос, приехавший вместе с блокировкой, показал бы
         * состояние ДО ожидания на ней — то есть не увидел бы карточку, которую сосед закоммитил,
         * пока мы стояли в очереди. Отдельный оператор идёт уже по свежему снимку.
         *
         * Два случая — два ответа, и это не украшательство: человеку от них требуется разное.
         * Техника ссылку не отпустит никогда (архивная карточка тоже считается), и единственный
         * выход — гасить модель отметкой «Активна». Расходник же отвязывается свободно (Р6,
         * разметка совместимости, а не история), и после этого модель удаляется по-настоящему.
         * Сказать про картридж «снимите „Активна“» значило бы отправить человека делать не то.
         *
         * Техника проверяется первой: когда верны оба, называть надо ту причину, которую нельзя
         * обойти, — иначе человек снимет привязку картриджа и вернётся к тому же отказу.
         */
        const [used] = await tx
          .select({ byEquipment: usedByEquipmentExpr, byConsumable: usedByConsumableExpr })
          .from(officeEquipmentModels)
          .where(eq(officeEquipmentModels.id, id));
        if (used!.byEquipment) {
          throw err.conflict('На модель ссылается техника, снимите «Активна» вместо удаления');
        }
        if (used!.byConsumable) {
          throw err.conflict(
            'К модели привязан расходник: снимите совместимость в его карточке или снимите «Активна» вместо удаления',
          );
        }
        await tx.delete(officeEquipmentModels).where(eq(officeEquipmentModels.id, id));
        return row;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentModel.delete',
        entityType: 'officeEquipmentModel',
        entityId: id,
        // Строки больше нет — в журнале остаётся то, чем её называли.
        metadata: { name: removed.name, equipmentTypeId: removed.equipmentTypeId },
      });
      return { ok: true };
    },
  );
}
