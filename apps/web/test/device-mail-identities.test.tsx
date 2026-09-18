import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, DeviceIdentityDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import {
  DeviceIdentityRegistry,
  REGISTRY_EMPTY_TEXT,
  REVOKE_CONSEQUENCE,
  TARGETS_PREFIX,
} from '../src/features/device-mail-identities';

/**
 * РЕЕСТР КЛЮЧЕЙ ОПОЗНАНИЯ (план `docs/office-equipment-mail-identity-ui-plan.md`, §7) против
 * замороженных DTO.
 *
 * Проверяется то, ради чего экран написан именно так:
 *
 *   1. СНЯТЫЕ КЛЮЧИ СКРЫТЫ, пока их не попросят: они ничего не опознают, а в общем списке
 *      выглядели бы работающими;
 *   2. ЧИСЛО ЗАТРОНУТЫХ ПИСЕМ ПРИХОДИТ С СЕРВЕРА и показывается ДО подтверждения: посчитать его
 *      здесь нечем — пачка ищется по снимкам всех накопленных писем;
 *   3. СНЯТИЕ НАЗЫВАЕТ ПОСЛЕДСТВИЕ И ТРЕБУЕТ ПРИЧИНЫ: записанные показания оно не откатывает, и
 *      человек, ожидавший отката, должен узнать об этом в окне, а не через неделю по счётчику;
 *   4. ОТКАЗ СЕРВЕРА ДОЕЗЖАЕТ СЛОВАМИ: «ключ уже ведёт к другому аппарату» — ответ на то, что
 *      человек ввёл, и прятать его за общим «ошибка» нельзя.
 */

const REVIEWER: AuthUser = authUser({
  role: 'manager',
  grantPermissions: ['officeEquipment.read', 'officeEquipment.telemetry'],
});

function identity(over: Partial<DeviceIdentityDto> = {}): DeviceIdentityDto {
  return {
    id: 'key-1',
    kind: 'serial',
    value: 'W512P900123',
    equipmentId: 'eq-1',
    equipmentTitle: 'Ricoh Aficio MP C2011SP · инв. 3282',
    equipmentInventoryNumber: '3282',
    objectName: 'Площадка «Заречная»',
    confirmedByName: 'Иванов И. И.',
    confirmedAt: '2026-09-18T06:00:00.000Z',
    note: 'по табличке на корпусе',
    revokedAt: null,
    revokedByName: '',
    revokeNote: '',
    ...over,
  };
}

const page = (items: DeviceIdentityDto[]) => json({ items, hasMore: false, nextCursor: null });

function renderRegistry(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /device-mail/identities': () => page([identity()]),
    'GET /office-equipment': () => json({ items: [], total: 0, page: 1, pageSize: 20 }),
    ...over,
  });
  renderWithUser(<DeviceIdentityRegistry />, { user: REVIEWER });
  return http;
}

describe('реестр ключей опознания', () => {
  it('показывает ключ, аппарат и автора', async () => {
    renderRegistry();
    expect(await screen.findByText('W512P900123')).toBeDefined();
    expect(screen.getByText('Ricoh Aficio MP C2011SP · инв. 3282')).toBeDefined();
    expect(screen.getByText(/Иванов И. И./)).toBeDefined();
    expect(screen.getByText('Опознаёт')).toBeDefined();
  });

  it('пустой реестр говорит, что делать, а не «данных нет»', async () => {
    renderRegistry({ 'GET /device-mail/identities': () => page([]) });
    expect(await screen.findByText(REGISTRY_EMPTY_TEXT)).toBeDefined();
  });

  it('снятые ключи спрашиваются отдельно и показывают причину', async () => {
    const http = renderRegistry({
      'GET /device-mail/identities': (req) =>
        req.query.get('includeRevoked') === 'true'
          ? page([
              identity({
                revokedAt: '2026-09-18T08:00:00.000Z',
                revokedByName: 'Петров П. П.',
                revokeNote: 'аппарат списан',
              }),
            ])
          : page([]),
    });

    expect(await screen.findByText(REGISTRY_EMPTY_TEXT)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Показывать снятые' }));
    expect(await screen.findByText(/аппарат списан/)).toBeDefined();
    // У снятой строки действий нет: применять и снимать нечего.
    expect(screen.queryByRole('button', { name: 'Снять' })).toBeNull();
    expect(http.countOf('GET /device-mail/identities')).toBeGreaterThan(1);
  });

  it('окно снятия называет последствие и требует причину', async () => {
    const http = renderRegistry();
    fireEvent.click(await screen.findByRole('button', { name: 'Снять' }));
    expect(await screen.findByText(REVOKE_CONSEQUENCE)).toBeDefined();

    // Пустая причина не отправляется: снятая строка без объяснения объясняет ровно ничего. Кнопок
    // с этим именем теперь две — в строке и в окне; нажимается та, что в окне (последняя).
    fireEvent.click(screen.getAllByRole('button', { name: 'Снять' }).at(-1)!);
    await waitFor(() => expect(screen.getByText(/Назовите причину/)).toBeDefined());
    expect(http.countOf('POST /device-mail/identities/key-1/revoke')).toBe(0);
  });

  it('отказ сервера доезжает словами', async () => {
    renderRegistry({
      'POST /device-mail/identities/key-1/apply': () =>
        apiError(422, {
          code: 'unprocessable_entity',
          message: 'Снятая привязка ничего не применяет — заведите ключ заново',
        }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Применить к очереди' }));
    expect(await screen.findByText(/Снятая привязка ничего не применяет/)).toBeDefined();
  });
});

describe('окно «Добавить ключ»', () => {
  it('показывает, сколько писем подберёт ключ, и считает это сервер', async () => {
    const http = renderRegistry({
      'GET /device-mail/identities/targets': () => json({ messages: 7, batch: true }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Добавить ключ' }));
    const value = await screen.findByPlaceholderText(/Серийный номер или имя устройства/);
    fireEvent.change(value, { target: { value: 'W512P900777' } });

    expect(await screen.findByText(`${TARGETS_PREFIX}7`)).toBeDefined();
    expect(screen.getByText('Все они применятся к этой карточке сразу')).toBeDefined();
    const asked = http.lastCall('GET /device-mail/identities/targets');
    expect(asked?.query.get('kind')).toBe('serial');
    expect(asked?.query.get('value')).toBe('W512P900777');
  });
});
