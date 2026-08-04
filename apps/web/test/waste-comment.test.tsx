import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { wasteRequest } from './factories/waste';
import { WasteRequestViewModal } from '../src/pages/waste/WasteRequestViewModal';

/**
 * Комментарий заявки на вывоз разведён по сторонам (ADR 0053): площадка и исполнитель говорят
 * своими строками. Проверяется карточка заявки — единственное место, где строку исполнителя не
 * только видно, но и пишут: формы правки у оператора нет вовсе.
 *
 * Историю событий карточка читает сама (ADR 0012), и отвечает на неё HTTP-мок, а не подменённый
 * `api/resources`: к комментарию история отношения не имеет, а подмена модуля описывала бы не
 * поведение карточки, а сегодняшнюю раскладку файлов портала.
 */

const request = wasteRequest({
  id: 'wr-42',
  num: 42,
  displayNumber: 'М-42',
  status: 'confirmed',
  // Исполнитель назначен: его названием и подписана вторая строка комментария.
  operatorCounterpartyId: 'cp-1',
  operatorName: 'ООО «ЭкоТранс»',
  comment: 'заезд со двора',
  operatorComment: 'будем после 15:00',
});

/**
 * Карточка вместе с ручкой истории. История пуста — проверяется комментарий, — и пустой ответ
 * карточка объявляет строкой «История недоступна»: по ней видно, что запрос отработал. Ожидание
 * обязательно, а не для порядка: ответ, пришедший после теста, обновлял бы снятое с экрана дерево.
 */
async function renderCard(props: Partial<Parameters<typeof WasteRequestViewModal>[0]> = {}) {
  mockHttp({ 'GET /waste-requests/:id/history': () => json([]) });
  renderWithUser(<WasteRequestViewModal request={request} onClose={vi.fn()} {...props} />);
  await screen.findByText('История недоступна');
}

describe('комментарий заявки в карточке', () => {
  it('показывает обе стороны: площадку словом, исполнителя — названием контрагента', async () => {
    await renderCard();
    expect(screen.getByText('Площадка:')).toBeDefined();
    expect(screen.getByText('заезд со двора')).toBeDefined();
    expect(screen.getByText('ООО «ЭкоТранс»:')).toBeDefined();
    expect(screen.getByText('будем после 15:00')).toBeDefined();
  });

  // Права нет либо заявка закрыта — страница просто не передаёт обработчик, и поля правки нет.
  it('без права на примечание правка не предлагается', async () => {
    await renderCard();
    expect(screen.queryByPlaceholderText('Комментарий исполнителя')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
  });

  it('сохраняет примечание исполнителя обрезанным и только после правки', async () => {
    const onSave = vi.fn();
    await renderCard({ onSaveOperatorComment: onSave });
    const field = screen.getByPlaceholderText('Комментарий исполнителя');
    const save = screen.getByRole('button', { name: 'Сохранить' });
    // Текст не трогали — сохранять нечего: кнопка заперта, пока строка та же.
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(field, { target: { value: '  будем к 18:00  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(onSave).toHaveBeenCalledWith(request, 'будем к 18:00');
  });
});
