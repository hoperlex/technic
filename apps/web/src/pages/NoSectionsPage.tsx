import { useState } from 'react';
import { Button, Empty, Space, Typography } from 'antd';
import { CustomerServiceOutlined, LogoutOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
// Тем же относительным путём, каким окно зовут фичи: `components/` — легаси-каталог без алиаса и
// без публичного входа, и заводить ему `@`-псевдоним ради одной страницы значило бы закрепить
// каталог, который планово разбирается по слоям.
import { SupportContactsModal } from '../components/SupportContactsModal';

/**
 * Главный экран учётки, которой не открыт ни один раздел портала.
 *
 * До него это состояние заканчивалось редиректом на смену пароля: стартовая страница перебирала
 * разделы, не находила ни одного и отдавала `/change-password` — служебный маршрут вне каркаса.
 * Человек видел форму пароля, приехавшую ниоткуда, и проблема доступа выглядела как просроченный
 * пароль; сменить пароль не помогало — круг замыкался тем же перебором.
 *
 * Поэтому здесь экран, а не редирект: он называет состояние честно («разделов нет») и никуда не
 * уводит. Живёт index-маршрутом внутри `AppLayout`, поэтому своей шапки и полноэкранной вёрстки не
 * держит — вокруг остаётся каркас с меню учётной записи и служебным меню, а странице остаётся
 * только область контента.
 */
export function NoSectionsPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  // Окно поддержки — со своим состоянием: `useUtilityMenu` принадлежит каркасу и наружу через
  // `<Outlet />` не отдаётся, а окно самодостаточно (контакты берёт из конфигурации).
  const [supportOpen, setSupportOpen] = useState(false);

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Space orientation="vertical" size={4} style={{ maxWidth: 420 }}>
            <Typography.Title level={4} style={{ marginBottom: 0 }}>
              Разделы портала вам пока не назначены
            </Typography.Title>
            <Typography.Text type="secondary">
              Учётная запись активна, но ни один раздел ей не открыт. Доступ выдаёт администратор
              портала.
            </Typography.Text>
          </Space>
        }
      >
        {/* Два выхода из тупика, и оба ведут наружу портала: внутри для этой учётки открывать
            нечего. Поддержка первой — доступ выдают по обращению, а не выходом из портала. */}
        <Space wrap>
          <Button
            type="primary"
            icon={<CustomerServiceOutlined />}
            onClick={() => setSupportOpen(true)}
          >
            Написать в поддержку
          </Button>
          <Button
            icon={<LogoutOutlined />}
            onClick={() => void logout().then(() => navigate('/login'))}
          >
            Выйти
          </Button>
        </Space>
      </Empty>

      <SupportContactsModal open={supportOpen} onClose={() => setSupportOpen(false)} />
    </div>
  );
}
