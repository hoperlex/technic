import { reassignStaleReason } from './preview';
import { recheckReasonOf } from './warnings';

/**
 * Assignment/history dialogs first handle an obsolete consequence preview, then changed sheet
 * warnings. Keep that precedence shared by the command's toast suppression and the dialog's
 * retry screen, otherwise one refusal can be reported twice or return to the wrong step.
 */
export function assignmentRecheckReason(error: unknown): string | null {
  return reassignStaleReason(error) ?? recheckReasonOf(error);
}
