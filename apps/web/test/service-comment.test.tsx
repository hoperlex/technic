import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { heldServiceRequest, serviceExecutor, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Примечание исполнителя (приём ADR 0053): строка сервисной компании в чужой заявке.
 *
 * Проверяется то, что расходится молча. Ручка на сервере была с самого модуля, а окна не было —
 * заявку исполнитель не редактирует, и поле, приделанное к правке заявки, ему бы не открылось.
 * Отсюда три вещи, которые ломаются беззвучно: пустое значение здесь не отказ формы, а способ
 * снять устаревшую запись; предзаполнение прежним текстом отличает «дополнить» от «набрать
 * заново»; и пункт обязан жить у отложенной заявки (Р110) — именно тогда пишут «запчасть будет
 * 3-го», — но исчезать у закрытой, где сервер отвечает отказом.
 */

/** Исполнитель: право `serviceRequests.estimate` даёт ему тип контрагента, а не роль (ADR 0038). */
const EXECUTOR: AuthUser = serviceExecutor();

function renderTab(
  items: ServiceRequestDto[],
  over: RouteMap = {},
  user: AuthUser = EXECUTOR,
): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
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

/** Открыть окно примечания из меню строки. */
async function openCommentModal(): Promise<void> {
  await rowActionLabels();
  fireEvent.click(await screen.findByText('Примечание исполнителя'));
  await screen.findByLabelText('Примечание исполнителя');
}

describe('окно «Примечание исполнителя»', () => {
  it('текст уходит на сервер вместе с версией заявки', async () => {
    const saved = vi.fn();
    const request = serviceRequest({ status: 'diagnostics' });
    const http = renderTab([request], {
      'PATCH /service-requests/:id/service-comment': ({ body }) => {
        saved(body);
        return json({ ...request, serviceComment: 'запчасть будет 3-го' });
      },
    });
    await screen.findByText('СО-14');

    await openCommentModal();
    fireEvent.change(screen.getByLabelText('Примечание исполнителя'), {
      target: { value: 'запчасть будет 3-го' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(saved).toHaveBeenCalled());
    // Версия — оптимистическая блокировка (Р30): между открытием окна и нажатием заявку мог
    // подвинуть другой человек, и молча затирать его решение нельзя.
    expect(saved.mock.calls[0]![0]).toMatchObject({
      serviceComment: 'запчасть будет 3-го',
      version: 3,
    });
    expect(http.countOf('PATCH /service-requests/:id/service-comment')).toBe(1);
  });

  it('поле открывается с прежней записью: её дополняют, а не набирают заново', async () => {
    renderTab([serviceRequest({ status: 'in_work', serviceComment: 'ждём поставку' })]);
    await screen.findByText('СО-14');

    await openCommentModal();

    // Пустое поле поверх существующей записи означало бы, что «дописать пару слов» невозможно:
    // человек либо перепечатывает прежний текст, либо молча стирает его сохранением.
    expect((screen.getByLabelText('Примечание исполнителя') as HTMLTextAreaElement).value).toBe(
      'ждём поставку',
    );
  });

  it('устаревшую запись стирают тем же окном — уходит пустая строка', async () => {
    const saved = vi.fn();
    const request = serviceRequest({ status: 'in_work', serviceComment: 'ждём поставку' });
    renderTab([request], {
      'PATCH /service-requests/:id/service-comment': ({ body }) => {
        saved(body);
        return json({ ...request, serviceComment: '' });
      },
    });
    await screen.findByText('СО-14');

    await openCommentModal();
    fireEvent.change(screen.getByLabelText('Примечание исполнителя'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    // Пустое значение — обычный ход, а не отказ формы: деталь приехала, и «ждём поставку» в
    // карточке врёт. Другого способа снять строку у исполнителя нет.
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(saved.mock.calls[0]![0]).toMatchObject({ serviceComment: '', version: 3 });
  });
});

describe('где пункт «Примечание исполнителя» есть, а где его нет', () => {
  it('у отложенной заявки пункт остаётся: тогда его и пишут (Р110)', async () => {
    renderTab([heldServiceRequest('diagnostics')]);
    await screen.findByText('СО-14');

    // Заморозка останавливает ход заявки, а не жизнь вокруг неё: «запчасть будет 3-го» — ответ
    // ровно на тот вопрос, из-за которого заявку и остановили.
    expect(await rowActionLabels()).toContain('Примечание исполнителя');
  });

  it('у принятой заявки пункта нет: сервер закрытую не принимает', async () => {
    // Смотрит администратор, а не исполнитель, и это существенно: право `serviceRequests.estimate`
    // у него есть, а меню принятой заявки у исполнителя пусто и без него — тогда проверка ничего
    // бы не сказала про сам пункт. Пропадает он именно от закрытости заявки.
    renderTab([serviceRequest({ status: 'accepted' })], {}, authUser({ role: 'admin' }));
    await screen.findByText('СО-14');

    // Показать пункт здесь значило бы предложить окно, из которого нельзя выйти сохранением.
    expect(await rowActionLabels()).not.toContain('Примечание исполнителя');
  });
});
