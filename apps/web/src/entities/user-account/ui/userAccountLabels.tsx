import { Space, Tag } from 'antd';
import {
  OFFICE_EQUIPMENT_PROFILE_REGISTRY,
  officeEquipmentProfilesOf,
  registrationRequestDetail,
  roleAddonColors,
  roleAddonLabels,
  roleColors,
  roleLabels,
  roleMigrationOf,
  type Role,
  type UserAccountDto,
} from '@technic/contracts';
import { hasExternalEmail } from '../model/registrationApproval';

/**
 * How an account is labelled on screen: role with add-ons, email with a marker, the request detail
 * and the note under the role picker.
 *
 * A separate file because each of these labels is read in two places at once: the table column and
 * the row card on a phone, the list and the request card. If they diverged, the same account would
 * be named differently on a phone than on desktop, and the difference would read as a difference in
 * data. There is no local notion of roles here: colors, labels and role migrations come from the
 * contracts.
 */

/**
 * Note under the role picker, for exactly two roles of the reform, and neither is decoration.
 *
 * "Site" (ADR 0112) is available to admins from stage 4b, before HQ staff, construction managers and
 * site superintendents are moved onto it, and chosen today it gives waste removal and office
 * equipment but **not** vehicle ordering, which arrives as a grant. Without the note it looks like a
 * "trimmed-down HQ" and gets explained by a rejection on the very first request.
 *
 * A role being retired (ADR 0113) stays in the list only for the account that already has it, and
 * the note explains why it is not offered to others: the migration ships as a separate release, and
 * until then the role works as before.
 *
 * Other roles intentionally have no note: their permission set is not moving anywhere, and a hint
 * there would imply that it is.
 */
export function roleNote(role: Role | undefined): string | undefined {
  if (role === 'site') {
    return 'Заказ техники и виза приезжают полномочиями — «Заказ техники» и «Виза объекта». Ролью открыты вывоз мусора и оргтехника';
  }
  const migration = roleMigrationOf(role);
  if (!migration) return undefined;
  const grants = migration.grants.length > 0 ? ' и выданными полномочиями' : '';
  return `Роль упраздняется: новым учёткам она не назначается. Действующие переведёт на «${roleLabels[migration.to]}»${grants} отдельный выкат — до него роль работает как прежде`;
}

/**
 * Role, add-ons and the office-equipment business profile in one cell (ADR 0086; office-equipment
 * profiles plan, R7). An add-on supplements the role rather than replacing it, so it sits next to
 * the role tag, not instead of it: "HQ" with office equipment and "HQ" without differ only by this
 * tag. A separate column would not work: it would be empty for almost everyone, and the add-on is
 * always read together with the role.
 *
 * THE PROFILE IS DERIVED FROM THE CODES OF GRANTED SETS (`officeEquipmentProfilesOf`), not from
 * permissions and not from add-ons (R9). Permissions would answer differently and worse: a set an
 * admin assembled with the same contents would be labelled "Operator", and half of the IT profile
 * would show as the full profile. Add-ons know only about two system sets and go away at step 1e of
 * ADR 0106, so the label would survive that step silently while vanishing for half the people.
 *
 * The "profile -> codes" mapping lives in the CONTRACTS REGISTRY, one for the form, the label and
 * the docs: a second such table here would drift from the grant form, and the list would show one
 * profile where the account window granted another.
 *
 * There is no "Service center" tag here and there must not be: it is expressed by the pair "role
 * `operator` + counterparty type `service`" (R11), and both halves already appear in the row as their
 * own columns, so a tag would repeat them a third time and would lie on an account with no
 * counterparty.
 */
export function roleTags(u: UserAccountDto) {
  if (!u.role) return '—';
  return (
    <Space size={4} wrap>
      <Tag color={roleColors[u.role]}>{roleLabels[u.role]}</Tag>
      {u.addons.map((addon) => (
        <Tag key={addon} color={roleAddonColors[addon]}>
          {roleAddonLabels[addon]}
        </Tag>
      ))}
      {officeEquipmentProfilesOf(u.grantCodes).map((profile) => (
        <Tag key={profile} color="geekblue">
          {`Оргтехника: ${OFFICE_EQUIPMENT_PROFILE_REGISTRY[profile].label}`}
        </Tag>
      ))}
    </Space>
  );
}

/**
 * The request detail is free text, not a directory reference: the object list is not served to
 * unauthenticated users (ADR 0034), so the admin does the matching.
 *
 * There are **two lines at once** here, not the first that fits: a comment is now written for any
 * wish, not only for "Other", and if only one detail were returned, a department employee who added
 * "system administrator" would look like an ordinary department employee. The comment was opened to
 * everyone precisely for such notes: a narrow position has no wish of its own in the list.
 *
 * Joined with the same ` · ` the request card uses between the wish, the detail and the mail marker:
 * the string lands in the same row, and a second separator would read as a difference in meaning.
 */
export function requestedDetailText(u: UserAccountDto): string | undefined {
  if (!u.requestedRole) return undefined;
  const detail = registrationRequestDetail[u.requestedRole];
  const parts = [
    // Object and department share one column for two questions; only the wish tells them apart.
    detail === 'object' && u.requestedObject ? `Объект: ${u.requestedObject}` : undefined,
    detail === 'department' && u.requestedObject ? `Отдел: ${u.requestedObject}` : undefined,
    detail === 'company' && u.requestedCompany ? `Компания: ${u.requestedCompany}` : undefined,
    // Regardless of the wish: for "Other" this is the only basis for reviewing the request at all,
    // for the rest it is what the position list lacked. Empty means there was nothing to write, or
    // the request predates the comment becoming mandatory (migration 0139).
    u.requestedComment ? `Комментарий: ${u.requestedComment}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Request email with the external-domain marker, identical in the list and in the phone card. */
export function emailCell(u: UserAccountDto) {
  if (!hasExternalEmail(u)) return u.email;
  return (
    <Space size={4} wrap>
      <span>{u.email}</span>
      <Tag color="orange">Внешняя почта</Tag>
    </Space>
  );
}
