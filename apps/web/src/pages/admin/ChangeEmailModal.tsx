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
import { usersApi } from '../../api/resources';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

interface Props {
  open: boolean;
  /** Учётка, которой меняют адрес: из неё берётся прежний адрес и признак «это я сам». */
  user: UserDto | null;
  /** Свою учётку меняют с подтверждением паролем — и выходят из портала сразу после смены. */
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
 * Смена адреса учётной записи (ADR 0092) — предупреждающее окно, а не поле в карточке.
 *
 * Адрес учётки это логин, и смена делает сразу четыре вещи: переносит вход, гасит живые ссылки
 * восстановления, завершает сессии на всех устройствах и отправляет два письма. Ни одну из них
 * администратор не увидит в форме правки телефона — поэтому окно перечисляет их до нажатия, а не
 * сообщает после.
 *
 * Адрес вводится дважды. Опечатка здесь — это одновременно потеря входа и письма постороннему,
 * причём портал её не заметит: `ivan@su10.ru` и `ivam@su10.ru` одинаково правильны с виду.
 * Повторный ввод — единственная проверка, которая ловит именно этот случай.
 */
export function ChangeEmailModal({ open, user, self, onCancel, onSubmit, confirmLoading }: Props) {
  const [form] = Form.useForm<Values>();
  const newEmail = Form.useWatch('newEmail', form) ?? '';

  // Окно переиспользуется для разных учёток: адрес предыдущей не должен оставаться в полях.
  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  // Предупреждение о чужом домене (ADR 0090) — то же правило, что на форме регистрации, и здесь
  // оно нужно ровно затем же: рабочий адрес сотрудника опечаткой в домене превращается в чужой,
  // а выглядит правильным. Пустое поле молчит — предупреждать не о чем.
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
            // Пароль уходит только со своей учётки: чужую сервер о нём не спрашивает, и посылать
            // туда пустую строку значило бы получить 400 на поле, которого в окне не было.
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
        {/* Второе поле сверяется с первым, а не наоборот: человек правит опечатку там, где её
            заметил, и обе стороны сравнения должны быть равноправны — antd пересчитывает правило
            при изменении зависимости. */}
        {/* Приведение и здесь: иначе повтор расходился бы с первым полем невидимым пробелом,
            и человек искал бы опечатку там, где её нет. */}
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
        {/* Поле пароля есть только у своей учётки: чужую сервер паролем не защищает, и выключенное
            поле обещало бы проверку, которой не будет (ADR 0033 §6). */}
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
        {/* Адрес водителя в справочнике — отдельная запись (ADR 0008): задания на рейс уходят по
            нему, а не по адресу учётки, и смена здесь его не трогает. Напоминание общее, без
            проверки привязки: карточка учётки о связи с физлицом не рассказывает. */}
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Если человек получает задания на рейс как водитель, его адрес правится отдельно — в
          карточке водителя.
        </Typography.Paragraph>
      </Form>
    </FormModal>
  );
}

/**
 * Действие «сменить адрес» целиком: состояние окна, запрос, разбор исходов и готовое окно.
 *
 * Хук, а не пятьдесят строк в списке учёток: у смены свои побочные последствия (два письма,
 * архивная тень, выход из портала при смене себе), и разбирать их посреди вкладки, которая занята
 * ролями и областью, значит смешать два разных разговора. Вызывающему остаётся пункт меню.
 */
export function useChangeEmailAction(opts: {
  /** Кто смотрит: свою учётку меняют с паролем и с выходом из портала. */
  currentUserId: string | undefined;
  /**
   * Что обновить после смены. Колбэком, а не запросом отсюда: какой список показан и каким ключом
   * он закэширован — дело вызывающего экрана, а хук отвечает за саму смену.
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
      // Своя учётка: сессии отозваны сервером, и следующий же запрос вернёт 401. Портал уходит на
      // страницу входа сам, не дожидаясь этого, — иначе человек увидел бы не объяснение, а ошибку
      // на первом попавшемся экране. Список обновлять незачем: сессии уже нет.
      if (self) {
        message.success(`Адрес изменён на ${updated.email}. Войдите заново — уже по новому адресу`);
        void logout();
        return;
      }
      // Про письма говорится по каждому отдельно: «отправлены» одним словом скрыло бы, что до
      // прежнего ящика предупреждение не дошло, — а это и есть та новость, ради которой оно шло.
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
      // Не ошибка и не отказ — последствие, о котором узнают только сейчас: адрес занимала
      // архивная учётка, и вернуть её из архива уже нельзя (ADR 0063).
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
    /** Открыть окно для учётки. */
    openFor: (u: UserDto) => setUser(u),
    /** Готовое окно — вызывающему остаётся поставить его рядом с остальными. */
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
