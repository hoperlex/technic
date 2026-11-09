/**
 * The lessor's receipt of a mechanization rental (plan `docs/mechanization-lessor-receipt-plan.md`):
 * after «Взять в работу» the lessor or the office attaches one PDF or JPG, a holder of the request
 * visa approves or rejects it in a window that shows the receipt itself, or allows completion «без
 * чека»; completion waits for one of the two.
 *
 * A slice of its own, not a part of the extension or the completion: the receipt lives by its own
 * permission (`mechRequests.lessorReceipt` to attach, `mechRequests.approve` to decide), its own
 * doors and its own history events. What is available is never decided here — the buttons come from
 * `mechLessorReceiptAccess` of the contracts.
 *
 * The upload window, the version list and the version lines are built for two readers: the office's
 * card here and the lessor's page (W4), which turns his allow-listed view into the same lines with
 * `lessorReceiptLine`.
 */
export { useMechLessorReceiptActions } from './model/useMechLessorReceiptActions';
export {
  useAttachMechLessorReceipt,
  useDecideMechLessorReceipt,
  useWaiveMechLessorReceipt,
  type MechLessorReceiptRental,
} from './model/mutations';
export { lessorReceiptLine, officeReceiptLine, type MechLessorReceiptLine } from './model/lines';
export {
  MechLessorReceiptBlock,
  MechLessorReceiptStrip,
  type MechLessorReceiptHandlers,
} from './ui/MechLessorReceiptBlock';
export { MechLessorReceiptUploadModal } from './ui/MechLessorReceiptUploadModal';
export { MechLessorReceiptVisaModal } from './ui/MechLessorReceiptVisaModal';
export {
  MechLessorReceiptReasonModal,
  type MechLessorReceiptReasonKind,
} from './ui/MechLessorReceiptReasonModal';
export {
  MechLessorReceiptVersionLine,
  MechLessorReceiptVersions,
} from './ui/MechLessorReceiptVersions';
export { MechLessorReceiptFileLink } from './ui/MechLessorReceiptFileLink';
export { mechLessorReceiptHistoryFiles } from './ui/mechLessorReceiptHistoryFiles';
