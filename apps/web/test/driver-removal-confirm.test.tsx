import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DriverDto } from '@technic/contracts';
import { DriversTab } from '../src/pages/directories/DriversTab';
import { apiError, json, mockHttp, noContent } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';

/**
 * Подтверждение удаления карточки водителя (ADR 0190, план `machinist-card-removal`, Э3).
 *
 * Проверяется то, ради чего окно и заведено: цена действия названа **до** него — заказами, сроком и
 * числом бланков, — а подтверждают конкретный перечень, а не намерение вообще. Прежде карточку
 * снимали молча, и узнавали об этом на первом же продлении недели: заявка вставала целиком, а
 * объяснить это было нечем.
 *
 * Число листов в окне приходит с сервера посчитанным планом бумаги: недель впереди и бланков —
 * разные числа (в неделе законно живут два листа), и портал его не пересчитывает.
 */

function driver(over: Partial<DriverDto> = {}): DriverDto {
  return {
    id: 'p1',
    lastName: 'Коврова',
    firstName: 'Ольга',
    middleName: 'Ивановна',
    fullName: 'Коврова Ольга Ивановна',
    birthDate: null,
    phone: '',
    email: '',
    snils: '11223344595',
    comment: '',
    personnelNo: '0001',
    jobTitle: 'Машинист экскаватора',
    employedSince: null,
    licenses: [],
    version: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

const admin = authUser({ id: 'user-admin', role: 'admin' });

const ACK_REQUIRED = {
  code: 'driver_removal_ack_required',
  message: 'Карточку ведут 1 заказ(ов) — подтвердите удаление',
  details: {
    fullName: 'Коврова Ольга Ивановна',
    orders: [
      {
        requestId: 'r-1',
        num: 198,
        customer: 'ЖК PRIMAVERA',
        dateFrom: '2026-09-01',
        dateTo: '2026-09-13',
        assumedDateTo: '2026-09-20',
        pendingWeeklyNum: 123,
        futureSheets: 2,
      },
    ],
    futureRouteDays: 0,
    totalFutureSheets: 2,
    fingerprint: 'f'.repeat(64),
  },
};

function mockDirectory(bodies: unknown[]) {
  let answered = false;
  return mockHttp({
    'GET /drivers': () => json(list([driver()])),
    'GET /drivers/license-categories': () => json([]),
    'GET /drivers/job-titles': () => json([]),
    'DELETE /drivers/:id': ({ body }) => {
      bodies.push(body);
      if (answered) return noContent();
      answered = true;
      return apiError(409, ACK_REQUIRED);
    },
  });
}

/** Кнопка удаления строки: подписи у неё нет, поэтому ищем по иконке — она в таблице одна. */
function removeInRow(): HTMLButtonElement {
  const icons = [...document.querySelectorAll('.anticon-delete')];
  const button = icons[0]?.closest('button');
  if (!button) throw new Error(`кнопки удаления нет; иконок найдено: ${icons.length}`);
  return button as HTMLButtonElement;
}

async function confirmModal(text: RegExp | string): Promise<void> {
  const button = await screen.findByRole('button', { name: text });
  fireEvent.click(button);
}

describe('удаление карточки водителя со связями', () => {
  it('показывает заказы и число листов, а подтверждает отпечатком перечня', async () => {
    const bodies: unknown[] = [];
    const http = mockDirectory(bodies);
    renderWithUser(<DriversTab />, { user: admin });

    await screen.findByText('Коврова Ольга Ивановна');
    fireEvent.click(removeInRow());
    // Обычное подтверждение справочника: удаление помечает карточку, а не стирает её.
    await confirmModal(/Удалить/);

    // Сервер ответил перечнем — портал показывает его целиком: номер заказа, продление и бланки.
    const order = await screen.findByText(/ТС-198/);
    expect(order.textContent).toContain('ЖК PRIMAVERA');
    expect(order.textContent).toContain('продление до 20.09.2026');
    expect(order.textContent).toContain('НЗ-123');
    expect(order.textContent).toContain('выпишется ещё 2 листа');

    await confirmModal(/Всё равно удалить/);

    // Второй запрос несёт отпечаток того перечня, который человек прочитал.
    await waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[0]).toBeFalsy();
    expect(bodies[1]).toEqual({ acknowledge: { fingerprint: 'f'.repeat(64) } });
    expect(http.countOf('DELETE /drivers/:id')).toBe(2);
  });
});
