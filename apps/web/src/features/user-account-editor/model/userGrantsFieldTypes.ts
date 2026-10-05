import type { ReactNode } from 'react';
import type { CounterpartyType, GrantStatement, Role, UserAccountDto } from '@technic/contracts';

/** What the grants field reads and where it reports its result. */
export interface UserGrantsFieldParams {
  /** The modal is open. Closing it resets manual ticks (R4) and the shown refusal. */
  open: boolean;
  /** The administrator edits their own account: the field is absent (R9). */
  isSelf: boolean;
  /** Role selected in the form right now: it defines the list, not the role stored in the DB (R2). */
  role: Role | null;
  /** Counterparty type from the form — the other half of the subject of the "Will be added" line (§6). */
  counterpartyType: CounterpartyType | null;
  /** The edited account: its assignments and the "before" role. A new account has none. */
  record: UserAccountDto | null;
  /**
   * Grant codes proposed by the applicant's wish (ADR 0143, §3.6). Empty or absent means no
   * suggestion: an ordinary account and a new one open this way.
   *
   * They enter as the third hydration set rather than as an assignment to the field, which is a
   * different mechanism from the form initialisation (§3.5): role and scope are filled once,
   * whereas suggested grants are recomputed on every role change. The difference shows in one
   * scenario — change the role and change it back: suggested ticks come back (the wish is still
   * there), while a tick removed by hand does not (the "unchecked" set lives while the modal is
   * open).
   */
  suggestedCodes?: readonly string[];
  /** Reload the account data: called when saving hit a stale screen. */
  onReload: () => void;
}

export interface UserGrantsControl {
  /** The field is shown: a role is selected, it is not driver, and the account is not one's own. */
  shown: boolean;
  /**
   * The catalog is loaded to the end, i.e. there is something to say about grants. The form needs
   * it as the approval barrier (§3.6), and blocked does not replace it: blocked is derived from an
   * error and complete === false, while the initial load (data === undefined) is not part of it at
   * all. During that window statements() silently returns undefined and grants are not sent.
   *
   * Before a role was ever suggested this silence was harmless: the administrator ticked nothing,
   * and nothing was saved. With a suggested role it is harmful: one could switch "Active" on and
   * save, getting an account with a role and without the suggested grants — silently. So the flag
   * is honest (complete === true), and the ban on approving a half-loaded catalog is enforced by
   * the role field validator, the same one that keeps "a registration is reviewed as a whole".
   */
  ready: boolean;
  /**
   * The catalog came back incomplete or failed with an error; waiting for the first answer is not
   * included, ready reports that. It locks the role field too: silence about grants is legal only
   * while the role does not switch their effect (§4.2), and the form must not lead to a refusal
   * caused by itself.
   */
  blocked: boolean;
  /** Statement for the request body; undefined means do not send the field at all (§4.1). */
  statements: () => GrantStatement[] | undefined;
  /** Map a server refusal onto the field. true means it is shown and no generic error is needed (R8). */
  handleError: (error: unknown) => boolean;
  /** The field markup; null when there is no field. */
  field: ReactNode;
}
