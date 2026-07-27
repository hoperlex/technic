import { and, eq, or } from 'drizzle-orm';
import {
  type RequestType,
  type ResolvedWasteTariffDto,
  isPricedRequestType,
  isVolumeAllowed,
  volumeStepMessage,
} from '@technic/contracts';
import { db } from '../db/client';
import { containerTypes, wasteTariffs } from '../db/schema';
import { err } from '../lib/errors';

/** numeric приходит из pg строкой — DTO и расчёты работают с числом. */
export function toNum(v: string | null): number | null {
  return v == null ? null : Number(v);
}

/**
 * Подбор тарифа под пару «тип мусора × тип машины/контейнера» (ADR 0009).
 * Точный тариф по типу контейнера побеждает тариф вида техники: так выражается прайсовое
 * «контейнерами — 1500 ₽/м³, кроме контейнера 8 м³ — 15 000 ₽ за контейнер».
 * Возвращает null, если для пары прайс не задан.
 */
export async function resolveWasteTariff(
  wasteTypeId: string,
  containerTypeId: string,
): Promise<ResolvedWasteTariffDto | null> {
  const [containerType] = await db
    .select({
      id: containerTypes.id,
      kind: containerTypes.type,
      volumeM3: containerTypes.volumeM3,
    })
    .from(containerTypes)
    .where(eq(containerTypes.id, containerTypeId));
  if (!containerType) throw err.notFound('Тип машины/контейнера не найден');

  const candidates = await db
    .select()
    .from(wasteTariffs)
    .where(
      and(
        eq(wasteTariffs.wasteTypeId, wasteTypeId),
        eq(wasteTariffs.isActive, true),
        or(
          eq(wasteTariffs.containerTypeId, containerTypeId),
          eq(wasteTariffs.containerKind, containerType.kind),
        ),
      ),
    );

  const tariff =
    candidates.find((t) => t.containerTypeId === containerTypeId) ??
    candidates.find((t) => t.containerKind === containerType.kind);
  if (!tariff) return null;

  // Тариф «за контейнер» опирается на вместимость: без неё кратность не проверить.
  if (tariff.isPerContainer && containerType.volumeM3 == null) {
    throw err.unprocessable(
      'Тариф задан за контейнер, но вместимость типа не указана в справочнике',
    );
  }

  return {
    tariffId: tariff.id,
    wasteTypeId,
    containerTypeId,
    pricePerM3: Number(tariff.pricePerM3),
    isPerContainer: tariff.isPerContainer,
    containerVolumeM3: containerType.volumeM3,
    volumeStepM3: tariff.isPerContainer ? containerType.volumeM3 : null,
    matchedBy: tariff.containerTypeId === containerTypeId ? 'container_type' : 'container_kind',
  };
}

export interface PricingSnapshot {
  wasteTariffId: string | null;
  pricePerM3: string | null;
}

/**
 * Снимок цены для сохранения в заявке. Для нетарифицируемой операции (установка контейнера)
 * возвращает пустой снимок — так поля цены гарантированно очищаются при смене типа заявки.
 * Сумму заявки считает БД (generated-колонка `amount`).
 */
export async function priceWasteRequest(input: {
  requestType: RequestType;
  wasteTypeId: string | null;
  containerTypeId: string | null;
  volumeM3: number | null;
}): Promise<PricingSnapshot> {
  if (!isPricedRequestType(input.requestType)) {
    return { wasteTariffId: null, pricePerM3: null };
  }
  if (!input.wasteTypeId || !input.containerTypeId || input.volumeM3 == null) {
    throw err.validation({
      wasteTypeId: 'Для расчёта нужны тип мусора, тип машины/контейнера и объём',
    });
  }

  const resolved = await resolveWasteTariff(input.wasteTypeId, input.containerTypeId);
  if (!resolved) {
    throw err.unprocessable('Для выбранного типа мусора и техники тариф не задан', {
      wasteTypeId: 'Тариф не найден',
    });
  }
  if (!isVolumeAllowed(input.volumeM3, resolved.volumeStepM3)) {
    throw err.validation({ volumeM3: volumeStepMessage(resolved.volumeStepM3!) });
  }

  return { wasteTariffId: resolved.tariffId, pricePerM3: String(resolved.pricePerM3) };
}
