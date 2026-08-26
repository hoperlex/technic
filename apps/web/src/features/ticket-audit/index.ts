/**
 * Аудит распознавания талонов вывоза (ADR 0137): вход в модуль и его экраны. Снаружи берут
 * `@features/ticket-audit` — кнопку панели и само окно; всё остальное (адресные параметры, выбор
 * экрана, правила чисел) остаётся внутри слайса, потому что снаружи их некому применять.
 */
export { TicketAuditButton } from './ui/TicketAuditButton';
export { TicketAuditModal } from './ui/TicketAuditModal';
export { useTicketAuditMobileAction } from './model/useTicketAuditAction';
