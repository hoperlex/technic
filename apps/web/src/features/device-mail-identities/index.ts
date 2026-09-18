/**
 * Ключи опознания аппаратов: реестр, заведение из карточки и снятие со следом (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §6.1 и §7).
 *
 * Сценарий, а не сущность: слайс знает правила — какие рода заводят руками, какой ключ применяется
 * пачкой, что снятие не откатывает записанное. Данные ему даёт `@entities/device-mail`.
 */
export { DeviceIdentityRegistry, REGISTRY_EMPTY_TEXT } from './ui/DeviceIdentityRegistry';
export { DeviceIdentityAddModal, TARGETS_PREFIX } from './ui/DeviceIdentityAddModal';
export { RevokeIdentityModal, REVOKE_CONSEQUENCE } from './ui/RevokeIdentityModal';
export { DeviceIdentityCardBlock } from './ui/DeviceIdentityCardBlock';
export {
  applySummary,
  useDeviceIdentityApply,
  useDeviceIdentityCreate,
  useDeviceIdentityRevoke,
} from './model/actions';
