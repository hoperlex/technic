/**
 * Талон вывоза, каким его видит портал (ADR 0114): распознанные значения, замечания сверки и
 * состояние подсистемы распознавания. Снаружи берут `@entities/waste-ticket`.
 */
export { wasteTicketsApi } from './api/wasteTicketsApi';
export type { TicketRecognitionHealth } from './api/wasteTicketsApi';
export { wasteTicketKeys } from './api/keys';
export {
  ticketAuditAccuracyQuery,
  ticketAuditCohortsQuery,
  ticketAuditEventsQuery,
  ticketAuditOperationsQuery,
  ticketAuditSummaryQuery,
  ticketRecognitionHealthQuery,
  wasteTicketBlindQueueQuery,
  wasteTicketsQuery,
} from './api/queries';
