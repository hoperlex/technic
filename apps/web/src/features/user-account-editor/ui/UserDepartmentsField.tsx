import { Form, Select } from 'antd';
import type { UserDepartmentRefDto } from '@technic/contracts';

/**
 * The account's departments (ADR 0040) — the second scope axis — together with the answer to "does
 * this person head them" (§11.1 of the permissions restructuring plan, migration 0149).
 *
 * **Why show the flag in the account card if it is not set here.** The head used to be made by the
 * role: the administrator picked "department head", added a department — and the person started
 * approving requests. Now role and headship are decoupled; the flag lives on the link
 * (`user_departments.is_head`) and is set only from the department card. Were the form silent about
 * it, an administrator creating a head exactly the way they did for a year would get an account
 * that approves nothing, with no explanation on screen.
 *
 * **Shown, not set.** The flag arrives in the same row as the department itself
 * (`UserDepartmentRefDto.isHead`), but the account endpoint does not accept it: `PATCH /users/:id`
 * knows only `departmentIds` — membership. Setting it from here would only be possible by
 * overwriting the head set of every affected department — that is, blindly editing other cards from
 * a form that never asked about them.
 *
 * Read from the account card itself, not from the other side of the link (`DepartmentDto.heads`):
 * the directory feeds only active departments into the dropdown, and headship of a disabled one
 * would vanish from the screen while staying in the database.
 */

interface Props {
  /** Label of the selected role: the field is named after it — "Departments (for role …)". */
  roleLabel: string;
  /** Account departments with the head flag; empty — the account is being created or has none. */
  departments: UserDepartmentRefDto[];
  /** The account is being created: it heads nothing yet, so the flag talk is different. */
  isNew: boolean;
  options: { value: string; label: string }[];
  loading: boolean;
}

/** How a department is named in the hint: code and name, as in the dropdown itself. */
const departmentTitle = (d: { code: string; name: string }): string => `${d.code} — ${d.name}`;

export function UserDepartmentsField({ roleLabel, departments, isNew, options, loading }: Props) {
  const headed = departments.filter((d) => d.isHead);

  /*
   * Three distinct answers, not one generic text: "heads these", "heads nothing" and "nothing to
   * talk about yet". The middle one is the normal state of a department employee and must read as
   * a fact, not as something unfinished; it also settles the question about the role that used to
   * mean headship.
   */
  const hint = isNew
    ? 'Руководителем отдела учётка становится не здесь: сохраните её и назначьте в справочнике «Отделы»'
    : headed.length > 0
      ? // A department removed here takes its headship along (the link is deleted entirely) —
        // this must be said before saving, not discovered as a loss in the directory afterwards.
        `Руководит: ${headed.map(departmentTitle).join(' · ')}. Признак ставят в справочнике «Отделы»; убранный здесь отдел снимет и руководство им`
      : 'Отделами не руководит — участие задаётся здесь, руководство в справочнике «Отделы». Роль «Руководитель отдела» сама по себе руководителем не делает';

  return (
    <Form.Item
      name="departmentIds"
      label={`Отделы (для роли «${roleLabel}»)`}
      extra={hint}
      rules={[
        {
          validator: (_rule, value: string[] | undefined) =>
            value && value.length > 0
              ? Promise.resolve()
              : Promise.reject(new Error('Выберите хотя бы один отдел')),
        },
      ]}
    >
      <Select
        mode="multiple"
        options={options}
        loading={loading}
        showSearch
        optionFilterProp="label"
        placeholder="Выберите отделы"
      />
    </Form.Item>
  );
}
