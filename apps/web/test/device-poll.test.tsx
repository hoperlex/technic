import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, DevicePollAttemptDto, DevicePollTargetDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DevicePollBoard, NO_ATTEMPT_TEXT, POLL_EMPTY_TEXT } from '../src/features/device-poll';

/**
 * ОПРОС ПО СЕТИ (решение `docs/adr/0205-device-network-poll.md`) против замороженных DTO.
 *
 * Проверяется то, ради чего экран написан именно так:
 *
 *   1. КАРТОЧКА ГОВОРИТ ДО НАЖАТИЯ, ЧТО БУДЕТ ПОСЛЕ: адрес, ожидаемый серийник и есть ли карточка
 *      аппарата. Без последнего человек нажимает и получает «записывать некуда» — уже постфактум;
 *   2. СНЯТОЕ ЧИСЛО ВИДНО С ЕДИНИЦЕЙ: «97 011» без «оттисков» не значит ничего, а листы и оттиски
 *      — разные величины;
 *   3. ЧИСЛО, КОТОРОЕ НЕ ЗАПИСАНО, ПОМЕЧЕНО ПРЯМО ПОД НИМ: иначе «Снято» читается как «в
 *      показаниях есть»;
 *   4. МОЛЧАНИЕ СЕТИ — ЭТО ОТВЕТ, А НЕ ПУСТОТА: исход и совет («проверьте маршрут») показываются
 *      тем же местом, что и удачное число;
 *   5. ПУСТОЙ СПИСОК ЦЕЛЕЙ ОБЪЯСНЯЕТ СЕБЯ: цели живут в настройке окружения, и человек, открывший
 *      вкладку, должен узнать об этом здесь, а не в чужой документации;
 *   6. ОТКАЗ СЕРВЕРА ДОЕЗЖАЕТ СЛОВАМИ и не выдаёт себя за успешный опрос.
 */

const OPERATOR: AuthUser = authUser({
  role: 'manager',
  grantPermissions: ['officeEquipment.read', 'officeEquipment.telemetry'],
});

function attempt(over: Partial<DevicePollAttemptDto> = {}): DevicePollAttemptDto {
  return {
    id: 'attempt-1',
    startedAt: '2026-09-22T06:00:00.000Z',
    durationMs: 42,
    outcome: 'ok',
    message: 'Снято: 97011',
    sysDescr: 'RICOH MP C2011SP',
    sysName: 'ricoh-priemnaya',
    deviceSerial: 'Y505P400123',
    metricCode: 'marker_life_total',
    value: 97_011,
    unit: 'impressions',
    requestedBy: 'Иванов И. И.',
    ...over,
  };
}

function target(over: Partial<DevicePollTargetDto> = {}): DevicePollTargetDto {
  return {
    key: 'ricoh',
    label: 'RICOH, приёмная',
    address: '192.168.5.71:161',
    expectedSerial: 'Y505P400123',
    equipment: { id: 'eq-1', title: 'Ricoh MP C2011SP · инв. ИНВ-1' },
    lastAttempt: null,
    ...over,
  };
}

/**
 * Область поиска — сама карточка цели.
 *
 * Иначе поиск берёт ПЕРВОЕ совпадение по документу, а тот же текст показывает всплывающее
 * сообщение antd: тест на «что осталось на карточке» проходил бы на тосте, который через секунду
 * исчезнет.
 */
function cardOf(label: string) {
  const title = screen.getByText(label);
  return within(title.closest('.ant-card') as HTMLElement);
}

function renderBoard(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /device-poll/targets': () => json({ items: [target()] }),
    'POST /device-poll/targets/:key/poll': () => json(target({ lastAttempt: attempt() })),
    ...over,
  });
  renderWithUser(<DevicePollBoard />, { user: OPERATOR });
  return http;
}

describe('опрос аппаратов по сети', () => {
  it('показывает адрес, ожидаемый серийник и карточку аппарата', async () => {
    renderBoard();

    expect(await screen.findByText('RICOH, приёмная')).toBeDefined();
    expect(screen.getByText('192.168.5.71:161')).toBeDefined();
    expect(screen.getByText('Ricoh MP C2011SP · инв. ИНВ-1')).toBeDefined();
    expect(screen.getByText(NO_ATTEMPT_TEXT)).toBeDefined();
  });

  it('предупреждает до нажатия, что писать показание некуда', async () => {
    renderBoard({
      'GET /device-poll/targets': () => json({ items: [target({ equipment: null })] }),
    });

    expect(await screen.findByText(/не найдена — показание записывать некуда/)).toBeDefined();
  });

  it('по нажатию опрашивает и показывает число с единицей', async () => {
    const http = renderBoard();

    fireEvent.click(await screen.findByRole('button', { name: 'Получить данные' }));

    expect(await screen.findByText('97 011')).toBeDefined();
    expect(screen.getByText(/оттисков · Общий счётчик/)).toBeDefined();
    expect(screen.getByText('Снято')).toBeDefined();
    // Кто ответил — видно на карточке: по этой строке ловят «на адресе не тот аппарат».
    expect(screen.getByText('RICOH MP C2011SP')).toBeDefined();
    expect(http.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      'POST /device-poll/targets/ricoh/poll',
    );
  });

  /**
   * Снято, но в ряд наработки не попало. Число при этом показывается — прятать его нечестно, —
   * поэтому рядом обязана стоять оговорка: без неё «Снято» читается как «показание есть».
   */
  it('помечает снятое число, которое не записано', async () => {
    renderBoard({
      'POST /device-poll/targets/:key/poll': () =>
        json(
          target({
            equipment: null,
            lastAttempt: attempt({
              outcome: 'no_equipment',
              message: 'Снято: 97011. Карточки с серийным номером «Y505P400123» нет',
            }),
          }),
        ),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Получить данные' }));

    expect(await screen.findByText('Снято, карточка не найдена')).toBeDefined();
    expect(screen.getByText('в показания не записано')).toBeDefined();
  });

  it('молчание сети показывает исходом и советом, а не пустотой', async () => {
    renderBoard({
      'POST /device-poll/targets/:key/poll': () =>
        json(
          target({
            lastAttempt: attempt({
              outcome: 'no_answer',
              message: '192.168.5.71:161 не ответил. Проверьте маршрут до сети аппарата',
              sysDescr: '',
              sysName: '',
              deviceSerial: '',
              metricCode: null,
              value: null,
              unit: null,
            }),
          }),
        ),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Получить данные' }));

    expect(await screen.findByText('Нет ответа')).toBeDefined();
    expect(cardOf('RICOH, приёмная').getByText(/Проверьте маршрут/)).toBeDefined();
  });

  it('пустой список целей объясняет, где они заводятся', async () => {
    renderBoard({ 'GET /device-poll/targets': () => json({ items: [] }) });
    expect(await screen.findByText(POLL_EMPTY_TEXT)).toBeDefined();
  });

  it('отказ сервера доезжает словами', async () => {
    renderBoard({
      'POST /device-poll/targets/:key/poll': () =>
        apiError(409, { code: 'poll_in_progress', message: 'Опрос этой цели уже идёт' }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Получить данные' }));

    await waitFor(() => expect(screen.getByText('Опрос этой цели уже идёт')).toBeDefined());
    // Неудавшийся опрос не оставляет на карточке вида, будто что-то снято.
    expect(screen.getByText(NO_ATTEMPT_TEXT)).toBeDefined();
  });
});
