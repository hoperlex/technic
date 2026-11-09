import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MechLessorReceiptDecision } from '@technic/contracts';
import { filesApi } from '@entities/file';
import { mechRequestKeys, mechRequestsApi } from '@entities/mech-request';

/**
 * The rental a receipt door acts on: its id, its number for the window's title and the version the
 * person saw. Narrow on purpose: the office's `MechRequestDto` and the lessor's own rental both fit,
 * so the lessor's page (W4) opens the same upload window.
 */
export interface MechLessorReceiptRental {
  id: string;
  displayNumber: string;
  version: number;
}

/*
 * One mutation per door (lessor receipt plan, P5–P7). Each drops the module's whole cache when it
 * settles, refusal included: a 409 means the card under the hand is another one already, and a 422
 * means the state differs from what the buttons were built on — leaving the old card on screen would
 * invite the same press again. The doors answer only the receipt block; the card, the list rows and
 * their marks are read again from the server.
 */

/** Upload the file, then attach it: storage first, the link second, as every attachment. */
export function useAttachMechLessorReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ rental, file }: { rental: MechLessorReceiptRental; file: File }) => {
      const uploaded = await filesApi.upload(file);
      return mechRequestsApi.attachLessorReceipt(rental.id, {
        fileId: uploaded.id,
        version: rental.version,
      });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: mechRequestKeys.root }),
  });
}

/**
 * A decision on the version the person SAW: `receiptId` is the one shown, and the server binds the
 * write to it, so a signature never lands on a version replaced while the window was open (P5).
 */
export function useDecideMechLessorReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      rental: MechLessorReceiptRental;
      receiptId: string;
      decision: MechLessorReceiptDecision;
      comment: string;
    }) =>
      mechRequestsApi.decideLessorReceipt(v.rental.id, {
        receiptId: v.receiptId,
        decision: v.decision,
        comment: v.comment,
        version: v.rental.version,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: mechRequestKeys.root }),
  });
}

/** The «без чека» visa (P6): the reason is its only record. */
export function useWaiveMechLessorReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { rental: MechLessorReceiptRental; comment: string }) =>
      mechRequestsApi.waiveLessorReceipt(v.rental.id, {
        comment: v.comment,
        version: v.rental.version,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: mechRequestKeys.root }),
  });
}
