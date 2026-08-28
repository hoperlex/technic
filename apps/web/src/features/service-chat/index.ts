/**
 * Обсуждение заявки на обслуживание оргтехники (ADR 0141): лента реплик, адресат-пометка и
 * непрочитанное.
 *
 * Сценарий, а не сущность: слайс знает и стороны разговора, и цену прочтения (курсор двигается
 * только после успешного показа ленты и только у видимой вкладки), и то, что гаснет от реплики.
 * Правил доступа он при этом не считает — их считает сервер и присылает блоком `chat` в DTO
 * (§3.2 плана): вторая копия правил на портале разошлась бы с ручкой молча.
 */
export { ServiceChatModal } from './ui/ServiceChatModal';
export { ServiceChatMark } from './ui/ServiceChatMark';
export { MarkAllChatReadButton } from './ui/MarkAllChatReadButton';
export { useServiceChatUnreadCount } from './model/useServiceChatUnreadCount';
