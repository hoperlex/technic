import { useState, type ReactNode } from 'react';
import { Badge, Dropdown, Layout, Menu, type MenuProps, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  CarOutlined,
  ProfileOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  KeyOutlined,
  LeftOutlined,
  LogoutOutlined,
  PrinterOutlined,
  RightOutlined,
  ScheduleOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { ADMIN_PAGE_PERMISSIONS, formatShortName, roleLabels } from '@technic/contracts';
import { usersApi } from '../api/resources';
import { useAuth } from '../auth/AuthContext';
import { UtilityMenu, useUtilityMenu } from '@widgets/utility-menu';
import { useServiceWaitingCount } from '@features/service-waiting-badge';
import { readSiderCollapsed, useIsMobile, writeSiderCollapsed } from '@shared/lib';
import { MobileAppBar } from './MobileAppBar';
import { MobileNav, type MobileNavItem } from './MobileNav';
import { PortalLogo } from './PortalLogo';
import { UserAvatar } from './UserAvatar';

const { Sider, Content } = Layout;

const SIDER_WIDTH = 230;
const SIDER_COLLAPSED_WIDTH = 64;

export function AppLayout() {
  const { user, logout, can, canUse } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(readSiderCollapsed);

  /**
   * Помощь и новости портала (ADR 0077) — не разделы, и каркас про них знает ровно две вещи: где
   * стоят их пункты и куда положить окна. Что это за пункты и что они открывают, решает виджет.
   */
  const utility = useUtilityMenu();

  const toggleCollapsed = () =>
    setCollapsed((v) => {
      writeSiderCollapsed(!v);
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

  const waitingServiceCount = useServiceWaitingCount();

  /**
   * Бейдж ведёт не в раздел, а в саму очередь «Требуют решения» — тот же пресет списка, что и
   * кнопка на вкладке заявок. Обработчик гасит всплытие: нажатие мимо бейджа остаётся нажатием на
   * пункт меню и открывает раздел целиком. Ставится он только на зажжённый бейдж — у погасшего
   * иконка обязана вести туда же, куда весь пункт.
   */
  const serviceMenuIcon =
    waitingServiceCount > 0 ? (
      <span
        title="Требуют решения"
        onClick={(e) => {
          e.stopPropagation();
          navigate('/office-equipment?tab=requests&waitingOnMe=true');
        }}
      >
        <Badge count={waitingServiceCount} size="small" offset={[4, -2]} color="gold">
          <PrinterOutlined />
        </Badge>
      </span>
    ) : (
      <PrinterOutlined />
    );

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
    // Орг.техника (ADR 0085) — заявки на обслуживание и парк техники. Заявки видят заказчик
    // (штаб и отдел), оператор оргтехники и сервисная компания; парк — все, кому открыт
    // справочник оргтехники, в том числе менеджер и диспетчер, у которых модуля заявок нет
    // (Р72). Пункт меню обязан открываться по любому из двух прав, иначе вкладка «Техника»
    // остаётся за закрытой дверью. `can`, а не `canUse`: область раздела — объекты и отделы
    // учётки, и пустой она у видящей роли не бывает.
    ...(can('serviceRequests.read') || can('officeEquipment.read')
      ? [
          {
            key: '/office-equipment',
            icon: serviceMenuIcon,
            label: 'Орг.техника',
            short: 'Оргтех.',
          },
        ]
      : []),
    // Раздел открывают два права (ADR 0085, Р7): весь набор справочников ведёт
    // `directories.write`, одну вкладку «Оргтехника» — `officeEquipment.write`. Второе право
    // заведено как раз затем, чтобы ответственному за оргтехнику не выдавать первое.
    ...(can('directories.write') || can('officeEquipment.write')
      ? [
          {
            key: '/directories',
            icon: <DatabaseOutlined />,
            label: 'Справочники',
            short: 'Справ.',
          },
        ]
      : []),
    /*
     * Администрирование открывает любое право его вкладок, а не одно `users.manage`
     * (`ADMIN_PAGE_PERMISSIONS`, `docs/manuals-plan.md` §3.6): держатель набора «Рассылки»
     * маршрут проходил, а пункта меню не видел — раздел был доступен только по прямой ссылке.
     * Список общий с маршрутом и стартовым редиректом: поимённые копии в трёх местах и разошлись.
     */
    ...(ADMIN_PAGE_PERMISSIONS.some((permission) => can(permission))
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

  const userMenu: MenuProps = {
    items: [
      { key: 'change-password', icon: <KeyOutlined />, label: 'Сменить пароль' },
      // На телефоне нижняя навигация занята разделами целиком (ADR 0030), и служебным пунктам
      // место только здесь. На десктопе они стоят в подвале боковой панели — и здесь не
      // дублируются: два входа в одно окно превращают меню учётки в свалку.
      ...(isMobile ? [{ type: 'divider' as const }, ...utility.menuItems] : []),
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: 'Выйти', danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'logout') void logout().then(() => navigate('/login'));
      if (key === 'change-password') navigate('/change-password');
      utility.openUtility(key);
    },
  };

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
          hasNews={utility.hasNews}
        />
        <main className="mobile-content">
          <Outlet />
        </main>
        <MobileNav items={navItems} selectedKey={selectedKey} onSelect={(key) => navigate(key)} />
        {utility.modals}
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
          <UtilityMenu menu={utility} collapsed={collapsed} />
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
      {utility.modals}
    </Layout>
  );
}
