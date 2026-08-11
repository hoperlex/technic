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
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  can,
  createOfficeEquipmentSchema,
  formatServiceRequestNumber,
  moveOfficeEquipmentSchema,
  officeEquipmentListQuerySchema,
  officeEquipmentTitle,
  type OfficeEquipmentDto,
  type OfficeEquipmentItemWarrantyDto,
  type OfficeEquipmentMovementDto,
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
  officeEquipmentMovements,
  officeEquipmentTypes,
  serviceRequestItems,
  serviceRequests,
  users,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
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
const fromObjects = alias(constructionObjects, 'movement_from_objects');
const toObjects = alias(constructionObjects, 'movement_to_objects');
const fromDepartments = alias(departments, 'movement_from_departments');
const toDepartments = alias(departments, 'movement_to_departments');
const movers = alias(users, 'movement_movers');

/**
 * Сколько перемещений отдаётся в ленту карточки. Столько же, сколько событий у истории заявки
 * (`HISTORY_LIMIT`): карточку открывают вопросом «что было недавно», а полный журнал за пять лет —
 * это выгрузка, и заводится она отдельно, если понадобится.
 */
const MOVEMENT_LIMIT = 50;

/**
 * Тип и объект у единицы есть всегда (`NOT NULL`), поэтому они `innerJoin`; отдел — необязателен,
 * и `leftJoin` здесь означает ровно «не размечена», а не потерянную ссылку.
 */
function baseQuery() {
  return db
    .select({ e: officeEquipment, type: typeRef, object: objectRef, department: departmentRef })
    .from(officeEquipment)
    .innerJoin(officeEquipmentTypes, eq(officeEquipment.equipmentTypeId, officeEquipmentTypes.id))
    .innerJoin(constructionObjects, eq(officeEquipment.objectId, constructionObjects.id))
    .leftJoin(departments, eq(officeEquipment.ownerDepartmentId, departments.id));
}

type EquipmentRow = Awaited<ReturnType<typeof baseQuery>>[number];

function toDto(r: EquipmentRow): OfficeEquipmentDto {
  return {
    id: r.e.id,
    type: r.type,
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
      // Секция обслуживания — по праву модуля, а не справочника (§8.2): менеджер и диспетчер ведут
      // карточки техники, но ремонтом не занимаются, и заявки с суммами им знать незачем. Поля
      // просто нет в ответе — пустой список означал бы «ремонтов не было».
      if (!can(p, 'serviceRequests.read')) return dto;
      return { ...dto, serviceHistory: await loadServiceHistory(p, dto.id) };
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createOfficeEquipmentSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const b = req.body;
      const created = await db.transaction(async (tx) => {
        await assertTypeUsable(tx, b.equipmentTypeId);
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
            name: b.name,
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
          .returning({ id: officeEquipment.id });
        return row!;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipment.create',
        entityType: 'officeEquipment',
        entityId: created.id,
        metadata: {
          name: b.name,
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
      await db.transaction(async (tx) => {
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
        if (b.name !== undefined) set.name = b.name;
        if (b.serialNumber !== undefined) set.serialNumber = b.serialNumber;
        if (b.inventoryNumber !== undefined) set.inventoryNumber = b.inventoryNumber;
        if (b.departmentId !== undefined) set.ownerDepartmentId = b.departmentId ?? null;
        if (b.location !== undefined) set.location = b.location;
        if (b.purchasedOn !== undefined) set.purchasedOn = b.purchasedOn ?? null;
        if (b.warrantyUntil !== undefined) set.warrantyUntil = b.warrantyUntil ?? null;
        if (b.comment !== undefined) set.comment = b.comment;
        if (b.isActive !== undefined) set.isActive = b.isActive;
        await tx.update(officeEquipment).set(set).where(eq(officeEquipment.id, id));
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipment.update',
        entityType: 'officeEquipment',
        entityId: id,
      });
      return (await getDto(id))!;
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
   * История единицы одной лентой (Р62): перемещения и обслуживание вперемешку по датам.
   *
   * Ремонтная часть отдаётся только при `serviceRequests.read` — то же правило, что у секции
   * `serviceHistory` в карточке: право справочника карточку открывает, а обслуживание — нет.
   */
  r.get(
    '/:id/history',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const [ex] = await db
        .select({
          id: officeEquipment.id,
          objectId: officeEquipment.objectId,
          ownerDepartmentId: officeEquipment.ownerDepartmentId,
          deletedAt: officeEquipment.deletedAt,
        })
        .from(officeEquipment)
        .where(eq(officeEquipment.id, id));
      if (!ex) throw err.notFound('Единица оргтехники не найдена');
      assertArchiveVisible(p, ex.deletedAt, 'Единица оргтехники не найдена');
      assertOfficeEquipmentScope(p, {
        objectId: ex.objectId,
        ownerDepartmentId: ex.ownerDepartmentId,
      });

      const rows = await db
        .select({
          m: officeEquipmentMovements,
          fromObject: {
            id: fromObjects.id,
            code: fromObjects.code,
            name: fromObjects.name,
          },
          toObject: { id: toObjects.id, code: toObjects.code, name: toObjects.name },
          fromDepartment: {
            id: fromDepartments.id,
            code: fromDepartments.code,
            name: fromDepartments.name,
          },
          toDepartment: {
            id: toDepartments.id,
            code: toDepartments.code,
            name: toDepartments.name,
          },
          movedByName: movers.fullName,
          requestNum: serviceRequests.num,
        })
        .from(officeEquipmentMovements)
        .innerJoin(fromObjects, eq(officeEquipmentMovements.fromObjectId, fromObjects.id))
        .innerJoin(toObjects, eq(officeEquipmentMovements.toObjectId, toObjects.id))
        .leftJoin(
          fromDepartments,
          eq(officeEquipmentMovements.fromDepartmentId, fromDepartments.id),
        )
        .leftJoin(toDepartments, eq(officeEquipmentMovements.toDepartmentId, toDepartments.id))
        .innerJoin(movers, eq(officeEquipmentMovements.movedBy, movers.id))
        .leftJoin(
          serviceRequests,
          eq(officeEquipmentMovements.serviceRequestId, serviceRequests.id),
        )
        .where(eq(officeEquipmentMovements.equipmentId, id))
        .orderBy(desc(officeEquipmentMovements.movedOn), desc(officeEquipmentMovements.createdAt))
        .limit(MOVEMENT_LIMIT);

      const movements: OfficeEquipmentMovementDto[] = rows.map((row) => ({
        id: row.m.id,
        movedOn: row.m.movedOn,
        fromObject: row.fromObject,
        toObject: row.toObject,
        // `leftJoin` отдаёт `null` целиком, когда отдела не было: «не закреплена» — рабочее
        // состояние единицы, а не потерянная ссылка.
        fromDepartment: row.fromDepartment?.id ? row.fromDepartment : null,
        toDepartment: row.toDepartment?.id ? row.toDepartment : null,
        fromLocation: row.m.fromLocation,
        toLocation: row.m.toLocation,
        fromState: row.m.fromState,
        toState: row.m.toState,
        reason: row.m.reason,
        comment: row.m.comment,
        serviceRequestId: row.m.serviceRequestId,
        serviceRequestNum: row.requestNum,
        movedByName: row.movedByName,
        createdAt: row.m.createdAt.toISOString(),
      }));

      // Обслуживание — тем же запросом, что и в карточке: два разных ответа на «что с этим
      // аппаратом делали» разъехались бы на первой же правке.
      const serviceHistory = can(p, 'serviceRequests.read')
        ? await loadServiceHistory(p, id)
        : undefined;
      return { movements, serviceHistory };
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
        if (!ex.deletedAt) return false;
        // Область у восстановления та же, что у остальных действий: право `archive.restore` сейчас
        // есть только у администратора, но право и область выдаются по отдельности.
        assertOfficeEquipmentScope(p, {
          objectId: ex.objectId,
          ownerDepartmentId: ex.ownerDepartmentId,
        });
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
