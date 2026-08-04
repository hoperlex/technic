import { createQueryKeys } from '@shared/api';
import type { WasteTariffTarget } from './wasteTariffsApi';

/**
 * Ключи запросов прайса.
 *
 * Прайс спрашивают двумя разными вопросами, и ключи у них общего имеют только корень:
 *  - `grid` — весь прайс одной страницей под сводную таблицу «пара × операторы». Собрать строку из
 *    куска выборки нельзя: цены операторов приехали бы на разных страницах, поэтому в ключе стоят
 *    сужения справочника, а не номер страницы — постранично здесь ходят по уже собранным строкам;
 *  - `resolve` — цена одной пары «тип мусора × техника».
 *
 * В ключ подбора входит и цель (`target`): сегодня оба места спрашивают вид «Самосвал» (ADR 0022),
 * но цена конкретного типа контейнера — другой ответ на тот же вопрос, и без цели в ключе первый
 * же такой запрос получил бы чужую цену из кэша.
 */
export const wasteTariffKeys = createQueryKeys('waste-tariffs', {
  grid: (params: { wasteTypeId?: string; isActive?: string }) => ['grid', params],
  resolve: (params: {
    wasteTypeId: string | null;
    target: WasteTariffTarget;
    operatorCounterpartyId: string | null;
  }) => ['resolve', params],
});
