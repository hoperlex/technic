import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  equipmentRequestOutcomeLabels,
  type AuthUser,
  type EquipmentChangeRowDto,
  type EquipmentMovementRowDto,
  type EquipmentRequestRowDto,
  type OfficeEquipmentDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { EquipmentHistoryModal } from '../src/features/equipment-history';
import { OfficeEquipmentServiceHistory } from '../src/pages/directories/OfficeEquipmentServiceHistory';

/**
 * История единицы оргтехники тремя бизнес-блоками (план
 * `docs/office-equipment-history-blocks-plan.md`, §10.2).
 *
 * Проверяется то, ради чего блоки и заведены: заявка занимает ОДНУ строку и ведёт в свою карточку;
 * событийная лента цела и лежит четвёртой вкладкой; пустой блок объясняет себя словами, а «не
 * положено видеть» отличается от «не было» тем, что вкладки нет вовсе; страницы догружаются
 * курсором, и переключение вкладок загруженного не теряет.
 */

/** Право модуля плюс право заявок: только с обоими блок «Заявки» существует (Р1). */
const READER: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: ['officeEquipment.read', 'serviceRequests.read'],
});

/**
 * Справочник открыт, модуль обслуживания — нет: так живут менеджер и диспетчер. Ручка заявок
 * ответила бы им `403`, поэтому вкладки у них нет вовсе — и это «не положено», а не «не было».
 */
const NO_SERVICE: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: ['officeEquipment.read'],
});

function equipment(overrides: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'ty-1', name: 'МФУ', isActive: true },
    specs: [],
    name: 'Kyocera M3145',
    serialNumber: 'SN-1',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    department: null,
    location: 'каб. 214',
    state: 'on_site',
    stateNote: '',
    purchasedOn: null,
    warrantyUntil: null,
    comment: '',
    isActive: true,
    createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function requestRow(overrides: Partial<EquipmentRequestRowDto> = {}): EquipmentRequestRowDto {
  return {
    id: 'sr-1',
    displayNumber: 'СО-14',
    kind: 'repair',
    summary: 'Не печатает: замятие бумаги в дуплексе',
    executors: ['ООО «Сервис-Про»'],
    createdAt: '2026-07-02T09:00:00.000Z',
    updatedAt: '2026-07-05T09:00:00.000Z',
    status: 'accepted',
    outcome: { code: 'accepted', label: equipmentRequestOutcomeLabels.accepted },
    totalAmount: 6200,
    warranties: [],
    objectMismatch: false,
    ...overrides,
  };
}

function changeRow(overrides: Partial<EquipmentChangeRowDto> = {}): EquipmentChangeRowDto {
  return {
    id: 'ch-1',
    at: '2026-06-01T10:00:00.000Z',
    actorName: 'Оператор О. О.',
    changes: [{ field: 'location', from: 'каб. 214', to: 'каб. 12' }],
    ...overrides,
  };
}

function movementRow(overrides: Partial<EquipmentMovementRowDto> = {}): EquipmentMovementRowDto {
  return {
    id: 'mv-1',
    movedOn: '2026-08-09',
    fromObject: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    toObject: { id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' },
    fromDepartment: null,
    toDepartment: null,
    fromLocation: 'каб. 214',
    toLocation: 'каб. 12',
    fromState: 'on_site',
    toState: 'on_site',
    fromStateNote: '',
    toStateNote: '',
    reason: 'Перевод бухгалтерии',
    comment: '',
    serviceRequestId: null,
    serviceRequestNum: null,
    confirmsDeclaredPlace: false,
    movedByName: 'Оператор О. О.',
    createdAt: '2026-08-10T09:00:00.000Z',
    ...overrides,
  };
}

/** Событие ленты: порядок и вид считает сервер, портал только рисует (Р75–Р79). */
const feedEvent = {
  kind: 'movement' as const,
  id: 'mv-1',
  sortId: 'movement:mv-1',
  occurredOn: '2026-08-09',
  recordedAt: '2026-08-10T09:00:00.000Z',
  actorName: 'Оператор О. О.',
  fromObject: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
  toObject: { id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' },
  fromLocation: 'каб. 214',
  toLocation: 'каб. 12',
  fromState: 'on_site' as const,
  toState: 'on_site' as const,
  toDepartmentName: null,
  reason: 'Перевод бухгалтерии',
  comment: '',
  serviceRequestId: null,
  serviceRequestNum: null,
};

const page = <T,>(items: T[], nextCursor: string | null = null) => ({
  items,
  hasMore: nextCursor !== null,
  nextCursor,
});

function renderModal(over: RouteMap = {}, user: AuthUser = READER): HttpMock {
  const http = mockHttp({
    'GET /office-equipment/:id/requests': () => json(page([requestRow()])),
    'GET /office-equipment/:id/changes': () => json(page([changeRow()])),
    'GET /office-equipment/:id/movements': () => json(page([movementRow()])),
    'GET /office-equipment/:id/history': () =>
      json({ items: [feedEvent], hasMore: false, nextCursor: null, serviceVisible: true }),
    ...over,
  });
  renderWithUser(<EquipmentHistoryModal equipment={equipment()} onClose={() => {}} />, { user });
  return http;
}

describe('окно истории тремя блоками', () => {
  it('открывается заявками: одна заявка — одна строка', async () => {
    const http = renderModal();
    expect(await screen.findByText('СО-14')).toBeDefined();
    expect(screen.getByText(/Не печатает/)).toBeDefined();
    // Обе даты в строке (Н4): заведения и последней правки заявки.
    expect(screen.getByText('02.07.2026')).toBeDefined();
    expect(screen.getByText(/05\.07\.2026/)).toBeDefined();
    // Соседние вкладки не спрашиваются, пока на них не перешли: окно открывают одним вопросом.
    expect(http.countOf('GET /office-equipment/:id/history')).toBe(0);
    expect(http.countOf('GET /office-equipment/:id/movements')).toBe(0);
  });

  it('шапка отвечает, когда карточку завели (Р6)', async () => {
    renderModal();
    await screen.findByText('СО-14');
    expect(screen.getByText('Заведена')).toBeDefined();
    expect(screen.getByText('10.01.2026')).toBeDefined();
  });

  it('«Полная история» показывает прежнюю ленту событий', async () => {
    const http = renderModal();
    await screen.findByText('СО-14');

    fireEvent.click(screen.getByText('Полная история'));

    // Та же таблица ленты: вид события тегом, а не строкой блока.
    expect(await screen.findByText('Перемещение')).toBeDefined();
    expect(screen.getByText(/Перевод бухгалтерии/)).toBeDefined();
    expect(http.countOf('GET /office-equipment/:id/history')).toBe(1);
  });

  it('строка заявки ведёт в её карточку тем же адресом, что и остальные ссылки портала', async () => {
    renderModal();
    const link = await screen.findByRole('link', { name: 'СО-14' });
    expect(link.getAttribute('href')).toBe('/office-equipment?tab=requests&open=sr-1');
  });

  it('пустой блок говорит «не было» словами', async () => {
    renderModal({ 'GET /office-equipment/:id/requests': () => json(page([])) });
    expect(
      await screen.findByText(/Заявок на обслуживание по этому аппарату не было/),
    ).toBeDefined();
  });

  it('без права заявок вкладки «Заявки» нет вовсе, а соседние работают', async () => {
    const http = renderModal({}, NO_SERVICE);
    // «Не положено» отличается от «не было» тем, что рассказа нет совсем: пустая таблица заявок
    // утверждала бы, что их не было.
    expect(await screen.findByText('Правки')).toBeDefined();
    expect(screen.queryByText('Заявки')).toBeNull();
    // Ручку заявок портал не дёргает: спрашивать сервер ради 403 незачем.
    expect(http.countOf('GET /office-equipment/:id/requests')).toBe(0);
    // Умолчание съезжает на первую доступную вкладку, а не оставляет окно пустым.
    expect(await screen.findByText('Место:')).toBeDefined();
    expect(screen.getByText('каб. 12')).toBeDefined();
  });

  it('«Показать ещё» дозагружает страницу по курсору', async () => {
    renderModal({
      'GET /office-equipment/:id/requests': ({ query }) =>
        json(
          query.get('cursor')
            ? page([requestRow({ id: 'sr-2', displayNumber: 'СО-15' })])
            : page([requestRow()], '1~requests~2026-07-02T09:00:00.000Z~sr-1'),
        ),
    });
    await screen.findByText('СО-14');

    fireEvent.click(screen.getByText('Показать ещё'));

    expect(await screen.findByText('СО-15')).toBeDefined();
    // Первая страница осталась на месте: «показать ещё» дописывает, а не заменяет.
    expect(screen.getByText('СО-14')).toBeDefined();
  });

  it('переключение вкладок не сбрасывает загруженное', async () => {
    const http = renderModal({
      'GET /office-equipment/:id/requests': ({ query }) =>
        json(
          query.get('cursor')
            ? page([requestRow({ id: 'sr-2', displayNumber: 'СО-15' })])
            : page([requestRow()], '1~requests~2026-07-02T09:00:00.000Z~sr-1'),
        ),
    });
    await screen.findByText('СО-14');
    fireEvent.click(screen.getByText('Показать ещё'));
    await screen.findByText('СО-15');

    fireEvent.click(screen.getByText('Правки'));
    expect(await screen.findByText('Оператор О. О.')).toBeDefined();
    fireEvent.click(screen.getByText('Заявки'));

    expect(await screen.findByText('СО-15')).toBeDefined();
    // Обе страницы взяты по одному разу: возврат на вкладку — не повод спрашивать сервер заново.
    await waitFor(() => expect(http.countOf('GET /office-equipment/:id/requests')).toBe(2));
  });

  it('перемещение показывает обе стороны, причину и подтверждение места', async () => {
    renderModal({
      'GET /office-equipment/:id/movements': () =>
        json(
          page([
            movementRow({
              toState: 'with_employee',
              toStateNote: 'Иванов И. И.',
              confirmsDeclaredPlace: true,
              serviceRequestId: 'sr-9',
              serviceRequestNum: 21,
            }),
          ]),
        ),
    });
    await screen.findByText('СО-14');

    fireEvent.click(screen.getByText('Перемещения'));

    expect(
      await screen.findByText(/ОБ-2 · каб\. 12 · У сотрудника \(Иванов И\. И\.\)/),
    ).toBeDefined();
    expect(screen.getByText('Место подтверждено')).toBeDefined();
    expect(screen.getByRole('link', { name: 'СО-21' }).getAttribute('href')).toBe(
      '/office-equipment?tab=requests&open=sr-9',
    );
  });

  it('правка без подробностей приходит честной строкой, а не пропадает', async () => {
    renderModal({
      'GET /office-equipment/:id/changes': () => json(page([changeRow({ changes: [] })])),
    });
    await screen.findByText('СО-14');

    fireEvent.click(screen.getByText('Правки'));

    expect(await screen.findByText('Правка без подробностей')).toBeDefined();
  });
});

describe('секция карточки «Обслуживание и гарантии»', () => {
  function renderSection(rows: EquipmentRequestRowDto[], user: AuthUser = READER): HttpMock {
    const http = mockHttp({
      'GET /office-equipment/:id': () => json(equipment()),
      'GET /office-equipment/:id/requests': () => json(page(rows)),
    });
    renderWithUser(<OfficeEquipmentServiceHistory equipmentId="oe-1" />, { user });
    return http;
  }

  it('показывает первые пять строк того же блока и ссылку в него', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) =>
      requestRow({ id: `sr-${n}`, displayNumber: `СО-${n}` }),
    );
    const http = renderSection(rows);

    expect(await screen.findByText('СО-1')).toBeDefined();
    expect(screen.getByText('СО-5')).toBeDefined();
    // Предел приходит запросом, а не обрезкой на портале: «а было ли больше» знает сервер.
    expect(http.lastCall('GET /office-equipment/:id/requests')?.query.get('pageSize')).toBe('5');

    fireEvent.click(screen.getByText('Все заявки по аппарату'));
    expect(await screen.findByText(/История · Kyocera M3145/)).toBeDefined();
    // Окно открывается сразу на заявках (Р7), а не на ленте.
    expect(screen.getByText('Заявки')).toBeDefined();
  });
});
