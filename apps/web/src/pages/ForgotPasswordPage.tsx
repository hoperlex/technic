import { useState } from 'react';
import { App, Button, Card, Form, Input, Result, Typography } from 'antd';
import { Link } from 'react-router';
import { authApi } from '../api/auth';
import { CaptchaField, type CaptchaValue } from '../components/CaptchaField';
import { errorFields, errorMessage } from '../utils/format';

interface FormValues {
  email: string;
  captcha?: CaptchaValue;
}

/**
 * «Забыли пароль?» — запрос ссылки (ADR 0072).
 *
 * Результат один и тот же независимо от того, есть ли такая учётная запись: страница, по которой
 * можно проверить, зарегистрирован ли человек в портале, — это утечка сама по себе, а форма входа
 * такой проверки не даёт. Пароль письмом не приходит: ссылка ведёт на страницу, где человек задаёт
 * новый сам.
 */
export function ForgotPasswordPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  // Челлендж капчи одноразовый: после неудачной отправки нужна новая картинка.
  const [captchaNonce, setCaptchaNonce] = useState(0);

  const onFinish = async (values: FormValues) => {
    setLoading(true);
    try {
      const res = await authApi.requestPasswordReset({
        email: values.email,
        captchaToken: values.captcha?.token ?? '',
        captchaAnswer: values.captcha?.answer ?? '',
      });
      setSent(res.message);
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
        {sent ? (
          <Result
            status="success"
            title="Письмо отправлено"
            subTitle={sent}
            extra={<Link to="/login">Вернуться ко входу</Link>}
          />
        ) : (
          <>
            <Typography.Title level={3} style={{ textAlign: 'center' }}>
              Восстановление доступа
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
              Пришлём ссылку на почту — новый пароль вы зададите сами.
            </Typography.Paragraph>
            <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
              <Form.Item
                name="email"
                label="Email"
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
                Прислать ссылку
              </Button>
            </Form>
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <Link to="/login">Вернуться ко входу</Link>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
