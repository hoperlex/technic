import { useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Result, Typography } from 'antd';
import { Link, useNavigate } from 'react-router';
import {
  emailSchema,
  expectsCorporateEmail,
  INTERNAL_EMAIL_DOMAINS,
  isInternalEmail,
  normalizeEmail,
  REGISTRATION_ROLE_REQUESTS,
  registrationRequestDetail,
  registrationRoleRequestLabels,
  type RegistrationRoleRequest,
} from '@technic/contracts';
import { authApi } from '../api/auth';
import { AutoSelect } from '@shared/ui';
import { CaptchaField, type CaptchaValue } from '../components/CaptchaField';
import { PasswordField } from '../components/PasswordField';
import { PersonNameFields } from '../components/PersonNameFields';
import { PhoneField } from '../components/PhoneField';
import { errorFields, errorMessage } from '../utils/format';

interface RegisterFormValues {
  lastName: string;
  firstName: string;
  middleName?: string;
  email: string;
  /** Телефон: форма без него заявку не отправит (ADR 0066) — по нему её и рассматривают. */
  phone?: string;
  password: string;
  requestedRole?: RegistrationRoleRequest;
  requestedObject?: string;
  requestedCompany?: string;
  requestedComment?: string;
  captcha?: CaptchaValue;
  /** Приманка для ботов: поле скрыто от человека и должно уехать пустым. */
  website?: string;
}

const roleRequestOptions = REGISTRATION_ROLE_REQUESTS.map((value) => ({
  value,
  label: registrationRoleRequestLabels[value],
}));

export function RegisterPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<RegisterFormValues>();
  const [loading, setLoading] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  // Челлендж капчи одноразовый: после любой неудачной отправки нужна новая картинка.
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const watchRoleRequest = Form.useWatch('requestedRole', form);
  const watchEmail = Form.useWatch('email', form) ?? '';
  // Объект или компанию спрашиваем только там, где без них заявку не рассмотреть.
  const detail = watchRoleRequest ? registrationRequestDetail[watchRoleRequest] : 'none';
  /**
   * Адрес не в домене компании (ADR 0090). Предупреждение, а не запрет: заявку с любого адреса
   * портал принимает — решает по ней всё равно администратор.
   *
   * Смотрим на дописанный адрес: на «ива» в поле предупреждать не о чем. Пока пожелание по роли не
   * выбрано, предупреждение показывается — оно должно попасться на глаза там, где адрес и правят;
   * оператору, работающему от лица сторонней компании, его снимет выбор роли.
   */
  const externalEmail =
    emailSchema.safeParse(watchEmail).success &&
    !isInternalEmail(watchEmail) &&
    (!watchRoleRequest || expectsCorporateEmail(watchRoleRequest));

  const onFinish = async (values: RegisterFormValues) => {
    setLoading(true);
    try {
      await authApi.register({
        email: values.email,
        lastName: values.lastName,
        firstName: values.firstName,
        middleName: values.middleName ?? '',
        phone: values.phone ?? '',
        password: values.password,
        requestedRole: values.requestedRole!,
        requestedObject: values.requestedObject ?? '',
        requestedCompany: values.requestedCompany ?? '',
        requestedComment: values.requestedComment ?? '',
        captchaToken: values.captcha?.token ?? '',
        captchaAnswer: values.captcha?.answer ?? '',
        website: values.website,
      });
      setSubmittedEmail(values.email);
    } catch (e) {
      setCaptchaNonce((n) => n + 1);
      // Ошибку по конкретному полю показываем у поля; общую — сообщением.
      const fields = errorFields(e);
      if (fields?.captchaAnswer) {
        form.setFields([{ name: 'captcha', errors: [fields.captchaAnswer] }]);
      } else {
        message.error(errorMessage(e));
      }
    } finally {
      setLoading(false);
    }
  };

  if (submittedEmail) {
    return (
      <div style={pageStyle}>
        <Card style={{ width: '100%', maxWidth: 520 }}>
          {/* Отдельный экран, а не всплывающее сообщение: человеку нужно понять, что дальше
              ничего не произойдёт само и войти прямо сейчас он не сможет.
              Подтверждение адреса выключено (EMAIL_VERIFICATION_ENABLED) — про письмо и ссылку
              здесь не говорится: их не будет. */}
          <Result
            status="success"
            title="Заявка на доступ принята"
            subTitle={
              <>
                Заявка с адреса <b>{submittedEmail}</b> ушла администратору. Подтверждать ничего не
                нужно: он рассмотрит её и свяжется с вами по указанному телефону. Войти можно будет,
                когда доступ выдадут.
              </>
            }
            extra={
              <Button type="primary" onClick={() => navigate('/login', { replace: true })}>
                Перейти ко входу
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      {/* Карточка держит прежнюю ширину, пока экран её вмещает, и сжимается на телефоне. */}
      <Card style={{ width: '100%', maxWidth: 480 }}>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          Регистрация
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          После регистрации аккаунт будет неактивен до активации администратором.
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
          <PersonNameFields size="large" autoFocus />
          {/* Пробелы снимаются на вводе, а не при отправке: иначе форма ругалась бы «введите
              корректный email» на адрес, который человек видит верным (`normalizeEmail`). */}
          <Form.Item
            name="email"
            label="Email"
            normalize={normalizeEmail}
            rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
          >
            <Input autoComplete="username" size="large" />
          </Form.Item>
          {/* Заявку с чужого адреса форма отправляет как любую другую: правило рекомендательное, и
              отказ формы превратил бы его в запрет — а рабочая почта есть не у всех, кому доступ
              нужен по делу. */}
          {externalEmail ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 24 }}
              message="Указан адрес внешней почтовой службы"
              description={`Заявка с такого адреса рассматривается дольше и может быть отклонена. Если у вас есть рабочая почта в домене ${INTERNAL_EMAIL_DOMAINS.join(', ')} — укажите её.`}
            />
          ) : null}
          {/* Телефон обязателен (ADR 0066): заявку на регистрацию рассматривают звонком — без
              номера администратору некуда обратиться. Требование стоит на форме; схема
              `registerSchema` пустой номер по-прежнему принимает — иначе учётки, заведённые до
              этого правила, стали бы непроходимыми для правки. */}
          <PhoneField size="large" required />
          <PasswordField
            name="password"
            identityFields={['email', 'lastName', 'firstName']}
            size="large"
          />
          {/* Кем человек работает. Роль из этого не назначается — её выбирает администратор при
              активации (ADR 0034); выбор лишь избавляет его от звонка «а вы кто?». */}
          <Form.Item
            name="requestedRole"
            label="Выберите наиболее подходящую роль"
            rules={[{ required: true, message: 'Выберите роль' }]}
            extra="Окончательную роль назначит администратор при активации"
          >
            <AutoSelect options={roleRequestOptions} size="large" />
          </Form.Item>
          {detail === 'object' ? (
            <Form.Item
              name="requestedObject"
              label="Объект"
              rules={[
                { required: true, message: 'Укажите объект' },
                { whitespace: true, message: 'Укажите объект' },
              ]}
              extra="Название или адрес стройки, где вы работаете"
            >
              <Input size="large" maxLength={200} />
            </Form.Item>
          ) : null}
          {detail === 'company' ? (
            <Form.Item
              name="requestedCompany"
              label="Компания"
              rules={[
                { required: true, message: 'Укажите название компании' },
                { whitespace: true, message: 'Укажите название компании' },
              ]}
              extra="Организация, от лица которой вы работаете"
            >
              <Input size="large" maxLength={200} />
            </Form.Item>
          ) : null}
          {/* «Другое» роли портала не соответствует (`registrationRoleRequestRole.other = null`):
              без объяснения своими словами администратору не из чего выбирать роль, и заявка
              решалась бы звонком — тем самым, ради отмены которого пожелание и заводили. */}
          {detail === 'comment' ? (
            <Form.Item
              name="requestedComment"
              label="Комментарий"
              rules={[
                { required: true, message: 'Напишите, кем вы работаете' },
                { whitespace: true, message: 'Напишите, кем вы работаете' },
              ]}
              extra="Кем вы работаете и зачем нужен доступ — по этому администратор подберёт роль"
            >
              <Input size="large" maxLength={200} />
            </Form.Item>
          ) : null}
          <Form.Item
            name="captcha"
            label="Проверка"
            rules={[
              {
                validator: (_, v: CaptchaValue | undefined) =>
                  v?.answer
                    ? Promise.resolve()
                    : Promise.reject(new Error('Введите код с картинки')),
              },
            ]}
          >
            <CaptchaField resetToken={captchaNonce} />
          </Form.Item>
          {/* Honeypot: человек этого поля не видит и не заполнит, простой бот заполнит всё. */}
          <Form.Item name="website" hidden aria-hidden="true">
            <Input tabIndex={-1} autoComplete="off" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Зарегистрироваться
          </Button>
        </Form>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          Уже есть аккаунт? <Link to="/login">Войти</Link>
        </div>
      </Card>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
