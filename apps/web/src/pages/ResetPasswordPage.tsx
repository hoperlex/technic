import { useState } from 'react';
import { App, Button, Card, Form, Result, Typography } from 'antd';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { authApi } from '../api/auth';
import { PasswordField } from '../components/PasswordField';
import { errorMessage } from '../utils/format';

interface FormValues {
  newPassword: string;
}

/**
 * Новый пароль по ссылке из письма (ADR 0072).
 *
 * Открытие страницы ничего не меняет: токен уходит на сервер только по нажатию кнопки. Иначе
 * ссылку гасил бы почтовый клиент или антивирус, предварительно открывающий её у себя, — и человек
 * получал бы «ссылка недействительна», ни разу по ней не перейдя.
 */
export function ResetPasswordPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const onFinish = async (values: FormValues) => {
    setLoading(true);
    try {
      await authApi.confirmPasswordReset({ token, newPassword: values.newPassword });
      setDone(true);
    } catch (e) {
      message.error(errorMessage(e));
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
        {!token ? (
          <Result
            status="warning"
            title="Ссылка неполная"
            subTitle="Откройте страницу по ссылке из письма целиком — в адресе не хватает кода подтверждения."
            extra={<Link to="/forgot-password">Запросить письмо заново</Link>}
          />
        ) : done ? (
          <Result
            status="success"
            title="Пароль изменён"
            subTitle="Прежние сессии завершены — на других устройствах потребуется войти заново."
            extra={
              <Button type="primary" onClick={() => navigate('/login', { replace: true })}>
                Войти
              </Button>
            }
          />
        ) : (
          <>
            <Typography.Title level={3} style={{ textAlign: 'center' }}>
              Новый пароль
            </Typography.Title>
            <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
              <PasswordField name="newPassword" label="Новый пароль" size="large" />
              <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                Сохранить пароль
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
