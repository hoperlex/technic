import type { ROLES } from '@technic/contracts';

/** Editable account fields; access scope remains mutually exclusive by the selected role. */
export interface UserFormValues {
  email: string;
  lastName: string;
  firstName: string;
  middleName?: string;
  phone?: string;
  role: (typeof ROLES)[number];
  password?: string;
  constructionObjectIds?: string[];
  departmentIds?: string[];
  counterpartyId?: string | null;
  personId?: string;
  confirmNameMismatch?: boolean;
  isActive: boolean;
  notifyUser: boolean;
}
