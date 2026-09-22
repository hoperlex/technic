/**
 * Цели опроса аппаратов по сети (решение `docs/adr/0205-device-network-poll.md`).
 *
 * Сущность, а не сценарий: слайс знает только, какие цели настроены и что ответила последняя
 * попытка. Что с этим делать — у `@features/device-poll`.
 */
export { devicePollApi } from './api/devicePollApi';
export { devicePollKeys } from './api/keys';
