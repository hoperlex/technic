import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, eq, exists, isNotNull, not, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  vehicleClassificationKey,
  vehicleClassificationListQuerySchema,
  type VehicleClassificationDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  vehicleCategories,
  vehicleKinds,
  vehicles,
  vehicleTypeSpecs,
  vehicleTypes,
} from '../db/schema';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

// Классификатор ТС одним списком: тип с категориями раскрыт в свои категории, тип без категорий
// остаётся сам собой. Правило «общий тип при наличии категорий не выводится» живёт здесь, а не
// в каждом экране: заявка, справочник техники и справочник типов обязаны отвечать на вопрос
// «что можно выбрать» одинаково.
//
// Своей таблицы у классификатора нет и быть не должно: это представление двух справочников
// (ADR 0005 + ADR 0016), а не третья сущность.

/** Категории типа для проверки «есть ли они вообще» — своим алиасом, чтобы не путать с LEFT JOIN. */
const typeCategories = alias(vehicleCategories, 'type_categories');

const specCount = sql<number>`(
  SELECT count(*) FROM ${vehicleTypeSpecs}
  WHERE ${vehicleTypeSpecs.vehicleTypeId} = ${vehicleTypes.id}
)`;

/** Что показывать человеку: наименование категории уже содержит тип (ADR 0016 §11). */
const label = sql<string>`coalesce(${vehicleCategories.name}, ${vehicleTypes.name})`;

/**
 * Порядок цены позиции: средняя ставка техники, которую по ней могут выдать. Отбор повторяет то,
 * что предложит форма перевода в работу (ADR 0027): активные машины заказанного типа, а у позиции
 * с категорией — ещё и её категории. Принадлежность не сужает — заказчику отвечают на «во сколько
 * обойдётся», а чьей машиной заявку закроют, на момент заказа неизвестно.
 *
 * Машины без ставки в среднее не идут: `avg` пропускает NULL сам, и знаменатель остаётся числом
 * машин с ценой. Своей колонки у среднего нет и не нужно — прайс живёт в реестре техники, а здесь
 * его читают.
 */
function avgPrice(
  column: typeof vehicles.pricePerHour | typeof vehicles.pricePerShift,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT avg(${column}) FROM ${vehicles}
    WHERE ${vehicles.vehicleTypeId} = ${vehicleTypes.id}
      AND (${vehicleCategories.id} IS NULL OR ${vehicles.vehicleCategoryId} = ${vehicleCategories.id})
      AND ${vehicles.status} = 'active'
      AND ${vehicles.deletedAt} IS NULL
  )`;
}

/** Активность позиции целиком: неактивный тип не даёт активных позиций. */
const activeExpr = sql<boolean>`(${vehicleTypes.isActive} AND coalesce(${vehicleCategories.isActive}, true))`;

export default async function vehicleClassificationsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Справочники читают все роли — без них не заполнить ни одну форму.
  const canRead = app.requirePermission('directories.read');

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: vehicleClassificationListQuerySchema },
    },
    async (req) => {
      const q = req.query;

      /**
       * Активность категории — условие соединения, а не фильтр строк. Разница важна: у типа,
       * где все категории выключены, `LEFT JOIN` с этим условием не найдёт ни одной и отдаст
       * строку самого типа. Тот же признак в `WHERE` отсёк бы её вместе с категориями, и тип
       * исчез бы из выбора совсем — хотя заказывать его по-прежнему можно.
       */
      const categoryJoin = and(
        eq(vehicleCategories.vehicleTypeId, vehicleTypes.id),
        q.isActive === true ? eq(vehicleCategories.isActive, true) : undefined,
      )!;

      /** «У типа есть категории» — с той же поправкой на активность, что и соединение. */
      const typeHasCategories = exists(
        db
          .select({ one: sql`1` })
          .from(typeCategories)
          .where(
            and(
              eq(typeCategories.vehicleTypeId, vehicleTypes.id),
              q.isActive === true ? eq(typeCategories.isActive, true) : undefined,
            ),
          ),
      );

      // LEFT JOIN + «строка типа только у типа без категорий» — это и есть плоский классификатор:
      // одна строка на категорию, одна на бескатегорийный тип, ни одной лишней.
      const where = and(
        or(isNotNull(vehicleCategories.id), not(typeHasCategories)),
        q.kindId ? eq(vehicleTypes.kindId, q.kindId) : undefined,
        q.vehicleTypeId ? eq(vehicleTypes.id, q.vehicleTypeId) : undefined,
        q.isActive === undefined ? undefined : eq(activeExpr, q.isActive),
        // Ищут по тому, что видно в списке, плюс по коду типа — им ищет тот, кто вёл справочник.
        searchCondition(q.search, [vehicleTypes.code, vehicleTypes.name, vehicleCategories.name]),
      );

      const sortCols = {
        kindName: vehicleKinds.name,
        label,
        sortOrder: vehicleTypes.sortOrder,
        isActive: activeExpr,
      };

      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select({
            vehicleTypeId: vehicleTypes.id,
            vehicleCategoryId: vehicleCategories.id,
            kindId: vehicleTypes.kindId,
            kindCode: vehicleKinds.code,
            kindName: vehicleKinds.name,
            typeCode: vehicleTypes.code,
            typeName: vehicleTypes.name,
            categoryName: vehicleCategories.name,
            label,
            specCount,
            avgPricePerHour: avgPrice(vehicles.pricePerHour),
            avgPricePerShift: avgPrice(vehicles.pricePerShift),
            isActive: activeExpr,
            typeIsActive: vehicleTypes.isActive,
            categoryIsActive: vehicleCategories.isActive,
            sortOrder: vehicleTypes.sortOrder,
            categorySortOrder: vehicleCategories.sortOrder,
          })
          .from(vehicleTypes)
          .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
          .leftJoin(vehicleCategories, categoryJoin)
          .where(where)
          // Категории внутри типа идут своим порядком, а не как легли в таблицу: «г/п 20 т»
          // раньше «г/п 25 т» — так их выстроил тот, кто вёл справочник.
          .orderBy(
            orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'),
            asc(vehicleTypes.name),
            asc(vehicleCategories.sortOrder),
            asc(vehicleCategories.name),
          )
          .limit(p.limit)
          .offset(p.offset),
        db
          .select({ c: count() })
          .from(vehicleTypes)
          .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
          .leftJoin(vehicleCategories, categoryJoin)
          .where(where),
      ]);

      const items: VehicleClassificationDto[] = rows.map((row) => ({
        key: vehicleClassificationKey(row.vehicleTypeId, row.vehicleCategoryId),
        vehicleTypeId: row.vehicleTypeId,
        vehicleCategoryId: row.vehicleCategoryId,
        kindId: row.kindId,
        kindCode: row.kindCode,
        kindName: row.kindName,
        typeCode: row.typeCode,
        typeName: row.typeName,
        categoryName: row.categoryName,
        label: row.label,
        specCount: Number(row.specCount),
        // numeric приходит из pg строкой; пустое среднее (ставок нет ни у одной машины) остаётся
        // null — «нет цены» и «ноль» для читателя списка разные ответы.
        avgPricePerHour: row.avgPricePerHour == null ? null : Number(row.avgPricePerHour),
        avgPricePerShift: row.avgPricePerShift == null ? null : Number(row.avgPricePerShift),
        isActive: row.isActive,
        typeIsActive: row.typeIsActive,
        categoryIsActive: row.categoryIsActive,
        sortOrder: row.sortOrder,
        categorySortOrder: row.categorySortOrder,
      }));

      return { items, total: Number(totalRows[0]!.c), page: p.page, pageSize: p.pageSize };
    },
  );
}
