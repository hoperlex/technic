import type { ReactNode } from 'react';
import type { SpecialEquipmentRequestDto, VehicleRequestDto } from '@technic/contracts';
import type { FormValues, VehiclePeriodCommand } from '@features/vehicle-request-editor';
import type { VehicleRequestPeriodResultDto } from '@entities/vehicle-request';

/** Period correction remains an independent door; the editor owns when and with what it opens. */
export interface VehicleRequestEditorPeriodModalProps {
  command: VehiclePeriodCommand | null;
  onApplied: (result: VehicleRequestPeriodResultDto) => void;
  onCancel: () => void;
  operationId: string;
  reason?: string;
  request: SpecialEquipmentRequestDto | null;
}

export interface VehicleRequestEditorController {
  canCopy: (request: VehicleRequestDto) => boolean;
  node: ReactNode;
  openCopy: (request: VehicleRequestDto) => void;
  openCreate: () => void;
  openEdit: (request: VehicleRequestDto) => void;
}

export interface PendingPeriodSave {
  command: VehiclePeriodCommand;
  request: SpecialEquipmentRequestDto;
  values: FormValues;
}
