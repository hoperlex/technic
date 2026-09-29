import { Alert } from 'antd';

/**
 * What the "History repair" window says about itself, apart from the consequences list: why a
 * repair will also restore an archived request.
 *
 * A file of its own because the window is a conversation (inspect, preview, refusals, confirmation)
 * and these are two of its replies; keeping them there would push the window past the length budget
 * of the portal, and neither reply is input (`RepairFields.tsx`).
 */

/**
 * The shown consequences were computed with `restore` (R29): the repair touches paper that is
 * still valid for an archived request, so it only goes through together with taking the request
 * out of the archive — in the same operation.
 *
 * Whether the person may do that is not checked here: the right is the server's, and a refusal
 * comes back as the same in-window "not enough rights" text as any other.
 */
export function RepairRestoreAlert() {
  return (
    <Alert
      type="warning"
      showIcon
      title="Заявка в архиве — починка восстановит её"
      description="Ремонт затрагивает бумагу, которая по архивной заявке осталась действующей, поэтому пройдёт только вместе с выводом заявки из архива — той же операцией. Для этого нужно право на восстановление из архива."
    />
  );
}

/**
 * The step back after a 422 on `restore`: the server found at the command that this archived
 * repair needs restoring (the undecided tail of an archived request is refused this way without
 * being flagged by `restoreRequired`). The window recomputes the preview with `restore` and says why.
 */
export const RESTORE_RECHECK =
  'Ремонт этой архивной заявки проходит только вместе с её восстановлением — последствия пересчитаны с ним. Прочитайте и подтвердите заново.';
