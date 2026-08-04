import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ViewFields } from '../src/shared/ui';
import { VehicleRequestViewModal } from '../src/pages/vehicle/VehicleRequestViewModal';
import { renderWithUser } from './render';
import { json, mockHttp } from './http';
import { vehicleRequest } from './factories/vehicle';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport } from './viewport';

/**
 * Раскладка карточки просмотра.
 *
 * Ширины полей в карточке обязаны складываться ровно в строку. antd, встретив широкое поле в
 * остатке строки, молча ужимал его до этого остатка: «Согласование» с длинным тегом занимало треть
 * строки, соседние значения от этого сжимались до 84 px, и дата ломалась посреди числа. Проверка
 * держится за это правило, а не за конкретную карточку: любое поле, объявленное `full`, занимает
 * строку целиком, а строка никогда не остаётся недобранной.
 */

/** Строки карточки ячейками: подпись и значение — разные ячейки, ширина значения в `colSpan`. */
function cardRows(): { tag: string; span: number; text: string }[][] {
  const table = document.querySelector('.view-fields table');
  if (!table) throw new Error('карточка полей не отрисована');
  return [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.children].map((cell) => ({
      tag: cell.tagName,
      span: (cell as HTMLTableCellElement).colSpan,
      text: cell.textContent ?? '',
    })),
  );
}

/** Сколько долей строки занято: подпись — одну, значение — объявленный `colSpan`. */
const rowWidth = (row: { span: number }[]) => row.reduce((sum, cell) => sum + cell.span, 0);

describe('карточка полей просмотра', () => {
  it('поле во всю ширину занимает строку целиком, а не остаток от соседа', () => {
    setViewport(DESKTOP_VIEWPORT);
    render(
      <ViewFields
        items={[
          { key: 'a', label: 'Статус', children: 'Новая' },
          { key: 'b', label: 'Согласование', full: true, children: 'Ждёт визы руководителя' },
          { key: 'c', label: 'Автор', children: 'Диспетчеров Д. П.' },
        ]}
      />,
    );

    const rows = cardRows();
    // Три поля — три строки: широкое не влезало в остаток первой и встало со следующей, а
    // «Статус» растянулся на брошенную половину.
    expect(rows).toHaveLength(3);
    expect(rows[1]!.map((c) => c.text)).toEqual(['Согласование', 'Ждёт визы руководителя']);
    for (const row of rows) expect(rowWidth(row)).toBe(4);
  });

  it('соседние обычные поля делят строку', () => {
    setViewport(DESKTOP_VIEWPORT);
    render(
      <ViewFields
        items={[
          { key: 'a', label: 'Тип/категория', children: 'г/п 25 т' },
          { key: 'b', label: 'Период работы', children: '05.08.2026 – 07.08.2026' },
        ]}
      />,
    );

    const rows = cardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.map((c) => c.text)).toEqual([
      'Тип/категория',
      'г/п 25 т',
      'Период работы',
      '05.08.2026 – 07.08.2026',
    ]);
  });

  it('на телефоне поле каждое своей строкой, подпись над значением (ADR 0030)', () => {
    setViewport(MOBILE_VIEWPORT);
    render(
      <ViewFields
        items={[
          { key: 'a', label: 'Тип/категория', children: 'г/п 25 т' },
          { key: 'b', label: 'Период работы', children: '05.08.2026 – 07.08.2026' },
        ]}
      />,
    );

    const rows = cardRows();
    // Вертикальная раскладка: у каждого поля строка подписи и строка значения.
    expect(rows.map((row) => row.map((c) => c.text))).toEqual([
      ['Тип/категория'],
      ['г/п 25 т'],
      ['Период работы'],
      ['05.08.2026 – 07.08.2026'],
    ]);
    setViewport(DESKTOP_VIEWPORT);
  });

  it('карточка заявки на технику: строки собраны без брошенных долей и без ругани antd', async () => {
    // antd жалуется на несходящиеся ширины через console.error — молчание здесь и есть проверка,
    // что карточка больше не отдаёт ему полей, которые он ужимает по своему усмотрению.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockHttp({
      'GET /vehicle-requests/:id/history': () => json([]),
      'GET /vehicle-requests/:id/relocations': () => json([]),
      'GET /vehicle-requests/:id/waybills': () => json([]),
    });
    renderWithUser(<VehicleRequestViewModal request={vehicleRequest()} onClose={() => {}} />);
    await screen.findByText('Тип/категория');

    for (const row of cardRows()) expect(rowWidth(row)).toBe(4);
    expect(errors.mock.calls.map(String).join('\n')).not.toContain('Descriptions');
    errors.mockRestore();
  });
});
