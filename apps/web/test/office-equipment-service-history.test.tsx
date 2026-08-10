import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { AuthUser, OfficeEquipmentDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { OfficeEquipmentServiceHistory } from '../src/pages/directories/OfficeEquipmentServiceHistory';

/**
 * Секция «Обслуживание и гарантии» в карточке единицы справочника (§8.2).
 *
 * Проверяется не вёрстка, а разница между двумя «пусто»: секции нет вовсе, если смотрящему не
 * положено видеть заявки (`serviceHistory` не приходит в ответе), и секция есть с надписью
 * «заявок не было», если их правда не было. Слейся эти два случая — менеджер и диспетчер, которые
 * ведут справочник, но ремонтом не занимаются, увидели бы раздел про суммы чужих заявок.
 */

function equipmentDto(overrides: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'ty-1', name: 'МФУ', isActive: true },
    name: 'Kyocera M3145',
    serialNumber: 'SN-1',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    department: null,
    location: 'каб. 12',
    purchasedOn: '2025-03-01',
    warrantyUntil: '2027-03-01',
    comment: '',
    isActive: true,
    createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

function renderSection(dto: OfficeEquipmentDto): HttpMock {
  const http = mockHttp({ 'GET /office-equipment/:id': () => json(dto) });
  renderWithUser(<OfficeEquipmentServiceHistory equipmentId="oe-1" />, { user: OPERATOR });
  return http;
}

describe('история обслуживания в карточке единицы', () => {
  it('показывает заявку, её итог и действующие гарантии ремонта', async () => {
    renderSection(
      equipmentDto({
        serviceHistory: [
          {
            id: 'sr-1',
            displayNumber: 'СО-14',
            status: 'accepted',
            createdAt: '2026-06-01T09:00:00.000Z',
            completedAt: '2026-06-05T09:00:00.000Z',
            serviceName: 'ООО «Сервис-Про»',
            totalAmount: 6200,
            warranties: [
              { itemId: 'it-1', name: 'Замена узла подачи', warrantyUntil: '2026-11-20' },
            ],
          },
        ],
      }),
    );

    expect(await screen.findByText('СО-14')).toBeDefined();
    expect(screen.getByText('Принята')).toBeDefined();
    expect(screen.getByText('ООО «Сервис-Про»')).toBeDefined();
    expect(screen.getByText('Замена узла подачи')).toBeDefined();
  });

  it('пустой список говорит, что ремонтов не было', async () => {
    renderSection(equipmentDto({ serviceHistory: [] }));
    expect(await screen.findByText('Заявок на обслуживание не было')).toBeDefined();
  });

  it('без права модуля секции нет вовсе, а не «ремонтов не было»', async () => {
    const http = renderSection(equipmentDto());
    // Ответ дождаться нужно: до него секции нет и так, и тест не проверял бы ничего. Дальше
    // рисовать уже нечего — поля `serviceHistory` в ответе нет.
    await waitFor(() => expect(http.lastCall('GET /office-equipment/:id')).toBeTruthy());
    expect(screen.queryByText('Обслуживание и гарантии')).toBeNull();
    expect(screen.queryByText('Заявок на обслуживание не было')).toBeNull();
  });
});
