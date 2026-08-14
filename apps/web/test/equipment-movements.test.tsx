import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, OfficeEquipmentDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { EquipmentHistoryModal } from '../src/features/equipment-history';
import { EquipmentMoveModal } from '../src/features/equipment-move';

/**
 * Перемещения оргтехники и лента истории единицы (план модернизации, Р59–Р62).
 *
 * Проверяется то, из-за чего переезд и стал отдельным действием: у него есть дата, причина и обе
 * стороны, а техника после него уходит из справочника отдающей площадки. И то, ради чего лента
 * сведена в одну: перемещения и ремонты читаются вместе, по датам, а не двумя рассказами.
 */

const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

function equipment(overrides: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'ty-1', name: 'МФУ', isActive: true },
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

function renderMove(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /objects': () => json(list([objectDto(), objectDto({ id: 'obj-2', code: 'ОБ-2' })])),
    'GET /departments': () => json(emptyList()),
    'POST /office-equipment/:id/move': () => json(equipment(), 201),
    ...over,
  });
  renderWithUser(<EquipmentMoveModal equipment={equipment()} onClose={() => {}} />, {
    user: OPERATOR,
  });
  return http;
}

describe('перемещение единицы', () => {
  it('уходит на сервер датой, причиной и целевым местом', async () => {
    const http = renderMove();
    fireEvent.change(await screen.findByPlaceholderText(/Перевод бухгалтерии/), {
      target: { value: 'Перевод бухгалтерии' },
    });
    fireEvent.click(screen.getByText('Записать перемещение'));

    await waitFor(() => expect(http.lastCall('POST /office-equipment/:id/move')).toBeDefined());
    const body = http.lastCall('POST /office-equipment/:id/move')?.body as Record<string, unknown>;
    expect(body.reason).toBe('Перевод бухгалтерии');
    // Дата переезда уходит всегда: технику увозят в пятницу, а заносят в понедельник.
    expect(body.movedOn).toBeTruthy();
    expect(body.objectId).toBe('obj-1');
  });

  it('без причины перемещение не отправляется: журнал без объяснений бесполезен', async () => {
    const http = renderMove();
    await screen.findByText('Записать перемещение');
    fireEvent.click(screen.getByText('Записать перемещение'));
    await waitFor(() => expect(screen.queryAllByText(/Укажите причину/).length).toBeGreaterThan(0));
    expect(http.lastCall('POST /office-equipment/:id/move')).toBeUndefined();
  });
});

describe('лента истории единицы', () => {
  const movement = {
    id: 'mv-1',
    movedOn: '2026-08-10',
    fromObject: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    toObject: { id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' },
    fromDepartment: null,
    toDepartment: null,
    fromLocation: 'каб. 214',
    toLocation: 'каб. 12',
    fromState: 'on_site' as const,
    toState: 'on_site' as const,
    reason: 'Перевод бухгалтерии',
    comment: '',
    serviceRequestId: null,
    serviceRequestNum: null,
    movedByName: 'Оператор О. О.',
    createdAt: '2026-08-10T09:00:00.000Z',
  };

  const repair = {
    id: 'sr-1',
    displayNumber: 'СО-14',
    status: 'accepted' as const,
    createdAt: '2026-07-02T09:00:00.000Z',
    completedAt: '2026-07-02T15:00:00.000Z',
    serviceName: 'ООО «Сервис-Про»',
    totalAmount: 6200,
    warranties: [],
  };

  function renderHistory(payload: unknown): void {
    mockHttp({ 'GET /office-equipment/:id/history': () => json(payload) });
    renderWithUser(<EquipmentHistoryModal equipment={equipment()} onClose={() => {}} />, {
      user: OPERATOR,
    });
  }

  it('перемещения и ремонты идут одной лентой, свежее сверху', async () => {
    renderHistory({ movements: [movement], serviceHistory: [repair] });
    expect(await screen.findByText('Перемещение')).toBeDefined();
    expect(screen.getByText('Обслуживание')).toBeDefined();
    // Порядок: переезд августа стоит выше июльского ремонта.
    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '');
    const move = rows.findIndex((text) => text.includes('Перемещение'));
    const service = rows.findIndex((text) => text.includes('Обслуживание'));
    expect(move).toBeLessThan(service);
  });

  it('без права модуля лента состоит из одних перемещений', async () => {
    // Поля `serviceHistory` в ответе нет вовсе — это «не положено видеть», а не «ремонтов не было».
    renderHistory({ movements: [movement] });
    expect(await screen.findByText('Перемещение')).toBeDefined();
    expect(screen.queryByText('Обслуживание')).toBeNull();
  });

  it('пустая лента объясняет пустоту, а не показывает пустую таблицу', async () => {
    renderHistory({ movements: [], serviceHistory: [] });
    expect(await screen.findByText(/Ни перемещений, ни ремонтов/)).toBeDefined();
  });
});
