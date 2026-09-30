import type { ReactNode } from 'react';
import type {
  FeedKind,
  RequestStatus,
  SpecialEquipmentRequestDto,
  VehicleFeedRow,
  VehicleRequestDto,
  WeeklyVehicleRequestDto,
} from '@technic/contracts';
import type { TableChange } from '@shared/lib';
import type { FilterDefinition, FilterOption } from '@shared/ui';

/** The client key DataTable needs on top of the feed's discriminated union. */
export type VehicleRequestFeedRow = VehicleFeedRow & { id: string };

export interface VehicleRequestFeedRights {
  canApprove: boolean;
  canCreate: boolean;
  canCreateWeekly: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canRestore: boolean;
  showRoutes: boolean;
}

export interface VehicleRequestFeedPending {
  approvalRequestId?: string;
  statusRequestId?: string;
}

/**
 * Every command leaves the widget through this port. The feed owns presentation and interaction
 * placement, while the page keeps mutations, navigation state and permission predicates.
 */
export interface VehicleRequestFeedActions {
  approveEarlyEnd: (request: SpecialEquipmentRequestDto) => void;
  canChangeMachinist: (request: VehicleRequestDto) => request is SpecialEquipmentRequestDto;
  canDecideEarlyEnd: (request: VehicleRequestDto) => request is SpecialEquipmentRequestDto;
  canModify: (request: VehicleRequestDto) => boolean;
  canReassign: (request: VehicleRequestDto) => boolean;
  canRepairHistory: (request: VehicleRequestDto) => request is SpecialEquipmentRequestDto;
  canRequestEarlyEnd: (request: VehicleRequestDto) => request is SpecialEquipmentRequestDto;
  changeApproval: (request: VehicleRequestDto, approved: boolean) => void;
  changeMachinist: (request: SpecialEquipmentRequestDto) => void;
  changeStatus: (request: VehicleRequestDto, status: RequestStatus) => void;
  create: () => void;
  createWeekly: () => void;
  edit: (request: VehicleRequestDto) => void;
  openOrder: (request: VehicleRequestDto) => void;
  openRoute: (routeId: string) => void;
  openRoutes: () => void;
  openWeekly: (request: WeeklyVehicleRequestDto) => void;
  reassign: (request: VehicleRequestDto) => void;
  rejectEarlyEnd: (request: SpecialEquipmentRequestDto) => void;
  remove: (request: VehicleRequestDto) => void;
  repairHistory: (request: SpecialEquipmentRequestDto) => void;
  requestEarlyEnd: (request: SpecialEquipmentRequestDto) => void;
  restore: (request: VehicleRequestDto) => void;
  routeLink: (routeId: string) => string | null;
}

export interface VehicleRequestFeedFilters {
  approved?: string;
  classificationControls: ReactNode;
  classificationMobileFilter: FilterDefinition;
  customerControls: ReactNode;
  customerMobileFilter: FilterDefinition;
  documentTypeOptions: FilterOption[];
  documentTypeValue?: string;
  kind?: FeedKind;
  num?: number;
  onApprovalChange: (value: string | undefined) => void;
  onDocumentTypeChange: (value: string | undefined) => void;
  onNumberSearch: (value: string) => void;
  onStatusChange: (value: RequestStatus | undefined) => void;
  onWeekStartChange: (value: string | undefined) => void;
  status?: string;
  vehicleControls: ReactNode;
  vehicleMobileFilter: FilterDefinition;
  weekOptions: FilterOption[];
  weekStart?: string;
}

export interface VehicleRequestFeedList {
  onChange: (change: TableChange) => void;
  onSortChange: (sortBy: string | undefined, sortOrder: 'asc' | 'desc') => void;
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
}

export interface VehicleRequestFeedSummary {
  awaitingApproval: number;
  confirmed: number;
  new: number;
  weeklyPending: number;
}

export interface VehicleRequestFeedProps {
  actions: VehicleRequestFeedActions;
  children?: ReactNode;
  filters: VehicleRequestFeedFilters;
  list: VehicleRequestFeedList;
  loading: boolean;
  pending: VehicleRequestFeedPending;
  rights: VehicleRequestFeedRights;
  rows: VehicleFeedRow[];
  summary: VehicleRequestFeedSummary;
  total: number;
}
