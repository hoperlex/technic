import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { serviceOperator, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { serviceRepeatQuery } from '../src/pages/service/serviceRequestRepeat';

/**
 * Признак повторного обращения по аппарату (план `docs/office-equipment-repeat-request-plan.md`,
 * Э3): тег у номера, тот же тег в карточке на телефоне, строка карточки со ссылкой и отбор
 * «Только повторные».
 *
 * ГЛАВНОЕ, ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, — ЧТО ПОРТАЛ ЧИТАЕТ ПРИЗНАК, А НЕ СЧИТАЕТ ЕГО САМ. Поэтому
 * фикстуры описывают ответ сервера целиком: окно у каждой строки своё, а совпадения считаются в
 * области смотрящего (Р8) — собери портал «похожий» отбор из аппарата и статусов, он показал бы не
 * то число, которое человек только что видел в теге, и тест этого не заметил бы.
 *
 * СОСТОЯНИЙ ТРИ, И РАЗВЕДЕНЫ ОНИ НАМЕРЕННО: признака нет вовсе (окно выключено настройкой),
 * `count: 0` («считали, повторов нет») и `count > 0`. Тега нет в первых двух, а вот отбор при нуле
 * работать обязан — слейся эти два случая, портал прятал бы работающий отбор либо предлагал
 * выключенный.
 */

const OPERATOR: AuthUser = serviceOperator();

/** По аппарату уже закрывали две заявки за окно в 30 дней; последняя — 12.08.2026. */
const repeated = (over: Partial<ServiceRequestDto> = {}): ServiceRequestDto =>
  serviceRequest({
    repeat: { count: 2, windowDays: 30, lastAt: '2026-08-12T09:00:00.000Z' },
    ...over,
  });

function renderTab(items: ServiceRequestDto[], viewport?: Viewport, over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    // Статический путь описан раньше `:id` — иначе шаблон с параметром перехватил бы и его.
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    // Карточка спрашивает заявку сама, строкой списка лишь рисуясь, пока едет свежая.
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user: OPERATOR, viewport });
  return http;
}

describe('тег «Повтор ×N» в списке', () => {
  it('стоит у номера и подсказкой называет период, за который считали', async () => {
    renderTab([repeated()]);

    const tag = await screen.findByText(/Повтор ×2/);
    /*
     * Подсказка проверяется вместе с тегом, а не отдельно: «Повтор ×2» без периода — утверждение,
     * которому нечего предъявить, а по нему решают, звать ли подрядчика на разговор. Текст назван
     * целиком и потому сторожит и слова: подсказка обещает ЗАКРЫТЫЕ ЗАЯВКИ ПО АППАРАТУ, а не
     * «повторную поломку» — о том, то же ли сломалось, признак не знает вовсе (§12 плана).
     */
    fireEvent.mouseEnter(tag);
    expect(await screen.findByText('2 закрытые заявки по аппарату за 30 дней')).toBeDefined();
  });

  it('повторов не нашли — тега нет, но отбор остаётся: признак работает', async () => {
    renderTab([serviceRequest({ repeat: { count: 0, windowDays: 30, lastAt: null } })]);
    await screen.findByText('СО-14');

    expect(screen.queryByText(/Повтор/)).toBeNull();
    // Ноль — это «считали, не нашли», и отбирать повторные по всему списку человеку можно.
    expect(screen.getByLabelText('Только повторные')).toBeDefined();
  });

  it('признак выключен — ни тега, ни отбора', async () => {
    // Поля `repeat` в строке нет вовсе: окно выключено настройкой (`W = 0`), заявка на расходники
    // либо заявка без аппарата. Отличить это от нуля портал обязан — состояния разные.
    renderTab([serviceRequest()]);
    await screen.findByText('СО-14');

    expect(screen.queryByText(/Повтор/)).toBeNull();
    expect(screen.queryByLabelText('Только повторные')).toBeNull();
    // Панель отборов при этом на месте: пропал именно отбор повторов, а не шапка целиком.
    expect(screen.getByLabelText('Только срочные')).toBeDefined();
  });

  it('на телефоне тот же тег стоит в бейджах карточки списка', async () => {
    renderTab([repeated()], MOBILE_VIEWPORT);
    await screen.findByText('СО-14');

    // Таблицы на телефоне нет вовсе (ADR 0030): найденный тег виден именно в карточке.
    expect(document.querySelector('.ant-table')).toBeNull();
    expect(screen.getByText(/Повтор ×2/)).toBeDefined();
  });
});

describe('отбор «Только повторные»', () => {
  it('уходит на сервер признаком', async () => {
    const http = renderTab([repeated()]);
    await screen.findByText('СО-14');

    fireEvent.click(screen.getByLabelText('Только повторные'));

    // Отбор уходит параметром, а не собирается порталом из аппарата и статусов: правило одно, и
    // живёт оно на сервере (`serviceRequestRepeatWhere`).
    await waitFor(() =>
      expect(http.lastCall('GET /service-requests')?.query.get('repeat')).toBe('true'),
    );
  });
});

describe('ссылка «Показать предыдущие» из карточки', () => {
  /** Открыть карточку так, как её открывает человек: нажатием по строке списка. */
  const openCard = async (): Promise<void> => {
    fireEvent.click(await screen.findByText('СО-14'));
    await screen.findByText('Повторное обращение');
  };

  it('уводит в список с одним `repeatFor` — прежний отбор снят', async () => {
    const http = renderTab([repeated()]);
    await screen.findByText('СО-14');

    /*
     * Отбор выставлен ЗАРАНЕЕ, и это суть случая: списки помнят набор между сеансами (ADR 0139),
     * поэтому человек приходит к ссылке не с чистым списком. Останься отбор — сервер ответил бы
     * 422 (`repeatFor` не сочетается ни с чем), а стерпи он его, список не совпал бы с числом в
     * теге, и «Повтор ×2» читалось бы как враньё портала.
     */
    fireEvent.click(screen.getByLabelText('Только срочные'));
    await waitFor(() =>
      expect(http.lastCall('GET /service-requests')?.query.get('urgent')).toBe('true'),
    );

    await openCard();
    const link = screen.getByText('Показать предыдущие');
    // Настоящая ссылка с адресом, а не кнопка: список предыдущих открывают и соседней вкладкой,
    // чтобы не терять карточку, из которой пришли.
    expect(link.getAttribute('href')).toBe('/office-equipment?tab=requests&repeatFor=sr-1');

    fireEvent.click(link);

    await waitFor(() => {
      const last = http.lastCall('GET /service-requests');
      expect(last?.query.get('repeatFor')).toBe('sr-1');
      expect(last?.query.get('urgent')).toBeNull();
    });
    // Единственный предметный параметр — сам режим: ни одного отбора рядом с ним не уехало.
    const last = http.lastCall('GET /service-requests');
    expect(last?.query.get('search')).toBeNull();
    expect(last?.query.get('status')).toBeNull();
    expect(last?.query.get('page')).toBe('1');
  });

  it('в режиме «предыдущие» отборов и очередей на экране нет, а выход из него — назван', async () => {
    renderTab([repeated()]);
    await screen.findByText('СО-14');
    await openCard();

    fireEvent.click(screen.getByText('Показать предыдущие'));

    // Плашка объясняет, почему список неполон: список, у которого молча пропала половина шапки,
    // читается как поломка.
    expect(await screen.findByText('Предыдущие заявки по аппарату')).toBeDefined();
    /*
     * Отборы и очереди убраны не для красоты: сервер их рядом с `repeatFor` не принимает, а
     * «Отметить все прочитанными» применяет набор БЕЗ режима — она погасила бы не то, что видно, а
     * всю область читателя.
     */
    expect(screen.queryByLabelText('Только срочные')).toBeNull();
    expect(screen.queryByText('Отметить все прочитанными')).toBeNull();
  });

  it('«Показать все заявки» возвращает обычный список', async () => {
    const http = renderTab([repeated()]);
    await screen.findByText('СО-14');
    await openCard();
    fireEvent.click(screen.getByText('Показать предыдущие'));
    await waitFor(() =>
      expect(http.lastCall('GET /service-requests')?.query.get('repeatFor')).toBe('sr-1'),
    );

    fireEvent.click(screen.getByText('Показать все заявки'));

    await waitFor(() =>
      expect(http.lastCall('GET /service-requests')?.query.get('repeatFor')).toBeNull(),
    );
    // Шапка вернулась целиком: режим кончился, а не остался наполовину.
    expect(screen.getByLabelText('Только срочные')).toBeDefined();
  });
});

/**
 * Сочетание режима с отбором сервер встречает отказом (422), и портал обязан до него не доводить.
 *
 * Проверка стоит на самой сборке запроса, а не на экране, потому что дверей к отбору больше, чем
 * панель фильтров: строка поиска на телефоне и лупа столбца остаются на месте и в режиме. Правило
 * одно и живёт в одном месте — сюда же и предъявлено.
 */
describe('режим «предыдущие» и отбор не встречаются в одном запросе', () => {
  const base = { page: 1, pageSize: 20, sortOrder: 'asc' as const, repeatFor: 'sr-1' };

  it('один — уходит; вместе с поиском или отбором режим уступает', () => {
    expect(serviceRepeatQuery({ ...base }).repeatFor).toBe('sr-1');
    // Набранный поиск важнее: человек просил найти, а не показать предыдущие.
    expect(serviceRepeatQuery({ ...base, search: 'Kyocera' }).repeatFor).toBeUndefined();
    expect(serviceRepeatQuery({ ...base, urgent: 'true' }).repeatFor).toBeUndefined();
    // Снятый отбор режима не воскрешает — параметр к тому времени убран и из состояния списка.
    expect(serviceRepeatQuery({ ...base, urgent: undefined }).repeatFor).toBe('sr-1');
  });
});
