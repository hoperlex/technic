import { useEffect, useMemo, useState } from 'react';
import { Alert, Checkbox, Form, Select, Space, Tag, type FormInstance } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  formatPhone,
  isPersonScopedRole,
  type UserAccountDto,
  type UserPersonRefDto,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
import {
  userAccountKeys,
  usersApi,
  type PersonCandidateDto,
  type PersonCandidateMatch,
  type RestoreUserBody,
} from '@entities/user-account';

/**
 * Employee picker for a driver account (ADR 0102, R30), in its own file rather than a block inside
 * `UsersTab`: the field has its own server results, its own reconciliation with the employee card
 * and its own confirmation checkbox, and these belong where they live; otherwise the account form
 * grows a third conversation on top of roles, area and mail.
 *
 * The portal **suggests candidates but does not choose**: the system does not verify the
 * applicant's identity (R32), so the whole burden of checking lies with the admin. Hence the
 * field's design: it shows exactly what each candidate matched on, and puts a name mismatch on a
 * separate line with a checkbox, because a silent binding would hand the applicant someone else's
 * jobs along with customers' phone numbers.
 */

/** Account traits: used both to search for the employee and to reconcile with them. */
export interface DriverAccountFacts {
  /** `null` — the account is being created: the hint searches by the name typed in the form. */
  id: string | null;
  lastName: string;
  firstName: string;
  middleName: string;
  phone: string;
  email: string;
  /** Already bound employee: the field must show a name, not an identifier. */
  person: UserPersonRefDto | null;
}

/**
 * Account traits for the candidate hint. The field reads name and phone live from the form, since
 * the admin edits them in the same window; this holds what the form lacks: the account itself and
 * the already bound employee.
 */
export const personFactsOf = (u: UserAccountDto | null): DriverAccountFacts => ({
  id: u?.id ?? null,
  lastName: u?.lastName ?? '',
  firstName: u?.firstName ?? '',
  middleName: u?.middleName ?? '',
  phone: u?.phone ?? '',
  email: u?.email ?? '',
  person: u?.person ?? null,
});

/**
 * An archived driver account without a live employee card (R8): restoring it requires picking the
 * person in the same action, because a live account cannot exist without one, and "restore now,
 * fix later" would hit the database CHECK.
 */
export const restoreNeedsPerson = (u: UserAccountDto): boolean =>
  isPersonScopedRole(u.role) && (!u.person || !!u.person.deletedAt);

const matchLabels: Record<PersonCandidateMatch, string> = {
  phone: 'телефон',
  email: 'почта',
  name: 'ФИО',
};

/**
 * Whether two names are the same, by the same rule as the server: case-insensitive, ignoring extra
 * whitespace. If the rules diverged, the form would ask for confirmation where the server does not
 * expect it (or, conversely, stay silent right before a rejection).
 */
const sameName = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase('ru') === b.trim().toLocaleLowerCase('ru');

const isBlank = (v: string): boolean => v.trim() === '';

/** Candidate line: name, match reasons, job title and phone, which is how the admin recognizes the employee. */
function candidateLabel(p: {
  fullName: string;
  phone: string;
  jobTitle?: string;
  matchedBy?: PersonCandidateMatch[];
}) {
  const details = [p.jobTitle, p.phone ? formatPhone(p.phone) : ''].filter(Boolean).join(' · ');
  return (
    <Space size={6} wrap>
      <span>{p.fullName}</span>
      {details ? <span style={{ color: 'rgba(0,0,0,.45)' }}>{details}</span> : null}
      {(p.matchedBy ?? []).map((m) => (
        <Tag key={m} color={m === 'name' ? 'default' : 'green'}>
          {matchLabels[m]}
        </Tag>
      ))}
    </Space>
  );
}

/**
 * What the portal will copy silently on binding (R31): empty on one side is filled from the other,
 * filled on both and different is left alone. Shown beforehand rather than after the fact: the
 * copy happens without asking, so the admin must see it before pressing "Save".
 */
function fillNotice(account: DriverAccountFacts, person: PersonCandidateDto): string | null {
  const toAccount: string[] = [];
  const toPerson: string[] = [];
  if (isBlank(account.middleName) && !isBlank(person.middleName)) toAccount.push('отчество');
  if (isBlank(account.phone) && !isBlank(person.phone)) toAccount.push('телефон');
  if (!isBlank(account.middleName) && isBlank(person.middleName)) toPerson.push('отчество');
  if (!isBlank(account.phone) && isBlank(person.phone)) toPerson.push('телефон');
  // Email is copied only into the card: the "driver job" mailing sends to `persons.email`, and an
  // empty address there means the job is never sent at all.
  if (isBlank(person.email)) toPerson.push('почту');
  const parts = [
    toAccount.length > 0 ? `в учётку из карточки — ${toAccount.join(', ')}` : '',
    toPerson.length > 0 ? `в карточку из учётки — ${toPerson.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `Незаполненное перенесётся при сохранении: ${parts.join('; ')}` : null;
}

interface FieldProps {
  /** Account form: the field reads the chosen employee from it and writes alongside the other fields. */
  form: FormInstance;
  account: DriverAccountFacts;
  /** Name of the employee id field; the account form and the restore window use the same one. */
  name?: string;
}

export function DriverPersonField({ form, account: base, name = 'personId' }: FieldProps) {
  const [search, setSearch] = useState('');
  const term = search.trim();
  /*
   * Name and phone are read live from the form: the admin edits them in the same window, and the
   * hint and the mismatch check must follow what is typed, not what was in the database before.
   * The subscription lives here rather than in the account form, otherwise every keystroke would
   * re-render the tab together with the table. The restore window has no such fields, so the
   * account's own values remain there.
   */
  const account: DriverAccountFacts = {
    ...base,
    lastName: Form.useWatch<string | undefined>('lastName', form) ?? base.lastName,
    firstName: Form.useWatch<string | undefined>('firstName', form) ?? base.firstName,
    middleName: Form.useWatch<string | undefined>('middleName', form) ?? base.middleName,
    phone: Form.useWatch<string | undefined>('phone', form) ?? base.phone,
    email: Form.useWatch<string | undefined>('email', form) ?? base.email,
  };
  /*
   * Until something is typed, search by the request's own traits: for an existing account the
   * server does this (phone, email, similar name), while a new one has no traits on the server yet,
   * so we pass the name the admin has just typed in the form.
   */
  const typedName = [account.lastName, account.firstName].filter(Boolean).join(' ').trim();
  const query = term || (account.id ? '' : typedName);
  const { data, isFetching } = useQuery({
    queryKey: userAccountKeys.personCandidates({ userId: account.id, query }),
    queryFn: () =>
      usersApi.personCandidates({ query: query || undefined, userId: account.id ?? undefined }),
    enabled: !!query || !!account.id,
  });
  const candidates = useMemo(() => data?.items ?? [], [data]);

  const personId = Form.useWatch<string | undefined>(name, form);
  const options = useMemo(() => {
    const list = candidates.map((c) => ({
      value: c.id,
      label: candidateLabel(c),
      title: c.fullName,
    }));
    // The bound employee is added if missing from the results: the hint answers "whom to pick",
    // but the field must also show who is already picked, otherwise an id string would appear in
    // place of the name. A dismissed employee is not added: the server would reject them anyway,
    // and there is no point offering a choice that ends in a rejection.
    const bound = account.person?.deletedAt ? null : account.person;
    if (bound && !list.some((o) => o.value === bound.id)) {
      list.unshift({ value: bound.id, label: candidateLabel(bound), title: bound.fullName });
    }
    return list;
  }, [candidates, account.person]);

  /*
   * The picked candidate is remembered separately rather than looked up in the current results each
   * time: the next typed query changes the results, and the picked one would vanish along with the
   * mismatch check, so the "same person" checkbox would be cleared silently and the rejection would
   * come from the server instead.
   */
  const [picked, setPicked] = useState<PersonCandidateDto | null>(null);
  const selected: PersonCandidateDto | null =
    (picked?.id === personId ? picked : null) ??
    candidates.find((c) => c.id === personId) ??
    (account.person && account.person.id === personId
      ? { ...account.person, jobTitle: '', matchedBy: [] }
      : null);
  /*
   * A mismatch is checked only for a new choice. For an existing binding the server does not
   * re-check either: after binding the directory owns the name (R31), and asking for confirmation on
   * every save would train admins to tick the checkbox without looking.
   */
  const changed = !!selected && selected.id !== account.person?.id;
  const nameMismatch =
    changed &&
    (!sameName(selected.lastName, account.lastName) ||
      !sameName(selected.firstName, account.firstName));
  const notice = changed ? fillNotice(account, selected) : null;

  // Losing the mismatch also clears the confirmation: a checkbox that survived a change of employee
  // would confirm a mismatch the admin never saw, and do so silently.
  useEffect(() => {
    if (!nameMismatch) form.setFieldValue('confirmNameMismatch', false);
  }, [nameMismatch, form]);

  return (
    <>
      <Form.Item
        name={name}
        label="Работник"
        tooltip="Кабинет водителя показывает задание работника: рейсы и путевые листы записаны на карточку справочника, а не на учётную запись"
        rules={[{ required: true, message: 'Выберите работника' }]}
        extra="Работник с действующей учётной записью в списке не показывается — у человека она одна"
      >
        <Select
          showSearch
          allowClear
          // Filtering happens on the server: the full directory is never sent to the portal, so a
          // local filter would silently cut what the server has already found.
          filterOption={false}
          onSearch={setSearch}
          // This handler does not replace the form's: `Form.Item` calls both, so the form field is
          // set as usual, and here we keep the candidate itself, with the name for reconciliation.
          onChange={(value: string | undefined) =>
            setPicked(candidates.find((c) => c.id === value) ?? null)
          }
          loading={isFetching}
          options={options}
          optionLabelProp="title"
          placeholder="ФИО, телефон или почта"
          notFoundContent={
            query
              ? 'Никого не нашлось — проверьте написание или заведите работника в справочнике'
              : 'Начните вводить ФИО или телефон'
          }
        />
      </Form.Item>
      {notice ? <Alert type="info" showIcon style={{ marginBottom: 16 }} title={notice} /> : null}
      {nameMismatch ? (
        // A separate line rather than one of the field's errors: a surname change is common, an
        // accidental namesake is rare, and only a human can tell them apart. The server refuses
        // the binding without this checkbox (R30), and the confirmation is recorded in the audit.
        <Form.Item
          name="confirmNameMismatch"
          valuePropName="checked"
          rules={[
            {
              validator: (_rule, value: boolean | undefined) =>
                value
                  ? Promise.resolve()
                  : Promise.reject(new Error('Подтвердите, что это один человек')),
            },
          ]}
          extra={`В учётке «${account.lastName} ${account.firstName}», в карточке «${selected?.fullName ?? ''}». ФИО учётки останется как есть — его владелец справочник`}
        >
          <Checkbox>Это один человек</Checkbox>
        </Form.Item>
      ) : null}
    </>
  );
}

interface RestoreProps {
  /** Archived account; `null` means the window is closed. */
  account: DriverAccountFacts | null;
  onCancel: () => void;
  onSubmit: (body: RestoreUserBody) => void;
  confirmLoading?: boolean;
}

/**
 * Restoring an archived driver account (R8).
 *
 * A separate window rather than a silent request, because for a driver restoring means binding
 * again: the archived account's `person_id` may have been nulled along with the deleted employee,
 * and a live account cannot exist without it (CHECK `users_driver_person_check`). Such an account
 * cannot be restored blindly, and the person must be asked before the server rejects the request.
 */
export function DriverRestoreModal({ account, onCancel, onSubmit, confirmLoading }: RestoreProps) {
  const [form] = Form.useForm<RestoreUserBody>();

  /*
   * The form resets once per window session: when it opens for an account or switches to another
   * one. The parent builds `account` anew on every render (`personFactsOf(record)`), and the page
   * re-renders while the restore request is pending and after a server refusal; keyed on the object,
   * the reset wiped the employee the admin had just picked, exactly when they needed to retry.
   */
  const session = account ? (account.id ?? '') : null;
  useEffect(() => {
    if (session !== null) form.resetFields();
  }, [session, form]);

  return (
    <FormModal
      title={`Восстановление учётной записи${account ? `: ${account.lastName} ${account.firstName}` : ''}`}
      open={!!account}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      width={560}
    >
      <Form form={form} layout="vertical" className="form-dense" onFinish={(v) => onSubmit(v)}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="Учётная запись водителя живёт при карточке работника — выберите его. Учётка вернётся неактивной: доступ включает обычная правка карточки"
        />
        {account ? <DriverPersonField form={form} account={account} /> : null}
      </Form>
    </FormModal>
  );
}
