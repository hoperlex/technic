import type { ReactNode } from 'react';
import type { CounterpartyType, GrantStatement, Role, UserAccountDto } from '@technic/contracts';

export interface UserGrantsFieldParams {
  open: boolean;
  isSelf: boolean;
  role: Role | null;
  counterpartyType: CounterpartyType | null;
  record: UserAccountDto | null;
  /** Grant codes proposed from the registration request, not silently assigned by the client. */
  suggestedCodes?: readonly string[];
  onReload: () => void;
}

export interface UserGrantsControl {
  shown: boolean;
  /** True only after the server confirms that the whole catalog has been loaded. */
  ready: boolean;
  /** An incomplete or failed catalog also blocks role changes in the surrounding form. */
  blocked: boolean;
  /** Build a versioned statement; undefined deliberately omits grants from the request. */
  statements: () => GrantStatement[] | undefined;
  /** Return true when the field has rendered the server violation itself. */
  handleError: (error: unknown) => boolean;
  field: ReactNode;
}
