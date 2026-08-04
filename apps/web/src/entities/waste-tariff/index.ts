/**
 * Позиция прайса вывоза мусора: цена оператора за пару «что вывозим × чем вывозим» (ADR 0009,
 * ADR 0026). Снаружи берут `@entities/waste-tariff`.
 */
export { wasteTariffsApi } from './api/wasteTariffsApi';
export type { WasteTariffTarget } from './api/wasteTariffsApi';
export { wasteTariffKeys } from './api/keys';
export { wasteTariffResolveQuery } from './api/queries';
