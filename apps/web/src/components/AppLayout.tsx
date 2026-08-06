import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Dropdown, Layout, Menu, type MenuProps, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  CarOutlined,
  CustomerServiceOutlined,
  ProfileOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  KeyOutlined,
  LeftOutlined,
  LogoutOutlined,
  NotificationOutlined,
  RightOutlined,
  ScheduleOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { formatShortName, roleLabels } from '@technic/contracts';
import { usersApi } from '../api/resources';
import { useAuth } from '../auth/AuthContext';
import { useReleases } from '@entities/release';
import { useIsMobile } from '@shared/lib';
import { MobileAppBar } from './MobileAppBar';
import { MobileNav, type MobileNavItem } from './MobileNav';
import { PortalLogo } from './PortalLogo';
import { ReleaseNotesModal } from './ReleaseNotesModal';
import { SupportContactsModal } from './SupportContactsModal';
import { UserAvatar } from './UserAvatar';

const { Sider, Content } = Layout;

const SIDER_WIDTH = 230;
const SIDER_COLLAPSED_WIDTH = 64;
const COLLAPSED_STORAGE_KEY = 'technic:sider-collapsed';

// localStorage недоступен в приватном режиме части браузеров — состояние меню не критично, молча игнорируем.
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* состояние просто не переживёт перезагрузку */
  }
}

export function AppLayout() {
  const { user, logout, can, canUse } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [supportOpen, setSupportOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);

  /**
   * Журнал обновлений (ADR 0077). Список спрашивается каркасом, а не самим окном: он нужен раньше
   * окна — точке в меню, которая и сообщает, что открывать журнал есть зачем.
   */
  const { hasNews, markSeen } = useReleases();

  /*
   * Отметка ставится при открытии окна, а не при закрытии: закрывают и по Esc, и мимо кнопки, — а
   * выпуск к этому моменту уже увидели (ADR 0077).
   *
   * Эффектом, а не строкой в обработчике нажатия: в момент нажатия список мог ещё не доехать, и
   * отмечать было бы нечего — отметка встаёт, как только есть что отмечать, окно при этом уже
   * открыто. Живёт здесь, а не в окне, потому что здесь же считается точка в меню: две копии
   * состояния гасили бы её каждая у себя.
   */
  useEffect(() => {
    if (changelogOpen) markSeen();
  }, [changelogOpen, markSeen]);

  const toggleCollapsed = () =>
    setCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });

  /**
   * Заявки на регистрацию никуда не уведомляют — почты у портала нет. Бейдж в меню и есть
   * единственный сигнал администратору, что кто-то ждёт активации (ADR 0034).
   */
  const { data: pendingUsers } = useQuery({
    queryKey: ['users', 'pending-count'],
    queryFn: () => usersApi.pendingCount(),
    enabled: can('users.manage'),
    staleTime: 60_000,
  });

  // `short` — подпись для нижней навигации мобильного режима: на 360 px пункту достаётся
  // четверть экрана, и полное название раздела туда не помещается (ADR 0030).
  const navItems: (MobileNavItem & { icon: ReactNode })[] = [
    // Руководитель строительства отвечает за технику на объекте, вывоз мусора ведёт штаб (ADR 0025).
    // `canUse`, а не `can`: у отдела без площадки право на вывоз есть, но работать им не над чем,
    // и раздел закрывает пустая область (ADR 0062).
    ...(canUse('wasteRequests.read')
      ? [{ key: '/waste', icon: <FileTextOutlined />, label: 'Вывоз мусора', short: 'Вывоз' }]
      : []),
    // Оператор вывоза — внешний перевозчик: заказ ТС к его работе отношения не имеет (ADR 0010).
    ...(canUse('vehicleRequests.read')
      ? [
          {
            key: '/vehicle-requests',
            icon: <CarOutlined />,
            label: 'Заказ ТС',
            short: 'Заказ ТС',
          },
        ]
      : []),
    // Журнал путевых листов (ADR 0037): его ведут те же, кто выписывает листы переводом заявок
    // в работу. В листе персональные данные водителя — потому и право своё.
    ...(can('waybills.read')
      ? [
          {
            key: '/waybills',
            icon: <ProfileOutlined />,
            label: 'Путевые листы',
            short: 'Листы',
          },
        ]
      : []),
    // Гараж (ADR 0076) — срез дня: чем заняты свои машины и водители. Стоит после листов, рядом
    // с тем, из чего собран: рейсы, заказы и бланки ведут в соседних разделах.
    ...(can('garage.read')
      ? [
          {
            key: '/garage',
            icon: <ScheduleOutlined />,
            label: 'Гараж',
            short: 'Гараж',
          },
        ]
      : []),
    ...(can('directories.write')
      ? [
          {
            key: '/directories',
            icon: <DatabaseOutlined />,
            label: 'Справочники',
            short: 'Справ.',
          },
        ]
      : []),
    ...(can('users.manage')
      ? [
          {
            key: '/admin',
            icon: (
              <Badge count={pendingUsers?.count ?? 0} size="small" offset={[4, -2]} color="gold">
                <TeamOutlined />
              </Badge>
            ),
            label: 'Администрирование',
            short: 'Админ.',
          },
        ]
      : []),
  ];

  // Подсвечен тот пункт, на страницу которого зашли; если такого пункта у роли нет — никакой.
  const selectedKey = navItems.find((it) => location.pathname.startsWith(it.key))?.key ?? '';

  /**
   * Служебные пункты: они не разделы портала и не зависят от прав — писать в поддержку и читать
   * журнал обновлений вправе любой вошедший (ADR 0077: право, закрывающее «что нового в портале»,
   * пришлось бы выдать всем). Страницы за ними нет, поэтому подсветка выключена, а нажатие
   * открывает окно.
   */
  const utilityItems = [
    {
      key: 'support',
      icon: <CustomerServiceOutlined />,
      label: 'Техподдержка',
      // Свёрнутой панели остаётся одна иконка, и `title` — единственное, чем пункт назван.
      title: 'Техподдержка',
      disabled: false,
    },
    {
      key: 'changelog',
      /*
       * Точка, а не число непрочитанных выпусков: в той же панели уже висит счётчик заявок на
       * регистрацию, и два числа рядом начинают спорить за внимание — выигрывает то, которое
       * больше, а не то, которое важнее. «Сколько» здесь ничего и не решает: журнал открывают
       * узнать «что», и одного непрочитанного выпуска для этого достаточно (ADR 0077).
       */
      icon: (
        <Badge dot={hasNews} offset={[4, -2]}>
          <NotificationOutlined />
        </Badge>
      ),
      label: 'Обновления',
      title: 'Обновления',
      disabled: false,
    },
  ];

  /**
   * Служебные пункты открываются из трёх мест — меню учётной записи, подвал развёрнутой панели и
   * свёрнутая панель, — и разбор ключа здесь один на всех. Раньше свёрнутая панель звала поддержку
   * на любой пункт: пока «Обновления» стояли выключенными, ошибка была невидимой.
   */
  const openUtility = (key: string) => {
    if (key === 'support') setSupportOpen(true);
    if (key === 'changelog') setChangelogOpen(true);
  };

  /** Пункт меню antd получает те же поля, что и раньше: `title` нужен только свёрнутой панели. */
  const utilityMenuItems: MenuProps['items'] = utilityItems.map(
    ({ key, icon, label, disabled }) => ({ key, icon, label, disabled }),
  );

  const userMenu: MenuProps = {
    items: [
      { key: 'change-password', icon: <KeyOutlined />, label: 'Сменить пароль' },
      // На телефоне нижняя навигация занята разделами целиком (ADR 0030), и служебным пунктам
      // место только здесь. На десктопе они стоят в подвале боковой панели — и здесь не
      // дублируются: два входа в одно окно превращают меню учётки в свалку.
      ...(isMobile ? [{ type: 'divider' as const }, ...utilityMenuItems] : []),
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: 'Выйти', danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'logout') void logout().then(() => navigate('/login'));
      if (key === 'change-password') navigate('/change-password');
      openUtility(key);
    },
  };

  /** Оба окна служебные и живут в каркасе: открывают их из меню, а не переходом на страницу. */
  const utilityModals = (
    <>
      <SupportContactsModal open={supportOpen} onClose={() => setSupportOpen(false)} />
      <ReleaseNotesModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
    </>
  );

  /**
   * Мобильная раскладка (ADR 0030): разделы — нижней навигацией, учётная запись — в верхней
   * панели. Высота остаётся фиксированной, как на десктопе: страницы внутри рассчитывают её
   * сами (вкладки и тело таблицы со своей прокруткой), и менять это здесь — не дело каркаса.
   */
  if (isMobile) {
    const title = navItems.find((it) => it.key === selectedKey)?.label ?? 'АВТО';
    return (
      <div className="mobile-shell">
        {/* На 360 px полное ФИО в панель не помещается; части ФИО есть (ADR 0034) — значит
            можно показать «Иванов И. И.», а не обрезать строку многоточием. */}
        <MobileAppBar
          title={title}
          userName={user ? formatShortName(user) : undefined}
          menu={userMenu}
          hasNews={hasNews}
        />
        <main className="mobile-content">
          <Outlet />
        </main>
        <MobileNav items={navItems} selectedKey={selectedKey} onSelect={(key) => navigate(key)} />
        {utilityModals}
      </div>
    );
  }

  return (
    <Layout style={{ height: '100dvh', position: 'relative' }}>
      <Sider
        theme="light"
        width={SIDER_WIDTH}
        collapsedWidth={SIDER_COLLAPSED_WIDTH}
        collapsible
        collapsed={collapsed}
        trigger={null}
        style={{ borderInlineEnd: '1px solid rgba(0,0,0,0.06)' }}
      >
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              height: 56,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: collapsed ? 0 : '0 16px',
              justifyContent: collapsed ? 'center' : 'flex-start',
            }}
          >
            <PortalLogo size={28} />
            {!collapsed && (
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 18,
                  letterSpacing: 1,
                  lineHeight: 1.05,
                  whiteSpace: 'nowrap',
                }}
              >
                АВТО
              </span>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {collapsed ? (
              <div className="sider-mini-nav">
                {navItems.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className={`sider-mini-item${
                      selectedKey === it.key ? ' sider-mini-item--active' : ''
                    }`}
                    onClick={() => navigate(it.key)}
                    title={it.label}
                    aria-label={it.label}
                  >
                    {it.icon}
                  </button>
                ))}
              </div>
            ) : (
              <Menu
                mode="inline"
                selectedKeys={[selectedKey]}
                // Пункт меню antd получает ровно те же поля, что и раньше: короткая подпись
                // нужна только нижней навигации мобильного режима.
                items={navItems.map(({ key, icon, label }) => ({ key, icon, label }))}
                onClick={({ key }) => navigate(key)}
                style={{ borderInlineEnd: 'none' }}
              />
            )}
          </div>
          {/* Служебные пункты — над учётной записью и отдельно от разделов: это не места, куда
              переходят работать, а помощь и новости о самом портале. */}
          <div className="sider-utility">
            {collapsed ? (
              <div className="sider-mini-nav">
                {utilityItems.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className="sider-mini-item"
                    disabled={it.disabled}
                    onClick={() => openUtility(it.key)}
                    title={it.title}
                    aria-label={it.title}
                  >
                    {it.icon}
                  </button>
                ))}
              </div>
            ) : (
              <Menu
                mode="inline"
                selectable={false}
                items={utilityMenuItems}
                onClick={({ key }) => openUtility(key)}
                style={{ borderInlineEnd: 'none' }}
              />
            )}
          </div>
          <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', padding: 8 }}>
            <Dropdown menu={userMenu} trigger={['click']} placement="topLeft">
              <div className={`sider-account${collapsed ? ' sider-account--collapsed' : ''}`}>
                <UserAvatar name={user?.fullName} size="small" />
                {!collapsed && (
                  <div style={{ lineHeight: 1.2, minWidth: 0 }}>
                    <div
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {user?.fullName}
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {user?.role ? roleLabels[user.role] : '—'}
                    </Typography.Text>
                  </div>
                )}
              </div>
            </Dropdown>
          </div>
        </div>
      </Sider>
      {/* Кнопка на стыке панели и контента: видна всегда, «едет» вместе с краем сайдера */}
      <button
        type="button"
        className="sider-toggle"
        aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        style={{ left: collapsed ? SIDER_COLLAPSED_WIDTH : SIDER_WIDTH }}
      >
        {collapsed ? <RightOutlined /> : <LeftOutlined />}
      </button>
      <Layout>
        <Content
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16 }}
        >
          <Outlet />
        </Content>
      </Layout>
      {utilityModals}
    </Layout>
  );
}
