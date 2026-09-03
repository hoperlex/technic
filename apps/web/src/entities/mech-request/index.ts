/**
 * Заявка на аренду малой механизации (план `docs/mechanization-module-plan.md`): виброплиты,
 * компрессоры, генераторы, тепловые пушки — всё, что стоит на площадке неделями и стоит денег
 * каждый день.
 *
 * Слайс сущности: запросы, ключи кэша, подписи значений и ячейки списка. Правил цикла здесь нет
 * вовсе — предикаты состояний, барьеры правки и удаления, расчёт стоимости и просрочка живут в
 * контрактах (`packages/contracts/src/mech-requests.ts`) одной копией на портал и сервер.
 *
 * Снаружи берут `@entities/mech-request` — внутренние модули слайса не видны, и перестроить его
 * можно, не трогая потребителей.
 */
export { mechRequestsApi } from './api/mechRequestsApi';
export { mechLessorKeys, mechRequestKeys } from './api/keys';
export { mechLessorOptionsQuery } from './api/queries';
export {
  isDepartmentRequester,
  mechDayLabel,
  mechDaysLeftLabel,
  mechMoney,
  mechMoneySum,
  mechModelLabel,
  mechRateLabel,
  mechRequesterLabel,
  mechTermLabel,
  mechWorkedLabel,
} from './model/labels';
export { isMechStaleError, mechFailureText, MECH_STALE_MESSAGE } from './model/failure';
export { MechRequestContext } from './ui/MechRequestContext';
export { MechStateTag } from './ui/MechStateTag';
export type { MechStateRow } from './ui/MechStateTag';
export { MechTermCell } from './ui/MechTermCell';
export type { MechTermRow } from './ui/MechTermCell';
export { MechRateCell } from './ui/MechRateCell';
export { MechPlaceCell, MechRequesterCell } from './ui/MechRequesterCell';
