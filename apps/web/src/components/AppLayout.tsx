import { useState, type MouseEvent, type ReactNode } from 'react';
import { Badge, Dropdown, Layout, Menu, type MenuProps, Space, Typography } from 'antd';
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
  ToolOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router';
import {
  formatShortName,
  openShellSections,
  roleLabels,
  type PortalShellSectionId,
} from '@technic/contracts';
import { usersApi } from '../api/resources';
import { useAuth } from '../auth/AuthContext';
import { UtilityMenu, useUtilityMenu } from '@widgets/utility-menu';
import { useServiceWaitingCount } from '@features/service-waiting-badge';
import { useServiceChatUnreadCount } from '@features/service-chat';
import { readSiderCollapsed, useIsMobile, writeSiderCollapsed } from '@shared/lib';
import { MobileAppBar } from './MobileAppBar';
import { MobileNav, type MobileNavItem } from './MobileNav';
import { PortalLogo } from './PortalLogo';
import { UserAvatar } from './UserAvatar';

const { Sider, Content } = Layout;

const SIDER_WIDTH = 230;
const SIDER_COLLAPSED_WIDTH = 64;

/**
 * Иконки разделов — здесь, а не в реестре: контракты про React не знают, и рисование — дело
 * каркаса. `Record` по `PortalShellSectionId`, а не по всем разделам портала: раздел каркаса без
 * иконки не соберётся, а кабинету водителя (ADR 0102) иконка не нужна — пункта меню у него нет.
 */
const SECTION_ICONS: Record<PortalShellSectionId, ReactNode> = {
  waste: <FileTextOutlined />,
  'vehicle-requests': <CarOutlined />,
  waybills: <ProfileOutlined />,
  garage: <ScheduleOutlined />,
  // Ключ, а не машина: механизация — это виброплиты, компрессоры и пушки, которые привозят на
  // площадку, и `CarOutlined` соседнего «Заказа ТС» читался бы как второй раздел про транспорт.
  mechanization: <ToolOutlined />,
  'office-equipment': <PrinterOutlined />,
  directories: <DatabaseOutlined />,
  admin: <TeamOutlined />,
};

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
  const unreadChatCount = useServiceChatUnreadCount();

  /**
   * Бейдж ведёт не в раздел, а в саму очередь «Требуют решения» — тот же пресет списка, что и
   * кнопка на вкладке заявок. Обработчик гасит всплытие: нажатие мимо бейджа остаётся нажатием на
   * пункт меню и открывает раздел целиком. Ставится он только на зажжённый бейдж — у погасшего
   * иконка обязана вести туда же, куда весь пункт.
   */
  const openWaitingQueue = (e: MouseEvent) => {
    e.stopPropagation();
    navigate('/office-equipment?tab=requests&waitingOnMe=true');
  };

  const waitingBadge =
    waitingServiceCount > 0 ? (
      <span title="Требуют решения" onClick={openWaitingQueue}>
        <Badge count={waitingServiceCount} size="small" offset={[4, -2]} color="gold">
          {SECTION_ICONS['office-equipment']}
        </Badge>
      </span>
    ) : (
      SECTION_ICONS['office-equipment']
    );

  /**
   * Второй бейдж — синий, о непрочитанном в обсуждениях заявок (ADR 0141). Отдельный от золотого,
   * и СКЛАДЫВАТЬ ИХ НЕЛЬЗЯ: «где меня ждут» и «где мне написали» — разные вопросы, а сумма не
   * отвечает ни на один и вела бы в очередь, отобранную не тем фильтром. Отсюда и два цвета:
   * одинаковые кружки рядом читались бы как одно число, разбитое надвое.
   *
   * Своей ссылки у него нет: отбора «где мне написали» в списке не существует — непрочитанное
   * показано меткой у номера, а не колонкой, — и нажатие остаётся нажатием на пункт меню.
   *
   * На телефоне — точка вместо числа, как у новостей выпуска (ADR 0077): пункт нижней навигации
   * шириной в четверть экрана несёт подпись и иконку, и число поверх них не читается. Дальше
   * человек всё равно идёт в раздел, где метка стоит у самой заявки.
   *
   * Точка стоит у ЛЕВОГО края иконки, а золотой счётчик — у правого: на двузначном числе он
   * разрастается влево, и точка, поставленная там же, тонула прямо в нём — на приёмке она
   * закрывала «2» у «12».
   */
  const serviceMenuIcon =
    unreadChatCount > 0 ? (
      <Badge
        count={isMobile ? undefined : unreadChatCount}
        dot={isMobile}
        size="small"
        offset={isMobile ? [-16, 2] : [4, 14]}
        color="blue"
        title={`Непрочитанных обсуждений: ${unreadChatCount}`}
      >
        {waitingBadge}
      </Badge>
    ) : (
      waitingBadge
    );

  /**
   * Те же два счётчика для РАЗВЁРНУТОГО меню — строкой, у правого края пункта, а не на иконке.
   * От иконки до подписи десять пикселей, и двузначное число в них не помещается: на приёмке
   * золотой «12» лежал на первой букве «Орг.техники», а синий закрывал правый край самой иконки.
   * У правого края строки места хватает обоим, и оба остаются ЧИСЛАМИ: точка отвечала бы
   * «где-то что-то есть» там, где спрашивают «сколько». На свёрнутой панели и на телефоне подписи
   * рядом с иконкой нет вовсе — там счётчики остаются на иконке (`serviceMenuIcon`).
   */
  const serviceCounters =
    waitingServiceCount > 0 || unreadChatCount > 0 ? (
      <Space size={4}>
        {waitingServiceCount > 0 && (
          <span title="Требуют решения" onClick={openWaitingQueue}>
            <Badge count={waitingServiceCount} size="small" color="gold" />
          </span>
        )}
        {unreadChatCount > 0 && (
          <Badge
            count={unreadChatCount}
            size="small"
            color="blue"
            title={`Непрочитанных обсуждений: ${unreadChatCount}`}
          />
        )}
      </Space>
    ) : null;

  /**
   * Бейджи — украшение иконки, а не отдельный пункт: состав меню задаёт реестр, число надевает
   * каркас. Оба счётчика приходят из живых запросов и потому пересобираются каждым рендером.
   */
  const sectionIcons: Record<PortalShellSectionId, ReactNode> = {
    ...SECTION_ICONS,
    'office-equipment': serviceMenuIcon,
    admin: (
      <Badge count={pendingUsers?.count ?? 0} size="small" offset={[4, -2]} color="gold">
        {SECTION_ICONS.admin}
      </Badge>
    ),
  };

  /**
   * Пункты меню и нижней навигации собираются из реестра разделов (`portal-sections.ts`): состав,
   * порядок и подписи — его, каркасу остаются иконка и переход. Почему раздел открыт такой-то роли
   * (ADR 0010, 0025, 0037, 0062, 0076, 0085), написано там же, в строках разделов: копия
   * объяснений здесь разъехалась бы с копией состава — с этого болезнь и начиналась.
   *
   * Реестр спрашивает всюду `canUse`, хотя до него часть пунктов спрашивала `can`. Состав меню от
   * этого не меняется ни у одной роли: область сужает единственный `MODULE_SCOPE` — вывоз мусора у
   * отдела без площадки (ADR 0062), — а для остальных прав `canUse` совпадает с `can`.
   *
   * `short` — подпись для нижней навигации мобильного режима: на 360 px пункту достаётся четверть
   * экрана, и полное название раздела туда не помещается (ADR 0030).
   */
  const sectionCounters: Partial<Record<PortalShellSectionId, ReactNode>> = {
    'office-equipment': serviceCounters,
  };

  /** `menuIcon` — иконка развёрнутого меню: у раздела со счётчиками в строке она остаётся голой. */
  type NavItem = MobileNavItem & { icon: ReactNode; menuIcon: ReactNode; counters: ReactNode };
  const navItems: NavItem[] = openShellSections({
    role: user?.role ?? null,
    canUse,
  }).map((section) => ({
    key: section.path,
    icon: sectionIcons[section.id],
    menuIcon: sectionCounters[section.id] ? SECTION_ICONS[section.id] : sectionIcons[section.id],
    counters: sectionCounters[section.id] ?? null,
    label: section.label,
    short: section.short,
  }));

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
                // Короткая подпись нужна только нижней навигации мобильного режима, а счётчики
                // разъезжаются по пункту сами: подпись жмётся влево, числа встают справа.
                items={navItems.map(({ key, menuIcon, label, counters }) => ({
                  key,
                  icon: menuIcon,
                  label: counters ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {label}
                      </span>
                      {counters}
                    </span>
                  ) : (
                    label
                  ),
                }))}
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
