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
  /** Delivery period bounds as YYYY-MM-DD dates; they become instants only in the request. */
  deliveryFrom?: string;
  deliveryTo?: string;
  /** Ticket review registry (ADR 0114, Р24): "pending" means "требуют разбора". */
  ticketReview?: string;
  [key: string]: unknown;
}

export interface WasteFilterOptions {
  values: WasteFilterValues;
  onChange: (patch: Partial<WasteFilterValues>) => void;
  /**
   * Object filter. For a role with a single site it is shown but locked: "all" would mean exactly
   * that site anyway. The empty string is "all", and the server narrows the list to the scope.
   */
  objects: {
    options: FilterOption[];
    loading: boolean;
    value: string;
    disabled: boolean;
    onChange: (value: string) => void;
  };
  /** Container or truck: options and parsing of the choice live in subjectFilter. */
  subject: {
    options: FilterOptionGroup[];
    value: string | undefined;
    onChange: (value: string | undefined) => void;
  };
  /**
   * Waste operators. null means no filter at all: the operator is chosen by whoever assigns it, and
   * in an operator's own list every request is theirs anyway (ADR 0010).
   */
  operators: { options: FilterOption[]; loading: boolean } | null;
  /** Request number: a string in the field ("М-128"), a number in the parameters. */
  num: { text: string; onChange: (raw: string) => void };
  /**
   * Ticket review registry is a separate right (ADR 0114, Р25): without it there is no filter. The
   * server answers the same way, rejecting (not ignoring) the ticketReview parameter without it.
   */
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
  /** A waste operator executes requests rather than processing them (ADR 0010). */
  isOperator: boolean;
}

export interface WasteRequestFeedPending {
  /** The request whose status change is in flight: its tag waits for the answer and is disabled. */
  statusRequestId?: string;
}

export interface WasteRequestFeedSources {
  /**
   * The sole site of a place-scoped role, or an empty string. Such a role is narrowed to its own
   * sites (ADR 0039), and "all" means all of its own: the server returns nothing else.
   */
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
