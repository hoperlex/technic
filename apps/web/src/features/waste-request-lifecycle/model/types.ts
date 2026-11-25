import type { ReactNode } from 'react';
import type { CompleteWasteRequestInput, RequestStatus, WasteRequestDto } from '@technic/contracts';

export interface WasteRequestOperatorValue {
  operatorCounterpartyId: string;
  ownerMismatchReason?: string;
}

export interface WasteRequestOperatorModalProps {
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (value: WasteRequestOperatorValue) => void;
  request: WasteRequestDto | null;
}

export interface WasteRequestCompletionValue {
  comment: string;
  /** Removal fact; null for a container operation, which has no hauled quantity. */
  completion: CompleteWasteRequestInput | null;
  ticketFileIds: string[];
}

/**
 * What became of a submitted completion: `saved`; `rejected` — the server refused, nothing was
 * attached; `unknown` — the answer was lost (5xx, no connection) and the completion may have
 * committed, so its files must outlive the window (snow-removal plan, §3.3).
 */
export type CompletionOutcome = 'saved' | 'rejected' | 'unknown';

/** The request was reloaded after a 409; `blocked` — it can no longer be completed from here. */
export interface CompletionReload {
  pending: boolean;
  blocked: boolean;
}

export interface WasteRequestCompletionModalProps {
  /** May read the review state of the paper already attached (ADR 0114, R25). */
  canReviewTickets: boolean;
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (value: WasteRequestCompletionValue) => Promise<CompletionOutcome>;
  /** Set after a 409 while the saved fact and ticket links are reloaded and once they are. */
  reload: CompletionReload | null;
  request: WasteRequestDto | null;
}

export interface WasteRequestLifecycleController {
  actions: {
    canModify: (request: WasteRequestDto) => boolean;
    changeStatus: (request: WasteRequestDto, status: RequestStatus) => void;
    remove: (request: WasteRequestDto) => void;
    restore: (request: WasteRequestDto) => void;
  };
  node: ReactNode;
  pending: { statusRequestId?: string };
  rights: {
    canDelete: boolean;
    canEdit: boolean;
    canRestore: boolean;
  };
}
