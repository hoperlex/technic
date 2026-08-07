import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  createOfficeEquipmentSchema,
  formatServiceRequestNumber,
  officeEquipmentListQuerySchema,
  officeEquipmentTitle,
  type OfficeEquipmentDto,
  type OfficeEquipmentWarrantyFilter,
  updateOfficeEquipmentSchema,
  WARRANTY_EXPIRING_DAYS,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  officeEquipment,
  officeEquipmentTypes,
  serviceRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import {
  archiveWhere,
  assertArchiveVisible,
  assertOfficeEquipmentScope,
  officeEquipmentScopeWhere,
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
      return dto;
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
        const objectId = b.objectId ?? ex.objectId;
        const ownerDepartmentId =
          b.departmentId !== undefined ? (b.departmentId ?? null) : ex.ownerDepartmentId;
        const serialNumber = b.serialNumber ?? ex.serialNumber;
        const inventoryNumber = b.inventoryNumber ?? ex.inventoryNumber;

        if (equipmentTypeId !== ex.equipmentTypeId) await assertTypeUsable(tx, equipmentTypeId);
        if (objectId !== ex.objectId) await assertObjectExists(tx, objectId);
        if (ownerDepartmentId && ownerDepartmentId !== ex.ownerDepartmentId) {
          await assertDepartmentExists(tx, ownerDepartmentId);
        }
        if (objectId !== ex.objectId || ownerDepartmentId !== ex.ownerDepartmentId) {
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
        if (b.objectId !== undefined) set.objectId = b.objectId;
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
