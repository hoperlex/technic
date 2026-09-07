import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import {
  equipmentRequestOutcomeLabels,
  type AuthUser,
  type EquipmentRequestRowDto,
  type OfficeEquipmentDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { OfficeEquipmentServiceHistory } from '../src/pages/directories/OfficeEquipmentServiceHistory';

/**
 * Секция «Обслуживание и гарантии» в карточке единицы справочника (§8.2) — первые строки блока
 * «Связанные заявки» (план `docs/office-equipment-history-blocks-plan.md`, Р7).
 *
 * Проверяется не вёрстка, а разница между двумя «пусто»: секции нет вовсе, если смотрящему не
 * положено видеть заявки (без `serviceRequests.read` ручка блока отвечает `403`), и секция есть с
 * надписью «заявок не было», если их правда не было. Слейся эти два случая — менеджер и
 * диспетчер, которые ведут справочник, но ремонтом не занимаются, увидели бы раздел про суммы
 * чужих заявок.
 *
 * Источник строк с этого плана один на секцию и на вкладку окна (К7): раньше секция читала срез
 * `serviceHistory` ответа карточки — последние десять без ответа «а было ли больше» (Н1).
 */

function equipmentDto(overrides: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'ty-1', name: 'МФУ', isActive: true },
    specs: [],
    name: 'Kyocera M3145',
    serialNumber: 'SN-1',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    department: null,
    location: 'каб. 12',
    state: 'on_site',
    stateNote: '',
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

/** Набор «Оргтехника: ведение» даёт оба права: и справочник, и заявки по нему. */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

/** Справочник открыт, модуль обслуживания — нет: так живут менеджер и диспетчер. */
const NO_SERVICE: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: ['officeEquipment.read'],
});

function renderSection(rows: EquipmentRequestRowDto[], user: AuthUser = OPERATOR): HttpMock {
  const http = mockHttp({
    'GET /office-equipment/:id': () => json(equipmentDto()),
    'GET /office-equipment/:id/requests': () =>
      json({ items: rows, hasMore: false, nextCursor: null }),
  });
  renderWithUser(<OfficeEquipmentServiceHistory equipmentId="oe-1" />, { user });
  return http;
}

describe('история обслуживания в карточке единицы', () => {
  it('показывает заявку, её итог и действующие гарантии ремонта', async () => {
    renderSection([
      {
        id: 'sr-1',
        displayNumber: 'СО-14',
        kind: 'repair',
        summary: 'Не печатает',
        executors: ['ООО «Сервис-Про»'],
        createdAt: '2026-06-01T09:00:00.000Z',
        updatedAt: '2026-06-05T09:00:00.000Z',
        status: 'accepted',
        outcome: { code: 'accepted', label: equipmentRequestOutcomeLabels.accepted },
        totalAmount: 6200,
        warranties: [{ itemId: 'it-1', name: 'Замена узла подачи', warrantyUntil: '2026-11-20' }],
        objectMismatch: false,
      },
    ]);

    expect(await screen.findByText('СО-14')).toBeDefined();
    // «Принята» → «Закрыта» (Н2): единый словарь статусов на оба вида заявок.
    expect(screen.getByText('Закрыта')).toBeDefined();
    expect(screen.getByText('ООО «Сервис-Про»')).toBeDefined();
    expect(screen.getByText('Замена узла подачи')).toBeDefined();
    // Итог — нефинансовым словом рядом с суммой, а не вместо неё (Н12).
    expect(screen.getByText(equipmentRequestOutcomeLabels.accepted)).toBeDefined();
  });

  it('пустой список говорит, что ремонтов не было', async () => {
    renderSection([]);
    expect(
      await screen.findByText(/Заявок на обслуживание по этому аппарату не было/),
    ).toBeDefined();
  });

  it('без права на заявки секции нет вовсе, а не «ремонтов не было»', async () => {
    const http = renderSection([], NO_SERVICE);
    // Блок такому читателю не спрашивается вовсе: ручка ответила бы `403`, и рисовать нечего.
    await waitFor(() => expect(http.countOf('GET /office-equipment/:id/requests')).toBe(0));
    expect(screen.queryByText('Обслуживание и гарантии')).toBeNull();
    expect(screen.queryByText(/Заявок на обслуживание/)).toBeNull();
  });
});
