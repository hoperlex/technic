import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DeviceRulesBoard } from '../src/features/device-mail-rules';

describe('проба доски правил', () => {
  it('открывает окно нового правила', async () => {
    mockHttp({ 'GET /device-mail/rules': () => json({ items: [] }) });
    renderWithUser(<DeviceRulesBoard />, {
      user: authUser({
        role: 'manager',
        grantPermissions: ['officeEquipment.read', 'officeEquipment.telemetry'],
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    expect(await screen.findByText('Новое правило разбора')).toBeDefined();
    fireEvent.change(await screen.findByPlaceholderText('Например: machine id'), {
      target: { value: 'serial number' },
    });
    expect(screen.getByPlaceholderText('Идентификатор письма из очереди')).toBeDefined();
  });
});
