import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, ne } from 'drizzle-orm';
import {
  type ContainerKind,
  createWasteTariffSchema,
  pricePerM3FromContainer,
  updateWasteTariffSchema,
  validateWasteTariff,
  validateWasteTypeChoice,
  type WasteTariffDefinition,
  type WasteTariffDto,
  resolveWasteTariffQuerySchema,
  wasteTariffListQuerySchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { containerTypes, wasteTariffs, wasteTypes } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams } from '../lib/pagination';
import { resolveWasteTariff } from '../services/waste-pricing';
import { asWasteTypeNameConflict, createWasteType } from '../services/waste-types';

const dtoColumns = {
  id: wasteTariffs.id,
  wasteTypeId: wasteTariffs.wasteTypeId,
  wasteTypeName: wasteTypes.name,
  containerTypeId: wasteTariffs.containerTypeId,
  containerTypeName: containerTypes.name,
  containerVolumeM3: containerTypes.volumeM3,
  containerKind: wasteTariffs.containerKind,
  pricePerM3: wasteTariffs.pricePerM3,
  pricePerContainer: wasteTariffs.pricePerContainer,
  isPerContainer: wasteTariffs.isPerContainer,
  note: wasteTariffs.note,
  isActive: wasteTariffs.isActive,
};

/** Строка выборки `dtoColumns`: колонки типа контейнера приходят из leftJoin, поэтому nullable. */
interface DtoRow {
  id: string;
  wasteTypeId: string;
  wasteTypeName: string;
  containerTypeId: string | null;
  containerTypeName: string | null;
  containerVolumeM3: number | null;
  containerKind: ContainerKind | null;
  pricePerM3: string;
  pricePerContainer: string | null;
  isPerContainer: boolean;
  note: string;
  isActive: boolean;
}

function toDto(t: DtoRow): WasteTariffDto {
  return {
    id: t.id,
    wasteTypeId: t.wasteTypeId,
    wasteTypeName: t.wasteTypeName,
    containerTypeId: t.containerTypeId,
    containerTypeName: t.containerTypeName,
    containerVolumeM3: t.containerVolumeM3,
    containerKind: t.containerKind,
    pricePerM3: Number(t.pricePerM3),
    pricePerContainer: t.pricePerContainer == null ? null : Number(t.pricePerContainer),
    isPerContainer: t.isPerContainer,
    note: t.note,
    isActive: t.isActive,
  };
}

const idParams = z.object({ id: z.string().uuid() });

/** Позиция прайса после проверок — в том виде, в каком ложится в строку таблицы. */
interface TariffValues {
  wasteTypeId: string;
  containerTypeId: string | null;
  containerKind: ContainerKind | null;
  pricePerM3: string;
  pricePerContainer: string | null;
  isPerContainer: boolean;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающее соединение: подходит и пул, и транзакция. */
type Reader = Pick<Tx, 'select'>;

/**
 * Проверяет позицию и выводит хранимые цены. Цену за м³ у позиции «за контейнер» считает сервер
 * из вместимости типа (ADR 0009): вводится одна цена, вторая — производная, разойтись им негде.
 * `excludeId` — id правимой позиции: она сама не считается дублем.
 */
async function prepareValues(
  conn: Reader,
  input: WasteTariffDefinition & { wasteTypeId: string },
  excludeId?: string,
): Promise<TariffValues> {
  const fields = validateWasteTariff(input);
  if (Object.keys(fields).length > 0) throw err.validation(fields);

  const [wasteType] = await conn
    .select({ id: wasteTypes.id })
    .from(wasteTypes)
    .where(eq(wasteTypes.id, input.wasteTypeId));
  if (!wasteType) throw err.validation({ wasteTypeId: 'Тип мусора не найден' });

  let containerVolumeM3: number | null = null;
  if (input.containerTypeId) {
    const [containerType] = await conn
      .select({ volumeM3: containerTypes.volumeM3 })
      .from(containerTypes)
      .where(eq(containerTypes.id, input.containerTypeId));
    if (!containerType) {
      throw err.validation({ containerTypeId: 'Тип машины/контейнера не найден' });
    }
    containerVolumeM3 = containerType.volumeM3;
  }

  // Дальше цены уже согласованы с режимом тарификации — это гарантирует validateWasteTariff.
  let pricePerM3: number;
  let pricePerContainer: number | null = null;
  if (input.isPerContainer) {
    // Без вместимости не вывести ни цену за м³, ни кратность объёма в заявке.
    if (containerVolumeM3 == null) {
      throw err.validation({
        containerTypeId: 'У типа не задана вместимость — цену за контейнер задать нельзя',
      });
    }
    pricePerContainer = input.pricePerContainer!;
    pricePerM3 = pricePerM3FromContainer(pricePerContainer, containerVolumeM3);
  } else {
    pricePerM3 = input.pricePerM3!;
  }

  // Пара «тип мусора × техника» разрешается однозначно, поэтому вторая позиция на ту же пару —
  // не новая цена, а спор двух цен. Частичные UNIQUE в БД это же ловят кодом 23505 без пояснения.
  const dupWhere = and(
    eq(wasteTariffs.wasteTypeId, input.wasteTypeId),
    input.containerTypeId
      ? eq(wasteTariffs.containerTypeId, input.containerTypeId)
      : eq(wasteTariffs.containerKind, input.containerKind!),
    excludeId ? ne(wasteTariffs.id, excludeId) : undefined,
  );
  const dup = await conn.select({ id: wasteTariffs.id }).from(wasteTariffs).where(dupWhere);
  if (dup.length > 0) {
    throw err.conflict('Тариф для этой пары уже задан — измените цену в существующей позиции');
  }

  return {
    wasteTypeId: input.wasteTypeId,
    containerTypeId: input.containerTypeId,
    containerKind: input.containerKind,
    pricePerM3: String(pricePerM3),
    pricePerContainer: pricePerContainer == null ? null : String(pricePerContainer),
    isPerContainer: input.isPerContainer,
  };
}

async function loadDto(id: string): Promise<WasteTariffDto> {
  const [row] = await db
    .select(dtoColumns)
    .from(wasteTariffs)
    .innerJoin(wasteTypes, eq(wasteTariffs.wasteTypeId, wasteTypes.id))
    .leftJoin(containerTypes, eq(wasteTariffs.containerTypeId, containerTypes.id))
    .where(eq(wasteTariffs.id, id));
  if (!row) throw err.notFound('Тариф не найден');
  return toDto(row);
}

// Прайс вывоза мусора (ADR 0009). Читают все, кто видит заявки; ведут — администратор и менеджер
// (ADR 0014). Правка цены не переписывает оформленные суммы: в заявке остаётся снимок тарифа.
export default async function wasteTariffsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  // ── Подбор тарифа под пару «тип мусора × техника» (предпросмотр цены в форме заявки) ──
  // Объявлен до '/:id'-подобных маршрутов не случайно: статический сегмент должен матчиться первым.
  r.get(
    '/resolve',
    { preHandler: [app.authenticate], schema: { querystring: resolveWasteTariffQuerySchema } },
    async (req) => {
      const { wasteTypeId, containerTypeId } = req.query;
      const resolved = await resolveWasteTariff(wasteTypeId, containerTypeId);
      if (!resolved) throw err.notFound('Тариф для выбранной пары не задан');
      return resolved;
    },
  );

  // ── Список тарифов ──
  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: wasteTariffListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.wasteTypeId ? eq(wasteTariffs.wasteTypeId, q.wasteTypeId) : undefined,
        q.containerTypeId ? eq(wasteTariffs.containerTypeId, q.containerTypeId) : undefined,
        q.isActive === undefined ? undefined : eq(wasteTariffs.isActive, q.isActive),
      );
      const sortCols = {
        wasteTypeName: wasteTypes.name,
        pricePerM3: wasteTariffs.pricePerM3,
        isActive: wasteTariffs.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns)
          .from(wasteTariffs)
          .innerJoin(wasteTypes, eq(wasteTariffs.wasteTypeId, wasteTypes.id))
          .leftJoin(containerTypes, eq(wasteTariffs.containerTypeId, containerTypes.id))
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'wasteTypeName'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(wasteTariffs).where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  // ── Новая позиция прайса (и, если тип назван, сам тип мусора) ──
  // Тип и цена заводятся одной транзакцией (ADR 0017): отдельного шага «сначала тип» нет, иначе
  // брошенная на полпути форма оставляла бы тип без цены — невидимый в заявках и неправимый,
  // потому что интерфейс типа живёт в строке тарифа.
  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createWasteTariffSchema } },
    async (req, reply) => {
      const b = req.body;
      const choice = validateWasteTypeChoice(b);
      if (Object.keys(choice).length > 0) throw err.validation(choice);

      const { tariff, newType } = await db
        .transaction(async (tx) => {
          const type = b.wasteTypeName ? await createWasteType(tx, b.wasteTypeName) : null;
          const values = await prepareValues(tx, {
            wasteTypeId: type?.id ?? b.wasteTypeId!,
            containerTypeId: b.containerTypeId ?? null,
            containerKind: b.containerKind ?? null,
            pricePerM3: b.pricePerM3 ?? null,
            pricePerContainer: b.pricePerContainer ?? null,
            isPerContainer: b.isPerContainer,
          });
          const [created] = await tx
            .insert(wasteTariffs)
            .values({ ...values, note: b.note, isActive: b.isActive })
            .returning();
          return { tariff: created!, newType: type };
        })
        .catch((e: unknown) => {
          throw asWasteTypeNameConflict(e, 'wasteTypeName');
        });

      const actorUserId = requirePrincipal(req).id;
      if (newType) {
        await writeAudit({
          actorUserId,
          action: 'waste_type.create',
          entityType: 'waste_type',
          entityId: newType.id,
          metadata: { code: newType.code, name: newType.name, tariffId: tariff.id },
        });
      }
      await writeAudit({
        actorUserId,
        action: 'waste_tariff.create',
        entityType: 'waste_tariff',
        entityId: tariff.id,
        metadata: {
          wasteTypeId: tariff.wasteTypeId,
          containerTypeId: tariff.containerTypeId,
          containerKind: tariff.containerKind,
          pricePerM3: tariff.pricePerM3,
          pricePerContainer: tariff.pricePerContainer,
          isPerContainer: tariff.isPerContainer,
        },
      });
      reply.code(201);
      return loadDto(tariff.id);
    },
  );

  // ── Правка позиции ──
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateWasteTariffSchema },
    },
    async (req) => {
      const b = req.body;
      const [current] = await db
        .select()
        .from(wasteTariffs)
        .where(eq(wasteTariffs.id, req.params.id));
      if (!current) throw err.notFound('Тариф не найден');

      // Патч накладывается на сохранённую позицию, и проверяется результат целиком: инварианты
      // прайса кросс-полевые, по отдельным полям их не проверить.
      const isPerContainer = b.isPerContainer ?? current.isPerContainer;
      const values = await prepareValues(
        db,
        {
          wasteTypeId: b.wasteTypeId ?? current.wasteTypeId,
          containerTypeId:
            b.containerTypeId === undefined ? current.containerTypeId : (b.containerTypeId ?? null),
          containerKind:
            b.containerKind === undefined ? current.containerKind : (b.containerKind ?? null),
          pricePerM3:
            b.pricePerM3 === undefined ? Number(current.pricePerM3) : (b.pricePerM3 ?? null),
          pricePerContainer:
            b.pricePerContainer === undefined
              ? current.pricePerContainer == null
                ? null
                : Number(current.pricePerContainer)
              : (b.pricePerContainer ?? null),
          isPerContainer,
        },
        current.id,
      );

      const [updated] = await db
        .update(wasteTariffs)
        .set({
          ...values,
          ...(b.note === undefined ? {} : { note: b.note }),
          ...(b.isActive === undefined ? {} : { isActive: b.isActive }),
          updatedAt: new Date(),
        })
        .where(eq(wasteTariffs.id, current.id))
        .returning();

      const action =
        b.isActive === false
          ? 'waste_tariff.deactivate'
          : b.isActive === true
            ? 'waste_tariff.activate'
            : 'waste_tariff.update';
      // История цен ведётся аудитом: снимок «было → стало» — единственный след правки прайса.
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action,
        entityType: 'waste_tariff',
        entityId: current.id,
        metadata: {
          before: {
            pricePerM3: current.pricePerM3,
            pricePerContainer: current.pricePerContainer,
            isPerContainer: current.isPerContainer,
            isActive: current.isActive,
          },
          after: {
            pricePerM3: updated!.pricePerM3,
            pricePerContainer: updated!.pricePerContainer,
            isPerContainer: updated!.isPerContainer,
            isActive: updated!.isActive,
          },
        },
      });
      return loadDto(current.id);
    },
  );
}
