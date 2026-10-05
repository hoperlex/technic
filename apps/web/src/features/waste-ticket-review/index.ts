import { lazy } from 'react';

/**
 * Ticket review inside the request card and recognition status (ADR 0114).
 * Keep the independent queue lazy here: the same public entry also serves card-only callers.
 */
export { BlindCheckPanel } from './ui/BlindCheckPanel';
export const BlindCheckQueue = lazy(() =>
  import('./ui/BlindCheckQueue').then((module) => ({ default: module.BlindCheckQueue })),
);
export { TicketCell } from './ui/TicketCell';
export { TicketFormModal } from './ui/TicketFormModal';
export { TicketRecognitionBanner } from './ui/TicketRecognitionBanner';
export { WasteTicketsPanel } from './ui/WasteTicketsPanel';
