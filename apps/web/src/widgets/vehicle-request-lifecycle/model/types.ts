import type { ReactNode } from 'react';
import type {
  AssignVehicleBody,
  CompleteVehicleRequestInput,
  ConfirmScheduleBody,
  DecideVehicleEarlyEndBody,
  RequestStatus,
  RequestVehicleEarlyEndInput,
  SpecialEquipmentRequestDto,
  VehicleRequestDto,
} from '@technic/contracts';

export interface VehicleEarlyEndApproveModalProps {
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (body: DecideVehicleEarlyEndBody) => Promise<unknown> | undefined;
  request: SpecialEquipmentRequestDto | null;
}

export interface VehicleEarlyEndModalProps {
  approvesOwn: boolean;
  confirmLoading: boolean;
  onCancel: () => void;
  onDate: string;
  onSubmit: (body: RequestVehicleEarlyEndInput) => Promise<unknown> | undefined;
  request: SpecialEquipmentRequestDto | null;
}

export interface VehicleCompleteModalProps {
  confirmLoading: boolean;
  onCancel: () => void;
  onCompleted: () => void;
  onDate: string;
  onSubmit: (value: { completion: CompleteVehicleRequestInput; comment: string }) => void;
  request: VehicleRequestDto | null;
}

export interface AssignmentStatusCommand {
  assignment: AssignVehicleBody;
  previewFingerprint?: string;
  schedule: ConfirmScheduleBody | null;
}

export interface VehicleRequestLifecycleController {
  actions: {
    approveEarlyEnd: (request: SpecialEquipmentRequestDto) => void;
    canDecideEarlyEnd: (request: VehicleRequestDto) => request is SpecialEquipmentRequestDto;
    canModify: (request: VehicleRequestDto) => boolean;
    canRequestEarlyEnd: (request: VehicleRequestDto) => request is SpecialEquipmentRequestDto;
    changeApproval: (request: VehicleRequestDto, approved: boolean) => void;
    changeStatus: (request: VehicleRequestDto, status: RequestStatus) => void;
    rejectEarlyEnd: (request: SpecialEquipmentRequestDto) => void;
    remove: (request: VehicleRequestDto) => void;
    requestEarlyEnd: (request: SpecialEquipmentRequestDto) => void;
    restore: (request: VehicleRequestDto) => void;
  };
  assignment: {
    close: () => void;
    pending: boolean;
    submit: (command: AssignmentStatusCommand) => Promise<VehicleRequestDto> | undefined;
    target: VehicleRequestDto | null;
  };
  earlyEndActions: (request: VehicleRequestDto) => ReactNode;
  node: ReactNode;
  pending: {
    approvalRequestId?: string;
    statusRequestId?: string;
  };
  rights: {
    canApprove: boolean;
    canDelete: boolean;
    canEdit: boolean;
    canRestore: boolean;
  };
}
