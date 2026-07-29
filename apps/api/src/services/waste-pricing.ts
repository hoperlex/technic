import { and, eq, or } from 'drizzle-orm';
import {
  type ContainerKind,
  type RequestType,
  type ResolvedWasteTariffDto,
  WASTE_REMOVAL_CONTAINER_KIND,
  isPricedRequestType,
  isVolumeAllowed,
  pickWasteTariff,
  volumeStepMessage,
} from '@technic/contracts';
import { db } from '../db/client';
import { containerTypes, counterparties, wasteTariffs } from '../db/schema';
import { err } from '../lib/errors';

/** numeric приходит из pg строкой — DTO и расчёты работают с числом. */
export function toNum(v: string | null): number | null {
  return v == null ? null : Number(v);
}

/** Позиция прайса вместе с именем владельца — то, чем оперирует подбор. */
const candidateColumns = {
  id: wasteTariffs.id,
  operatorCounterpartyId: wasteTariffs.operatorCounterpartyId,
  operatorName: counterparties.name,
  containerTypeId: wasteTariffs.containerTypeId,
  containerKind: wasteTariffs.containerKind,
  pricePerM3: wasteTariffs.pricePerM3,
  isPerContainer: wasteTariffs.isPerContainer,
};

interface CandidateRow {
  id: string;
  operatorCounterpartyId: string;
  operatorName: string;
  containerTypeId: string | null;
  containerKind: ContainerKind | null;
  pricePerM3: string;
  isPerContainer: boolean;
}

/**
 * Действующие позиции прайса на тип мусора, подходящие по технике. Неактивный оператор из
 * подбора выпадает вместе со своими ценами: назначить его исполнителем всё равно нельзя, а в
 * минимум он бы вошёл и занизил цену «от».
 */
async function loadCandidates(
  wasteTypeId: string,
  target: { containerTypeId?: string | null; containerKind: ContainerKind },
): Promise<(Omit<CandidateRow, 'pricePerM3'> & { pricePerM3: number })[]> {
  const rows: CandidateRow[] = await db
    .select(candidateColumns)
    .from(wasteTariffs)
    .innerJoin(counterparties, eq(wasteTariffs.operatorCounterpartyId, counterparties.id))
    .where(
      and(
        eq(wasteTariffs.wasteTypeId, wasteTypeId),
        eq(wasteTariffs.isActive, true),
        eq(counterparties.isActive, true),
        target.containerTypeId
          ? or(
              eq(wasteTariffs.containerTypeId, target.containerTypeId),
              eq(wasteTariffs.containerKind, target.containerKind),
            )
          : eq(wasteTariffs.containerKind, target.containerKind),
      ),
    );
  return rows.map((r) => ({ ...r, pricePerM3: Number(r.pricePerM3) }));
}

/**
 * Подбор тарифа по одному лишь виду техники (ADR 0022): заявка на вывоз мусора заказывает
 * объём, а не машину, поэтому конкретного типа у неё нет — цену даёт прайсовая строка на вид
 * («вывоз самосвалами — 850 ₽/м³»). Тариф «за контейнер» сюда не попадает по построению: он
 * задаётся только на конкретный тип (`validateWasteTariff`), а значит и кратности объёма нет.
 * Оператор выбирает, чей прайс применить; без него берётся минимальная цена (ADR 0026).
 * Возвращает null, если для пары прайс не задан.
 */
export async function resolveWasteTariffByKind(
  wasteTypeId: string,
  containerKind: ContainerKind,
  operatorCounterpartyId: string | null = null,
): Promise<ResolvedWasteTariffDto | null> {
  const candidates = await loadCandidates(wasteTypeId, { containerKind });
  const picked = pickWasteTariff(candidates, { operatorCounterpartyId });
  if (!picked) return null;

  return {
    tariffId: picked.tariff.id,
    wasteTypeId,
    containerTypeId: null,
    operatorCounterpartyId: picked.tariff.operatorCounterpartyId,
    operatorName: picked.tariff.operatorName,
    isMinimum: picked.isMinimum,
    pricePerM3: picked.tariff.pricePerM3,
    isPerContainer: picked.tariff.isPerContainer,
    containerVolumeM3: null,
    volumeStepM3: null,
    matchedBy: 'container_kind',
  };
}

/**
 * Подбор тарифа под пару «тип мусора × тип машины/контейнера» (ADR 0009).
 * Точный тариф по типу контейнера побеждает тариф вида техники: так выражается прайсовое
 * «контейнерами — 1500 ₽/м³, кроме контейнера 8 м³ — 15 000 ₽ за контейнер».
 * Между операторами выбор тот же, что и в подборе по виду (ADR 0026).
 * Возвращает null, если для пары прайс не задан.
 */
export async function resolveWasteTariff(
  wasteTypeId: string,
  containerTypeId: string,
  operatorCounterpartyId: string | null = null,
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

  const candidates = await loadCandidates(wasteTypeId, {
    containerTypeId,
    containerKind: containerType.kind,
  });
  const picked = pickWasteTariff(candidates, { operatorCounterpartyId, containerTypeId });
  if (!picked) return null;
  const tariff = picked.tariff;

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
    operatorCounterpartyId: tariff.operatorCounterpartyId,
    operatorName: tariff.operatorName,
    isMinimum: picked.isMinimum,
    pricePerM3: tariff.pricePerM3,
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
 * Снимок цены для сохранения в заявке. Тарифицируется один вывоз мусора, и техники у него нет
 * (ADR 0022) — цена берётся по виду «Самосвал». Прайс у каждого оператора свой (ADR 0026):
 * пока исполнитель не назначен, в заявку ложится самая дешёвая позиция — цена «от», которую
 * назначение оператора уточнит. Для нетарифицируемой операции (любая контейнерная — установка,
 * замена, снятие; ADR 0019) снимок пустой: так поля цены гарантированно очищаются при смене типа
 * заявки. Сумму считает БД (generated-колонка `amount`).
 */
export async function priceWasteRequest(input: {
  requestType: RequestType;
  wasteTypeId: string | null;
  volumeM3: number | null;
  operatorCounterpartyId: string | null;
}): Promise<PricingSnapshot> {
  if (!isPricedRequestType(input.requestType)) {
    return { wasteTariffId: null, pricePerM3: null };
  }
  if (!input.wasteTypeId || input.volumeM3 == null) {
    throw err.validation({
      wasteTypeId: 'Для расчёта нужны тип мусора и объём',
    });
  }

  const resolved = await resolveWasteTariffByKind(
    input.wasteTypeId,
    WASTE_REMOVAL_CONTAINER_KIND,
    input.operatorCounterpartyId,
  );
  if (!resolved) {
    // Разные причины — разные подсказки: у назначенного оператора цены может не быть вовсе,
    // и тогда правится прайс, а не заявка.
    throw input.operatorCounterpartyId
      ? err.unprocessable('У выбранного оператора не задана цена на этот тип мусора', {
          operatorCounterpartyId: 'Тариф оператора не найден',
        })
      : err.unprocessable('Для выбранного типа мусора тариф на вывоз не задан', {
          wasteTypeId: 'Тариф не найден',
        });
  }
  if (!isVolumeAllowed(input.volumeM3, resolved.volumeStepM3)) {
    throw err.validation({ volumeM3: volumeStepMessage(resolved.volumeStepM3!) });
  }

  return { wasteTariffId: resolved.tariffId, pricePerM3: String(resolved.pricePerM3) };
}
