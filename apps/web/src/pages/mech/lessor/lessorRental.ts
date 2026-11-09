import {
  isMechLessorSubject,
  mechLessorReceiptAccess,
  mechLessorReceiptAttachBlocker,
  mechLessorReceiptMark,
  type AuthUser,
  type MechLessorReceiptAccess,
  type MechLessorReceiptMark,
  type MechLessorReceiptTarget,
  type MechLessorRentalDto,
  type Permission,
} from '@technic/contracts';

/*
 * The lessor's rental as the contracts' receipt rules ask it (lessor receipt plan, P12, P15). His
 * DTO is an allow-list and carries the receipt as his audience's block, not the office's flat
 * fields, so the rules get the same facts by this one translation — the page never decides an
 * availability itself.
 */

/**
 * The receipt's side of the rental. `deletedAt` is `null` by construction: his doors never return
 * an archived rental (O12), the server's predicate refuses it before the DTO is built.
 */
export function lessorReceiptTarget(rental: MechLessorRentalDto): MechLessorReceiptTarget {
  const current = rental.lessorReceipt.current;
  return {
    status: rental.status,
    deletedAt: null,
    lessorReceiptRequired: rental.lessorReceipt.required,
    lessorReceipt: current ? { status: current.status } : null,
  };
}

/** The mark of his list row and card: the same `mechLessorReceiptMark` the office rows show. */
export function lessorRentalMark(rental: MechLessorRentalDto): MechLessorReceiptMark | null {
  return mechLessorReceiptMark(lessorReceiptTarget(rental));
}

/**
 * «Прикрепить чек» / «Заменить чек» of his card: `mechLessorReceiptAccess`, the predicate the server
 * answers with, over the facts his DTO carries.
 *
 * - `lessorId` is his own counterparty: a rental reaches him only through the server's
 *   `isMechLessorRentalVisible` (anything else is a 404), so a rental on his page IS his — the
 *   predicate is still asked, and it still checks «В работе».
 * - `lessorVersionCount` is `ownVersionCount`, sent by the server for exactly this (the cap of P7):
 *   the button disappears when the server would refuse.
 * - The visa sides are not in his DTO (O7). Empty values are safe: the visa circle refuses every
 *   counterparty-scoped role before it reads the row (`canApproveMechRequest`, P5), and the lessor
 *   holds no `mechRequests.approve` besides.
 *
 * `can` is the server's list (ADR 0223), never the matrix.
 */
export function mechLessorRentalAccess(
  user: AuthUser | null,
  rental: MechLessorRentalDto,
  can: (permission: Permission) => boolean,
): MechLessorReceiptAccess {
  return mechLessorReceiptAccess(
    user,
    {
      ...lessorReceiptTarget(rental),
      objectId: '',
      departmentId: null,
      lessorId: user?.counterpartyId ?? null,
      lessorVersionCount: rental.lessorReceipt.ownVersionCount,
    },
    can,
  );
}

/**
 * Why there is no attach button, in the words the server would refuse with — asked only when
 * `access.attach` is `false`, so it explains a decision and never makes one. `null` when the state
 * allows it and the reason is elsewhere (the permission).
 */
export function lessorAttachHint(
  user: AuthUser | null,
  rental: MechLessorRentalDto,
): string | null {
  return mechLessorReceiptAttachBlocker({
    row: rental,
    current: rental.lessorReceipt.current,
    lessorVersionCount: rental.lessorReceipt.ownVersionCount,
    actsAsLessor: isMechLessorSubject(user),
  });
}
