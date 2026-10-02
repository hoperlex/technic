import type { ReactNode } from 'react';
import type { SpecialEquipmentRequestDto, VehicleRequestDto } from '@technic/contracts';

/** Actions are optional because the same card serves editable lists and read-only overlays. */
export interface VehicleRequestViewModalProps {
  request: VehicleRequestDto | null;
  onClose: () => void;
  onEdit?: (request: VehicleRequestDto) => void;
  onCopy?: (request: VehicleRequestDto) => void;
  onReassign?: (request: VehicleRequestDto) => void;
  onChangeMachinist?: (request: VehicleRequestDto) => void;
  onTransfer?: (request: VehicleRequestDto) => void;
  onRelocate?: (request: VehicleRequestDto, purpose: 'delivery' | 'pickup') => void;
  onIssueEsm2?: (request: VehicleRequestDto) => void;
  earlyEndActions?: (request: VehicleRequestDto) => ReactNode;
  readOnly?: boolean;
  /** Work-day editing remains page-owned until the route/day cluster moves in wave 7. */
  renderDays: (request: SpecialEquipmentRequestDto, readOnly: boolean | undefined) => ReactNode;
  /** Weekly-request routing remains page-owned instead of leaking page routes into this widget. */
  weeklyRequestPath: (id: string) => string;
}
