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

export interface WasteRequestCompletionModalProps {
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (value: WasteRequestCompletionValue) => void;
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
