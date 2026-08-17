import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  attachVehicleTypeSpecSchema,
  createVehicleTypeSchema,
  requestCustomerName,
  switchVehicleTypeLinearSchema,
  updateVehicleTypeSchema,
  updateVehicleTypeSpecSchema,
  vehicleTypeListQuerySchema,
  type VehicleTypeDto,
  type VehicleTypeLinearSwitchPreviewDto,
  type VehicleTypeLinearSwitchRequestDto,
  type VehicleTypeLinearSwitchResultDto,
  type MaintenanceBasis,
  type WaybillFormCode,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  specialEquipmentRequestDetails,
  vehicleCategories,
  vehicleCategorySpecValues,
  vehicleKinds,
  vehicleRequests,
  vehicleSpecs,
  vehicleTypeSpecs,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { vehicleRequestVisibilityWhere } from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';
import { dropWeeklyItemsOfVehicleType } from '../services/weekly-request-cleanup';
import {
  assertValueFitsSpec,
  loadTypeSpecs,
  lockType,
  refreshTypeCategories,
  signaturesWithoutSpec,
  valueToColumn,
} from '../services/vehicle-categories';

const idParams = z.object({ id: z.string().uuid() });
const specParams = z.object({ id: z.string().uuid(), specId: z.string().uuid() });

// Счётчики ТТХ и категорий (ADR 0016) — коррелированными подзапросами, чтобы список типов не
// порождал запрос на строку. specCount = 0 означает, что у типа нет и не может быть категорий.
const specCount = sql<number>`(
  SELECT count(*) FROM ${vehicleTypeSpecs}
  WHERE ${vehicleTypeSpecs.vehicleTypeId} = ${vehicleTypes.id}
)`;
const categoryCount = sql<number>`(
  SELECT count(*) FROM ${vehicleCategories}
  WHERE ${vehicleCategories.vehicleTypeId} = ${vehicleTypes.id}
)`;
// Сколько заявок типа дорабатывает по прежнему режиму — их застигло переключение признака
// (миграция 0137). Тем же коррелированным подзапросом, что и счётчики выше, и по частичному
// индексу `vehicle_requests_linear_frozen_idx`. Число отвечает на вопрос «можно ли убирать
// костыль»: колонки снимка уходят, когда оно обнулится по всем типам, — и уходит вместе с ними.
const frozenRequests = sql<number>`(
  SELECT count(*) FROM ${vehicleRequests}
  WHERE ${vehicleRequests.vehicleTypeId} = ${vehicleTypes.id}
    AND ${vehicleRequests.isLinearFrozen} IS NOT NULL
)`;

const dtoColumns = {
  id: vehicleTypes.id,
  kindId: vehicleTypes.kindId,
  kindCode: vehicleKinds.code,
  kindName: vehicleKinds.name,
  code: vehicleTypes.code,
  name: vehicleTypes.name,
  description: vehicleTypes.description,
  isActive: vehicleTypes.isActive,
  sortOrder: vehicleTypes.sortOrder,
  waybillFormCode: vehicleTypes.waybillFormCode,
  isLinear: vehicleTypes.isLinear,
  maintenanceBasis: vehicleTypes.maintenanceBasis,
  frozenRequests,
  specCount,
  categoryCount,
  createdAt: vehicleTypes.createdAt,
  updatedAt: vehicleTypes.updatedAt,
};

type DtoRow = {
  id: string;
  kindId: string;
  kindCode: string;
  kindName: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  waybillFormCode: WaybillFormCode;
  isLinear: boolean;
  maintenanceBasis: MaintenanceBasis;
  frozenRequests: number;
  specCount: number;
  categoryCount: number;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: DtoRow): VehicleTypeDto {
  return {
    id: r.id,
    kindId: r.kindId,
    kindCode: r.kindCode,
    kindName: r.kindName,
    code: r.code,
    name: r.name,
    description: r.description,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    waybillFormCode: r.waybillFormCode,
    isLinear: r.isLinear,
    maintenanceBasis: r.maintenanceBasis,
    frozenRequests: Number(r.frozenRequests),
    specCount: Number(r.specCount),
    categoryCount: Number(r.categoryCount),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function getDtoById(id: string): Promise<VehicleTypeDto | undefined> {
  const [row] = await db
    .select(dtoColumns)
    .from(vehicleTypes)
    .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
    .where(eq(vehicleTypes.id, id));
  return row ? toDto(row) : undefined;
}

// ── Переключение признака «Линейная техника» под работающими заказами (ADR 0100, миграция 0137) ──
//
// Признак читается живым (`src/db/linear-mode.ts`), поэтому галочка в справочнике меняла бы режим
// документооборота каждой заявке в работе на ходу. Вместо запрета переключение оставляет
// застигнутым заявкам снимок прежнего значения, а человеку — предпросмотр: кто именно останется на
// прежнем режиме. Отсюда две ручки со своим протоколом и отказ общей правки (`PATCH`) трогать
// признак.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающее соединение: предпросмотр спрашивает пул, подтверждение — свою транзакцию. */
type Reader = Pick<Tx, 'select'>;

/**
 * Куда переключают — спрашивается явно, а не выводится «наоборот от текущего»: вкладка, открытая
 * со вчера, иначе показала бы последствия не того переключения, которое человек собирается сделать.
 */
const linearSwitchQuery = z.object({
  isLinear: z.enum(['true', 'false']).transform((v) => v === 'true'),
});

/**
 * Отпечаток пустого множества — тот самый `md5('')`, что вернёт и SQL. Предпросмотру, которому
 * нечего показывать, всё равно нужно назвать значение: клиент отправляет его обратно, и пустая
 * строка получила бы отказ там, где отказывать не за что.
 */
const EMPTY_SCOPE_FINGERPRINT = createHash('md5').update('').digest('hex');

/**
 * Множество, которое застигнет переключение: заявки, дорабатывающие по прежнему режиму. Отбор
 * живёт в одном месте на все три обращения — предпросмотр, сверку отпечатка и сам `UPDATE`:
 * разойдись они хоть одним условием, и подтверждение защищало бы не то, что записывается.
 *
 * Условия названы поимённо, потому что каждое отвечает на свой вопрос:
 *
 * - `request_type = 'special_equipment'` — режим есть только у заказа техники на объект. У
 *   грузоперевозки того же типа его нет вовсе, и снимок ей ничего не объясняет, зато держит
 *   уборку колонок;
 * - `status = 'confirmed'` — морозится работа, а не заказ: у новой заявки ничего не начиналось,
 *   у закрытой всё уже случилось;
 * - `deleted_at` здесь **не проверяется намеренно**: мягкое удаление статуса не меняет, и
 *   незамороженная архивная заявка вернулась бы из архива уже в другом режиме — мина, а не отказ;
 * - `is_linear_frozen IS NULL` — заявку, застигнутую прежним переключением, второе не переписывает.
 */
function linearSwitchScopeWhere(typeId: string): SQL | undefined {
  return and(
    eq(vehicleRequests.vehicleTypeId, typeId),
    eq(vehicleRequests.requestType, 'special_equipment'),
    eq(vehicleRequests.status, 'confirmed'),
    isNull(vehicleRequests.isLinearFrozen),
  );
}

interface LinearSwitchScope {
  count: number;
  archivedCount: number;
  fingerprint: string;
}

/**
 * Счётчики и отпечаток множества. Отпечаток считается из самих данных — серверного состояния и
 * токенов подтверждения не заводится, — и `coalesce` в нём обязателен: у пустого множества
 * `string_agg` возвращает `NULL`, `md5(NULL)` — тоже `NULL`, и сверка была бы ложной всегда.
 */
async function readLinearSwitchScope(conn: Reader, typeId: string): Promise<LinearSwitchScope> {
  const [row] = await conn
    .select({
      total: count(),
      archived: sql<number>`count(*) FILTER (WHERE ${vehicleRequests.deletedAt} IS NOT NULL)`,
      fingerprint: sql<string>`md5(coalesce(
        string_agg(${vehicleRequests.id}::text, ',' ORDER BY ${vehicleRequests.id}), ''))`,
    })
    .from(vehicleRequests)
    .where(linearSwitchScopeWhere(typeId));
  return {
    count: Number(row!.total),
    archivedCount: Number(row!.archived),
    fingerprint: row!.fingerprint,
  };
}

/**
 * Чем переключение обернётся для застигнутых заявок. Направление называется следствием, а не
 * признаком: «по неделям» и «по дням» человек сверяет с тем, что видит в заявке, а `isLinear: true`
 * не говорит ему ничего.
 */
function linearSwitchConsequence(count: number, next: boolean): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const one = mod10 === 1 && mod100 !== 11;
  const few = mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14);
  const word = one ? 'заявка' : few ? 'заявки' : 'заявок';
  const head = `${count} ${word} в работе ${one ? 'продолжит' : 'продолжат'} вестись`;
  const about = one ? 'ней' : 'ним';
  const to = one ? 'ей' : 'им';
  return next
    ? `${head} по неделям: ЭСМ-2 портал выписывает по ${about} сам, дни ${to} не планируются`
    : `${head} по дням: распланированные дни остаются в рейсах, ` +
        `недельные листы ${to} не выписываются`;
}

// Плоский справочник типов ТС (ADR 0005): один уровень, без подтипов/иерархии. Удаления нет —
// деактивация через PATCH isActive. Структурные ключи (code/kindId) неизменяемы после создания.
export default async function vehicleTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  // ── Список ──
  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: vehicleTypeListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      const where = and(
        q.kindId ? eq(vehicleTypes.kindId, q.kindId) : undefined,
        q.isActive === undefined ? undefined : eq(vehicleTypes.isActive, q.isActive),
        searchCondition(q.search, [vehicleTypes.code, vehicleTypes.name]),
      );
      const sortCols = {
        code: vehicleTypes.code,
        kindName: vehicleKinds.name,
        name: vehicleTypes.name,
        sortOrder: vehicleTypes.sortOrder,
        isActive: vehicleTypes.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns)
          .from(vehicleTypes)
          .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(vehicleTypes).where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  // ── Одна запись ──
  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const dto = await getDtoById(req.params.id);
      if (!dto) throw err.notFound('Тип не найден');
      return dto;
    },
  );

  // ── Создание ──
  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createVehicleTypeSchema } },
    async (req, reply) => {
      const actor = requirePrincipal(req).id;
      const body = req.body;

      const [kind] = await db
        .select({ id: vehicleKinds.id, isActive: vehicleKinds.isActive })
        .from(vehicleKinds)
        .where(eq(vehicleKinds.id, body.kindId));
      if (!kind) throw err.notFound('Вид ТС не найден');
      if (!kind.isActive) throw err.unprocessable('Вид ТС неактивен');

      const dup = await db
        .select({ id: vehicleTypes.id })
        .from(vehicleTypes)
        .where(eq(vehicleTypes.code, body.code));
      if (dup.length > 0) throw err.conflict('Тип с таким кодом уже существует');

      const [created] = await db
        .insert(vehicleTypes)
        .values({
          kindId: body.kindId,
          code: body.code,
          name: body.name,
          description: body.description,
          isActive: body.isActive,
          sortOrder: body.sortOrder,
          waybillFormCode: body.waybillFormCode,
          isLinear: body.isLinear,
          maintenanceBasis: body.maintenanceBasis,
        })
        .returning({ id: vehicleTypes.id });
      const createdId = created!.id;
      await writeAudit({
        actorUserId: actor,
        action: 'vehicle_type.create',
        entityType: 'vehicle_type',
        entityId: createdId,
        metadata: {
          code: body.code,
          kindId: body.kindId,
          isActive: body.isActive,
          waybillFormCode: body.waybillFormCode,
          isLinear: body.isLinear,
          maintenanceBasis: body.maintenanceBasis,
        },
      });
      reply.code(201);
      return (await getDtoById(createdId))!;
    },
  );

  // ── Обновление (name/description/sortOrder/isActive; code/kindId неизменяемы) ──
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateVehicleTypeSchema },
    },
    async (req) => {
      const actor = requirePrincipal(req).id;
      const id = req.params.id;
      const body = req.body;
      const [row] = await db.select().from(vehicleTypes).where(eq(vehicleTypes.id, id));
      if (!row) throw err.notFound('Тип не найден');

      /*
       * Признак линейности этой ручкой не переключается: у переключения свой протокол —
       * предпросмотр, отпечаток подтверждения и ответ с номерами заявок, оставленных на прежнем
       * режиме (`POST /:id/linear`). Полем общей правки подтверждение обходилось бы молча —
       * старым клиентом, скриптом, вкладкой, открытой со вчера.
       *
       * Совпадающее значение отказом не считается: форма справочника шлёт полный объект правки, а
       * не изменённые поля, и запрет на «то же самое» запер бы правку наименования у каждого
       * линейного типа. Отвечает handler, а не Zod: поле осталось в схеме нарочно — `strict()`
       * отдал бы `400` «Ошибка валидации данных» вместо инструкции, куда идти.
       */
      if (body.isLinear !== undefined && body.isLinear !== row.isLinear) {
        throw err.unprocessable(
          'Признак «Линейная техника» переключают своей ручкой: портал сначала покажет ' +
            'заявки, которые останутся на прежнем режиме',
          { isLinear: 'Переключается своей ручкой' },
        );
      }

      await db
        .update(vehicleTypes)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(vehicleTypes.id, id));

      const activeChanged = body.isActive !== undefined && body.isActive !== row.isActive;
      /*
       * Смена бланка — своё действие журнала, а не строка в «обновлён» (ADR 0065): этим полем
       * переключается документ строгой отчётности, и вопрос «кто перевёл тип на форму № 3»
       * должен иметь ответ. Активность приоритетнее лишь потому, что она грубее: выключенным
       * типом не заводят ни заявок, ни рейсов, и бланк у него уже ни на что не влияет.
       *
       * Линейности в этой развилке больше нет: её действие (`vehicle_type.linear`) пишет своя
       * ручка — вместе с номерами заявок, оставленных на прежнем режиме, которых общая правка не
       * знает и знать не может.
       */
      const formChanged =
        body.waybillFormCode !== undefined && body.waybillFormCode !== row.waybillFormCode;
      /*
       * Разметка ТО — тоже своё действие, и по той же причине, что бланк: этим полем включается и
       * выключается целый расчёт, а вопрос «почему у экскаваторов пропало обслуживание» обязан
       * иметь ответ в журнале, а не в поддержке. Ниже бланка в развилке она стоит не по важности,
       * а по редкости: обе правки в одном запросе — это форма справочника, отправленная целиком,
       * и назвать событие можно только одним словом.
       */
      const basisChanged =
        body.maintenanceBasis !== undefined && body.maintenanceBasis !== row.maintenanceBasis;
      const action = activeChanged
        ? body.isActive
          ? 'vehicle_type.activate'
          : 'vehicle_type.deactivate'
        : formChanged
          ? 'vehicle_type.waybill_form'
          : basisChanged
            ? 'vehicle_type.maintenance_basis'
            : 'vehicle_type.update';
      await writeAudit({
        actorUserId: actor,
        action,
        entityType: 'vehicle_type',
        entityId: id,
        metadata: {
          code: row.code,
          kindId: row.kindId,
          oldName: row.name,
          newName: body.name ?? row.name,
          oldActive: row.isActive,
          newActive: body.isActive ?? row.isActive,
          oldWaybillFormCode: row.waybillFormCode,
          newWaybillFormCode: body.waybillFormCode ?? row.waybillFormCode,
          oldMaintenanceBasis: row.maintenanceBasis,
          newMaintenanceBasis: body.maintenanceBasis ?? row.maintenanceBasis,
          // Пары «было → стало» по линейности здесь нет: этой ручкой признак не меняется, и
          // запись «было false, стало false» отвечала бы на вопрос, которого никто не задавал.
          isLinear: row.isLinear,
        },
      });
      return (await getDtoById(id))!;
    },
  );

  // ── Предпросмотр переключения признака «Линейная техника» ──
  // Право то же, что у правки справочника: переключает признак тот, кто ведёт типы. Блокировки
  // здесь нет — это чтение для диалога, а не решение; решает подтверждение ниже.
  r.get(
    '/:id/linear-switch-preview',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, querystring: linearSwitchQuery },
    },
    async (req): Promise<VehicleTypeLinearSwitchPreviewDto> => {
      const p = requirePrincipal(req);
      const id = req.params.id;
      const next = req.query.isLinear;

      const [type] = await db
        .select({ isLinear: vehicleTypes.isLinear })
        .from(vehicleTypes)
        .where(eq(vehicleTypes.id, id));
      if (!type) throw err.notFound('Тип не найден');

      // Признак уже стоит в запрошенном значении: переключать нечего и морозить некого — ровно то
      // же ответит и сама ручка. Показать здесь работающие заявки значило бы пообещать заморозку,
      // которой не будет.
      if (type.isLinear === next) {
        return {
          next,
          count: 0,
          archivedCount: 0,
          requests: [],
          fingerprint: EMPTY_SCOPE_FINGERPRINT,
        };
      }

      const scope = await readLinearSwitchScope(db, id);

      /*
       * Перечень считается не по тому множеству, что счётчики, и это нарочно: отпечаток и `count`
       * берутся по полному набору — включая архивные и невидимые этой учётке по области, — иначе
       * подтверждение защищало бы не то, что записывается. А номера показываются только те,
       * которые человек и так видит в списке заявок: архив в портале — администраторская область,
       * тогда как признак переключают менеджер и диспетчер. Сколько заявок осталось за кадром,
       * говорит `archivedCount` — числом, а не строками.
       */
      const rows = await db
        .select({
          num: vehicleRequests.num,
          objectId: vehicleRequests.objectId,
          objectCode: constructionObjects.code,
          objectName: constructionObjects.name,
          departmentId: vehicleRequests.departmentId,
          departmentCode: departments.code,
          departmentName: departments.name,
          dateFrom: specialEquipmentRequestDetails.dateFrom,
          dateTo: specialEquipmentRequestDetails.dateTo,
        })
        .from(vehicleRequests)
        .innerJoin(
          specialEquipmentRequestDetails,
          eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
        )
        .leftJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
        .leftJoin(departments, eq(vehicleRequests.departmentId, departments.id))
        .where(
          and(
            linearSwitchScopeWhere(id),
            isNull(vehicleRequests.deletedAt),
            vehicleRequestVisibilityWhere(
              p,
              vehicleRequests.objectId,
              vehicleRequests.departmentId,
            ),
          ),
        )
        .orderBy(vehicleRequests.num);

      return {
        next,
        count: scope.count,
        archivedCount: scope.archivedCount,
        fingerprint: scope.fingerprint,
        requests: rows.map((row): VehicleTypeLinearSwitchRequestDto => ({
          num: row.num,
          objectName: requestCustomerName(row),
          dateFrom: row.dateFrom,
          dateTo: row.dateTo,
        })),
      };
    },
  );

  // ── Переключение признака: снимок прежнего режима застигнутым заявкам и новое значение типу ──
  // Всё одной транзакцией и в жёстком порядке: блокировка, идемпотентный выход, сверка набора,
  // снимки, признак. Порядок здесь не стилистика — каждый шаг закрывает свою щель.
  r.post(
    '/:id/linear',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: switchVehicleTypeLinearSchema },
    },
    async (req): Promise<VehicleTypeLinearSwitchResultDto> => {
      const actor = requirePrincipal(req).id;
      const id = req.params.id;
      const { isLinear: next, fingerprint } = req.body;

      const switched = await db.transaction(async (tx) => {
        /*
         * Блокировка строки типа сериализует переключение со входом заявок в работу: тот читает
         * свой тип внутри своей транзакции и потому либо ждёт здесь, либо уже виден пересчёту
         * ниже. Успел вход — заявка морозится прежним значением; успело переключение — вход
         * прочитает уже новое и пойдёт по новому режиму. Третьего порядка нет.
         */
        const [row] = await tx
          .select({ code: vehicleTypes.code, isLinear: vehicleTypes.isLinear })
          .from(vehicleTypes)
          .where(eq(vehicleTypes.id, id))
          .for('update');
        if (!row) throw err.notFound('Тип не найден');

        // Значение уже стоит — выход до всякой сверки отпечатка. Это и есть идемпотентность
        // повтора: клиент, потерявший ответ на сети, шлёт тот же запрос со своим прежним
        // отпечатком, а множество к этому времени пусто — сверка ответила бы `409` на успешно
        // выполненной операции.
        if (row.isLinear === next) return null;

        const scope = await readLinearSwitchScope(tx, id);

        /*
         * Нужно ли подтверждение — решают данные под блокировкой, а не тело запроса: у типа без
         * работающих заказов подтверждать нечего вовсе, и обязательное поле схемы отдавало бы
         * `400` там, где ответом должно быть число заявок и что с ними станет. Отказ называет
         * следствие, а не поле: клиент, переключающий признак мимо портала, должен прочитать, что
         * именно случится с заявками, а не «требуется fingerprint».
         */
        if (fingerprint === undefined && scope.count > 0) {
          const consequence = linearSwitchConsequence(scope.count, next);
          throw err.unprocessable(
            `${consequence}. Подтвердите переключение отпечатком предпросмотра`,
            { fingerprint: 'Нужно подтверждение' },
          );
        }
        // Присланный отпечаток сверяется всегда, включая опустевшее множество: он говорит «я видел
        // вот этот состав», и молча переключить по устаревшему предпросмотру нельзя. Прежнего
        // числа сервер не знает и не выдумывает — оно лежит у клиента, и фразу «было M, стало N»
        // собирает он.
        if (fingerprint !== undefined && fingerprint !== scope.fingerprint) {
          throw err.conflict(
            `Состав заявок изменился, сейчас их ${scope.count} — посмотрите предпросмотр заново`,
          );
        }

        /*
         * Снимок — ПРЕЖНЕЕ значение признака: застигнутая заявка дорабатывает так, как её вели, а
         * не так, как с этой минуты ведутся новые. Ответ и журнал собираются из `RETURNING`:
         * второй запрос «а сколько же их вышло» посчитал бы уже другое множество и рассказал бы
         * про соседнюю операцию.
         */
        const frozen = await tx
          .update(vehicleRequests)
          .set({ isLinearFrozen: row.isLinear, linearFrozenAt: new Date() })
          .where(linearSwitchScopeWhere(id))
          .returning({ num: vehicleRequests.num });
        await tx
          .update(vehicleTypes)
          .set({ isLinear: next, updatedAt: new Date() })
          .where(eq(vehicleTypes.id, id));

        // Порядок строк `RETURNING` не определён, а номера идут и в ответ, и в журнал: одна
        // операция не должна выглядеть в двух местах по-разному.
        const nums = frozen.map((f) => f.num).sort((a, b) => a - b);
        return { code: row.code, oldIsLinear: row.isLinear, nums };
      });

      // Повтор уже сделанного переключения событием не является: не записано ничего — писать в
      // журнал нечего, иначе история типа обрастала бы переключениями, которых не было.
      if (switched) {
        await writeAudit({
          actorUserId: actor,
          action: 'vehicle_type.linear',
          entityType: 'vehicle_type',
          entityId: id,
          metadata: {
            code: switched.code,
            oldIsLinear: switched.oldIsLinear,
            newIsLinear: next,
            frozenNow: switched.nums.length,
            frozenNums: switched.nums,
          },
        });
      }

      const type = (await getDtoById(id))!;
      return {
        type,
        frozenNow: switched?.nums.length ?? 0,
        frozenNums: switched?.nums ?? [],
        // Снимков у типа всего, включая поставленные прежними переключениями: с `frozenNow` их
        // путать нельзя — то считает только новых, это всех, кто ещё дорабатывает по своему.
        frozenTotal: type.frozenRequests,
      };
    },
  );

  // ── ТТХ типа (ADR 0016) ──
  // Привязка = обязательность: каждая категория типа обязана иметь значение по каждому
  // привязанному ТТХ. Поэтому и добавление, и отвязка задевают все категории разом и идут
  // в транзакции с блокировкой строки типа.

  r.get(
    '/:id/specs',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const [type] = await db
        .select({ id: vehicleTypes.id })
        .from(vehicleTypes)
        .where(eq(vehicleTypes.id, req.params.id));
      if (!type) throw err.notFound('Тип не найден');
      return await loadTypeSpecs(db, req.params.id);
    },
  );

  r.post(
    '/:id/specs',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: attachVehicleTypeSpecSchema },
    },
    async (req, reply) => {
      const typeId = req.params.id;
      const body = req.body;

      await db.transaction(async (tx) => {
        const type = await lockType(tx, typeId);
        const [spec] = await tx.select().from(vehicleSpecs).where(eq(vehicleSpecs.id, body.specId));
        if (!spec) throw err.notFound('ТТХ не найден');
        if (!spec.isActive) throw err.unprocessable('ТТХ неактивен');

        const existing = await tx
          .select({ specId: vehicleTypeSpecs.specId })
          .from(vehicleTypeSpecs)
          .where(
            and(
              eq(vehicleTypeSpecs.vehicleTypeId, typeId),
              eq(vehicleTypeSpecs.specId, body.specId),
            ),
          );
        if (existing.length > 0) throw err.conflict('Этот ТТХ уже привязан к типу');

        const cats = await tx
          .select({ id: vehicleCategories.id })
          .from(vehicleCategories)
          .where(eq(vehicleCategories.vehicleTypeId, typeId));

        // Существующие категории мгновенно стали бы неполными — поэтому значение обязательно.
        // Одинаковая координата, добавленная ко всем кортежам, коллизий сигнатур не создаёт.
        if (cats.length > 0 && body.backfillValue === undefined) {
          throw err.unprocessable(
            `У типа уже есть категории (${cats.length}): укажите значение нового ТТХ — оно будет проставлено каждой из них`,
          );
        }

        const bounds = {
          name: spec.name,
          unit: spec.unit,
          decimals: Number(spec.decimals),
          minValue: spec.minValue == null ? null : Number(spec.minValue),
          maxValue: spec.maxValue == null ? null : Number(spec.maxValue),
        };
        if (cats.length > 0) assertValueFitsSpec(body.backfillValue!, bounds);

        await tx
          .insert(vehicleTypeSpecs)
          .values({ vehicleTypeId: typeId, specId: body.specId, sortOrder: body.sortOrder });

        if (cats.length > 0) {
          await tx.insert(vehicleCategorySpecValues).values(
            cats.map((c) => ({
              categoryId: c.id,
              vehicleTypeId: typeId,
              specId: body.specId,
              valueNum: valueToColumn(body.backfillValue!, bounds),
            })),
          );
          await refreshTypeCategories(tx, typeId, type.name);
        }
      });

      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle_type_spec.attach',
        entityType: 'vehicle_type',
        entityId: typeId,
        metadata: { specId: body.specId, backfillValue: body.backfillValue ?? null },
      });
      reply.code(201);
      return await loadTypeSpecs(db, typeId);
    },
  );

  // Порядок ТТХ определяет порядок полей в форме категории и частей в её наименовании,
  // поэтому авто-имена пересобираются.
  r.patch(
    '/:id/specs/:specId',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: specParams, body: updateVehicleTypeSpecSchema },
    },
    async (req) => {
      const { id: typeId, specId } = req.params;
      await db.transaction(async (tx) => {
        const type = await lockType(tx, typeId);
        const updated = await tx
          .update(vehicleTypeSpecs)
          .set({ sortOrder: req.body.sortOrder })
          .where(
            and(eq(vehicleTypeSpecs.vehicleTypeId, typeId), eq(vehicleTypeSpecs.specId, specId)),
          )
          .returning({ specId: vehicleTypeSpecs.specId });
        if (updated.length === 0) throw err.notFound('ТТХ не привязан к этому типу');
        await refreshTypeCategories(tx, typeId, type.name);
      });
      return await loadTypeSpecs(db, typeId);
    },
  );

  r.delete(
    '/:id/specs/:specId',
    { preHandler: [app.authenticate, canWrite], schema: { params: specParams } },
    async (req) => {
      const { id: typeId, specId } = req.params;
      await db.transaction(async (tx) => {
        const type = await lockType(tx, typeId);
        const specs = await loadTypeSpecs(tx, typeId);
        const binding = specs.find((s) => s.specId === specId);
        if (!binding) throw err.notFound('ТТХ не привязан к этому типу');

        const cats = await tx
          .select({ id: vehicleCategories.id, name: vehicleCategories.name })
          .from(vehicleCategories)
          .where(eq(vehicleCategories.vehicleTypeId, typeId));

        if (cats.length > 0) {
          if (specs.length === 1) {
            throw err.conflict(
              `Это единственный ТТХ типа, а категорий ${cats.length}: категория без значений невозможна — сначала удалите категории`,
            );
          }
          // Выброшенная координата может схлопнуть две категории в один кортеж. Останавливаемся
          // до потери данных, а не ловим уникальным индексом после удаления значений.
          const nameById = new Map(cats.map((c) => [c.id, c.name]));
          const seen = new Map<string, string>();
          const clashes: string[] = [];
          for (const [catId, sig] of await signaturesWithoutSpec(tx, typeId, specId)) {
            const prev = seen.get(sig);
            if (prev) clashes.push(`«${prev}» и «${nameById.get(catId) ?? catId}»`);
            else seen.set(sig, nameById.get(catId) ?? catId);
          }
          if (clashes.length > 0) {
            throw err.conflict(
              `Без этого ТТХ категории станут неразличимы: ${clashes.join('; ')}. Объедините или удалите их и повторите.`,
            );
          }
        }

        // Значения — раньше привязки: составной FK на (vehicle_type_id, spec_id) стоит RESTRICT.
        await tx
          .delete(vehicleCategorySpecValues)
          .where(
            and(
              eq(vehicleCategorySpecValues.vehicleTypeId, typeId),
              eq(vehicleCategorySpecValues.specId, specId),
            ),
          );
        await tx
          .delete(vehicleTypeSpecs)
          .where(
            and(eq(vehicleTypeSpecs.vehicleTypeId, typeId), eq(vehicleTypeSpecs.specId, specId)),
          );
        if (cats.length > 0) await refreshTypeCategories(tx, typeId, type.name);
      });

      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle_type_spec.detach',
        entityType: 'vehicle_type',
        entityId: typeId,
        metadata: { specId },
      });
      return await loadTypeSpecs(db, typeId);
    },
  );

  // Удаление насовсем (ADR 0060). Категории и привязки ТТХ уходят вместе с типом: они существуют
  // только внутри него и ведутся в его же карточке — требовать вычистить их вручную значило бы
  // не дать удалить тип вовсе. Порядок задан составными внешними ключами: значения, потом
  // категории, потом привязки — тот же, что при отвязке ТТХ выше.
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(vehicleTypes).where(eq(vehicleTypes.id, id));
      return row;
    },
    isDown: (row) => !row.isActive,
    remove: async (tx, row, actor) => {
      // Первым делом — следы в неприменённых недельных заявках (ADR 0085 Р15): строка «нужна
      // дополнительно» заказывает погашенную позицию классификатора, а держать ею тип вечно
      // нельзя. Категории типа снимаются тем же условием: у строки с категорией этого типа и сам
      // тип — этот (составной внешний ключ), поэтому второго прохода по категориям не нужно.
      const cleanup = await dropWeeklyItemsOfVehicleType(tx, actor, {
        id: row.id,
        name: row.name,
      });
      await tx
        .delete(vehicleCategorySpecValues)
        .where(eq(vehicleCategorySpecValues.vehicleTypeId, row.id));
      await tx.delete(vehicleCategories).where(eq(vehicleCategories.vehicleTypeId, row.id));
      await tx.delete(vehicleTypeSpecs).where(eq(vehicleTypeSpecs.vehicleTypeId, row.id));
      await tx.delete(vehicleTypes).where(eq(vehicleTypes.id, row.id));
      return cleanup;
    },
    notFound: 'Тип ТС не найден',
    stillLive: 'Тип ТС активен — сначала деактивируйте его',
    subject: 'тип ТС',
    audit: {
      action: 'vehicle_type.purge',
      entityType: 'vehicle_type',
      metadata: (row) => ({ code: row.code, name: row.name }),
    },
  });
}
