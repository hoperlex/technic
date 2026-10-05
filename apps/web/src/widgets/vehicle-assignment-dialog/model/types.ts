import type { FormInstance } from 'antd';
import type { VehicleRequestDto } from '@technic/contracts';
import type {
  AssignCommand,
  AssignFormValues,
  DayBatchFormValues,
} from '@features/vehicle-assignment';

/**
 * Form fields: vehicle selection plus the 4-P batch for the whole period (ADR 0207). An
 * intersection of types, not a nested field of `AssignFormValues`: the batch is not part of the
 * assignment command — it goes through a second door with its own body, and mixing its fields into
 * the assignment assembly would send them where nobody expects them.
 */
export type VehicleAssignmentFormValues = AssignFormValues & DayBatchFormValues;
export type VehicleAssignmentForm = FormInstance<VehicleAssignmentFormValues>;

export interface VehicleAssignModalProps {
  /** `null` — the dialog is closed; the request comes from the list row. */
  request: VehicleRequestDto | null;
  /**
   * Why the dialog is open: `confirm` — taking the request into work (ADR 0027), `reassign` —
   * changing the vehicle of a running one (ADR 0048). The mode sets the title, the button text and
   * whether the actual-term block exists, but not the vehicle selection — it is one for both cases.
   */
  mode?: 'confirm' | 'reassign';
  confirmLoading: boolean;
  onCancel: () => void;
  /**
   * `schedule: null` — the term was not asked (`reassign`); `correction` is filled where the
   * vehicle is changed retroactively (ADR 0101, R8) — with a reason and the forms to reissue;
   * `previewFingerprint` goes with the "done" -> "confirmed" rollback (§5.4 of the plan) and with a
   * vehicle change of an on-site order (wave 4a) — the live handler checks by it that consequences
   * shown at the second step are still true.
   *
   * The dialog **awaits** the returned promise, and that is part of the handshake: a 409
   * "consequences changed" is cured not by a toast but by showing them again — the dialog must
   * learn of the refusal to return the person to the recomputed list. A sender that does not need
   * this may still return `void`: there is nothing to wait for, and nothing changes.
   */
  onSubmit: (command: AssignCommand) => void | Promise<unknown>;
}
