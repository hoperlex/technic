import { COUNTERPARTY_TYPES, counterpartyTypeLabels } from '@technic/contracts';

/** One counterparty-type option list shared by registry filters and the editor. */
export const counterpartyTypeOptions = COUNTERPARTY_TYPES.map((type) => ({
  value: type,
  label: counterpartyTypeLabels[type],
}));
