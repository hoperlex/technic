import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { pretendContentOverflows } from './clamp';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { WasteRequestsPage } from '../src/pages/WasteRequestsPage';

/**
 * Строка списка заявок на вывоз: открытие карточки кликом и свёрнутый комментарий.
 *
 * Карточку открывают кликом по строке — тем же движением, каким на телефоне открывают карточку
 * списка, — а целиться в иконку колонки «Действия» приходилось на каждую заявку. Но строка полна
 * активного содержимого: переходы статуса, файлы, действия и переключатель свёрнутого
 * комментария. Проверяется поэтому не «клик открывает», а граница — что открывает, а что нет:
 * ошибка здесь не падает тестом, она открывает окно поверх каждого нажатия.
 *
 * Комментарий сторон (ADR 0053) проверяется здесь же: в строке он живёт одной сворачиваемой
 * ячейкой, и обе стороны должны быть в ней, а не обрезаться каждая по отдельности.
 */

/**
 * Заявка в работе, у которой есть что показывать в комментарии: обе стороны заполнены, площадка
 * многословна — на две видимые строки её текст не помещается, ради чего ячейка и сворачивается.
 */
const REQUEST = wasteRequest({
  status: 'confirmed',
  version: 4,
  operatorCounterpartyId: 'cp-1',
  operatorName: 'ООО «Чистый двор»',
  comment: 'заезд со двора, ворота открывает охрана по звонку; контейнер у третьего подъезда',
  operatorComment: 'будем после 15:00',
});

function renderPage(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /waste-requests': () => json(list([REQUEST])),
    'GET /waste-requests/summary': () => json(wasteSummary({ confirmed: 1 })),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () => json(list([wasteType()])),
    'GET /counterparties': () => json(list([operator()])),
    // Карточка заявки спрашивает историю при открытии (ADR 0012); сценариям нужен сам факт
    // открытия, поэтому история пуста.
    'GET /waste-requests/:id/history': () => json([]),
    ...over,
  });

  renderWithUser(<WasteRequestsPage />);
  return http;
}

/** Открыта ли карточка заявки: окно подписано её номером. */
function cardOf(displayNumber: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((el) =>
    el.textContent?.includes(`Заявка № ${displayNumber}`),
  );
}

const row = () => document.querySelector<HTMLElement>('.ant-table-tbody tr.ant-table-row')!;

describe('строка списка заявок на вывоз', () => {
  it('открывает карточку кликом по ячейке без активного содержимого', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('ЖК Северный'));

    await waitFor(() => expect(cardOf('М-128')).toBeTruthy());
  });

  it('не открывает карточку кликом по колонке действий — она отдана нажатиям целиком', async () => {
    renderPage();
    await screen.findByText('М-128');

    // Промах мимо кнопки: попали в саму ячейку действий, а не в действие.
    const actions = row().querySelector<HTMLElement>('td.no-row-click')!;
    expect(actions).toBeTruthy();
    fireEvent.click(actions);

    await waitFor(() => expect(cardOf('М-128')).toBeUndefined());
  });

  it('не открывает карточку выбором в меню статуса — оно живёт в портале', async () => {
    // Меню antd рисует в конце `body`: в дереве React оно осталось внутри ячейки, и событие
    // всплывает до строки, хотя в DOM лежит вне её. Не отсеки его — выбор перехода открывал бы
    // карточку поверх окна, которое сам же и вызвал.
    renderPage();
    await screen.findByText('М-128');

    fireEvent.click(screen.getByLabelText('Изменить статус'));
    const cancel = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
        (el) => el.textContent === 'Отменена',
      );
      expect(found, 'пункт меню «Отменена»').toBeTruthy();
      return found!;
    });
    fireEvent.click(cancel);

    // Открылось окно причины отмены — и только оно: карточка заявки поверх него не всплыла.
    expect(await screen.findByText('Отмена заявки')).toBeDefined();
    expect(cardOf('М-128')).toBeUndefined();
  });

  it('не открывает карточку переключателем свёрнутой ячейки — он разворачивает комментарий', async () => {
    pretendContentOverflows();
    renderPage();
    await screen.findByText('М-128');

    // Свёрнутая ячейка в строке одна — комментарий обеих сторон.
    const toggles = within(row()).getAllByLabelText('Показать полностью');
    expect(toggles).toHaveLength(1);
    fireEvent.click(toggles[0]!);

    await waitFor(() => expect(within(row()).getAllByLabelText('Свернуть')).toHaveLength(1));
    // Развёрнутая ячейка клэмп снимает: текст виден целиком, а не двумя строками.
    expect(row().querySelector('.expandable-cell__body--clamped')).toBeNull();
    expect(cardOf('М-128')).toBeUndefined();
  });

  it('держит обе стороны комментария в одной свёрнутой ячейке', async () => {
    renderPage();
    await screen.findByText('М-128');

    const body = within(row()).getByText('Площадка:').closest('.expandable-cell__body')!;
    expect(body.className).toContain('expandable-cell__body--clamped');
    // Обе стороны — в одной ячейке: раньше каждая обрезалась своим многоточием, и от второй
    // оставалась подпись. Исполнитель подписан названием контрагента (ADR 0053).
    const text = body.textContent ?? '';
    expect(text).toContain('заезд со двора');
    expect(text).toContain('ООО «Чистый двор»:');
    expect(text).toContain('будем после 15:00');
  });
});
