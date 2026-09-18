/**
 * Приём писем от оргтехники (план `docs/office-equipment-mail-telemetry-plan.md`, Э2).
 *
 * Наружу отдаётся ровно то, что нужно шву воркера: настройки из окружения и приёмник с тиком.
 * Транспорты ящика и разговор с внутренними ручками — внутреннее дело слоя.
 */
export { readDeviceMailConfig } from './config';
export { startDeviceMailPoller } from './poller';
export type { DeviceMailPoller, DeviceMailPollerDeps, DeviceMailTickResult } from './poller';
export { createDirMailbox, readDirMailboxState } from './mailbox-dir';
export { createImapMailbox } from './mailbox-imap';
export { createDeviceMailApi, type DeviceMailApi } from './intake-client';
export {
  DeviceMailPausedError,
  type DeviceMailConfig,
  type DeviceMailCursor,
  type DeviceMailEnvelope,
  type DeviceMailIntakeResult,
  type DeviceMailSubmission,
  type DeviceMailbox,
} from './types';
