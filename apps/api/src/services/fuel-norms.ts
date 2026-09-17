import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  FUEL_NORM_DEFAULTS,
  type FuelNormSettingsDto,
  type VehicleFuelNormDto,
  vehicleLabel,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  fuelNormSettings,
  persons,
  users,
  vehicleCategories,
  vehicleFuelNorms,
  vehicleModels,
  vehicles,
  vehicleTypes,
} from '../db/schema';

/**
 * Нормы расхода топлива: чтение справочника и настроек сверки (план `docs/fuel-norms-plan.md`,
 * §2; таблицы — миграция 0314).
 *
 * Здесь живёт **чтение**, которым пользуются и окно справочника, и расчёт сверки. Запись —
 * в `routes/fuel-norms.ts`: у справочника она короткая и ничем не отличается от соседей по модулю.
 *
 * Главное решение файла: **настройки читаются один раз и передаются дальше значением** — и в
 * SQL расчёта (границы сезона), и в ответ порталу (допуск, Р12б). Второго чтения в запросе нет
 * намеренно: соединение с одиночкой внутри тяжёлого агрегата стоило бы строки плана ради двух
 * чисел, которые и так уже прочитаны, а разойтись с ответом они не имеют права — иначе экран
 * красит превышение одним допуском, а книга считает другим.
 */

export interface FuelNormSeason {
  /** `MM-DD`: начало и конец зимнего периода. Через Новый год — обычное его состояние. */
  winterFromMd: string;
  winterToMd: string;
  tolerancePercent: number;
}

/**
 * Настройки сверки. Строку сеет миграция, но отсутствие её не должно ронять сводку парка: пустая
 * таблица — это состояние свежей базы и db-теста, а не ошибка. Умолчания берутся из контрактов —
 * оттуда же, откуда их взяла миграция, и второго списка этих чисел в проекте нет.
 */
export async function loadFuelNormSeason(): Promise<FuelNormSeason> {
  const [row] = await db.select().from(fuelNormSettings).limit(1);
  return {
    winterFromMd: row?.winterFromMd ?? FUEL_NORM_DEFAULTS.winterFromMd,
    winterToMd: row?.winterToMd ?? FUEL_NORM_DEFAULTS.winterToMd,
    tolerancePercent: Number(row?.tolerancePercent ?? FUEL_NORM_DEFAULTS.tolerancePercent),
  };
}

/** То же плюс реквизиты последней правки: окну нужен ответ на «кто менял допуск». */
export async function loadFuelNormSettings(): Promise<FuelNormSettingsDto> {
  const [row] = await db
    .select({
      winterFromMd: fuelNormSettings.winterFromMd,
      winterToMd: fuelNormSettings.winterToMd,
      tolerancePercent: fuelNormSettings.tolerancePercent,
      updatedAt: fuelNormSettings.updatedAt,
      updatedByName: persons.fullName,
    })
    .from(fuelNormSettings)
    .leftJoin(users, eq(users.id, fuelNormSettings.updatedBy))
    .leftJoin(persons, eq(persons.id, users.personId))
    .limit(1);
  return {
    winterFromMd: row?.winterFromMd ?? FUEL_NORM_DEFAULTS.winterFromMd,
    winterToMd: row?.winterToMd ?? FUEL_NORM_DEFAULTS.winterToMd,
    tolerancePercent: Number(row?.tolerancePercent ?? FUEL_NORM_DEFAULTS.tolerancePercent),
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
    updatedByName: row?.updatedByName ?? null,
  };
}

/**
 * Машины, у которых есть хотя бы одна живая версия нормы, действующая не позже конца периода
 * (Р15а). Признак отвечает на вопрос «норму не заводили» и отличает его от «нормы есть, но сверять
 * нечего»: с виду оба состояния — прочерк, а требования у них к разным людям.
 *
 * Считается отдельным запросом по машинам ответа, а не боковым соединением расчёта, и причина
 * жёсткая: у машины, попавшей в сводку одними ожидаемыми сменами, строк показаний нет вовсе, и
 * соединение внутри проекции чисел дало бы ложное «нормы не заведено» там, где она заведена.
 */
export async function loadVehiclesWithNorm(
  vehicleIds: readonly string[],
  on: string,
): Promise<Set<string>> {
  if (vehicleIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ vehicleId: vehicleFuelNorms.vehicleId })
    .from(vehicleFuelNorms)
    .where(
      and(
        sql`${vehicleFuelNorms.vehicleId} = ANY(${sql.param(vehicleIds)}::uuid[])`,
        isNull(vehicleFuelNorms.deletedAt),
        sql`${vehicleFuelNorms.effectiveFrom} <= ${on}::date`,
      ),
    );
  return new Set(rows.map((r) => r.vehicleId));
}

/** Строка справочника с подписью машины — той же, какой её зовут сводка и гараж. */
type NormRow = typeof vehicleFuelNorms.$inferSelect & {
  ownership: (typeof vehicles.$inferSelect)['ownership'];
  description: string;
  registrationNumber: string | null;
  categoryName: string | null;
  typeName: string;
  modelName: string | null;
  isCurrent: boolean;
};

export function toFuelNormDto(row: NormRow): VehicleFuelNormDto {
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    vehicleLabel: vehicleLabel({
      ownership: row.ownership,
      description: row.description,
      registrationNumber: row.registrationNumber,
      categoryName: row.categoryName,
      typeName: row.typeName,
      modelName: row.modelName,
    }),
    registrationNumber: row.registrationNumber,
    effectiveFrom: row.effectiveFrom,
    unit: row.unit,
    winterRate: Number(row.winterRate),
    summerRate: Number(row.summerRate),
    fuelType: row.fuelType,
    note: row.note,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Список версий справочника. `isCurrent` считает сервер: «действующая» — живая запись машины с
 * наибольшей наступившей датой, и решать это окну нельзя, иначе экран и расчёт разойдутся на первом
 * же приказе задним числом.
 *
 * Оконная функция, а не боковой запрос на строку: версий у машины единицы, а строк на экране
 * сотни, и латераль на каждую означала бы сотню одинаковых поисков максимума.
 */
export function fuelNormSelection() {
  return {
    id: vehicleFuelNorms.id,
    vehicleId: vehicleFuelNorms.vehicleId,
    effectiveFrom: vehicleFuelNorms.effectiveFrom,
    unit: vehicleFuelNorms.unit,
    winterRate: vehicleFuelNorms.winterRate,
    summerRate: vehicleFuelNorms.summerRate,
    fuelType: vehicleFuelNorms.fuelType,
    note: vehicleFuelNorms.note,
    createdBy: vehicleFuelNorms.createdBy,
    createdAt: vehicleFuelNorms.createdAt,
    updatedBy: vehicleFuelNorms.updatedBy,
    updatedAt: vehicleFuelNorms.updatedAt,
    deletedAt: vehicleFuelNorms.deletedAt,
    deletedBy: vehicleFuelNorms.deletedBy,
    ownership: vehicles.ownership,
    description: vehicles.description,
    registrationNumber: vehicles.registrationNumber,
    categoryName: vehicleCategories.name,
    typeName: vehicleTypes.name,
    modelName: vehicleModels.name,
    /**
     * Действующая сегодня версия машины. `CURRENT_DATE` — дата базы: сезон и действие приказа
     * считаются календарными сутками, и час сервера здесь ничего не решает.
     */
    isCurrent: sql<boolean>`${vehicleFuelNorms.effectiveFrom} <= CURRENT_DATE
      AND ${vehicleFuelNorms.effectiveFrom} = max(${vehicleFuelNorms.effectiveFrom})
        FILTER (WHERE ${vehicleFuelNorms.effectiveFrom} <= CURRENT_DATE)
        OVER (PARTITION BY ${vehicleFuelNorms.vehicleId})`,
  };
}

/**
 * Порядок справочника: госномер, как во всех перечнях парка, а внутри машины — свежая версия
 * сверху. История приказов читается сверху вниз, а не наоборот.
 */
export const fuelNormOrder = [
  asc(vehicles.registrationNumberNormalized),
  desc(vehicleFuelNorms.effectiveFrom),
];
