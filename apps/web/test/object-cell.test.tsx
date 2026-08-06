import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { requestCustomerLabel } from '@technic/contracts';
import { renderWithUser } from './render';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../src/components/ObjectCell';

/**
 * Ячейка заказчика в списках: наименование объекта (или код отдела) и адрес под ним.
 *
 * Ширина колонки одна на все модули и задана числом, а не содержимым: списки читают сравнением
 * соседних строк, и колонка, которая в вывозе шире, чем в технике, читается как другая колонка.
 * Из этого следует остальное — наименование не помещается в строку и переносится, но не больше
 * чем на две: иначе строка таблицы растёт под самое длинное название площадки.
 *
 * Проверяется то, что молча теряется при правках стилей: обрезка именно двумя строками и полный
 * текст в подсказке. Без подсказки обрезанное наименование становится недоступным вовсе — в
 * списке его больше негде прочитать.
 */

const LONG = 'ЖК «Северный парк», корпус 3, этап 2, секция Б';

describe('ячейка заказчика в списке', () => {
  it('наименование переносится двумя строками, полный текст — в подсказке', () => {
    renderWithUser(<ObjectCell name={LONG} address="г. Москва, ул. Северная, 1" />);

    const name = screen.getByTitle(LONG);
    expect(name.textContent).toBe(LONG);
    expect(name.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
    expect(name.style.overflow).toBe('hidden');
  });

  it('адрес остаётся однострочным и со своей подсказкой', () => {
    const address = 'г. Москва, ул. Северная, 1, стр. 4';
    renderWithUser(<ObjectCell name="ЖК Северный" address={address} />);

    const line = screen.getByTitle(address);
    expect(line.style.whiteSpace).toBe('nowrap');
    expect(line.style.textOverflow).toBe('ellipsis');
  });

  it('пустой адрес второй строки не занимает', () => {
    const { container } = renderWithUser(<ObjectCell name="ЖК Северный" address="   " />);
    expect(container.textContent).toBe('ЖК Северный');
  });

  it('отдел стоит кодом, а подсказка называет его полностью', () => {
    // Так его и называют в работе; полное наименование нужно для сверки, а не для узнавания.
    const customer = requestCustomerLabel({
      objectName: null,
      departmentCode: 'ПТО',
      departmentName: 'Производственно-технический отдел',
    });
    renderWithUser(<ObjectCell name={customer.text} hint={customer.hint} />);

    const cell = screen.getByTitle('Производственно-технический отдел');
    expect(cell.textContent).toBe('ПТО');
  });

  it('у объекта подсказка повторяет наименование — сокращать его нечем', () => {
    const customer = requestCustomerLabel({
      objectName: 'ЖК Северный',
      departmentCode: null,
      departmentName: null,
    });
    expect(customer).toEqual({ text: 'ЖК Северный', hint: null });
  });

  it('ширина колонки — одно число на все списки портала', () => {
    expect(OBJECT_COLUMN_WIDTH).toBe(180);
  });
});
