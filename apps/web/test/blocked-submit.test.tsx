import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { vehicleRequest } from './factories/vehicle';
import { VehicleCompleteModal } from '../src/pages/vehicle/VehicleCompleteModal';
import { ServiceAcceptModal } from '../src/features/service-accept/ui/ServiceAcceptModal';

/**
 * Отказ на кнопке называет поле (ADR 0094).
 *
 * Оба окна раньше отвечали тостом в углу: заявка не двигалась, а что именно править — человек
 * искал сам. Проверяется не текст сообщения, а то, где он оказался: причина стоит под своим полем,
 * тоста нет, и действие не ушло на сервер.
 *
 * Окна выбраны разного устройства: у закрытия заявки форма была и до правки, у приёмки работ её
 * не было вовсе — поля жили состоянием окна.
 */

const REQUEST = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  dateFrom: '2026-08-03',
  dateTo: '2026-08-05',
});

/** Причина отказа под полем: её рисует `Form.Item`, а не заголовок и не тост. */
function fieldError(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-form-item-explain-error')?.textContent ?? null;
}

function serviceRequest(overrides: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return {
    id: 'sr-1',
    num: 14,
    displayNumber: 'СО-14',
    // «Ожидает приёмки»: работы предъявлены — из этого статуса их принимают или возвращают.
    status: 'done',
    statusChangedAt: '2026-08-05T09:00:00.000Z',
    waitingOn: 'operator',
    equipment: {
      id: 'oe-1',
      name: 'Kyocera M3145',
      serialNumber: 'SN-1',
      inventoryNumber: '0012345',
      typeName: 'МФУ',
      location: 'Корпус 3, каб. 214',
    },
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    customerDepartment: null,
    equipmentDepartment: null,
    description: 'Не захватывает бумагу',
    dueDate: '2026-08-12',
    responsibleName: 'Иванов И. И.',
    responsiblePhone: '9000000000',
    isUrgent: false,
    urgencyReason: '',
    service: null,
    warrantyClaim: null,
    estimateRevision: 1,
    estimateSubmittedAt: null,
    estimatedTotalAmount: 1000,
    approval: null,
    itApproval: null,
    items: [],
    completion: null,
    acceptedByName: '',
    acceptedAt: null,
    comment: '',
    serviceComment: '',
    files: [],
    createdByName: 'Штабов С. И.',
    createdAt: '2026-08-05T09:00:00.000Z',
    updatedAt: '2026-08-05T09:00:00.000Z',
    deletedAt: null,
    version: 3,
    ...overrides,
  };
}

describe('отказ на кнопке называет поле', () => {
  it('закрытие заявки ТС без отработанного помечает поле, а не показывает тост', async () => {
    mockHttp({ 'GET /vehicle-requests/vr-1/shifts': () => json({ onDate: '', items: [] }) });
    const onSubmit = vi.fn();
    renderWithUser(
      <VehicleCompleteModal
        request={REQUEST}
        confirmLoading={false}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );

    // Ноль — не пустое поле: правило `required` его пропускает, и отвечает на него именно
    // проверка окна («техника не могла отработать нисколько»).
    const worked = await screen.findByLabelText('Отработано смен');
    fireEvent.change(worked, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));

    await waitFor(() =>
      expect(fieldError('Отработано смен')).toBe('Укажите, сколько отработала техника'),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('.ant-message-notice')).toBeNull();
  });

  it('возврат на доработку без причины помечает поле причины', async () => {
    const sent = vi.fn();
    mockHttp({
      'PATCH /service-requests/sr-1/rework': ({ body }) => {
        sent(body);
        return json(serviceRequest());
      },
    });
    renderWithUser(
      <ServiceAcceptModal request={serviceRequest()} mode="rework" onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Вернуть на доработку' }));

    await waitFor(() => expect(fieldError('Что доделать')).toBe('Укажите, что доделать'));
    expect(sent).not.toHaveBeenCalled();
    expect(document.querySelector('.ant-message-notice')).toBeNull();
  });

  it('заполненная причина пропускает возврат на доработку', async () => {
    const sent = vi.fn();
    mockHttp({
      'PATCH /service-requests/sr-1/rework': ({ body }) => {
        sent(body);
        return json(serviceRequest({ status: 'assigned' }));
      },
    });
    renderWithUser(
      <ServiceAcceptModal request={serviceRequest()} mode="rework" onClose={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText('Что доделать'), {
      target: { value: 'не собран корпус' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть на доработку' }));

    await waitFor(() => expect(sent).toHaveBeenCalled());
    expect(sent.mock.calls[0]![0]).toMatchObject({ reason: 'не собран корпус', version: 3 });
  });
});
