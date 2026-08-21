import { useState } from 'react';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { Link, useLocation, useNavigate } from 'react-router';
import { normalizeEmail } from '@technic/contracts';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../utils/format';

export function LoginPage() {
  const { login } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      await login(values.email, values.password);
      const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
      // На корень, а не на жёстко зашитый раздел: какой из них открыт этой учётке, решает
      // стартовая страница по реестру. `/waste` закрыт половине ролей (ADR 0025), и вход
      // приводил их на гейт, а оттуда — на смену пароля.
      navigate(from ?? '/', { replace: true });
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
      {/* Карточка держит прежнюю ширину, пока экран её вмещает, и сжимается на телефоне. */}
      <Card style={{ width: '100%', maxWidth: 380 }}>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          Вход в портал
        </Typography.Title>
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          {/* Логин вставляют из письма — вместе с пробелом на конце (`normalizeEmail`). */}
          <Form.Item
            name="email"
            label="Email"
            normalize={normalizeEmail}
            rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
          >
            <Input autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Пароль"
            rules={[{ required: true, message: 'Введите пароль' }]}
          >
            <Input.Password autoComplete="current-password" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Войти
          </Button>
        </Form>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Link to="/forgot-password">Забыли пароль?</Link>
        </div>
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
        </div>
      </Card>
    </div>
  );
}
