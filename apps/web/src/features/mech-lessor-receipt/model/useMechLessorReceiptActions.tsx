import { useState, type ReactNode } from 'react';
import type { MechLessorReceiptVersionDto, MechRequestDto } from '@technic/contracts';
import type { MechLessorReceiptHandlers } from '../ui/MechLessorReceiptBlock';
import {
  MechLessorReceiptReasonModal,
  type MechLessorReceiptReasonKind,
} from '../ui/MechLessorReceiptReasonModal';
import { MechLessorReceiptUploadModal } from '../ui/MechLessorReceiptUploadModal';
import { MechLessorReceiptVisaModal } from '../ui/MechLessorReceiptVisaModal';

/**
 * The receipt windows of one call site (ADR 0140): the upload, the visa window and the reason
 * dialog. Like the rest of the module's actions, one set lives per place — the windows of a list row
 * at the tab, the windows of the card inside the card — because one window drawn in two places is
 * two instances, and the second hides under the first.
 *
 * What is available is not decided here: the menu and the card ask `mechLessorReceiptAccess`. The
 * openers only remember what to show; each window keeps the snapshot it was opened with, so a reread
 * of the card under it changes nothing the person is signing.
 */
export function useMechLessorReceiptActions(): {
  open: MechLessorReceiptHandlers;
  close: () => void;
  modals: ReactNode;
} {
  const [upload, setUpload] = useState<{ request: MechRequestDto; replace: boolean } | null>(null);
  const [visa, setVisa] = useState<{
    request: MechRequestDto;
    receipt: MechLessorReceiptVersionDto;
  } | null>(null);
  const [reason, setReason] = useState<{
    request: MechRequestDto;
    kind: MechLessorReceiptReasonKind;
  } | null>(null);

  const open: MechLessorReceiptHandlers = {
    attach: (request) => setUpload({ request, replace: request.lessorReceipt !== null }),
    review: (request) => {
      const receipt = request.lessorReceipt;
      if (receipt?.file) setVisa({ request, receipt });
    },
    waive: (request) => setReason({ request, kind: 'waive' }),
    revokeApproval: (request) => setReason({ request, kind: 'revokeApproval' }),
    revokeWaiver: (request) => setReason({ request, kind: 'revokeWaiver' }),
  };

  const close = () => {
    setUpload(null);
    setVisa(null);
    setReason(null);
  };

  const modals = (
    <>
      <MechLessorReceiptUploadModal
        rental={upload?.request ?? null}
        replace={upload?.replace ?? false}
        onClose={() => setUpload(null)}
      />
      <MechLessorReceiptVisaModal target={visa} onClose={() => setVisa(null)} />
      <MechLessorReceiptReasonModal target={reason} onClose={() => setReason(null)} />
    </>
  );

  return { open, close, modals };
}
