import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import { can, type AuthUser, type Permission, type VehicleRequestDto } from '@technic/contracts';
import { DESKTOP_VIEWPORT, setViewport } from './viewport';

/**
 * Форма правки заявки на ТС обязана показывать то, что у заявки есть, а не то, что бывает у роли
 * редактора: скрытое поле — это молчаливая потеря значения при сохранении, и заметить её в списке
 * нечем. Проверяются оба места, где формы это правило нарушали:
 *
 *  - заказчик грузоперевозки (ADR 0040): у заявки отдела форма спрашивала «Объект» — поле
 *    редактора, а не заявки, — и сохранение переносило заявку с отдела на площадку;
 *  - назначенная машина (ADR 0048): её в форме правки нет и быть не должно — подбор техники это
 *    не правка заказа, — но действие для неё обязано существовать, иначе поле «Техника» в карточке
 *    видно, а изменить его нечем.
 */

const USER: AuthUser = {
  id: 'user-1',
  email: 'd@test.local',
  lastName: 'Диспетчеров',
  firstName: 'Дмитрий',
  middleName: '',
  fullName: 'Диспетчеров Дмитрий',
  role: 'dispatcher',
  isActive: true,
  mustChangePassword: false,
  constructionObjectIds: [],
  departmentIds: [],
  counterpartyType: null,
};

vi.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({
    user: USER,
    status: 'authenticated' as const,
    login: vi.fn(),
    logout: vi.fn(),
    setUser: vi.fn(),
    refreshUser: vi.fn(),
    hasRole: () => true,
    can: (p: Permission) => can({ role: 'dispatcher' }, p),
  }),
}));

const ASSIGNMENT = {
  vehicleId: 'v-1',
  ownership: 'own' as const,
  typeName: 'Самосвалы',
  categoryName: null,
  modelName: 'КамАЗ-6520',
  registrationNumber: 'Е646СК799',
  description: '',
  lessorId: null,
  lessorName: null,
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: 'user-1',
  assignedByName: 'Диспетчеров Дмитрий',
  assignedAt: '2026-08-01T10:00:00.000Z',
};

/** Заказ техники на объект — «Новая»: машины нет, менять нечего. */
const SPECIAL = {
  id: 'r-1',
  num: 601,
  displayNumber: 'ТС-601',
  requestType: 'special_equipment',
  objectId: 'obj-1',
  objectCode: 'OBJ-A',
  objectName: 'Объект Химки',
  objectAddress: 'Химки, ул. Победы, 10',
  departmentId: null,
  departmentCode: null,
  departmentName: null,
  vehicleTypeId: 'type-crane',
  vehicleTypeName: 'Автокраны',
  vehicleCategoryId: 'cat-130',
  vehicleCategoryName: 'Автокраны, г/п 130 т',
  status: 'new',
  comment: 'котлован',
  cancelReason: null,
  approvedBy: null,
  approvedByName: null,
  approvedAt: null,
  assignment: null,
  completion: null,
  route: null,
  files: [],
  version: 1,
  createdBy: 'user-1',
  createdByName: 'Иванов И. И.',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  deletedAt: null,
  dateFrom: '2026-08-10',
  dateTo: null,
  responsibleName: 'Петров П. П.',
  responsiblePhone: '+7 926 000-00-01',
  earlyEnd: null,
} as unknown as VehicleRequestDto;

/** Грузоперевозка отдела, уже в работе: и заказчик-отдел, и назначенная машина. */
const FREIGHT = {
  ...SPECIAL,
  id: 'r-2',
  num: 602,
  displayNumber: 'ТС-602',
  requestType: 'freight_transport',
  objectId: null,
  objectCode: null,
  objectName: null,
  objectAddress: null,
  departmentId: 'dep-1',
  departmentCode: 'SNAB',
  departmentName: 'Снабжение',
  vehicleTypeId: 'type-truck',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  status: 'confirmed',
  comment: 'плиты',
  approvedAt: '2026-08-01T09:30:00.000Z',
  assignment: ASSIGNMENT,
  scheduledAt: '2026-08-10T09:00:00.000Z',
  scheduledTimeUnspecified: false,
  volumeM3: null,
  weightTons: 14,
  loadingLocation: 'Москва, ул. Ленина, 1',
  unloadingLocation: 'Химки, ул. Победы, 10',
  loadingAddress: { source: 'dadata', fiasId: 'a', fiasLevel: '8', qc: 0, lat: 55, lon: 37 },
  unloadingAddress: { source: 'dadata', fiasId: 'b', fiasLevel: '8', qc: 0, lat: 55, lon: 37 },
  loadingResponsibleName: 'Сидоров С. С.',
  loadingResponsiblePhone: '+7 926 000-00-02',
  unloadingResponsibleName: 'Петров П. П.',
  unloadingResponsiblePhone: '+7 926 000-00-03',
} as unknown as VehicleRequestDto;

const emptyList = { items: [], total: 0, page: 1, pageSize: 500 };

vi.mock('../src/api/resources', () => ({
  vehicleRequestsApi: {
    list: async () => ({ items: [SPECIAL, FREIGHT], total: 2, page: 1, pageSize: 20 }),
    summary: async () => ({ new: 1, awaitingApproval: 0, confirmed: 1 }),
    history: async () => [],
    routePrefill: async () => ({
      required: false,
      formLabel: null,
      reason: 'Рейс не ведётся',
      tripDate: '2026-08-10',
      routes: [],
      trip: null,
    }),
    waybill: async () => null,
    changeAssignment: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  objectsApi: {
    list: async () => ({
      items: [{ id: 'obj-1', code: 'OBJ-A', name: 'Объект Химки' }],
      total: 1,
      page: 1,
      pageSize: 500,
    }),
  },
  departmentsApi: {
    list: async () => ({
      items: [{ id: 'dep-1', code: 'SNAB', name: 'Снабжение' }],
      total: 1,
      page: 1,
      pageSize: 500,
    }),
  },
  vehicleClassificationsApi: { list: async () => emptyList },
  filesApi: { upload: vi.fn(), remove: vi.fn() },
  vehiclesApi: { list: async () => emptyList },
  driversApi: { available: async () => ({ drivers: [], requiredCategory: null }) },
  counterpartiesApi: { list: async () => emptyList },
}));

const { VehicleRequestsTab } = await import('../src/pages/vehicle/VehicleRequestsTab');

function renderTab() {
  setViewport(DESKTOP_VIEWPORT);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App>
        <VehicleRequestsTab />
      </App>
    </QueryClientProvider>,
  );
}

/** Подписи полей открытого окна — то, что человек в нём действительно видит. */
function formLabels(): string[] {
  return [...document.querySelectorAll('.ant-modal label')].map((l) => l.textContent ?? '');
}

/** Кнопка в строке заявки: строки различаются по номеру, а иконки внутри — по aria-label. */
async function rowButton(displayNumber: string, label: string): Promise<HTMLButtonElement | null> {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  return row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

describe('форма правки заявки на ТС: поля заявки, а не роли', () => {
  it('заказ техники на объект открывается со всеми своими полями', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('ТС-601')).toBeDefined());
    fireEvent.click(document.querySelectorAll('.anticon-edit')[0]!.closest('button')!);

    await waitFor(() => expect(screen.getByText('Заявка ТС-601')).toBeDefined());
    expect(formLabels()).toEqual(
      expect.arrayContaining([
        'Объект',
        'Тип заявки',
        'Тип/категория ТС',
        'Дата начала',
        'Дата окончания',
        'Ответственный на объекте',
      ]),
    );
  });

  it('у грузоперевозки отдела спрашивается отдел, а не пустой объект', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('ТС-602')).toBeDefined());
    fireEvent.click(document.querySelectorAll('.anticon-edit')[1]!.closest('button')!);

    await waitFor(() => expect(screen.getByText('Заявка ТС-602')).toBeDefined());
    const labels = formLabels();
    expect(labels).toContain('Отдел');
    // Диспетчер — не роль отдела, и раньше форма показывала ему свою ось: пустой «Объект».
    expect(labels).not.toContain('Объект');
    // Заказчик подставлен: пустое обязательное поле сохранением унесло бы заявку на площадку.
    expect(screen.getByTitle('SNAB — Снабжение')).toBeDefined();
  });
});

describe('смена назначенной техники (ADR 0048)', () => {
  it('у заявки в работе действие есть, у «Новой» — нет', async () => {
    renderTab();
    await screen.findByText('ТС-602');
    expect(await rowButton('ТС-602', 'Сменить технику')).not.toBeNull();
    // «Новой» машину назначает сам перевод в работу — менять нечего.
    expect(await rowButton('ТС-601', 'Сменить технику')).toBeNull();
  });

  it('окно открывается на текущей машине и не спрашивает срок', async () => {
    renderTab();
    await screen.findByText('ТС-602');
    fireEvent.click((await rowButton('ТС-602', 'Сменить технику'))!);

    await waitFor(() => expect(screen.getByText('Смена техники: заявка ТС-602')).toBeDefined());
    // Видно, с чего меняем: смена начинается с вопроса «на что», а ответ на «с чего» должен
    // стоять перед глазами.
    // Подпись машины та же, что в списке и карточке (`assignmentTitle`): у собственной это госномер.
    expect(screen.getByText(/Сейчас назначена: .*Е646СК799/)).toBeDefined();
    // Срок согласован при переводе в работу и здесь не правится (ADR 0048 п. 4).
    const labels = formLabels();
    expect(labels).not.toContain('Фактическая дата подачи');
    expect(labels).not.toContain('Фактическое время (МСК)');
    expect(labels).toContain('Конкретная техника');
    // Кнопка окна названа действием, а не «Сохранить»: она меняет исполнение заявки.
    expect(document.querySelector('.ant-modal-footer .ant-btn-primary')?.textContent).toBe(
      'Сменить технику',
    );
  });
});
