/**
 * Опрос аппаратов по сети (решение `docs/adr/0205-device-network-poll.md`).
 *
 * Сценарий, а не сущность: слайс знает, что кнопка спрашивает аппарат прямо сейчас, что снятое
 * пишется только при найденной карточке и что исход объясняет сервер.
 */
export { DevicePollBoard, NO_ATTEMPT_TEXT, POLL_EMPTY_TEXT } from './ui/DevicePollBoard';
export { useDevicePoll } from './model/actions';
