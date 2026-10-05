import { Space, Typography } from 'antd';
import type { HookAPI as ModalApi } from 'antd/es/modal/useModal';
import { WAYBILL_ACK_REQUIRED_CODE, type WaybillWarning } from '@technic/contracts';
import { isApiError } from '@shared/api';
import { WaybillWarningList } from '@entities/waybill';

/**
 * The portal side of the issuing handshake (R21, R21a of plan `docs/route-trips-plan.md`): parsing
 * the 409 `waybill_ack_required` refusal and the window in which the person reads the warnings
 * before a blank number is spent.
 *
 * A module of its own rather than a block of the route card, because there turned out to be five
 * paths that issue a number, not four: the fifth is the manual issue of a weekly ESM-2 for a
 * linear order (`VehicleEsm2Modal`), where there is no route at all. A second copy of the window
 * would drift from the first on the first text edit, and the person would read about the
 * irreversible spending of a blank in one place of the portal and not in another.
 *
 * Exactly two things are extracted, the refusal body parser and the window itself, because that is
 * all the two paths have in common. Their refusal bodies differ: `WaybillAckRequiredDetails` names
 * a route, while `Esm2AckRequiredDetails` names a request and a week, since a weekly sheet has no
 * route. What they share is the fingerprint and the list, which is exactly what the window reads.
 * The retry stays with the caller: only the mutation that sent the issuing body knows it.
 *
 * The assignment doors (history repair, period) answer the same 409 code with a different body: a
 * per-sheet `issues` list instead of one fingerprint, because one command there issues several
 * blanks. `ackRequiredDetails` returns `null` for that body on purpose — those doors read it
 * through `@features/vehicle-assignment`, and only the warning list itself (`@entities/waybill`) is
 * shared.
 */

/** What the window reads from the refusal: the part common to both bodies, set and fingerprint. */
export interface WaybillAckDetails {
  /** `sha256` of the set, computed by the server; sent back to it untouched. */
  fingerprint: string;
  warnings: WaybillWarning[];
}

/**
 * Whether this is the refusal the confirmation window exists for (R21).
 *
 * Both the code and the body shape are checked: the transport delivers `details` as `unknown` (it
 * has no way to know the endpoint), and an older server answering with this code but without the
 * list must lead to a regular error message, not to an empty "confirm nothing" window.
 */
export function ackRequiredDetails(e: unknown): WaybillAckDetails | null {
  if (!isApiError(e) || e.code !== WAYBILL_ACK_REQUIRED_CODE) return null;
  const details = e.details as Partial<WaybillAckDetails> | undefined;
  if (!details || typeof details.fingerprint !== 'string' || !Array.isArray(details.warnings)) {
    return null;
  }
  return details as WaybillAckDetails;
}

/**
 * The warning confirmation window: what exactly is being confirmed, as a list rather than a single
 * line.
 *
 * The caller owns the retry, and the fingerprint reaches it as a ready `acknowledge` field: the
 * retry must send **the same body** the server has already received, with one added
 * acknowledgement. For backdated issuing the idempotency key is computed over the whole body
 * (`correctionFingerprint`), and the server would answer a body rebuilt from the form fields with
 * "this is not a retry" instead of a sheet.
 *
 * The window deliberately does not name the paper: for a route it is the route number, for a
 * weekly sheet the request and the week, and both are visible behind the window it was opened
 * from. What stays common is what the window exists for: the warning list and the cost of the
 * press.
 */
export function confirmWaybillWarnings(
  modal: ModalApi,
  details: WaybillAckDetails,
  retry: (acknowledge: { fingerprint: string }) => Promise<unknown>,
): void {
  modal.confirm({
    title: 'Выписать лист с предупреждениями?',
    width: 560,
    content: (
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        {/* The list itself is shared with the assignment doors: one wording for every path that
          spends a blank number. */}
        <WaybillWarningList warnings={details.warnings} />
        <Typography.Text type="secondary">
          Номер бланка израсходуется: чтобы переписать лист, его придётся аннулировать.
        </Typography.Text>
      </Space>
    ),
    okText: 'Выписать всё равно',
    cancelText: 'Отмена',
    // The fingerprint goes back to the server untouched: it refers to the set the person has just
    // read and confirms exactly that set.
    //
    // A failed retry is swallowed here on purpose: showing it is the caller's `onError` job, and
    // the window must close. Otherwise a second 409 (the set changed in the meantime) would stack
    // a new window over the old one: two warning lists about one paper, with no telling which is
    // fresh.
    onOk: () => retry({ fingerprint: details.fingerprint }).catch(() => undefined),
  });
}
