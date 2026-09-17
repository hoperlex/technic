/**
 * Норма расхода топлива — ставка приказа, с которой гараж сверяет фактический расход
 * (план `docs/fuel-norms-plan.md`). Снаружи берут `@entities/fuel-norm`.
 */
export { fuelNormsApi } from './api/fuelNormsApi';
export { fuelNormKeys, fuelNormVehiclePickerKey } from './api/keys';
