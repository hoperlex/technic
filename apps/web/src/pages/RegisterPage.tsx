import { useState } from 'react';
import { App, Button, Card, Form, Input, Result, Typography } from 'antd';
import { Link, useNavigate } from 'react-router';
import {
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
  /** Телефон по желанию (ADR 0043): пустое поле — законный ответ. */
  phone?: string;
  password: string;
  requestedRole?: RegistrationRoleRequest;
  requestedObject?: string;
  requestedCompany?: string;
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
  // Объект или компанию спрашиваем только там, где без них заявку не рассмотреть.
  const detail = watchRoleRequest ? registrationRequestDetail[watchRoleRequest] : 'none';

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
              ничего не произойдёт само и войти прямо сейчас он не сможет. */}
          <Result
            status="success"
            title="Заявка на доступ принята"
            subTitle={
              <>
                Учётная запись <b>{submittedEmail}</b> создана и ждёт активации администратором.
                Вход станет возможен после того, как вам назначат роль. Если это срочно — сообщите
                администратору портала.
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
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
          >
            <Input autoComplete="username" size="large" />
          </Form.Item>
          {/* Телефон по желанию (ADR 0043): почты у портала нет, и звонок — единственный способ
              уточнить заявку. Требовать номер, чтобы завести учётку, при этом не за что. */}
          <PhoneField
            size="large"
            extra="Не обязательно. По нему администратор свяжется с вами быстрее — писем портал не шлёт"
          />
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
