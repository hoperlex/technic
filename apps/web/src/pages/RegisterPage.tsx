import { useState } from 'react';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { Link, useNavigate } from 'react-router';
import { authApi } from '../api/auth';
import { errorMessage } from '../utils/format';

export function RegisterPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { fullName: string; email: string; password: string }) => {
    setLoading(true);
    try {
      await authApi.register(values);
      message.success('Регистрация принята. Вход будет доступен после активации администратором.');
      navigate('/login', { replace: true });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <Card style={{ width: 420 }}>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          Регистрация
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          После регистрации аккаунт будет неактивен до активации администратором.
        </Typography.Paragraph>
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="fullName" label="ФИО" rules={[{ required: true, min: 2, message: 'Укажите ФИО' }]}>
            <Input size="large" />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
          >
            <Input autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Пароль"
            rules={[{ required: true, min: 10, message: 'Не менее 10 символов' }]}
          >
            <Input.Password autoComplete="new-password" size="large" />
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
