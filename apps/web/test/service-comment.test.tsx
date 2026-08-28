import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { heldServiceRequest, serviceExecutor, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * «Примечания исполнителя» в портале больше нет: его заменило обсуждение (ADR 0141, решение 1).
 *
 * Файл переписан целиком и оставлен на месте намеренно — он сторожит именно **снятие**. Заменить
 * одно другим мало: два места для одного текста означали бы вопрос «а где написать» у каждого, кто
 * открыл заявку, и два расходящихся ответа на «что сказал сервис». Поэтому проверяется, что окна
 * нет, пункта нет и строки в карточке нет, — а не то, что рядом появилось обсуждение (это дело
 * `service-chat.test.tsx`).
 *
 * Поле `serviceComment` при этом **живо в DTO и на сервере**: ручка-адаптер работает до выпуска C
 * (§3.10 плана) — старый бандл в браузере продолжает её звать, и снимать её вместе с окном нельзя.
 * Отсюда главный сценарий файла: непустое значение приходит, а карточка его не показывает.
 */

const EXECUTOR: AuthUser = serviceExecutor();

function renderTab(
  items: ServiceRequestDto[],
  over: RouteMap = {},
  user: AuthUser = EXECUTOR,
): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
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
  renderWithUser(<RequestsTab />, { user });
  return http;
}

/** Подписи пунктов меню строки: на десктопе оно за кнопкой «Действия». */
async function rowActionLabels(): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  const menu = await waitFor(() => {
    const found = document.querySelector('.ant-dropdown-menu');
    if (!found) throw new Error('меню действий не открылось');
    return found;
  });
  return [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map(
    (el) => el.textContent ?? '',
  );
}

describe('окна «Примечание исполнителя» больше нет', () => {
  it('в меню строки его место занято обсуждением', async () => {
    renderTab([serviceRequest({ status: 'in_work', serviceComment: 'ждём поставку' })]);
    await screen.findByText('СО-14');

    const labels = await rowActionLabels();
    expect(labels).not.toContain('Примечание исполнителя');
    expect(labels).toContain('Обсуждение');
  });

  it('у отложенной заявки — то же: писать туда по-прежнему надо, но уже репликой (Р110)', async () => {
    renderTab([heldServiceRequest('in_work')]);
    await screen.findByText('СО-14');

    const labels = await rowActionLabels();
    expect(labels).not.toContain('Примечание исполнителя');
    expect(labels).toContain('Обсуждение');
  });

  it('у закрытой заявки обсуждение остаётся, хотя примечания там не было вовсе', async () => {
    // Прежний пункт у принятой заявки исчезал: сервер отвечал на запись отказом. Лента же
    // замерзает, а не прячется — читать спор с подрядчиком после приёмки и надо (решение 3 ADR).
    renderTab([serviceRequest({ status: 'accepted' })], {}, authUser({ role: 'admin' }));
    await screen.findByText('СО-14');

    expect(await rowActionLabels()).toContain('Обсуждение');
  });
});

describe('карточка не показывает примечание, даже когда оно пришло с сервера', () => {
  it('непустое `serviceComment` строкой не выводится: поле живёт адаптером, а не интерфейсом', async () => {
    const http = renderTab([
      serviceRequest({ status: 'in_work', serviceComment: 'ждём поставку' }),
    ]);
    fireEvent.click(await screen.findByText('СО-14'));

    const card = await waitFor(() => {
      const wrap = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
        .filter((el) => el.style.display !== 'none')
        .find((el) => el.querySelector('.ant-modal-title')?.textContent === 'Заявка СО-14');
      if (!wrap) throw new Error('карточка не открылась');
      return within(wrap);
    });

    // Ни подписи поля, ни его значения: иначе «что сказал сервис» отвечалось бы из двух мест.
    expect(card.queryByText('Примечание исполнителя')).toBeNull();
    expect(card.queryByText('ждём поставку')).toBeNull();
    // «Комментарий» заявителя остался: он не реплика, а часть постановки задачи (решение 1 ADR).
    expect(card.getByText('Комментарий')).toBeDefined();
    // И самой ручки портал не зовёт больше нигде: она дожидается выпуска C ради старого бандла.
    expect(http.countOf('PATCH /service-requests/:id/service-comment')).toBe(0);
  });
});
