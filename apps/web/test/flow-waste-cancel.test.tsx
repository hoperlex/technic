import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { WasteRequestsPage } from '../src/pages/WasteRequestsPage';
import { expectModalClosed } from './antd';

/**
 * Отмена заявки на вывоз мусора из списка. Отмена — единственный переход, который портал не
 * выполняет одним нажатием: заявка закрывается без результата, и без причины ни автор, ни
 * следующий диспетчер не поймут, почему (`statusChangeRequiresReason`).
 *
 * Проверяется поток: что окно без причины ничего не отправляет, что уходит одним `PATCH`
 * со статусом, причиной и версией заявки — и что список после этого перезапрошен. Разметка окна
 * тут ни при чём: важно, что до сервера доходит ровно то, чего он ждёт.
 */

// Сценарий ведёт весь экран — список, меню статусов, окно причины: пяти секунд по умолчанию ему
// хватает не всегда, а упавший по таймауту тест читается как поломка портала.
vi.setConfig({ testTimeout: 20_000 });

/** Заявка в работе: у неё есть что отменять, и версия у неё уже не первая. */
const REQUEST = wasteRequest({
  status: 'confirmed',
  version: 4,
  operatorCounterpartyId: 'cp-1',
  operatorName: 'ООО «Чистый двор»',
});

const REASON = 'Площадка закрыта на карантин';

function setup() {
  const http = mockHttp({
    'GET /waste-requests': () => json(list([REQUEST])),
    'GET /waste-requests/summary': () => json(wasteSummary({ confirmed: 1 })),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () => json(list([wasteType()])),
    'GET /counterparties': () => json(list([operator()])),
    // Отвечаем той же заявкой, но уже отменённой и с новой версией — так отвечает и сервер.
    'PATCH /waste-requests/:id/status': ({ params, body }) =>
      json(
        wasteRequest({
          ...REQUEST,
          id: params.id,
          status: 'cancelled',
          cancelReason: (body as { comment?: string }).comment ?? null,
          version: REQUEST.version + 1,
        }),
      ),
  });
  renderWithUser(<WasteRequestsPage />);
  return http;
}

/** Смена статуса строки: тег статуса — кнопка с меню переходов, доступных этой роли (ADR 0021). */
async function openStatusMenu(target: string) {
  fireEvent.click(await screen.findByLabelText('Изменить статус'));
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
      (el) => el.textContent === target,
    );
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
}

/** Кнопка окна отмены: подписи у неё свои — «Отменить заявку» и «Не отменять». */
function submitCancelModal() {
  fireEvent.click(screen.getByText('Отменить заявку'));
}

const STATUS_ROUTE = 'PATCH /waste-requests/:id/status';

describe('отмена заявки на вывоз мусора', () => {
  it('без причины окно не отпускает: на сервер ничего не уходит', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    await openStatusMenu('Отменена');
    expect(await screen.findByText('Отмена заявки')).toBeDefined();

    submitCancelModal();
    expect(await screen.findByText('Укажите причину')).toBeDefined();
    expect(http.countOf(STATUS_ROUTE)).toBe(0);

    // Пробелы причиной не считаются: иначе поле обходилось бы нажатием на пробел, а в истории
    // статусов осталась бы пустая строка вместо объяснения.
    fireEvent.change(screen.getByLabelText('Причина отмены заявки № М-128'), {
      target: { value: '   ' },
    });
    submitCancelModal();
    await waitFor(() => expect(screen.getByText('Укажите причину')).toBeDefined());
    expect(http.countOf(STATUS_ROUTE)).toBe(0);
  });

  it('с причиной уходит один PATCH статуса — с причиной и версией заявки', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    await openStatusMenu('Отменена');
    expect(await screen.findByText('Отмена заявки')).toBeDefined();

    // Причина набирается с лишними пробелами: в историю статусов она попадает обрезанной.
    fireEvent.change(screen.getByLabelText('Причина отмены заявки № М-128'), {
      target: { value: `  ${REASON}  ` },
    });
    submitCancelModal();

    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(1));
    const call = http.lastCall(STATUS_ROUTE);
    // Адрес — та самая заявка, из строки которой открыли меню.
    expect(call?.path).toBe(`/waste-requests/${REQUEST.id}/status`);
    expect(call?.body).toMatchObject({
      status: 'cancelled',
      // Причина обязательна и уходит тем же запросом, что и статус: отдельным она разъехалась бы
      // со сменой статуса при первом же отказе сервера.
      comment: REASON,
      // Версия — защита от одновременной правки: без неё сервер не отличит отмену «этой» заявки
      // от отмены той, которую тем временем успели изменить.
      version: REQUEST.version,
    });
  });

  it('после отмены список перезапрашивается, а окно закрывается', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    await openStatusMenu('Отменена');
    expect(await screen.findByText('Отмена заявки')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Причина отмены заявки № М-128'), {
      target: { value: REASON },
    });
    submitCancelModal();

    // Строка списка обязана показать новый статус сама: перезапрос — единственное, что об этом
    // заботится, а прежний статус на экране читался бы как «отмена не прошла».
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(2));
    await expectModalClosed('Отмена заявки');
  });
});
