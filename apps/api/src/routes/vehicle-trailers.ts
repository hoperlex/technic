import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  can,
  createVehicleTrailerSchema,
  hitchTrailerSchema,
  type HitchTrailerResultDto,
  trailerTitle,
  updateVehicleTrailerSchema,
  vehicleTrailerListQuerySchema,
  type TrailerHitchPosition,
  type VehicleTrailerDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  organizations,
  vehicleModels,
  vehicleTrailers,
  vehicleTypes,
  vehicles,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';
import { UNHITCHED, withHitchLocks, type HitchScope } from '../services/vehicle-trailer-hitch';

/**
 * Реестр прицепов и полуприцепов (план `docs/vehicle-trailers-plan.md`, Р7, Р8, Р14, Р16).
 *
 * Прицеп — **не** единица техники: в `vehicles` он не лежит, и потому это отдельный модуль с
 * собственным CRUD, а не ветка `vehicles.ts`. Права те же, что у остальных справочников
 * (`directories.read` / `directories.write`), архив и вычистка — общие (`archive.restore`,
 * `records.purge`).
 *
 * Своего здесь ровно одно, и оно дорогое: **привязка к тягачу меняется командой**
 * (`POST /:id/hitch`, `POST /:id/unhitch`), а не полем в теле `PATCH`. Причин две.
 *
 * 1. Слот уникален (`UNIQUE (hitched_vehicle_id, hitch_position)`). Наивное «поставь прицеп B в
 *    слот 1 тягача X», где слот занят прицепом A, упёрлось бы в нарушение индекса вместо
 *    результата, а заставлять человека сначала отцепить A и лишь потом прицепить B — значит
 *    просить его выполнить транзакцию руками, оставив тягач без прицепа, если второй шаг не дошёл.
 * 2. Команда трогает до четырёх строк в двух таблицах: целевой тягач, прежний тягач перемещаемого
 *    прицепа, сам прицеп и вытесняемый жилец слота. Без **единого порядка захвата** две встречные
 *    перестановки — «A: X→Y» и одновременно «B: Y→X» — встают во взаимную блокировку. Порядок
 *    объявлен один на весь портал (`services/vehicle-trailer-hitch.ts`, `withHitchLocks`) и
 *    обязателен для всех, кто снимает или ставит привязку: `hitch`, `unhitch`, мягкое удаление и
 *    списание прицепа — и те же три события со стороны машины (`routes/vehicles.ts`). Команды с
 *    разными порядками — это та же взаимоблокировка, только между разными ручками.
 *
 * Оттого же в `PATCH` привязки нет вовсе: два пути к одному значению с разной надёжностью — это
 * гарантированно разошедшаяся пара, а не удобство.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

// ── Чтение карточки ──

const trailerSelect = {
  id: vehicleTrailers.id,
  kind: vehicleTrailers.kind,
  model: vehicleTrailers.model,
  registrationNumber: vehicleTrailers.registrationNumber,
  vin: vehicleTrailers.vin,
  passportNumber: vehicleTrailers.passportNumber,
  manufacturedYear: vehicleTrailers.manufacturedYear,
  color: vehicleTrailers.color,
  maxMassKg: vehicleTrailers.maxMassKg,
  curbMassKg: vehicleTrailers.curbMassKg,
  ownerOrganizationId: vehicleTrailers.ownerOrganizationId,
  // Собственник словами: карточка повторяет СТС, где он напечатан наименованием, а не ключом.
  ownerOrganizationName: organizations.name,
  status: vehicleTrailers.status,
  note: vehicleTrailers.note,
  sourceName: vehicleTrailers.sourceName,
  hitchedVehicleId: vehicleTrailers.hitchedVehicleId,
  hitchedVehicleRegistrationNumber: vehicles.registrationNumber,
  hitchedVehicleModelName: vehicleModels.name,
  hitchPosition: vehicleTrailers.hitchPosition,
  createdAt: vehicleTrailers.createdAt,
  updatedAt: vehicleTrailers.updatedAt,
  deletedAt: vehicleTrailers.deletedAt,
};

/**
 * Три левых соединения, которых нет в самой таблице: собственник и тягач с его маркой. Тягач
 * тянется через `vehicles` → `vehicle_models`, потому что называть машину одним госномером мало —
 * в списке рядом стоят «МАЗ» и «КАМАЗ» с похожими номерами, и марка и есть то, чем их различают.
 */
function baseQuery() {
  return db
    .select(trailerSelect)
    .from(vehicleTrailers)
    .leftJoin(organizations, eq(vehicleTrailers.ownerOrganizationId, organizations.id))
    .leftJoin(vehicles, eq(vehicleTrailers.hitchedVehicleId, vehicles.id))
    .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id));
}

type TrailerJoinedRow = Awaited<ReturnType<typeof baseQuery>>[number];

function toDto(r: TrailerJoinedRow): VehicleTrailerDto {
  return {
    id: r.id,
    kind: r.kind,
    model: r.model,
    registrationNumber: r.registrationNumber,
    vin: r.vin,
    passportNumber: r.passportNumber,
    manufacturedYear: r.manufacturedYear,
    color: r.color,
    maxMassKg: r.maxMassKg,
    curbMassKg: r.curbMassKg,
    ownerOrganizationId: r.ownerOrganizationId,
    ownerOrganizationName: r.ownerOrganizationName,
    status: r.status,
    note: r.note,
    sourceName: r.sourceName,
    // Пара «машина + слот» заполнена и пуста только целиком (CHECK `vehicle_trailers_hitch_pair`),
    // поэтому одной проверки ссылки хватает на оба поля.
    hitchedVehicle: r.hitchedVehicleId
      ? {
          id: r.hitchedVehicleId,
          registrationNumber: r.hitchedVehicleRegistrationNumber,
          modelName: r.hitchedVehicleModelName,
        }
      : null,
    hitchPosition: r.hitchPosition,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

async function getById(id: string): Promise<VehicleTrailerDto | null> {
  const [row] = await baseQuery().where(eq(vehicleTrailers.id, id));
  return row ? toDto(row) : null;
}

// ── Проверки реквизитов ──

/**
 * Госномер уникален среди живых — тем же правилом и той же нормализацией, что у техники: удалённая
 * запись номер освобождает. Проверка стоит до записи, чтобы человек получил понятный отказ, а не
 * нарушение индекса.
 */
async function assertRegUnique(tx: Tx, reg: string, exceptId?: string): Promise<void> {
  const [dup] = await tx
    .select({ id: vehicleTrailers.id })
    .from(vehicleTrailers)
    .where(
      and(
        sql`${vehicleTrailers.registrationNumberNormalized} = vehicle_reg_normalize(${reg})`,
        isNull(vehicleTrailers.deletedAt),
        exceptId ? ne(vehicleTrailers.id, exceptId) : undefined,
      ),
    );
  if (dup) {
    throw err.conflict('Прицеп с таким госномером уже есть', {
      fields: { registrationNumber: 'Такой госномер уже занят' },
    });
  }
}

/** Собственник по СТС. Проверяем до вставки: иначе отказ внешнего ключа доедет до человека 500-й. */
async function assertOwnerOrganization(tx: Tx, organizationId: string): Promise<void> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!row) throw err.badRequest('Организация не найдена', { ownerOrganizationId: 'Не найдена' });
}

/**
 * Годится ли машина в тягачи (план §4.2.3).
 *
 * Тягачом может быть **собственная неудалённая** машина, бланк типа которой не «форма № 3»: у неё
 * граф прицепа нет вовсе (ADR 0071), и закрепление за легковым описывало бы то, что негде
 * напечатать. Предложение аренды не годится по другой причине — это не машина парка, а строка
 * прайса арендодателя.
 *
 * **Сужать до типа `tractor_trailers` нельзя**: прицеп цепляют и к бортовому автомобилю, и к
 * самосвалу, а тип отвечает за бланк и категорию прав, а не за наличие фаркопа.
 *
 * Статус машине не мешает — ни `inactive`, ни `maintenance`: закрепление говорит, что полуприцеп
 * физически стоит за этой машиной, а не что на ней завтра поедут. Мешает только `retired`.
 */
async function assertTractorUsable(tx: Tx, vehicleId: string): Promise<void> {
  const [row] = await tx
    .select({
      ownership: vehicles.ownership,
      status: vehicles.status,
      deletedAt: vehicles.deletedAt,
      waybillFormCode: vehicleTypes.waybillFormCode,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicles.vehicleTypeId, vehicleTypes.id))
    .where(eq(vehicles.id, vehicleId));
  if (!row || row.deletedAt) throw err.badRequest('Машина не найдена', { vehicleId: 'Не найдена' });
  if (row.ownership !== 'own') {
    throw err.unprocessable('Прицеп закрепляют только за собственной машиной', {
      vehicleId: 'Это предложение аренды, а не машина парка',
    });
  }
  if (row.status === 'retired') {
    throw err.unprocessable('Машина списана — закреплять за ней прицеп нечем', {
      vehicleId: 'Машина списана',
    });
  }
  if (row.waybillFormCode === 'leg3') {
    throw err.unprocessable(
      'У формы № 3 граф прицепа нет — за такой машиной прицеп не закрепляют',
      {
        vehicleId: 'Лист по форме № 3, граф прицепа в нём нет',
      },
    );
  }
}

// ── Порядок блокировок и снятие привязки — в `services/vehicle-trailer-hitch.ts` ──
//
// Помощники захвата вынесены из ручки в сервис, потому что привязку меняет не только она: смена
// состояния машины (списание, мягкое удаление, перевод типа на «форму № 3») снимает привязки из
// `routes/vehicles.ts` — по тем же строкам и обязательно тем же порядком. Второй порядок на той
// же паре таблиц вернул бы ровно ту взаимоблокировку, ради которой порядок и объявлен.

/** Столбцы, которыми операция привязки принимает решения: состояние, жизнь и где прицеп стоит. */
const trailerLockColumns = {
  id: vehicleTrailers.id,
  model: vehicleTrailers.model,
  registrationNumber: vehicleTrailers.registrationNumber,
  status: vehicleTrailers.status,
  hitchedVehicleId: vehicleTrailers.hitchedVehicleId,
  hitchPosition: vehicleTrailers.hitchPosition,
  deletedAt: vehicleTrailers.deletedAt,
};

async function readTrailerRow(
  tx: Tx,
  id: string,
): Promise<{
  id: string;
  model: string;
  registrationNumber: string;
  status: VehicleTrailerDto['status'];
  hitchedVehicleId: string | null;
  hitchPosition: TrailerHitchPosition | null;
  deletedAt: Date | null;
} | null> {
  const [row] = await tx
    .select(trailerLockColumns)
    .from(vehicleTrailers)
    .where(eq(vehicleTrailers.id, id));
  return row ?? null;
}

type TrailerLockRow = NonNullable<Awaited<ReturnType<typeof readTrailerRow>>>;

/**
 * Область блокировки для операции, которая только **снимает** привязку прицепа: сам прицеп и
 * тягач, за которым он сейчас стоит. Ею живут `unhitch`, мягкое удаление и списание — порядок
 * захвата у них обязан быть тем же, что у `hitch`.
 */
function unhitchScope(tx: Tx, trailerId: string): () => Promise<HitchScope<TrailerLockRow | null>> {
  return async () => {
    const trailer = await readTrailerRow(tx, trailerId);
    return {
      vehicleIds: trailer?.hitchedVehicleId ? [trailer.hitchedVehicleId] : [],
      trailerIds: [trailerId],
      value: trailer,
    };
  };
}

export default async function vehicleTrailersRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: vehicleTrailerListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      // Архив показываем тем, кто ведёт справочник: остальным удалённая строка в списке выбора
      // только мешает (ADR 0021) — то же правило, что у техники.
      const showDeleted = q.includeDeleted && can(requirePrincipal(req), 'directories.write');
      const where = and(
        showDeleted ? undefined : isNull(vehicleTrailers.deletedAt),
        q.status ? eq(vehicleTrailers.status, q.status) : undefined,
        q.kind ? eq(vehicleTrailers.kind, q.kind) : undefined,
        // «Что стоит за этой машиной» — вопрос карточки техники и подстановки в рейс.
        q.hitchedVehicleId ? eq(vehicleTrailers.hitchedVehicleId, q.hitchedVehicleId) : undefined,
        // Ищут по тому, что напечатано в бланке и в СТС: госномер (по нормализованной форме — как
        // у техники, чтобы «вх 9332 77» находило «ВХ933277»), марка и номера документов.
        q.search
          ? or(
              sql`${vehicleTrailers.registrationNumberNormalized} ILIKE '%' || vehicle_reg_normalize(${q.search}) || '%'`,
              ilike(vehicleTrailers.model, `%${q.search}%`),
              ilike(vehicleTrailers.vin, `%${q.search}%`),
              ilike(vehicleTrailers.passportNumber, `%${q.search}%`),
            )
          : undefined,
      );
      const sortCols = {
        kind: vehicleTrailers.kind,
        registrationNumber: vehicleTrailers.registrationNumberNormalized,
        model: vehicleTrailers.model,
        manufacturedYear: vehicleTrailers.manufacturedYear,
        passportNumber: vehicleTrailers.passportNumber,
        // Столбец «за какой машиной» показывает госномер тягача — по нему и сортируется; поле
        // соединения, а не своё, потому что в самой таблице лежит только ключ.
        hitchedVehicle: vehicles.registrationNumber,
        status: vehicleTrailers.status,
        createdAt: vehicleTrailers.createdAt,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        baseQuery()
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
          .limit(p.limit)
          .offset(p.offset),
        // Счётчику соединения не нужны: и отбор, и поиск идут по столбцам самой таблицы.
        db.select({ c: count() }).from(vehicleTrailers).where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const dto = await getById(req.params.id);
      if (!dto) throw err.notFound('Прицеп не найден');
      return dto;
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createVehicleTrailerSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const b = req.body;
      // Привязки в теле нет намеренно (см. шапку файла): заведённый прицеп ни за кем не стоит,
      // и ставит его туда отдельная команда.
      const created = await db.transaction(async (tx) => {
        await assertRegUnique(tx, b.registrationNumber);
        if (b.ownerOrganizationId) await assertOwnerOrganization(tx, b.ownerOrganizationId);
        const [row] = await tx
          .insert(vehicleTrailers)
          .values({
            kind: b.kind,
            model: b.model,
            registrationNumber: b.registrationNumber,
            vin: b.vin,
            passportNumber: b.passportNumber,
            manufacturedYear: b.manufacturedYear ?? null,
            color: b.color,
            maxMassKg: b.maxMassKg ?? null,
            curbMassKg: b.curbMassKg ?? null,
            ownerOrganizationId: b.ownerOrganizationId ?? null,
            status: b.status,
            note: b.note,
          })
          .returning({ id: vehicleTrailers.id });
        return row!;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicleTrailer.create',
        entityType: 'vehicleTrailer',
        entityId: created.id,
        metadata: { registrationNumber: b.registrationNumber, kind: b.kind },
      });
      reply.code(201);
      return (await getById(created.id))!;
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateVehicleTrailerSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      let retired = false;
      await db.transaction(async (tx) => {
        const ex = await readTrailerRow(tx, id);
        if (!ex || ex.deletedAt) throw err.notFound('Прицеп не найден');

        const set: Partial<typeof vehicleTrailers.$inferInsert> = { updatedAt: new Date() };
        if (b.kind !== undefined) set.kind = b.kind;
        if (b.model !== undefined) set.model = b.model;
        if (b.registrationNumber !== undefined) set.registrationNumber = b.registrationNumber;
        if (b.vin !== undefined) set.vin = b.vin;
        if (b.passportNumber !== undefined) set.passportNumber = b.passportNumber;
        if (b.manufacturedYear !== undefined) set.manufacturedYear = b.manufacturedYear ?? null;
        if (b.color !== undefined) set.color = b.color;
        if (b.maxMassKg !== undefined) set.maxMassKg = b.maxMassKg ?? null;
        if (b.curbMassKg !== undefined) set.curbMassKg = b.curbMassKg ?? null;
        if (b.ownerOrganizationId !== undefined) {
          set.ownerOrganizationId = b.ownerOrganizationId ?? null;
        }
        if (b.status !== undefined) set.status = b.status;
        if (b.note !== undefined) set.note = b.note;

        if (b.registrationNumber !== undefined && b.registrationNumber !== ex.registrationNumber) {
          await assertRegUnique(tx, b.registrationNumber, id);
        }
        if (b.ownerOrganizationId) await assertOwnerOrganization(tx, b.ownerOrganizationId);

        // Списание **снимает** привязку, а не упирается в неё (план §4.2.3): закрепление —
        // удобство подстановки, а не учётный факт, и держать списание заложником у него не за что.
        // Тем же порядком захвата, что у команд: списание трогает те же строки, что `unhitch`, и
        // второй порядок на них дал бы ровно ту взаимоблокировку, ради которой порядок и объявлен.
        if ((b.status ?? ex.status) === 'retired') {
          const locked = await withHitchLocks(tx, unhitchScope(tx, id));
          if (!locked || locked.deletedAt) throw err.notFound('Прицеп не найден');
          if (locked.hitchedVehicleId) {
            Object.assign(set, UNHITCHED);
            retired = true;
          }
        }

        await tx.update(vehicleTrailers).set(set).where(eq(vehicleTrailers.id, id));
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicleTrailer.update',
        entityType: 'vehicleTrailer',
        entityId: id,
        // Снятая при списании привязка — часть той же правки, и в журнале она обязана быть рядом:
        // иначе «прицеп перестал стоять за машиной» не объясняется ничем.
        metadata: retired ? { unhitchedOnRetire: true } : {},
      });
      return (await getById(id))!;
    },
  );

  // ── Привязка к тягачу ──

  /**
   * Прицепить: поставить прицеп в слот бланка целевой машины, вытеснив оттуда прежнего жильца.
   *
   * Порядок шагов — общий для всех команд привязки (план §4.2.1):
   * 1) грязное чтение — где стоит перемещаемый прицеп и кто занимает целевой слот;
   * 2) сбор id затронутых строк: тягачи (целевой и прежний) и прицепы (перемещаемый и вытесняемый);
   * 3) захват `FOR UPDATE` — сначала `vehicles`, затем `vehicle_trailers`, внутри каждой по `id`;
   * 4) перечитывание под блокировкой и сверка набора, иначе повтор (не более трёх раз);
   * 5) правка — и только теперь, когда набор строк доказан, а не угадан.
   *
   * Слот освобождается **до** заселения: `UNIQUE (hitched_vehicle_id, hitch_position)` проверяется
   * на каждом операторе, и обратный порядок упёрся бы в индекс на ровном месте.
   */
  r.post(
    '/:id/hitch',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: hitchTrailerSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { vehicleId, position } = req.body;

      const result = await db.transaction(async (tx) => {
        const scan = async (): Promise<
          HitchScope<{ trailer: TrailerLockRow | null; occupant: TrailerLockRow | null }>
        > => {
          const trailer = await readTrailerRow(tx, id);
          const [occupant] = await tx
            .select(trailerLockColumns)
            .from(vehicleTrailers)
            .where(
              and(
                eq(vehicleTrailers.hitchedVehicleId, vehicleId),
                eq(vehicleTrailers.hitchPosition, position),
              ),
            );
          return {
            // Целевой тягач в наборе всегда — он же замок слота, даже если слот пуст.
            vehicleIds: [
              vehicleId,
              ...(trailer?.hitchedVehicleId ? [trailer.hitchedVehicleId] : []),
            ],
            trailerIds: [id, ...(occupant ? [occupant.id] : [])],
            value: { trailer, occupant: occupant ?? null },
          };
        };

        const { trailer, occupant } = await withHitchLocks(tx, scan);
        if (!trailer || trailer.deletedAt) throw err.notFound('Прицеп не найден');
        if (trailer.status === 'retired') {
          throw err.unprocessable('Списанный прицеп за машиной не стоит', {
            status: 'Прицеп списан',
          });
        }
        await assertTractorUsable(tx, vehicleId);

        // Вытесняем только чужого: прицеп, уже стоящий в этом слоте, — это он сам, и «отцеплен»
        // про него сказать нельзя.
        const evicted = occupant && occupant.id !== trailer.id ? occupant : null;
        if (evicted) {
          await tx
            .update(vehicleTrailers)
            .set({ ...UNHITCHED, updatedAt: new Date() })
            .where(eq(vehicleTrailers.id, evicted.id));
        }
        await tx
          .update(vehicleTrailers)
          .set({ hitchedVehicleId: vehicleId, hitchPosition: position, updatedAt: new Date() })
          .where(eq(vehicleTrailers.id, id));
        return { evicted, movedFrom: trailer.hitchedVehicleId };
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicleTrailer.hitch',
        entityType: 'vehicleTrailer',
        entityId: id,
        metadata: {
          vehicleId,
          position,
          // Кого выставили и откуда пришёл сам прицеп: без этих двух реквизитов журнал не отвечает
          // на вопрос «почему полуприцеп больше не стоит за моей машиной».
          unhitchedTrailerId: result.evicted?.id ?? null,
          movedFromVehicleId: result.movedFrom,
        },
      });

      const answer: HitchTrailerResultDto = {
        trailer: (await getById(id))!,
        notice: result.evicted
          ? `Слот ${position} занимал ${trailerTitle(result.evicted)} — он отцеплен`
          : null,
      };
      return answer;
    },
  );

  /**
   * Отцепить. Тела у команды нет — прицеп назван в адресе, а сниматься ему больше неоткуда.
   *
   * Порядок захвата тот же, что у `hitch`, и это не симметрия ради симметрии: `unhitch` трогает те
   * же две строки (прицеп и его тягач), и собственный порядок здесь означал бы взаимоблокировку
   * между двумя ручками одного модуля.
   */
  r.post(
    '/:id/unhitch',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const detached = await db.transaction(async (tx) => {
        const trailer = await withHitchLocks(tx, unhitchScope(tx, id));
        if (!trailer || trailer.deletedAt) throw err.notFound('Прицеп не найден');
        if (!trailer.hitchedVehicleId) return null;
        await tx
          .update(vehicleTrailers)
          .set({ ...UNHITCHED, updatedAt: new Date() })
          .where(eq(vehicleTrailers.id, id));
        return { vehicleId: trailer.hitchedVehicleId, position: trailer.hitchPosition };
      });
      // Отцепление уже отцепленного — не ошибка: две вкладки диспетчера нажимают одну кнопку, и
      // отказ на втором нажатии описывал бы состояние, которого человек и добивался.
      if (detached) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicleTrailer.unhitch',
          entityType: 'vehicleTrailer',
          entityId: id,
          metadata: { vehicleId: detached.vehicleId, position: detached.position },
        });
      }
      return (await getById(id))!;
    },
  );

  // ── Архив ──

  /**
   * Мягкое удаление. Привязку **снимает** той же транзакцией, а не запрещает (план §4.2.3):
   * CHECK `vehicle_trailers_hitch_alive_check` не допускает удалённого за машиной, и запрет
   * означал бы «сначала отцепите» — лишний шаг ровно там, где человек уже решил.
   *
   * Порядок захвата — общий (шаги 1–4): удаление прицепа и его перестановка спорят за те же строки.
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const removed = await db.transaction(async (tx) => {
        const trailer = await withHitchLocks(tx, unhitchScope(tx, id));
        if (!trailer || trailer.deletedAt) throw err.notFound('Прицеп не найден');
        const now = new Date();
        await tx
          .update(vehicleTrailers)
          .set({ ...UNHITCHED, deletedAt: now, updatedAt: now })
          .where(eq(vehicleTrailers.id, id));
        return trailer;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicleTrailer.delete',
        entityType: 'vehicleTrailer',
        entityId: id,
        metadata: {
          registrationNumber: removed.registrationNumber,
          unhitchedFromVehicleId: removed.hitchedVehicleId,
        },
      });
      return { ok: true };
    },
  );

  /**
   * Восстановление из архива — работа администратора (ADR 0021), а не обычная правка справочника.
   *
   * Привязку **не возвращает**, и это решение: пока прицеп лежал в архиве, слот мог занять другой,
   * и «вернуть как было» упёрлось бы в `UNIQUE` ровно в тот момент, когда человек меньше всего
   * ждёт отказа. Возвращённый прицеп стоит ни за кем, и куда его поставить — отдельное решение.
   *
   * Госномер сверяется заново: уникальность считается только среди живых, и пока запись лежала в
   * архиве, номер мог занять другой прицеп.
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
        const ex = await readTrailerRow(tx, id);
        if (!ex) throw err.notFound('Прицеп не найден');
        // Восстановление живой записи — не ошибка, но и не событие: журналу нечего о нём сказать.
        if (!ex.deletedAt) return false;
        await assertRegUnique(tx, ex.registrationNumber, id);
        await tx
          .update(vehicleTrailers)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(eq(vehicleTrailers.id, id));
        return true;
      });
      if (restored) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicleTrailer.restore',
          entityType: 'vehicleTrailer',
          entityId: id,
        });
      }
      return (await getById(id))!;
    },
  );

  // Удаление насовсем (ADR 0060) — только из архива, вторым шагом после обычного удаления. Ссылок
  // на прицеп сегодня не держит никто: рейс и лист хранят текст-снимок, а не ключ (план §4.5), —
  // но общий модуль всё равно переведёт будущий отказ внешнего ключа в понятный 409.
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(vehicleTrailers).where(eq(vehicleTrailers.id, id));
      return row;
    },
    isDown: (row) => !!row.deletedAt,
    remove: async (tx, row) => {
      await tx.delete(vehicleTrailers).where(eq(vehicleTrailers.id, row.id));
    },
    notFound: 'Прицеп не найден',
    stillLive: 'Прицеп не в архиве — сначала удалите его',
    subject: 'прицеп',
    audit: {
      action: 'vehicleTrailer.purge',
      entityType: 'vehicleTrailer',
      metadata: (row) => ({
        registrationNumber: row.registrationNumber,
        model: row.model,
        kind: row.kind,
      }),
    },
  });
}
