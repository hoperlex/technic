import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { heldServiceRequest, serviceOperator, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { ServiceHoldModal } from '@features/service-hold';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Заморозка заявки на обслуживание (Р103–Р110): «Отложена» с причиной и возврат туда, откуда
 * отложили.
 *
 * Проверяется то, что расходится молча. Причина — единственное содержание заморозки (Р107): даты
 * «отложена до» у неё нет, и окно, отпустившее пустую причину, оставило бы в списке «Отложена ·
 * 12 дней», по которым не понять, ждут запчасть или решение. Цель возврата не выбирают, а
 * показывают (Р104): дуга назад одна, и обещать её словами, не назвав статус, значило бы обещать
 * неизвестно что. А меню отложенной обязано совпадать с тем, что примет сервер (Р110), — иначе
 * портал предлагает правку и срочность там, где придёт отказ.
 */

const OPERATOR: AuthUser = serviceOperator();

/** Отложенная из «Диагностики»: вернётся она ровно туда, и другого пути назад нет (Р104). */
const HELD = heldServiceRequest('diagnostics');

/** Причина отказа под полем: её рисует `Form.Item`, а не заголовок и не тост (ADR 0094). */
function fieldError(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-form-item-explain-error')?.textContent ?? null;
}

function renderHold(mode: 'hold' | 'resume', request = HELD, routes: RouteMap = {}) {
  const http = mockHttp(routes);
  const onClose = vi.fn();
  renderWithUser(<ServiceHoldModal request={request} mode={mode} onClose={onClose} />, {
    user: OPERATOR,
  });
  return { http, onClose };
}

describe('окно «Отложить» требует причину (Р107)', () => {
  it('пустая причина помечает поле, а на сервер ничего не уходит', async () => {
    const { http } = renderHold('hold', serviceRequest({ status: 'diagnostics' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Отложить' }));

    await waitFor(() =>
      expect(fieldError('Почему откладываем')).toBe('Объясните, почему заявку откладывают'),
    );
    expect(http.countOf('PATCH /service-requests/:id/hold')).toBe(0);
    // Отказ стоит под полем, а не тостом в углу: правят причину здесь же.
    expect(document.querySelector('.ant-message-notice')).toBeNull();
  });

  it('до нажатия окно называет статус, в который заявку потом вернут', async () => {
    renderHold('hold', serviceRequest({ status: 'diagnostics' }));

    // Заморозку делают из текущего статуса, и обратный путь у неё один — человеку полезно видеть
    // это до нажатия, а не после.
    expect(await screen.findByText(/Вернуть её можно будет только в «Диагностика»/)).toBeDefined();
  });

  it('заполненная причина уходит на сервер вместе с версией заявки', async () => {
    const held = vi.fn();
    const { http, onClose } = renderHold('hold', serviceRequest({ status: 'diagnostics' }), {
      'PATCH /service-requests/:id/hold': ({ body }) => {
        held(body);
        return json(HELD);
      },
    });

    fireEvent.change(await screen.findByLabelText('Почему откладываем'), {
      target: { value: 'ждём запчасть от поставщика' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отложить' }));

    await waitFor(() => expect(held).toHaveBeenCalled());
    // Версия — оптимистическая блокировка (Р30): между открытием окна и нажатием заявку мог
    // подвинуть другой человек, и молча затирать его решение нельзя.
    expect(held.mock.calls[0]![0]).toMatchObject({
      reason: 'ждём запчасть от поставщика',
      version: 3,
    });
    expect(http.countOf('PATCH /service-requests/:id/hold')).toBe(1);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('окно «Возобновить» называет статус возврата (Р104)', () => {
  it('статус и причина заморозки видны прямо в окне', async () => {
    renderHold('resume');

    expect(await screen.findByText(/Заявка вернётся в «Диагностика»/)).toBeDefined();
    // Причина видна ровно здесь: после возврата заявка её не помнит — hold-поля чистит сам
    // переход (Р118).
    expect(screen.getByText(/Отложена: ждём запчасть от поставщика/)).toBeDefined();
  });

  it('комментарий необязателен: решение выражено самим переходом', async () => {
    const resumed = vi.fn();
    const { onClose } = renderHold('resume', HELD, {
      'PATCH /service-requests/:id/resume': ({ body }) => {
        resumed(body);
        return json(serviceRequest({ status: 'diagnostics' }));
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Возобновить' }));

    await waitFor(() => expect(resumed).toHaveBeenCalled());
    expect(resumed.mock.calls[0]![0]).toMatchObject({ comment: '', version: 3 });
    expect(fieldError('Комментарий')).toBeNull();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

/**
 * Меню отложенной заявки (Р110): заморозка останавливает ход заявки, а не жизнь вокруг неё.
 *
 * Список пунктов сверяется целиком, а не по одному: пропущенный пункт — это кнопка, ведущая в
 * отказ сервера, и обнаружить её проверкой «есть ли „Возобновить“» нельзя.
 */
describe('что можно с отложенной заявкой', () => {
  function renderTab(user: AuthUser): HttpMock {
    const http = mockHttp({
      'GET /service-requests': () => json(list([HELD])),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /office-equipment': () => json(emptyList()),
      'GET /office-equipment-types': () => json(emptyList()),
    });
    renderWithUser(<RequestsTab />, { user });
    return http;
  }

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

  it('оператору — только возобновление, перемещение техники и отмена', async () => {
    renderTab(OPERATOR);
    await screen.findByText('СО-14');

    /*
     * Ровно четыре пункта. Правки нет — `on_hold` не входит в список правимых статусов; срочности
     * нет — сервер отвечает на неё 422 (Р119); повторного письма нет — заморозка службе не
     * пишется (Р111). Аппарат при этом ездит независимо от статуса заявки, поэтому перемещение
     * остаётся.
     *
     * «Обсуждение» (ADR 0141) стоит здесь у обеих сторон и во всех статусах: ленту читают все,
     * кому видна заявка, а писать ли в неё, решает уже кнопка внутри окна. Прежнее «Примечание
     * исполнителя» спрашивало право `serviceRequests.estimate` — и у оператора его не было.
     */
    expect(await rowActionLabels()).toEqual([
      'Возобновить',
      'Обсуждение',
      'Записать перемещение техники',
      'Отменить заявку',
    ]);
  });

  it('администратору к ним добавляется снос в архив — его сервер пускает в любом статусе', async () => {
    renderTab(authUser({ role: 'admin' }));
    await screen.findByText('СО-14');

    // Площадочной роли этот пункт в `on_hold` не показывается вовсе (он строится тем же условием,
    // что проверяет сервер), а администратору снос открыт — заморозка тут ничего не меняет.
    //
    // От набора оператора отличается ровно сносом: обсуждение (ADR 0141) есть у обоих — оно ничьё
    // право не спрашивает, в отличие от снятого «Примечания исполнителя», которое администратор
    // видел по `serviceRequests.estimate`, а оператор не видел вовсе.
    expect(await rowActionLabels()).toEqual([
      'Возобновить',
      'Обсуждение',
      'Записать перемещение техники',
      'Отменить заявку',
      'Удалить',
    ]);
  });
});
