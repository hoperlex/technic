/**
 * Модель малой механизации — предмет заявки на аренду (ADR 0152, план
 * `docs/mechanization-models-directory-plan.md`). Снаружи берут `@entities/mech-model`:
 * внутренние модули слайса не видны, и перестроить его можно, не трогая потребителей.
 */
export { mechModelsApi } from './api/mechModelsApi';
export { mechModelKeys } from './api/keys';
export { mechModelOptionsQuery } from './api/queries';
