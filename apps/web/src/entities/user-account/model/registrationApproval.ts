import {
  isExternalRegistrationEmail,
  type MailOutcome,
  type Role,
  type UserAccountDto,
} from '@technic/contracts';

/**
 * A registration request as the form sees it: when it counts as reviewed and what to say about mail.
 *
 * A separate file because this is a rule, not markup, and it recurs in six places on the screen:
 * the request queue, the mail checkbox, the intent declared to the server, two form validations and
 * the success message. The rule is shared with the server, which computes the same predicate on the
 * locked row and answers 400 if the portal decided otherwise, so these six places must never
 * diverge. Kept together, they read as one condition rather than six similar expressions scattered
 * across the file.
 */

/** A registration request: the person signed up on their own and has no role assigned yet. */
export const isPendingRegistration = (u: UserAccountDto) => !u.isActive && !u.role;

/**
 * This edit takes the request out of the queue: an unreviewed request gets a role and activation at
 * once. One condition drives two things, the intent `approveRegistration` declared to the server and
 * the mail checkbox, and they must not diverge: the server computes the same predicate on the locked
 * row and answers 400 if the portal decided otherwise.
 *
 * It can hold exactly once: after review the account already has a role and stops being a request.
 */
export const approvesRegistration = (
  record: UserAccountDto | null,
  role: Role | undefined,
  isActive: boolean | undefined,
) => !!record && isPendingRegistration(record) && !!role && !!isActive;

/**
 * Whether the form asks about the access-granted email. For a new account the trigger is activation
 * itself: inviting someone into a portal that will not let them in is worse than silence. For an
 * existing account the only trigger is reviewing the request: on reactivation or a role change the
 * request was reviewed once, long ago, and "your access is open" to a current employee would be a lie.
 */
export const asksAboutMail = (
  record: UserAccountDto | null,
  role: Role | undefined,
  isActive: boolean | undefined,
) => (record ? approvesRegistration(record, role, isActive) : !!isActive);

/**
 * Success message together with the email's fate. A failed send must not be swallowed silently: the
 * admin would leave believing the person was notified, while disabled mail means exactly the opposite.
 */
export function withMailOutcome(done: string, notified: MailOutcome, sent: string): string {
  if (notified === 'queued') return `${done}, ${sent}`;
  if (notified === 'mail_disabled') return `${done}. Письмо не отправлено — почта выключена`;
  return done;
}

/**
 * A request is reviewed as a whole: the role is assigned together with activation. A half state
 * ("has a role, no access") means nothing but unfinished work, and the server rejects such an edit
 * with 400; the form merely saves the admin from pressing the button in vain.
 */
export const HALF_APPROVAL =
  'Заявку рассматривают целиком: назначьте роль и включите „Активен“ — или оставьте заявку в очереди';

/**
 * A request filed from an address outside the company domain (ADR 0090). Only for unreviewed ones:
 * on an active account the address has already been accepted by the admin, and the marker would
 * hang there forever deciding nothing; for operators an external address is normal anyway and is
 * not treated as a signal.
 */
export const hasExternalEmail = (u: UserAccountDto) =>
  isPendingRegistration(u) && isExternalRegistrationEmail(u);
