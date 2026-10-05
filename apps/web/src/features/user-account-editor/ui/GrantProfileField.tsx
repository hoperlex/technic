import { Form, Select, Typography } from 'antd';
import type { OfficeEquipmentProfileId } from '@technic/contracts';
import type { GrantProfileOption } from '../model/userGrantsModel';

/**
 * Business profile preset of the office equipment module in the account window (office equipment
 * profiles plan, R7).
 *
 * It sits ABOVE the grants field and outside it: it is not the field's value but a way to fill it —
 * inside the "Grants" field the preset would read as one more thing being granted. Its own file
 * for the same reason: the grants field owns checkboxes, versions and the request body, while here
 * there is exactly one question, "which module business role to grant", and its answer touches none
 * of the three.
 *
 * THE CHOICE SAVES NOTHING AND CHECKS NOTHING BY ITSELF. It puts the profile's codes into the third
 * hydration set ("suggested"), and the checkboxes are computed by the existing formula — the same
 * one that drives the wish-based prefill on activation (ADR 0143). This gives for free: manual
 * unchecks (not undone), role change (extinguishes incompatible sets on its own) and "privilege
 * escalation" as the administrator saving the form, not a side effect of picking from a list.
 */
export function GrantProfileField({
  profile,
  options,
  onChange,
}: {
  /** Selected preset; `null` — none chosen: checkboxes then describe the assignment alone. */
  profile: OfficeEquipmentProfileId | null;
  /** Profiles that have something to say under this role (`grantProfileOptions`). */
  options: GrantProfileOption[];
  onChange: (next: OfficeEquipmentProfileId | null) => void;
}) {
  /** Anything selectable? "service center" is always listed but never granted by choice (R11). */
  const selectable = options.some((option) => !option.disabled);

  return (
    <Form.Item
      label="Профиль «Орг.техники»"
      /* The field has no `name`: grant sets are saved, not the profile. The label-to-list link
         has to be set by hand — without it antd has nothing to put into `for`, and clicking the
         label would stop opening the list. */
      htmlFor={PROFILE_FIELD_ID}
      tooltip="Готовый набор полномочий бизнес-роли модуля. Выбор ничего не сохраняет: он отмечает нужные наборы ниже, а выдаёт их сохранение формы"
      extra={
        selectable
          ? 'Отмечает наборы профиля в списке ниже. Снятое вручную выбор не возвращает, а несовместимое с ролью не отмечает вовсе — выдаётся только то, что отмечено галочкой.'
          : undefined
      }
    >
      {/* Nothing to choose — instead of a disabled list there is a TEXT LINE (ADR 0033 §6) naming
          the profiles not granted through grant sets. A disabled list would give no answer: antd
          does not open it at all, and the explanation "granted by role and counterparty" — the
          very reason "service center" is kept in the list (R11) — would stay hidden behind the
          shutter exactly for the role where people look for it. */}
      {selectable ? (
        <Select<OfficeEquipmentProfileId>
          id={PROFILE_FIELD_ID}
          allowClear
          placeholder="Выберите профиль"
          value={profile ?? undefined}
          onChange={(next) => onChange(next ?? null)}
          options={options}
        />
      ) : (
        <Typography.Text type="secondary">
          {`Профиль модуля этой роли полномочиями не выдаётся. ${options
            .map((option) => option.label)
            .join('; ')}`}
        </Typography.Text>
      )}
    </Form.Item>
  );
}

/** Profile list id: the field has no `name`, so nothing else can link the label to it. */
const PROFILE_FIELD_ID = 'office-equipment-profile';
