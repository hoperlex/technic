import type {
  ContainerKind,
  CreateWasteTariffInput,
  ResolveWasteTariffResultDto,
  UpdateWasteTariffInput,
  WasteTariffDto,
} from '@technic/contracts';
import { apiFetch, createListApi, createWriteApi } from '@shared/api';

/**
 * Чему назначается цена: конкретному типу техники из справочника либо виду техники целиком
 * («любой самосвал»). Тип-объединение, а не два необязательных поля: ровно одна из целей
 * обязательна, и «ни одной» или «обе сразу» на сервер уходить не должны (ADR 0022).
 */
export type WasteTariffTarget = { containerTypeId: string } | { containerKind: ContainerKind };

/**
 * Прайс вывоза мусора (ADR 0009, ведение — ADR 0014, 0017): пара «что вывозим × чем вывозим» →
 * цена. Цена принадлежит оператору (ADR 0026), поэтому позиция прайса всегда чья-то.
 *
 * Правка цены не переписывает суммы оформленных заявок: в них снимок применённого тарифа.
 * Удаления по той же причине нет вовсе — на позицию ссылаются эти снимки, цена выбывает через
 * `update({ isActive: false })`, а отключённую сносит насовсем администратор (ADR 0060).
 */
export const wasteTariffsApi = {
  ...createListApi<WasteTariffDto>('/waste-tariffs'),
  ...createWriteApi<WasteTariffDto, CreateWasteTariffInput, UpdateWasteTariffInput>(
    '/waste-tariffs',
  ),
  /**
   * Тариф под пару «тип мусора × техника» — предпросмотр цены в форме заявки и цена-основание при
   * её закрытии. Цель подбора — либо конкретный тип из справочника, либо вид техники целиком:
   * вывоз мусора заказывает объём и машину не называет (ADR 0022). Оператор задан — цена его
   * прайса; не задан — минимальная среди операторов с пометкой `isMinimum` (цена «от», ADR 0026).
   * Незаданный прайс приходит как `{ tariff: null }`, а не ошибкой: сбой запроса форма показывает
   * иначе, чем отсутствие цены.
   */
  resolve: (
    wasteTypeId: string,
    target: WasteTariffTarget,
    operatorCounterpartyId?: string | null,
  ) =>
    apiFetch<ResolveWasteTariffResultDto>('/waste-tariffs/resolve', {
      query: {
        wasteTypeId,
        ...target,
        ...(operatorCounterpartyId ? { operatorCounterpartyId } : {}),
      },
    }),
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/waste-tariffs/${id}/purge`, { method: 'DELETE' }),
};
