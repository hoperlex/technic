import { useState } from 'react';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { Link, useLocation, useNavigate } from 'react-router';
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
      navigate(from ?? '/waste', { replace: true });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <Card style={{ width: 380 }}>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          Вход в портал
        </Typography.Title>
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
          >
            <Input autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item name="password" label="Пароль" rules={[{ required: true, message: 'Введите пароль' }]}>
            <Input.Password autoComplete="current-password" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Войти
          </Button>
        </Form>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
        </div>
      </Card>
    </div>
  );
}
