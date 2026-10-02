import type { ReactNode } from 'react';
import type { ContainerKind, RequestStatus, WasteRequestDto } from '@technic/contracts';
import type { TableChange } from '@shared/lib';
import type { FilterOption, FilterOptionGroup } from '@shared/ui';

/** Filter values sent to the working-list endpoint, excluding pagination and sorting. */
export interface WasteFilterValues {
  status?: string;
  requestType?: string;
  containerTypeId?: string;
  containerKind?: ContainerKind;
  operatorCounterpartyId?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
  ticketReview?: string;
  [key: string]: unknown;
}

export interface WasteFilterOptions {
  values: WasteFilterValues;
  onChange: (patch: Partial<WasteFilterValues>) => void;
  objects: {
    options: FilterOption[];
    loading: boolean;
    value: string;
    disabled: boolean;
    onChange: (value: string) => void;
  };
  subject: {
    options: FilterOptionGroup[];
    value: string | undefined;
    onChange: (value: string | undefined) => void;
  };
  operators: { options: FilterOption[]; loading: boolean } | null;
  num: { text: string; onChange: (raw: string) => void };
  ticketReview: boolean;
}

export interface WasteRequestFeedActions {
  canModify: (request: WasteRequestDto) => boolean;
  changeStatus: (request: WasteRequestDto, status: RequestStatus) => void;
  create: () => void;
  edit: (request: WasteRequestDto) => void;
  open: (request: WasteRequestDto) => void;
  openTicketReview: (request: WasteRequestDto) => void;
  remove: (request: WasteRequestDto) => void;
  restore: (request: WasteRequestDto) => void;
}

export interface WasteRequestFeedRights {
  canAuditTickets: boolean;
  canCreate: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canRestore: boolean;
  canReviewTickets: boolean;
  isOperator: boolean;
}

export interface WasteRequestFeedPending {
  statusRequestId?: string;
}

export interface WasteRequestFeedSources {
  initialObjectId: string;
  objectFilterDisabled: boolean;
  objectOptions: FilterOption[];
  objectsLoading: boolean;
  subjectTypes: {
    cont: FilterOption[];
    truck: FilterOption[];
  };
  operators: { options: FilterOption[]; loading: boolean } | null;
}

export interface WasteRequestFeedList {
  onChange: (change: TableChange) => void;
  onSortChange: (sortBy: string | undefined, sortOrder: 'asc' | 'desc') => void;
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
}

export interface WasteRequestFeedSummary {
  confirmed: number;
  done: number;
  new: number;
}

export interface WasteRequestFeedProps {
  actions: WasteRequestFeedActions;
  children?: ReactNode;
  pending: WasteRequestFeedPending;
  rights: WasteRequestFeedRights;
  sources: WasteRequestFeedSources;
}
