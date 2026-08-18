import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Navigate, Route, Routes } from 'react-router';
import {
  can,
  canOrderVehicleRequestType,
  isDepartmentScopedRole,
  isObjectScopedRole,
  type AccessSubject,
  type AuthUser,
  type CounterpartyType,
  type Permission,
  type Role,
  type ScopedSubject,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { AppLayout } from '../src/components/AppLayout';
import { RequirePermission } from '../src/auth/ProtectedRoute';
import { canOpenRoute } from '../src/utils/links';

/**
 * Портал скрывает недоступное по той же матрице, по которой API запрещает (ADR 0021).
 * Проверяется именно связка «субъект → право → элемент интерфейса»: расхождение здесь даёт либо
 * кнопку, ведущую в 403, либо раздел, невидимый тому, кому он разрешён. Субъект — роль, а у
 * внешнего исполнителя пара «роль + тип контрагента» (ADR 0038): один и тот же `operator`
 * видит разные разделы в зависимости от того, кого он исполняет.
 *
 * Субъект подставляется учёткой в контекст (`renderWithUser`), а не подменой `useAuth`: права
 * считает та же функция `can`, что и в приложении, и переключаются они между тестами. Сеть
 * заглушена на уровне HTTP — макету от неё нужен только счётчик заявок на регистрацию.
 */

const OBJECT_A = '11111111-1111-1111-1111-111111111111';
const DEPARTMENT_A = '55555555-5555-5555-5555-555555555555';

/**
 * Учётка субъекта: роли достаточно, исполнителю нужен ещё и тип контрагента (ADR 0038), а роли с
 * областью — сама область (ADR 0062). Область заполняется рабочая: учётку объектной роли без
 * объектов API не активирует, и проверять по ней состав меню значило бы описывать состояние,
 * которого в портале не бывает. Площадка отдела задаётся тестом отдельно — ею как раз и
 * разводятся два рабочих состояния отдела.
 */
const userFor = (subject: ScopedSubject): AuthUser | null =>
  subject.role
    ? authUser({
        role: subject.role,
        counterpartyType: subject.counterpartyType ?? null,
        constructionObjectIds: isObjectScopedRole(subject.role) ? [OBJECT_A] : [],
        departmentIds: isDepartmentScopedRole(subject.role) ? [DEPARTMENT_A] : [],
        departmentObjectIds: [...(subject.departmentObjectIds ?? [])],
        // Надстройки роли (ADR 0086) — третья ось субъекта: права поверх роли, область не трогают.
        addons: [...(subject.addons ?? [])],
      })
    : null;

const asSubject = (subject: ScopedSubject | Role | null): ScopedSubject =>
  typeof subject === 'string' ? { role: subject } : (subject ?? { role: null });

/** Внешний исполнитель: роль одна, разделы разные — их называет тип контрагента (ADR 0038). */
const executor = (counterpartyType: CounterpartyType): AccessSubject => ({
  role: 'operator',
  counterpartyType,
});

function renderMenu(subject: ScopedSubject | Role | null, viewport?: Viewport) {
  // Меню показывает бейдж с числом заявок на регистрацию (ADR 0034) — к правам это отношения не
  // имеет, но без ответа макет администратора ходил бы за счётчиком в настоящую сеть. Журнал
  // обновлений спрашивают все вошедшие независимо от прав (ADR 0077): пустым списком и отвечаем,
  // содержимое журнала к матрице прав отношения не имеет.
  mockHttp({
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /releases': () => json([]),
    // Счётчик «ждут меня» на разделе оргтехники (Р39) спрашивают только те, у кого в цикле заявки
    // есть шаг: оператор оргтехники и сервисная компания. К составу меню он отношения не имеет —
    // отвечаем нулём, чтобы бейдж не подмешивал число в подписи пунктов; чей это запрос и у кого
    // его не бывает вовсе, проверяет `service-waiting-badge.test.tsx`.
    'GET /service-requests/waiting-count': () => json({ count: 0 }),
  });
  return renderWithUser(
    <Routes>
      {/* Роутер поднят оболочкой рендера и стартует с «/», вложить в него второй нельзя —
          нужный раздел открывается редиректом: подсветку пункта макет считает по адресу. */}
      <Route path="/" element={<Navigate to="/waste" replace />} />
      <Route element={<AppLayout />}>
        <Route path="/waste" element={<div>Список заявок</div>} />
      </Route>
    </Routes>,
    { user: userFor(asSubject(subject)), viewport },
  );
}

function renderGuarded(role: Role | null, permission: Permission) {
  return renderWithUser(
    <Routes>
      {/* Адрес защищённой страницы значения не имеет: закрывает её право, а не путь. */}
      <Route element={<RequirePermission permission={permission} />}>
        <Route path="/" element={<div>Страница справочников</div>} />
      </Route>
      <Route path="/waste" element={<div>Список заявок</div>} />
    </Routes>,
    { user: userFor({ role }) },
  );
}

describe('пункты меню следуют из прав', () => {
  it('диспетчер видит справочники — доступ выдан вместе с правом directories.write', () => {
    renderMenu('dispatcher');
    expect(screen.getByText('Справочники')).toBeDefined();
    expect(screen.getByText('Заказ ТС')).toBeDefined();
    /*
     * Администрирование диспетчеру открыто, и не учётками: у него есть `mailings.read` — он ведёт
     * рассылки. Пункт появился вместе с общим списком прав входа (`ADMIN_PAGE_PERMISSIONS`,
     * `docs/manuals-plan.md` §3.6): до него маршрут диспетчера пускал, а меню о разделе молчало —
     * попасть туда можно было только по прямой ссылке. Учётки он на странице всё равно не увидит:
     * вкладки остались поимёнными, каждая под своим правом.
     */
    expect(screen.getByText('Администрирование')).toBeDefined();
  });

  it('менеджер видит то же самое', () => {
    renderMenu('manager');
    expect(screen.getByText('Справочники')).toBeDefined();
    expect(screen.queryByText('Администрирование')).toBeNull();
  });

  it('оператору вывоза не показывают ни заказ ТС, ни справочники (ADR 0010)', () => {
    renderMenu(executor('operator'));
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
    expect(screen.queryByText('Заказ ТС')).toBeNull();
    expect(screen.queryByText('Справочники')).toBeNull();
  });

  it('отделу не показывают вкладку «На объекте»: спецтехники у него не бывает (ADR 0040)', () => {
    // Вкладка отбирает спецтехнику на площадках. Отделу она недоступна как тип заявки, и список
    // был бы пуст всегда — вкладка обещала бы содержимое, которого не бывает.
    expect(canOrderVehicleRequestType({ role: 'department' }, 'special_equipment')).toBe(false);
    expect(canOrderVehicleRequestType({ role: 'department_head' }, 'special_equipment')).toBe(
      false,
    );
    expect(canOrderVehicleRequestType({ role: 'department' }, 'freight_transport')).toBe(true);
    // Остальным заказчикам доступны оба типа — вкладка на месте.
    for (const role of ['shtab', 'rukstroy', 'dispatcher'] as Role[]) {
      expect(canOrderVehicleRequestType({ role }, 'special_equipment'), role).toBe(true);
    }
  });

  it('рейс открывают только те, у кого есть и листы, и ход заявок', () => {
    /*
     * Вкладки «Маршруты» больше нет — рейс открывается окном поверх той страницы, где о нём
     * спросили (ADR 0120), — но правило доступа переехало под новым именем целиком: `canOpenRoute`
     * держит и ссылку на рейс в чужом списке, и параметр адреса `?route=`, которым окно открывают
     * прямой ссылкой. Спрашивается тут именно она, а не переписанное здесь условие: своя копия
     * правила разошлась бы с порталом при первой же правке и молча разрешила бы лишнее.
     *
     * Условие то же, что на самих ручках рейсов: в рейсе виден водитель (персональные данные,
     * ADR 0037 п. 13), поэтому одного права на статусы мало. Оно есть у внешнего арендодателя
     * (ADR 0038) — а рейсы собственного парка не его дело.
     */
    const opensRoute = (subject: AccessSubject) =>
      canOpenRoute((permission) => can(subject, permission));

    for (const role of ['admin', 'manager', 'dispatcher'] as Role[]) {
      expect(opensRoute({ role }), role).toBe(true);
    }
    expect(opensRoute(executor('vehicle_lessor'))).toBe(false);
    for (const role of ['shtab', 'rukstroy', 'department', 'observer'] as Role[]) {
      expect(opensRoute({ role }), role).toBe(false);
    }
  });

  it('отделу без площадки показывают только заказ ТС (ADR 0062)', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const { unmount } = renderMenu(role);
      expect(screen.getByText('Заказ ТС'), role).toBeDefined();
      // Право на вывоз у роли есть, но работать им не над чем: площадки у отдела нет, и раздел
      // закрывает пустая область — иначе он обещал бы работу, которой не бывает.
      expect(screen.queryByText('Вывоз мусора'), role).toBeNull();
      expect(screen.queryByText('Справочники'), role).toBeNull();
      expect(screen.queryByText('Администрирование'), role).toBeNull();
      unmount();
    }
  });

  it('отделу с площадкой показывают и вывоз мусора (ADR 0062)', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const { unmount } = renderMenu({ role, departmentObjectIds: [OBJECT_A] });
      expect(screen.getByText('Вывоз мусора'), role).toBeDefined();
      expect(screen.getByText('Заказ ТС'), role).toBeDefined();
      // Разводит их площадка, а не роль: права в обоих состояниях одни и те же.
      expect(screen.queryByText('Справочники'), role).toBeNull();
      unmount();
    }
  });

  it('арендодателю ТС показывают заказ техники — и только его (ADR 0038)', () => {
    renderMenu(executor('vehicle_lessor'));
    expect(screen.getByText('Заказ ТС')).toBeDefined();
    expect(screen.queryByText('Вывоз мусора')).toBeNull();
    expect(screen.queryByText('Справочники')).toBeNull();
  });

  it('исполнитель без контрагента не видит ни одного модуля заявок', () => {
    renderMenu({ role: 'operator' });
    expect(screen.queryByText('Вывоз мусора')).toBeNull();
    expect(screen.queryByText('Заказ ТС')).toBeNull();
  });

  it('штаб ведёт заявки обоих модулей, но справочники не правит', () => {
    renderMenu('shtab');
    expect(screen.getByText('Заказ ТС')).toBeDefined();
    expect(screen.queryByText('Справочники')).toBeNull();
  });

  it('надстройка «Оператор (оргтехника)» открывает штабу справочники (ADR 0086)', () => {
    // Права `officeEquipment.write` у роли штаба нет — его даёт надстройка поверх роли, и раздел
    // открывается ей одной. Проверяются оба состояния подряд: видимый пункт сам по себе ничего не
    // доказывает, доказывает разница между учёткой с надстройкой и той же учёткой без неё.
    const { unmount } = renderMenu({ role: 'shtab', addons: ['office_equipment_operator'] });
    expect(screen.getByText('Справочники')).toBeDefined();
    unmount();
    renderMenu('shtab');
    expect(screen.queryByText('Справочники')).toBeNull();
  });

  it('коменданту показывают вывоз мусора и не показывают заказ ТС', () => {
    renderMenu('commandant');
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
    // Раздел закрывается правом, а не спрятанной вкладкой: прав на технику у коменданта нет.
    expect(screen.queryByText('Заказ ТС')).toBeNull();
    expect(screen.queryByText('Справочники')).toBeNull();
    expect(screen.queryByText('Администрирование')).toBeNull();
  });

  it('наблюдатель видит оба модуля заявок и ничего сверх них (ADR 0033)', () => {
    renderMenu('observer');
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
    expect(screen.getByText('Заказ ТС')).toBeDefined();
    expect(screen.queryByText('Справочники')).toBeNull();
    expect(screen.queryByText('Администрирование')).toBeNull();
  });

  it('администратору доступно всё, включая учётки', () => {
    renderMenu('admin');
    expect(screen.getByText('Справочники')).toBeDefined();
    expect(screen.getByText('Администрирование')).toBeDefined();
  });
});

/**
 * Нижняя навигация мобильного режима (ADR 0030) строится из того же списка, что и меню на
 * десктопе, поэтому проверяется не разметка, а состав: лишний пункт здесь — это кнопка, ведущая
 * в 403, а недостающий — раздел, невидимый тому, кому он разрешён. Подписи в навигации сокращены,
 * доступное имя кнопки остаётся полным — по нему пункт и ищется.
 */
function mobileNavLabels(subject: ScopedSubject | Role | null): string[] {
  renderMenu(subject, MOBILE_VIEWPORT);
  const nav = screen.getByRole('navigation', { name: 'Разделы портала' });
  return [...nav.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
}

describe('нижняя навигация на мобильном повторяет права роли', () => {
  it('администратор — все разделы', () => {
    expect(mobileNavLabels('admin')).toEqual([
      'Вывоз мусора',
      'Заказ ТС',
      'Путевые листы',
      // Гараж (ADR 0076) стоит после листов — рядом с тем, из чего собран его срез.
      'Гараж',
      // Орг.техника (ADR 0085) — третий модуль заявок; стоит перед справочниками, потому что
      // справочник оргтехники ведут уже в них.
      'Орг.техника',
      'Справочники',
      'Администрирование',
    ]);
  });

  /**
   * «Орг.техника» у менеджера и диспетчера есть, хотя модуля заявок на обслуживание у них нет: с
   * появлением вкладки «Техника» раздел открывают два права (план
   * `office-equipment-mail-and-history-plan.md`, Р72), и второе — `officeEquipment.read` — у обоих
   * есть. Внутри они увидят только парк: вкладки заявок проверяют своё право сами.
   */
  it('менеджер — без администрирования', () => {
    expect(mobileNavLabels('manager')).toEqual([
      'Вывоз мусора',
      'Заказ ТС',
      'Путевые листы',
      'Гараж',
      'Орг.техника',
      'Справочники',
    ]);
  });

  // Менеджер и диспетчер расходятся ровно на администрировании: рассылки (`mailings.read`) есть
  // только у диспетчера, а с общим списком прав входа (§3.6) право на вкладку открывает и раздел.
  it('диспетчер — то же, что у менеджера, плюс администрирование: рассылки ведёт он', () => {
    expect(mobileNavLabels('dispatcher')).toEqual([
      'Вывоз мусора',
      'Заказ ТС',
      'Путевые листы',
      'Гараж',
      'Орг.техника',
      'Справочники',
      'Администрирование',
    ]);
  });

  // Журнал листов (ADR 0037) закрыт своим правом: в листе персональные данные водителя, и
  // ролям, которые заявки только заводят или смотрят, он не открывается.
  it('штабу журнал листов не показывают', () => {
    expect(mobileNavLabels('shtab')).not.toContain('Путевые листы');
  });

  it('руководителю строительства журнал листов не показывают', () => {
    expect(mobileNavLabels('rukstroy')).not.toContain('Путевые листы');
  });

  it('наблюдателю журнал листов не показывают', () => {
    expect(mobileNavLabels('observer')).not.toContain('Путевые листы');
  });

  // Гараж (ADR 0076) закрыт своим правом по той же причине, что и журнал: в срезе видно, кто за
  // рулём. Проверяется он по одной роли на случай — `mobileNavLabels` рендерит меню, и два вызова
  // в одном тесте оставили бы на экране две навигации.
  it('штабу гараж не показывают', () => {
    expect(mobileNavLabels('shtab')).not.toContain('Гараж');
  });

  it('наблюдателю гараж не показывают, хотя заявки он читает', () => {
    expect(mobileNavLabels('observer')).not.toContain('Гараж');
  });

  it('арендодателю ТС гараж не показывают: парк и водители в нём наши', () => {
    expect(mobileNavLabels(executor('vehicle_lessor'))).not.toContain('Гараж');
  });

  // Заявки на обслуживание оргтехники (ADR 0085) заводит заказчик — штаб объекта и отдел, —
  // поэтому раздел встаёт третьим у тех же ролей, что ведут вывоз и заказ техники.
  it('штаб — три модуля заявок, без справочников', () => {
    expect(mobileNavLabels('shtab')).toEqual(['Вывоз мусора', 'Заказ ТС', 'Орг.техника']);
  });

  it('руководитель строительства — те же модули, что у штаба (ADR 0031)', () => {
    expect(mobileNavLabels('rukstroy')).toEqual(['Вывоз мусора', 'Заказ ТС', 'Орг.техника']);
  });

  it('комендант — только вывоз мусора: техника не его модуль', () => {
    expect(mobileNavLabels('commandant')).toEqual(['Вывоз мусора']);
  });

  it('оператор вывоза — только вывоз мусора (ADR 0010)', () => {
    expect(mobileNavLabels(executor('operator'))).toEqual(['Вывоз мусора']);
  });

  it('арендодатель ТС — только заказ техники (ADR 0038)', () => {
    expect(mobileNavLabels(executor('vehicle_lessor'))).toEqual(['Заказ ТС']);
  });

  it('наблюдатель — все модули заявок, смотреть их можно и с телефона (ADR 0033)', () => {
    expect(mobileNavLabels('observer')).toEqual(['Вывоз мусора', 'Заказ ТС', 'Орг.техника']);
  });

  it('открытый раздел помечен для скринридера и подписан в шапке', () => {
    renderMenu('admin', MOBILE_VIEWPORT);
    const active = screen.getByRole('button', { name: 'Вывоз мусора' });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(
      screen.getByRole('button', { name: 'Заказ ТС' }).getAttribute('aria-current'),
    ).toBeNull();
    // Заголовок панели называет раздел полностью — в навигации подпись сокращена.
    expect(screen.getAllByText('Вывоз мусора').length).toBeGreaterThan(0);
  });

  it('на десктопе нижней навигации нет вовсе', () => {
    renderMenu('admin');
    expect(screen.queryByRole('navigation', { name: 'Разделы портала' })).toBeNull();
  });
});

describe('раздел закрывается правом, а не списком ролей', () => {
  it('пускает роль с правом', () => {
    renderGuarded('dispatcher', 'directories.write');
    expect(screen.getByText('Страница справочников')).toBeDefined();
  });

  it('роль без права уводит на список заявок, а не показывает пустую страницу', () => {
    renderGuarded('shtab', 'directories.write');
    expect(screen.queryByText('Страница справочников')).toBeNull();
    expect(screen.getByText('Список заявок')).toBeDefined();
  });

  it('учётку без роли не пускает никуда', () => {
    renderGuarded(null, 'directories.write');
    expect(screen.queryByText('Страница справочников')).toBeNull();
  });

  it('администрирование закрыто правом на учётки', () => {
    renderGuarded('manager', 'users.manage');
    expect(screen.queryByText('Страница справочников')).toBeNull();
  });
});

/**
 * Водители (ADR 0037) — единственный справочник со своим правом: в карточке персональные данные,
 * и роль, которой открыты остальные вкладки, доступа к ним не получает.
 */
describe('справочник водителей закрыт отдельным правом', () => {
  const WITH_ACCESS: AccessSubject[] = [
    { role: 'admin' },
    { role: 'manager' },
    { role: 'dispatcher' },
  ];
  const WITHOUT_ACCESS: AccessSubject[] = [
    { role: 'shtab' },
    { role: 'rukstroy' },
    { role: 'observer' },
    { role: 'operator', counterpartyType: 'operator' },
    { role: 'operator', counterpartyType: 'vehicle_lessor' },
  ];

  it('право есть у тех, кто выписывает путевые листы', () => {
    for (const subject of WITH_ACCESS) {
      expect(can(userFor(subject), 'drivers.read'), String(subject.role)).toBe(true);
      expect(can(userFor(subject), 'drivers.write'), String(subject.role)).toBe(true);
    }
  });

  it('остальным закрыт — включая тех, кому открыты прочие справочники', () => {
    for (const subject of WITHOUT_ACCESS) {
      const key = `${subject.role}/${subject.counterpartyType ?? ''}`;
      expect(can(userFor(subject), 'drivers.read'), key).toBe(false);
      // Прочие справочники им доступны: право на водителей отделено именно от них.
      expect(can(userFor(subject), 'directories.read'), key).toBe(true);
    }
  });
});
