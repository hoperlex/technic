import type { CounterpartyType } from '@technic/contracts';

/**
 * Matches an area from the free text of a registration request (plan "the registration wish names
 * the position and fills the activation form", §3.7).
 *
 * The applicant names the object, department and company as plain text: directories are not served
 * to unauthenticated users (ADR 0034), so they have nothing to pick a record from. The admin picks
 * the record at activation, and matching is all the help the portal may give: it either prefills a
 * single record or suggests several, but never chooses on the person's behalf.
 *
 * A separate file rather than part of the form, for the same reason as the other rules of this
 * screen: it computes over three directories at once (objects, departments, counterparties) and is
 * verified by values, not by clicking markup. Spread across field handlers, it would turn into three
 * similar chunks that drift apart on the first edit.
 *
 * There is no similarity threshold here and there will be none, neither our own nor `pg_trgm`:
 * directories are small, and a hint that guesses silently hands the admin someone else's object,
 * since nobody double-checks a filled field with a plausible name. The server suggests this way only
 * for people (`DriverPersonField`), where the directory is large and the choice stays with a human.
 */

/**
 * A directory record as matching sees it: **structure, not a label**.
 *
 * A ready-made list label does not work here. For a department it is already joined by the query
 * into `code — name` (`departmentOptionsQuery`) and cannot be split back: the first name containing
 * a dash would split on the wrong dash and feed matching an invented name. So the raw fields come
 * from a second observer of the same query (`departmentRecordsQuery`), and matching knows nothing
 * about how a record looks on screen.
 */
export interface MatchRecord {
  id: string;
  name: string;
  /** Object or department code; counterparties have no code. */
  code?: string;
  /** Counterparty INN (taxpayer number). */
  inn?: string;
  /** Counterparty type (ADR 0038); a plain string because matching has no need for the type vocabulary. */
  type?: string;
}

/** What it matched on: the label goes into the form banner, «объект „С-12 — ЖК Северный“ (совпал по названию)». */
export type MatchReason = 'code' | 'inn' | 'name';

/**
 * Match reason labels. A separate map rather than inline banner text: the reason is shown next to
 * the candidate line too, and two places spelling "by name" independently would drift in wording.
 */
export const matchReasonLabels: Record<MatchReason, string> = {
  code: 'по коду',
  inn: 'по ИНН',
  name: 'по названию',
};

/**
 * The matching result has three outcomes, not a record with a candidate array beside it.
 *
 * "Prefilled" and "suggested" are mutually exclusive by rule (§3.7): a prefill happens only on a
 * single exact match, and candidates only when there is none. A representation able to express both
 * at once would force the form to untangle it on every read, and the impossible state would remain
 * expressible anyway.
 */
export type AreaSuggestion =
  | { kind: 'match'; record: MatchRecord; reason: MatchReason }
  | { kind: 'candidates'; records: MatchRecord[] }
  | { kind: 'none' };

/** Nothing found: no candidate line at all, since an empty hint is worse than none. */
export const NO_SUGGESTION: AreaSuggestion = { kind: 'none' };

/**
 * More than three candidates is no longer a hint under a field but a second list next to the
 * dropdown, and the admin will stop reading it: searching it is as much work as the directory itself.
 */
const MAX_CANDIDATES = 3;

/**
 * Legal entity forms that distinguish nothing in a name: «ООО „Ромашка“» and «Ромашка» are the same
 * organization, and applicants write it either way.
 */
const LEGAL_FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'нао', 'ао', 'ип']);

/**
 * One normalization for both sides of the comparison: the directory is brought to the same form as
 * the request text, otherwise different spellings of the same thing would be compared.
 *
 * Punctuation and dashes become a space rather than disappearing: without this «ЖК Северный-2» and
 * «ЖК Северный 2» would differ, and gluing them without a space would make «Северный2» match
 * neither. Symbols are erased along with punctuation: Unicode classifies e.g. "+" as one, and a word
 * joined by it must not stick to its neighbour.
 */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Same as above plus stripping the legal form, **for counterparties only**: objects and departments
 * never carry such prefixes, and an "АО" in their name would be part of the name.
 *
 * The form is stripped **as a separate word at an edge**, not as a substring, and this is not
 * pedantry: `«каоленит»` without the substring `ао` becomes `«кленит»`, a bogus name that would
 * confidently match someone else's record. We never strip down to an empty string: an organization
 * named by its legal form alone has that as its name, not a missing name.
 */
function prepare(text: string, stripLegalForm: boolean): string {
  const normalized = normalize(text);
  if (!stripLegalForm) return normalized;
  const words = normalized.split(' ');
  if (words.length > 1 && LEGAL_FORMS.has(words[0] ?? '')) words.shift();
  if (words.length > 1 && LEGAL_FORMS.has(words.at(-1) ?? '')) words.pop();
  return words.join(' ');
}

/**
 * Tiered matching: code or INN, then exact name, then candidates by substring.
 *
 * Uniqueness is checked **at each tier separately**, and a non-unique tier does not stop matching
 * but yields to the next one. Two identical names therefore produce candidates, not a prefill: the
 * portal cannot choose between two "Severny" records for the admin, but it can show both and let
 * them click.
 */
function suggest(
  text: string | null | undefined,
  records: readonly MatchRecord[],
  stripLegalForm: boolean,
): AreaSuggestion {
  const query = prepare(text ?? '', stripLegalForm);
  if (!query) return NO_SUGGESTION;

  /*
   * Tier 1. Code applies to objects and departments, INN to counterparties, but the branch is on the
   * request text, not the directory: ten or twelve digits and nothing else is an INN, anything else
   * is a code. Records lacking the queried field match nothing and drop out on their own.
   */
  const digits = query.replace(/\s/gu, '');
  const looksLikeInn = /^(?:\d{10}|\d{12})$/u.test(digits);
  const identified = looksLikeInn
    ? records.filter((r) => r.inn === digits)
    : records.filter((r) => r.code !== undefined && normalize(r.code) === query);
  const [onlyIdentified] = identified;
  if (identified.length === 1 && onlyIdentified) {
    return { kind: 'match', record: onlyIdentified, reason: looksLikeInn ? 'inn' : 'code' };
  }

  // Tier 2: exact name; both sides went through the same normalization.
  const named = records.map((record) => ({ record, name: prepare(record.name, stripLegalForm) }));
  const sameName = named.filter((n) => n.name === query);
  const [onlySameName] = sameName;
  if (sameName.length === 1 && onlySameName) {
    return { kind: 'match', record: onlySameName.record, reason: 'name' };
  }

  /*
   * Tier 3: substring in either direction, since applicants write both shorter than the name
   * («Северный» for «ЖК Северный-2») and longer («ЖК Северный, корпус 2»). A record with no name at
   * all (only punctuation in it) is dropped: an empty string is contained in anything and would pull
   * the whole directory into the candidates.
   *
   * Candidate order is the directory order, sorted by name; ranking them "by match quality" would
   * mean introducing exactly the similarity threshold this module refuses to have.
   */
  const candidates = named.filter(
    (n) => n.name !== '' && (n.name.includes(query) || query.includes(n.name)),
  );
  if (candidates.length === 0) return NO_SUGGESTION;
  return { kind: 'candidates', records: candidates.slice(0, MAX_CANDIDATES).map((n) => n.record) };
}

/**
 * Matches a subdivision, i.e. an object or a department: the request stores both in one field, and
 * they differ only by the directory the records came from (§3.4).
 */
export function suggestSubdivision(
  text: string | null | undefined,
  records: readonly MatchRecord[],
): AreaSuggestion {
  return suggest(text, records, false);
}

/**
 * Matches a counterparty **only within the expected type** (the wish's `expectedCounterpartyType`).
 *
 * Three external wishes lead to the single role `operator`, and what the account actually does is
 * decided by the counterparty type (ADR 0038). «Ромашка» among lessors and «Ромашка» among service
 * companies are two different organizations, and matching without the type would give the account
 * the wrong module, silently.
 *
 * The type is a required argument, not an option with a default: a default of "search everywhere" is
 * exactly this bug, just written as a forgotten parameter. `null` (the wish does not ask about a
 * company) leaves the field to the admin: there is nothing to prefill and nothing to prefill from.
 *
 * This does not narrow the list in the form field itself: the admin may decide the applicant chose
 * the wrong position and pick an organization of another type by hand.
 */
export function suggestCounterparty(
  text: string | null | undefined,
  records: readonly MatchRecord[],
  expectedType: CounterpartyType | null,
): AreaSuggestion {
  if (!expectedType) return NO_SUGGESTION;
  return suggest(
    text,
    records.filter((r) => r.type === expectedType),
    true,
  );
}
