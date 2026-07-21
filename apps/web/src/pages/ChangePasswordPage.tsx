import { useState } from 'react';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { useNavigate } from 'react-router';
import { authApi } from '../api/auth';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../utils/format';

export function ChangePasswordPage() {
  const { user, setUser, logout } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { currentPassword: string; newPassword: string }) => {
    setLoading(true);
    try {
      const res = await authApi.changePassword(values);
      setUser(res.user);
      message.success('Пароль изменён');
      navigate('/waste', { replace: true });
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
          Смена пароля
        </Typography.Title>
        {user?.mustChangePassword ? (
          <Typography.Paragraph type="warning" style={{ textAlign: 'center' }}>
            Требуется сменить пароль перед продолжением работы.
          </Typography.Paragraph>
        ) : null}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="currentPassword"
            label="Текущий пароль"
            rules={[{ required: true, message: 'Введите текущий пароль' }]}
          >
            <Input.Password autoComplete="current-password" size="large" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="Новый пароль"
            rules={[{ required: true, min: 10, message: 'Не менее 10 символов' }]}
          >
            <Input.Password autoComplete="new-password" size="large" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="Повторите новый пароль"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: 'Повторите пароль' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                  return Promise.reject(new Error('Пароли не совпадают'));
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Сохранить
          </Button>
        </Form>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Button type="link" onClick={() => void logout().then(() => navigate('/login'))}>
            Выйти
          </Button>
        </div>
      </Card>
    </div>
  );
}
