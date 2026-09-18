/**
 * Письмо аппарата, ещё не ставшее показанием (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10).
 *
 * ОТДЕЛЬНЫМ СЛАЙСОМ ОТ `device-telemetry`, потому что это разные сущности, а не два вида одной.
 * Наблюдение и событие принадлежат карточке и пишутся только при однозначной привязке (Р20); письмо
 * очереди не принадлежит никому — у него нет ни аппарата, ни площадки, ни отдела, и вся работа с
 * ним состоит в том, чтобы это исправить.
 *
 * Снаружи берут `@entities/device-mail` — внутренние модули слайса не видны, и линт границ
 * запрещает путь вида `@entities/device-mail/api/keys` прямо.
 */
export {
  deviceMailApi,
  type DeviceMailBindTargets,
  type DeviceMailQueueParams,
} from './api/deviceMailApi';
export { deviceIdentityApi, type DeviceIdentityParams } from './api/deviceIdentityApi';
export { deviceRuleApi } from './api/deviceRuleApi';
export { deviceMailKeys } from './api/keys';
