/**
 * The plate key table shared by two tests (ADR 0138, owner decision S-6):
 *
 * - `vehicles-contracts.test.ts` checks the contracts copy `normalizeRegistration` against it on
 *   every `pnpm check`;
 * - `vehicle-reg-normalize-parity.db.test.ts` runs the same inputs through the database authority
 *   `vehicle_reg_normalize` (migration 0015) and demands the same key from both.
 *
 * One table and not two copies: the point of the pin is that both sides answer the same question,
 * and two tables could be edited apart just as the two rules once were.
 *
 * `key` is the database answer: `null` where Postgres returns `NULL`. The contracts copy returns
 * `''` there — the empty key, which matches nothing (see `normalizeRegistration`).
 */
export interface RegistrationKeyCase {
  what: string;
  input: string | null;
  key: string | null;
}

export const REGISTRATION_KEY_CASES: readonly RegistrationKeyCase[] = [
  { what: 'Cyrillic with spaces', input: 'В 094 ЕТ 77', key: 'B094ET77' },
  { what: 'Latin', input: 'B094ET77', key: 'B094ET77' },
  { what: 'lower-case Cyrillic', input: 'в094ет77', key: 'B094ET77' },
  { what: 'lower-case Latin', input: 'b094et77', key: 'B094ET77' },
  { what: 'two layouts in one plate', input: 'В094eТ77', key: 'B094ET77' },
  { what: 'region split by spaces', input: 'ХО 4654 50', key: 'XO465450' },
  { what: 'dashes', input: 'ХО-4654-50', key: 'XO465450' },
  { what: 'the trailer from ADR 0138 S-6', input: 'ен 806277', key: 'EH806277' },
  { what: 'tab, leading and trailing spaces', input: ' ВХ 9332\t77 ', key: 'BX933277' },
  { what: 'dot, slash and underscore are separators', input: 'АВ.123/77_RUS', key: 'AB12377RUS' },
  { what: 'all twelve look-alikes, upper case', input: 'АВЕКМНОРСТУХ', key: 'ABEKMHOPCTYX' },
  { what: 'all twelve look-alikes, lower case', input: 'авекмнорстух', key: 'ABEKMHOPCTYX' },
  { what: 'Cyrillic without a look-alike stays Cyrillic', input: 'ЖД 1234', key: 'ЖД1234' },
  { what: 'Cyrillic without a look-alike, lower case', input: 'жд1234', key: 'ЖД1234' },
  { what: 'Ё is kept and not folded into Е', input: 'ёЁ 12', key: 'ЁЁ12' },
  { what: 'Latin outside the plate alphabet is kept', input: 'q-12', key: 'Q12' },
  { what: 'a character outside the BMP is a separator', input: 'ВХ933277🚛', key: 'BX933277' },
  { what: 'non-ASCII digits are separators, not digits', input: 'АВ１２３', key: 'AB' },
  { what: 'empty', input: '', key: null },
  { what: 'spaces only', input: '   ', key: null },
  { what: 'separators only', input: ' - / - ', key: null },
  { what: 'NULL', input: null, key: null },
];
