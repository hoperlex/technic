import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Form, Space, type FormInstance } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  activationDefaultsFor,
  expectedCounterpartyType,
  registrationRequestDetail,
  requestRoleTitle,
  roleLabels,
  type Role,
  type UserAccountDto,
} from '@technic/contracts';
import { departmentRecordsQuery } from '@entities/department';
import { grantFormApi, grantKeys } from '@entities/grant';
import {
  matchReasonLabels,
  NO_SUGGESTION,
  suggestCounterparty,
  suggestSubdivision,
  type AreaSuggestion,
  type MatchRecord,
} from './activationSuggestion';
import {
  approvesRegistration,
  HALF_APPROVAL,
  hasExternalEmail,
  isPendingRegistration,
  requestedDetailText,
} from '@entities/user-account';
import type { UserFormValues } from './types';

/**
 * Prefills the registration-review form from the applicant's wish (plan "the registration wish
 * names the position and fills the activation form", §3.5–§3.8): the field-initialization state
 * machine, the match candidates under a field, and the banner's second line about what was filled.
 *
 * Kept out of `UsersTab` for the same reason as `userGrantsModel` and `registrationApproval`: this
 * is computation, not markup. "Which source has arrived, what does it suggest, was the field
 * touched" are answered by values, not by clicking fields; spread across three field handlers they
 * would become three similar chunks that drift apart on the first edit, and each of the three would
 * have to remember the fill-once rule on its own.
 *
 * The only markup here is two small pieces, the candidate line and the banner, and they live with
 * the computation deliberately: both are fully described by what the state machine computed, and
 * the form only sees one name for each. Spread over the three area fields, the candidate line would
 * be three copies of the same line.
 *
 * Nothing here grants permissions or approves requests: "Active" is never prefilled (§3.5), and
 * prefilled values reach the server only together with an approval (§3.6), since the form builds
 * the request body itself. A prefill is the screen's suggestion, not a value of the request.
 */

/** Area fields filled by matching: each has its own directory and its own label in the banner. */
export type ActivationAreaField = 'constructionObjectIds' | 'departmentIds' | 'counterpartyId';

/** Fields the prefill touches: the three area fields plus the role. */
type FilledField = 'role' | ActivationAreaField;

export interface ActivationControl {
  /**
   * Codes of the grant sets suggested by the wish, for the grants field (§3.6). Empty for a regular
   * account and when creating a new one: there is nothing to prefill from.
   */
  grantCodes: readonly string[];
  /** Candidate line under an area field; `undefined` means no hint at all (§3.7). */
  hint: (field: ActivationAreaField) => ReactNode;
  /** Request summary: what the applicant stated and what was filled from it. `null` — no wish. */
  banner: ReactNode;
}

/**
 * Refusal to approve a request while the grants catalog is still loading (§3.6).
 *
 * The barrier sits on approval, not on the whole form: silence about grants is harmless while no
 * role is being assigned, but with a prefilled role "Save" would grant access with the role and
 * **without** the suggested sets, and silently. Other edits to the request (name, phone) pass.
 */
const CATALOG_NOT_READY =
  'Список полномочий ещё загружается — дождитесь его: иначе заявка будет одобрена с ролью, но без предложенных наборов';

/**
 * What is wrong with the role field, as a single answer covering both request-review rules.
 *
 * There are two rules and both concern one decision, so they live in one place (§3.6): a request is
 * reviewed as a whole (`HALF_APPROVAL` — a role without activation and activation without a role are
 * equally unfinished), and it is approved no earlier than the grants catalog has loaded
 * (`CATALOG_NOT_READY`). The second rule came with prefilling: until the catalog arrives the grants
 * field is absent from the request body, and a request approved in that window would get the role
 * **without** the suggested sets, silently.
 *
 * Roles without a catalog never hit the barrier (`grants.shown === false`): a driver and one's own
 * account have no grants field by construction, so there is nothing to wait for. Other request edits
 * (name, phone) pass in any catalog state: they do not touch grants, and locking the window for a
 * field half the roles lack would make prefilling cost the edits that always worked before.
 *
 * Lives here rather than in `registrationApproval`: that module holds the review predicate shared
 * with the server, while this is a screen rule with no server-side counterpart.
 */
export function roleIssue(
  record: UserAccountDto | null,
  role: Role | undefined,
  isActive: boolean | undefined,
  grants: { shown: boolean; ready: boolean },
): string | undefined {
  if (approvesRegistration(record, role, isActive) && grants.shown && !grants.ready)
    return CATALOG_NOT_READY;
  if (role) return undefined;
  // For a request the role awaits a decision, not input: leaving it in the queue is a valid outcome.
  if (!record || !isPendingRegistration(record)) return 'Выберите роль';
  return isActive ? HALF_APPROVAL : undefined;
}

/**
 * Role used as the catalog key when there is nothing to prefill. `driver` works because it never
 * has a grants field, so no foreign response can end up cached under this key.
 */
const NO_CATALOG_ROLE: Role = 'driver';

/**
 * What has already been done, and for which request (§3.5, rules 1 and 2).
 *
 * Keyed by `record.id`: opening another request keeps the first one's defaults from leaking into
 * it, while closing and reopening the same one recomputes the prefill. There are three flags rather
 * than one because the sources arrive separately (the wish with the window, directories whenever
 * they respond), and a late response from the second directory must not overwrite what was applied.
 */
interface Progress {
  key: string | null;
  role: boolean;
  subdivision: boolean;
  counterparty: boolean;
}

/** What the prefill actually did: the banner's second line reports this and only this. */
interface Applied {
  role: Role | null;
  /** Ready-made line fragments, e.g. «объект «С-12 — ЖК Северный» (совпал по названию)». */
  areas: string[];
}

const NOTHING_APPLIED: Applied = { role: null, areas: [] };

interface Params {
  /** Window is open; a closed one means "request not under review" and resets the prefill. */
  open: boolean;
  /** Account being edited; `isPendingRegistration` makes it a request, not the fact of editing. */
  record: UserAccountDto | null;
  form: FormInstance<UserFormValues>;
  /** Objects and counterparties: the same lists the form shows in its own fields. */
  objects: readonly MatchRecord[] | undefined;
  counterparties: readonly MatchRecord[] | undefined;
}

/** How a record is shown in a list: code and name when there is a code, otherwise just the name. */
const recordLabel = (record: MatchRecord): string =>
  record.code ? `${record.code} — ${record.name}` : record.name;

/** Banner fragment about a prefilled area: what it matched on is a mandatory part (§3.7). */
const areaText = (kind: string, record: MatchRecord, reason: keyof typeof matchReasonLabels) =>
  `${kind} «${recordLabel(record)}» (совпал ${matchReasonLabels[reason]})`;

/**
 * Writes a default into a field, but only an empty and untouched one (§3.5, rule 3).
 *
 * "Touched" is asked of the form (`isFieldTouched`) rather than inferred by comparing values: an
 * admin who manually returned a field to its previous value still made a decision, and a late
 * directory response must not undo it. For a list, empty means zero length: "nothing selected" and
 * `[]` are the same here.
 *
 * Returns whether it filled the field: the banner reports an action taken, not one that might be.
 */
function fill(
  form: FormInstance<UserFormValues>,
  name: FilledField,
  value: string | string[],
): boolean {
  if (form.isFieldTouched(name)) return false;
  const current: unknown = form.getFieldValue(name);
  const empty = Array.isArray(current) ? current.length === 0 : !current;
  if (!empty) return false;
  form.setFieldValue(name, value);
  return true;
}

/**
 * Candidates are shown only under an empty field: a "looks like" hint next to an already chosen
 * record argues with the choice itself, and clicking it would silently overwrite the admin's decision.
 */
function hintsFor(
  suggestion: AreaSuggestion,
  current: string | string[] | null | undefined,
  choose: (id: string) => void,
): ReactNode {
  const empty = Array.isArray(current) ? current.length === 0 : !current;
  if (!empty || suggestion.kind !== 'candidates') return undefined;
  return (
    <Space size={4} wrap>
      Похоже на:
      {suggestion.records.map((record) => (
        <Button key={record.id} size="small" type="link" onClick={() => choose(record.id)}>
          {recordLabel(record)}
        </Button>
      ))}
    </Space>
  );
}

/**
 * The banner's second line is in the **past tense** (§3.8): it describes an action taken, not the
 * current form state, and stays true after the admin corrects the role. "Prefilled: role Site" while
 * a different role is selected would be a lie on screen.
 */
function filledText(applied: Applied, grantNames: string[]): string | undefined {
  const parts = [
    applied.role ? `роль «${roleLabels[applied.role]}»` : undefined,
    grantNames.length > 0
      ? `полномочия ${grantNames.map((name) => `«${name}»`).join(', ')}`
      : undefined,
    ...applied.areas,
  ].filter(Boolean);
  if (parts.length === 0) return undefined;
  return `Заполнено по заявке: ${parts.join(', ')}. Проверьте перед сохранением.`;
}

export function useActivationDefaults(params: Params): ActivationControl {
  const { open, record, form, objects, counterparties } = params;
  /*
   * Departments come as raw fields (`code` and `name` separately), not as list labels: a joined
   * "code — name" cannot be split back, since the first name containing a dash would split on the
   * wrong dash (§3.7). This is a second observer of the same query, sharing the key with the form's
   * dropdown, so no extra server round trip occurs. Objects and counterparties are passed in as
   * params because the form holds them itself.
   */
  const { data: departments } = useQuery(departmentRecordsQuery());

  /** A request under review is the only thing there is anything to prefill from (§3.5). */
  const request = open && record && isPendingRegistration(record) ? record : null;
  const defaults = activationDefaultsFor(request?.requestedRole);
  // Object and department share one request field across two directories; only the wish tells them apart (§3.4).
  const detail = request?.requestedRole ? registrationRequestDetail[request.requestedRole] : 'none';
  const subdivisionField =
    detail === 'object'
      ? 'constructionObjectIds'
      : detail === 'department'
        ? 'departmentIds'
        : null;
  const subdivisionRecords =
    detail === 'object' ? objects : detail === 'department' ? departments : undefined;
  const expectedType = expectedCounterpartyType(request?.requestedRole);

  const subdivision = useMemo(
    () =>
      subdivisionRecords
        ? suggestSubdivision(request?.requestedObject, subdivisionRecords)
        : NO_SUGGESTION,
    [request?.requestedObject, subdivisionRecords],
  );
  const counterparty = useMemo(
    () =>
      counterparties
        ? suggestCounterparty(request?.requestedCompany, counterparties, expectedType)
        : NO_SUGGESTION,
    [request?.requestedCompany, counterparties, expectedType],
  );

  /*
   * Prefill progress is a ref, not state: flags are set and read within one effect pass, and a
   * re-render per flag would add an extra cycle exactly where we are editing the form. The outcome,
   * however, is state, because the banner reports it.
   */
  const done = useRef<Progress>({
    key: null,
    role: false,
    subdivision: false,
    counterparty: false,
  });
  const [applied, setApplied] = useState<Applied>(NOTHING_APPLIED);

  useEffect(() => {
    const key = request?.id ?? null;
    if (done.current.key !== key) {
      done.current = { key, role: false, subdivision: false, counterparty: false };
      setApplied(NOTHING_APPLIED);
    }
    if (!request) return;

    /*
     * Role: its source is the wish itself, which arrives with the window. It still needs a flag,
     * otherwise the prefill would repeat on every directory response and bring back a role the
     * admin has already cleared by then.
     */
    if (!done.current.role) {
      done.current.role = true;
      const role = defaults.role;
      if (role && fill(form, 'role', role)) setApplied((was) => ({ ...was, role }));
    }

    // Object or department: wait for its directory to respond, since an empty list is not "no match".
    if (!done.current.subdivision && subdivisionField && subdivisionRecords) {
      done.current.subdivision = true;
      if (subdivision.kind === 'match' && fill(form, subdivisionField, [subdivision.record.id])) {
        const kind = subdivisionField === 'constructionObjectIds' ? 'объект' : 'отдел';
        const area = areaText(kind, subdivision.record, subdivision.reason);
        setApplied((was) => ({ ...was, areas: [...was.areas, area] }));
      }
    }

    // Counterparty: same order, but matching is allowed only within the expected type (§3.3).
    if (!done.current.counterparty && counterparties) {
      done.current.counterparty = true;
      if (counterparty.kind === 'match' && fill(form, 'counterpartyId', counterparty.record.id)) {
        const area = areaText('контрагент', counterparty.record, counterparty.reason);
        setApplied((was) => ({ ...was, areas: [...was.areas, area] }));
      }
    }
  }, [
    request,
    form,
    defaults,
    subdivision,
    subdivisionField,
    subdivisionRecords,
    counterparty,
    counterparties,
  ]);

  /*
   * Grant set names come from the catalog, not from the defaults table: a set's name changes with a
   * release, and the database stays the source of truth (§3.8). It is read by a **second observer**
   * of the grants field's query (`enabled: false`): a banner label is no reason to hit the server,
   * so this only reads what the field already requested. Keyed by the prefilled role: the banner
   * line is in the past tense, and the admin changing the role does not rewrite it.
   */
  const catalogRole = applied.role ?? NO_CATALOG_ROLE;
  const catalog = useQuery({
    queryKey: grantKeys.formCatalog(catalogRole),
    queryFn: () => grantFormApi.catalog(catalogRole),
    enabled: false,
  });
  const grantNames = (catalog.data?.items ?? [])
    .filter((item) => (defaults.grants as readonly string[]).includes(item.code))
    .map((item) => item.name);

  const objectIds = Form.useWatch('constructionObjectIds', form);
  const departmentIds = Form.useWatch('departmentIds', form);
  const counterpartyId = Form.useWatch('counterpartyId', form);

  /** A candidate is applied only on click: the portal suggests but does not choose (§3.7). */
  const choose = (field: ActivationAreaField, id: string) =>
    form.setFieldValue(field, field === 'counterpartyId' ? id : [id]);
  const currentValue: Record<ActivationAreaField, string | string[] | null | undefined> = {
    constructionObjectIds: objectIds,
    departmentIds: departmentIds,
    counterpartyId: counterpartyId,
  };

  return {
    grantCodes: defaults.grants,
    hint: (field) =>
      hintsFor(
        field === 'counterpartyId'
          ? counterparty
          : field === subdivisionField
            ? subdivision
            : NO_SUGGESTION,
        currentValue[field],
        (id) => choose(field, id),
      ),
    banner: record?.requestedRole ? (
      /*
       * One banner with two lines (§3.8): a second banner next to it would turn the top of the form
       * into two paragraphs before the first field. The wish is printed via `requestRoleTitle`
       * rather than a direct dictionary lookup: once the wish is retired, the dictionary would
       * answer `undefined` in a request line that can no longer be rewritten.
       */
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title={[
          `При регистрации указал: ${requestRoleTitle(record.requestedRole)}`,
          requestedDetailText(record),
          // Same flag as the list marker (ADR 0090): the decision is made in this window, and what
          // was seen in the list has been forgotten by now.
          hasExternalEmail(record) ? 'Адрес внешней почты' : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
        description={filledText(applied, grantNames)}
      />
    ) : null,
  };
}
