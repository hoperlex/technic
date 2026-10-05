import type { FormInstance } from 'antd';
import type { VehicleRequestDto } from '@technic/contracts';
import type {
  AssignCommand,
  AssignFormValues,
  DayBatchFormValues,
} from '@features/vehicle-assignment';

export type VehicleAssignmentFormValues = AssignFormValues & DayBatchFormValues;
export type VehicleAssignmentForm = FormInstance<VehicleAssignmentFormValues>;

export interface VehicleAssignModalProps {
  request: VehicleRequestDto | null;
  mode?: 'confirm' | 'reassign';
  confirmLoading: boolean;
  onCancel: () => void;
  /** The promise lets stale preview handshakes return the user to a recomputed confirmation. */
  onSubmit: (command: AssignCommand) => void | Promise<unknown>;
}
