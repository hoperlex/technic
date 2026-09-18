import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, DeviceParseRuleDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DeviceRulesBoard, RULES_EMPTY_TEXT } from '../src/features/device-mail-rules';

/**
 * ПРАВИЛА РАЗБОРА (план `docs/office-equipment-mail-identity-ui-plan.md`, §6.2) против замороженных
 * DTO.
 *
 * Проверяется то, ради чего экран написан именно так:
 *
 *   1. ПУСТОЙ СПИСОК — НОРМА, и подпись это говорит: правило заводят под формат, который портал не
 *      понял, и до первого такого письма правил не бывает;
 *   2. УДАЛЕНИЕ ПОКАЗЫВАЕТСЯ ТОЛЬКО ТАМ, ГДЕ ОНО ЗАКОННО (`canDelete` с сервера): по правилу, при
 *      жизни которого разбирали письма, кнопка обещала бы то, чем сервер ответит отказом;
 *   3. ПРОВЕРКА НА ПИСЬМЕ НИЧЕГО НЕ СОХРАНЯЕТ и показывает, ЧТО ИМЕННО вынулось: ради этого она и
 *      стоит в форме — ошибку в правиле метрики иначе заметить некому;
 *   4. ОТКАЗ ПО ВЫРАЖЕНИЮ ДОЕЗЖАЕТ СЛОВАМИ: опасное выражение правит человек, и «ошибка» вместо
 *      причины оставила бы его без единственной подсказки.
 */

const REVIEWER: AuthUser = authUser({
  role: 'manager',
  grantPermissions: ['officeEquipment.read', 'officeEquipment.telemetry'],
});

function rule(over: Partial<DeviceParseRuleDto> = {}): DeviceParseRuleDto {
  return {
    id: 'rule-1',
    target: 'identity',
    keyKind: 'serial',
    metricCode: null,
    component: null,
    valueForm: null,
    matchKind: 'label',
    expression: 'machine id',
    scope: 'any',
    whenProfile: null,
    whenFrom: '',
    whenSubject: '',
    sortOrder: 100,
    isEnabled: true,
    updatedAt: '2026-09-18T06:00:00.000Z',
    updatedByName: 'Иванов И. И.',
    canDelete: true,
    ...over,
  };
}

function renderBoard(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /device-mail/rules': () => json({ items: [rule()] }),
    ...over,
  });
  renderWithUser(<DeviceRulesBoard />, { user: REVIEWER });
  return http;
}

describe('правила разбора', () => {
  it('показывает, что правило достаёт и чем ищет', async () => {
    renderBoard();
    expect(await screen.findByText('Серийный номер')).toBeDefined();
    expect(screen.getByText('machine id')).toBeDefined();
    expect(screen.getByText(/Метка перед значением/)).toBeDefined();
    expect(screen.getByText('к любому письму')).toBeDefined();
    expect(screen.getByText('Применяется')).toBeDefined();
  });

  it('пустой список объясняет, что это норма', async () => {
    renderBoard({ 'GET /device-mail/rules': () => json({ items: [] }) });
    expect(await screen.findByText(RULES_EMPTY_TEXT)).toBeDefined();
  });

  it('удаление предлагается только там, где сервер его разрешил', async () => {
    renderBoard({ 'GET /device-mail/rules': () => json({ items: [rule({ canDelete: false })] }) });
    expect(await screen.findByRole('button', { name: 'Изменить' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();
  });

  it('проверка на письме ничего не сохраняет и называет найденное', async () => {
    const http = renderBoard({
      'POST /device-mail/rules/preview': () =>
        json({
          applies: true,
          found: true,
          rawValue: 'W512P900123',
          value: 'W512P900123',
          unitLabel: '',
          resolution: { status: 'matched', equipmentId: 'eq-1', equipmentTitle: 'Ricoh · инв. 3282' },
          note: 'С этим ключом письмо опознаёт аппарат: Ricoh · инв. 3282',
        }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    fireEvent.change(await screen.findByPlaceholderText('Например: machine id'), {
      target: { value: 'serial number' },
    });
    fireEvent.change(screen.getByPlaceholderText('Идентификатор письма из очереди'), {
      target: { value: '11111111-1111-1111-1111-111111111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText(/Нашлось: W512P900123/)).toBeDefined();
    expect(screen.getByText(/опознаёт аппарат/)).toBeDefined();
    // Проверка не пишет: ни создания, ни правки не ушло.
    expect(http.countOf('POST /device-mail/rules')).toBe(0);
    expect(http.lastCall('POST /device-mail/rules/preview')?.body).toMatchObject({
      rule: { target: 'identity', keyKind: 'serial', expression: 'serial number' },
    });
  });

  it('отказ по опасному выражению доезжает словами', async () => {
    renderBoard({
      'POST /device-mail/rules': () =>
        apiError(422, {
          code: 'unprocessable_entity',
          message: 'повтор навешен на группу, которая сама повторяется, — такое выражение вешает разбор',
        }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    fireEvent.change(await screen.findByPlaceholderText('Например: machine id'), {
      target: { value: '(a+)+$' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(screen.getByText(/вешает разбор/)).toBeDefined());
  });
});
