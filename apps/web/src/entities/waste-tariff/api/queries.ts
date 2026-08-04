import { queryOptions } from '@tanstack/react-query';
import { wasteTariffsApi, type WasteTariffTarget } from './wasteTariffsApi';
import { wasteTariffKeys } from './keys';

/**
 * Подбор цены под пару «тип мусора × техника»: предпросмотр в форме заявки и цена-основание при её
 * закрытии, если снимка тарифа в заявке нет. Оба места спрашивают одной ручкой намеренно — правило
 * подбора должно быть одно и то же на форму, на закрытие и на сервер (ADR 0022, ADR 0026).
 *
 * `enabled` оставлен вызывающему: спрашивать цену стоит не всегда — заявка может быть
 * нетарифицируемой (контейнерная операция), а у закрытой обычно уже есть свой снимок цены. Условие
 * это знает экран, а не слайс; тип мусора при этом обязан быть выбран — без него запрос
 * бессмысленен.
 */
export const wasteTariffResolveQuery = ({
  wasteTypeId,
  target,
  operatorCounterpartyId = null,
}: {
  wasteTypeId: string | null | undefined;
  target: WasteTariffTarget;
  operatorCounterpartyId?: string | null;
}) =>
  queryOptions({
    queryKey: wasteTariffKeys.resolve({
      wasteTypeId: wasteTypeId ?? null,
      target,
      operatorCounterpartyId: operatorCounterpartyId ?? null,
    }),
    queryFn: () => wasteTariffsApi.resolve(wasteTypeId!, target, operatorCounterpartyId),
  });
