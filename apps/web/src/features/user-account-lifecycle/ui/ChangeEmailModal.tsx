import { useEffect, useState } from 'react';
import { Alert, App, Form, Input, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { FormModal } from '@shared/ui';
import {
  isInternalEmail,
  normalizeEmail,
  type ChangeUserEmailBody,
  type UserDto,
} from '@technic/contracts';
import { usersApi } from '@entities/user-account';
import { useAuth } from '@entities/session';
import { userAccountErrorMessage as errorMessage } from '@entities/user-account';

interface Props {
  open: boolean;
  /** Account whose address changes: source of the previous address and of the "it is me" flag. */
  user: UserDto | null;
  /** One's own account changes with password confirmation and signs out right after the change. */
  self: boolean;
  onCancel: () => void;
  onSubmit: (body: ChangeUserEmailBody) => void;
  confirmLoading?: boolean;
}

interface Values {
  newEmail: string;
  newEmailRepeat: string;
  currentPassword?: string;
}

/**
 * Account address change (ADR 0092) is a warning modal, not a field in the account form.
 *
 * The address is the login, and changing it does four things at once: moves the sign-in, voids
 * live password-reset links, ends sessions on all devices and sends two emails. The administrator
 * would see none of these in a phone-edit form, so the modal lists them before the click rather
 * than reporting after.
 *
 * The address is typed twice. A typo here means both a lost login and mail to a stranger, and the
 * portal cannot notice it: `ivan@su10.ru` and `ivam@su10.ru` look equally valid. The repeated
 * entry is the only check that catches exactly this case.
 */
export function ChangeEmailModal({ open, user, self, onCancel, onSubmit, confirmLoading }: Props) {
  const [form] = Form.useForm<Values>();
  const newEmail = Form.useWatch('newEmail', form) ?? '';

  // The modal is reused for different accounts: the previous address must not stay in the fields.
  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  // Foreign-domain warning (ADR 0090) — the same rule as on the registration form, needed for the
  // same reason: a typo in the domain turns an employee's work address into someone else's while it
  // still looks right. An empty field stays silent — there is nothing to warn about.
  const external = newEmail.trim() !== '' && !isInternalEmail(newEmail.trim());

  return (
    <FormModal
      title={user ? `Смена адреса: ${user.email}` : 'Смена адреса'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="Сменить адрес"
      cancelText="Не менять"
      okDanger
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        className="form-dense"
        onFinish={(v: Values) =>
          onSubmit({
            newEmail: v.newEmail.trim(),
            // The password is sent only for one's own account: the server does not ask for it on
            // another account, and sending an empty string there would get a 400 on a field the
            // modal never showed.
            ...(self ? { currentPassword: v.currentPassword } : {}),
          })
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="Адрес учётной записи — это логин"
          description={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              <li>Вход по прежнему адресу перестанет работать сразу.</li>
              <li>Сессии на всех устройствах завершатся — потребуется войти заново.</li>
              <li>Ссылки восстановления пароля, отправленные раньше, перестанут действовать.</li>
              <li>
                Письма уйдут на оба адреса: на новый — с новым логином, на прежний — с
                предупреждением.
              </li>
            </ul>
          }
        />
        <Form.Item
          name="newEmail"
          label="Новый адрес"
          normalize={normalizeEmail}
          rules={[
            { required: true, message: 'Введите новый адрес' },
            { type: 'email', message: 'Некорректный email' },
          ]}
        >
          <Input autoFocus autoComplete="off" />
        </Form.Item>
        {/* The second field is checked against the first, not the other way round: the person fixes
            a typo wherever they notice it, and both sides of the comparison must be equal — antd
            re-runs the rule when the dependency changes. */}
        {/* Normalisation here too: otherwise the repeat would differ from the first field by an
            invisible space, and the person would hunt for a typo that is not there. */}
        <Form.Item
          name="newEmailRepeat"
          label="Повторите новый адрес"
          normalize={normalizeEmail}
          dependencies={['newEmail']}
          extra="Опечатку в адресе портал не отличит от верного адреса — письма уйдут постороннему, а вход потеряется."
          rules={[
            { required: true, message: 'Повторите новый адрес' },
            ({ getFieldValue }) => ({
              validator(_rule, value: string) {
                const first = (getFieldValue('newEmail') as string | undefined)?.trim() ?? '';
                if (!value || first.toLowerCase() === value.trim().toLowerCase()) {
                  return Promise.resolve();
                }
                return Promise.reject(new Error('Адреса не совпадают'));
              },
            }),
          ]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        {external ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="Адрес вне доменов компании — проверьте, что он написан верно"
          />
        ) : null}
        {/* The password field exists only for one's own account: the server does not guard another
            account with a password, and a disabled field would promise a check that never happens
            (ADR 0033 §6). */}
        {self ? (
          <Form.Item
            name="currentPassword"
            label="Ваш текущий пароль"
            extra="Свой адрес меняется с подтверждением паролем. Сразу после смены портал попросит войти заново — уже по новому адресу."
            rules={[{ required: true, message: 'Введите текущий пароль' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
        ) : null}
        {/* A driver's directory address is a separate record (ADR 0008): trip assignments go there,
            not to the account address, and this change does not touch it. The reminder is generic,
            without checking the link: the account card does not tell about its link to a person. */}
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Если человек получает задания на рейс как водитель, его адрес правится отдельно — в
          карточке водителя.
        </Typography.Paragraph>
      </Form>
    </FormModal>
  );
}

/**
 * The whole "change address" action: modal state, request, outcome handling and the ready modal.
 *
 * A hook rather than fifty lines in the account list: the change has its own side effects (two
 * emails, an archived shadow, signing out when changing one's own), and handling them in the middle
 * of a tab busy with roles and scope would mix two different conversations. The caller only adds a
 * menu item.
 */
export function useChangeEmailAction(opts: {
  /** Who is viewing: one's own account changes with a password and signs out. */
  currentUserId: string | undefined;
  /**
   * What to refresh after the change. A callback rather than a query from here: which list is shown
   * and under which cache key is the calling screen's business; the hook owns the change itself.
   */
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const { logout } = useAuth();
  const [user, setUser] = useState<UserDto | null>(null);
  const self = !!user && user.id === opts.currentUserId;

  const mut = useMutation({
    mutationFn: (v: { id: string; body: ChangeUserEmailBody }) =>
      usersApi.changeEmail(v.id, v.body),
    onSuccess: ({ user: updated, notifiedNew, notifiedOld, shadowsArchived }) => {
      setUser(null);
      // One's own account: the server has revoked the sessions and the next request returns 401.
      // The portal goes to the sign-in page by itself without waiting for that — otherwise the
      // person would see an error on a random screen instead of an explanation. There is no need
      // to refresh the list: the session is gone.
      if (self) {
        message.success(`Адрес изменён на ${updated.email}. Войдите заново — уже по новому адресу`);
        void logout();
        return;
      }
      // Each email is reported separately: a single "sent" would hide that the warning did not reach
      // the old mailbox — and that is exactly the news it was sent for.
      message.success(
        [
          `Адрес изменён на ${updated.email}`,
          notifiedNew === 'queued' ? 'письмо с новым логином отправлено' : null,
          notifiedOld === 'queued' ? 'на прежний адрес отправлено предупреждение' : null,
          notifiedNew === 'mail_disabled' || notifiedOld === 'mail_disabled'
            ? 'письма не отправлены — почта выключена'
            : null,
        ]
          .filter(Boolean)
          .join(', '),
      );
      // Neither an error nor a refusal — a consequence learned only now: an archived account held
      // the address, and it can no longer be restored from the archive (ADR 0063).
      if (shadowsArchived) {
        message.warning(
          'Этот адрес принадлежал архивной учётной записи — восстановить её из архива больше нельзя',
        );
      }
      opts.onChanged();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return {
    /** Open the modal for an account. */
    openFor: (u: UserDto) => setUser(u),
    /** The ready modal — the caller only places it next to the others. */
    modal: (
      <ChangeEmailModal
        open={!!user}
        user={user}
        self={self}
        onCancel={() => setUser(null)}
        onSubmit={(body) => user && mut.mutate({ id: user.id, body })}
        confirmLoading={mut.isPending}
      />
    ),
  };
}
