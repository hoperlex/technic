import type { ROLES } from '@technic/contracts';

/** Editable account fields; access scope remains mutually exclusive by the selected role. */
export interface UserFormValues {
  email: string;
  lastName: string;
  firstName: string;
  middleName?: string;
  /** Contact phone (ADR 0043) is optional: accounts created before it have none. */
  phone?: string;
  role: (typeof ROLES)[number];
  password?: string;
  /** Account objects (ADR 0039): an object-scoped role works on several sites at once. */
  constructionObjectIds?: string[];
  /** Account departments (ADR 0040): the second scope axis — instead of objects, not with them. */
  departmentIds?: string[];
  /**
   * Account counterparty: required for an external executor (ADR 0010). Its type selects the module
   * the account works in — waste removal or vehicle orders (ADR 0038).
   */
  counterpartyId?: string | null;
  /**
   * Directory person (ADR 0102): the fourth scope axis and a mandatory condition for activating a
   * driver. This role has no objects, departments or counterparty — it works from the person card.
   */
  personId?: string;
  /** Confirmation of a full-name mismatch (R30): shown only when there is a mismatch. */
  confirmNameMismatch?: boolean;
  isActive: boolean;
  /** Whether to email the person about the granted access. Not always asked — see asksAboutMail. */
  notifyUser: boolean;
}
