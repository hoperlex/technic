/**
 * Разбор очереди «Письма устройств» (план `docs/office-equipment-mail-telemetry-plan.md`, §10).
 *
 * Сценарий, а не сущность: слайс знает правила разбора — какой ключ применяется пачкой, какой
 * только к нажатой строке, что число затронутых писем считает сервер, и что решённое письмо гасит
 * не только очередь, но и показания карточки. Данные ему даёт `@entities/device-mail`.
 */
export { DeviceMailBindModal, BIND_TARGETS_PREFIX } from './ui/DeviceMailBindModal';
export { MailboxStateBar, MAILBOX_STUCK_PREFIX, MAILBOX_NEVER_POLLED } from './ui/MailboxStateBar';
export {
  bindSummary,
  invalidateAfterDeviceMailAction,
  useDeviceMailBind,
  useDeviceMailIgnore,
  useDeviceMailReparse,
  useDeviceMailReviewed,
  ALREADY_APPLIED_NOTICE,
  SKIPPED_NOTICE,
} from './model/actions';
