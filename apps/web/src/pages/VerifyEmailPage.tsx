import { useState } from 'react';
import { App, Button, Card, Form, Input, Result, Typography } from 'antd';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { authApi } from '../api/auth';
import { CaptchaField, type CaptchaValue } from '../components/CaptchaField';
import { errorFields, errorMessage } from '../utils/format';

interface ResendValues {
  email: string;
  captcha?: CaptchaValue;
}

/**
 * Подтверждение адреса по ссылке из письма (ADR 0072).
 *
 * Подтверждение отправляется по нажатию кнопки, а не при открытии страницы: почтовые клиенты и
 * антивирусы предварительно открывают ссылки у себя, и автоматическое подтверждение срабатывало бы
 * раньше, чем письмо увидел человек, — то есть подтверждало бы адрес без его участия.
 *
 * Устаревшая ссылка не тупик: с той же страницы запрашивается новое письмо.
 */
export function VerifyEmailPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [form] = Form.useForm<ResendValues>();
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const [resent, setResent] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);

  const confirm = async () => {
    setLoading(true);
    try {
      await authApi.verifyEmail({ token });
      setState('done');
    } catch (e) {
      message.error(errorMessage(e));
      setState('failed');
    } finally {
      setLoading(false);
    }
  };

  const resend = async (values: ResendValues) => {
    setLoading(true);
    try {
      const res = await authApi.resendVerification({
        email: values.email,
        captchaToken: values.captcha?.token ?? '',
        captchaAnswer: values.captcha?.answer ?? '',
      });
      setResent(res.message);
    } catch (e) {
      const fields = errorFields(e);
      if (fields?.captchaAnswer) {
        form.setFields([{ name: 'captcha', errors: [fields.captchaAnswer] }]);
      } else {
        message.error(errorMessage(e));
      }
      setCaptchaNonce((n) => n + 1);
      form.setFieldValue('captcha', undefined);
    } finally {
      setLoading(false);
    }
  };

  const resendForm = (
    <Form form={form} layout="vertical" onFinish={resend} requiredMark={false}>
      <Form.Item
        name="email"
        label="Email из заявки"
        rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
      >
        <Input autoComplete="username" size="large" />
      </Form.Item>
      <Form.Item
        name="captcha"
        label="Проверка"
        rules={[
          {
            validator: (_, value?: CaptchaValue) =>
              value?.answer ? Promise.resolve() : Promise.reject(new Error('Введите код')),
          },
        ]}
      >
        <CaptchaField resetToken={captchaNonce} />
      </Form.Item>
      <Button type="primary" htmlType="submit" size="large" block loading={loading}>
        Прислать письмо заново
      </Button>
    </Form>
  );

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <Card style={{ width: '100%', maxWidth: 420 }}>
        {state === 'done' ? (
          <Result
            status="success"
            title="Адрес подтверждён"
            subTitle="Заявка ушла администратору. Войти можно будет, когда он выдаст доступ."
            extra={
              <Button type="primary" onClick={() => navigate('/login', { replace: true })}>
                Ко входу
              </Button>
            }
          />
        ) : resent ? (
          <Result status="success" title="Письмо отправлено" subTitle={resent} />
        ) : (
          <>
            <Typography.Title level={3} style={{ textAlign: 'center' }}>
              Подтверждение адреса
            </Typography.Title>
            {token && state === 'idle' ? (
              <>
                <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
                  Нажмите кнопку, чтобы подтвердить, что этот ящик ваш.
                </Typography.Paragraph>
                <Button type="primary" size="large" block loading={loading} onClick={confirm}>
                  Подтвердить адрес
                </Button>
              </>
            ) : (
              <>
                <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
                  {token
                    ? 'Ссылка недействительна или устарела. Запросите новое письмо.'
                    : 'В адресе не хватает кода подтверждения — откройте ссылку из письма целиком или запросите новое письмо.'}
                </Typography.Paragraph>
                {resendForm}
              </>
            )}
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <Link to="/login">Вернуться ко входу</Link>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
