import {
  mechLessorReceiptAuthorLabels,
  type AttachedFileDto,
  type MechLessorReceiptRetireReason,
  type MechLessorReceiptStatus,
  type MechLessorReceiptVersionDto,
  type MechLessorReceiptVersionView,
} from '@technic/contracts';

/**
 * One receipt version as the block and the version list draw it — whoever reads it. The office's
 * version (`MechLessorReceiptVersionDto`) and the lessor's (`MechLessorReceiptVersionView`, P12) are
 * different allow-lists; each is turned into this line by its own function below, so the markup is
 * one and cannot show the lessor a field his view does not carry: what is absent from the view is
 * absent from the line.
 */
export interface MechLessorReceiptLine {
  id: string;
  versionNo: number;
  status: MechLessorReceiptStatus;
  /** `null` — a waiver: the «без чека» visa has no file. */
  file: AttachedFileDto | null;
  /** Who attached it: a name and its side for the office, the side alone for the lessor. */
  author: string;
  createdAt: string;
  /** Who decided: a name for the office, `null` for the lessor (no staff names, P12). */
  decidedBy: string | null;
  decidedAt: string | null;
  /**
   * The words under the decision. The office reads every one — the rejection, the waiver, a remark
   * on approval; the lessor only a rejection's, because he has something to fix.
   */
  reason: string | null;
  retiredAt: string | null;
  retiredBy: string | null;
  retiredReason: MechLessorReceiptRetireReason | null;
}

export function officeReceiptLine(version: MechLessorReceiptVersionDto): MechLessorReceiptLine {
  return {
    id: version.id,
    versionNo: version.versionNo,
    status: version.status,
    file: version.file,
    author: `${version.createdByName} (${mechLessorReceiptAuthorLabels[version.createdAs]})`,
    createdAt: version.createdAt,
    decidedBy: version.decidedByName,
    decidedAt: version.decidedAt,
    reason: version.decisionComment || null,
    retiredAt: version.retiredAt,
    retiredBy: version.retiredByName,
    retiredReason: version.retiredReason,
  };
}

/** The lessor's view (W4): his own words for the side, the rejection reason and nothing else. */
export function lessorReceiptLine(version: MechLessorReceiptVersionView): MechLessorReceiptLine {
  return {
    id: version.id,
    versionNo: version.versionNo,
    status: version.status,
    file: version.file,
    author: mechLessorReceiptAuthorLabels[version.createdAs],
    createdAt: version.createdAt,
    decidedBy: null,
    decidedAt: version.decidedAt,
    reason: version.rejectionReason,
    retiredAt: version.retiredAt,
    retiredBy: null,
    retiredReason: version.retiredReason,
  };
}

/** Status colours: gold waits for a signature (as every visa of the module), red is a refusal. */
export const RECEIPT_STATUS_COLORS: Record<MechLessorReceiptStatus, string> = {
  pending: 'gold',
  approved: 'green',
  rejected: 'red',
  waived: 'blue',
};

/** What the words under a decision are, by the decision: a reason and a remark read differently. */
export const RECEIPT_REASON_LABELS: Record<MechLessorReceiptStatus, string> = {
  pending: 'Комментарий',
  approved: 'Комментарий',
  rejected: 'Причина отказа',
  waived: 'Почему без чека',
};
