import { expect } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';

/**
 * Приёмы работы с antd в тестах — общие, потому что каждый сценарный тест наступает на одно и то
 * же: закрытое окно остаётся в разметке, выпадающий список тоже, а поиск по роли на полной
 * странице стоит секунд.
 */

/**
 * Окно ушло с экрана.
 *
 * Проверять по исчезновению разметки нельзя: antd оставляет закрытое окно в DOM и лишь прячет
 * его по окончании анимации, а в jsdom анимации сами не идут — их конец объявляется событием.
 * Событие шлётся на каждой попытке `waitFor`: анимация начинается не в тот же миг, что закрытие,
 * и посланное слишком рано никто не услышит.
 */
export async function expectModalClosed(title: string): Promise<void> {
  const heading = [...document.querySelectorAll('.ant-modal-title')].find(
    (el) => el.textContent === title,
  );
  if (!heading) throw new Error(`окна «${title}» на экране нет`);
  const wrap = heading.closest('.ant-modal-wrap') as HTMLElement;
  await waitFor(() => {
    const dialog = wrap.querySelector('[role="dialog"]');
    if (dialog) {
      fireEvent.animationEnd(dialog);
      fireEvent.transitionEnd(dialog);
    }
    expect(wrap.style.display).toBe('none');
  });
}

/**
 * Открыть поле формы (`Select`/`AutoSelect`) и вернуть его выпадашку.
 *
 * Искать `.ant-select-item-option` по всему документу нельзя: закрытые выпадашки других полей
 * остаются в разметке, и выбор молча уходит в чужой список. Список поля — это `<id поля>_list`,
 * поэтому варианты ищутся в выпадашке, которая его держит.
 *
 * Само поле ожидается, а не берётся сразу: в общем прогоне форма к этому моменту бывает ещё не
 * отрисована, и синхронный поиск роняет тест не на его смысле, а на пустой ссылке.
 *
 * `labelText` — подпись поля; она же связывает `Form.Item` с самим полем через `id`.
 */
async function openSelect(labelText: string): Promise<HTMLElement> {
  const input = await waitFor(() => {
    const label = [...document.querySelectorAll('label')].find(
      (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
    );
    if (!label) throw new Error(`поля «${labelText}» на экране нет`);
    const fieldId = label.getAttribute('for');
    if (!fieldId) throw new Error(`подпись «${labelText}» ни с чем не связана — у поля нет id`);
    const found = document.getElementById(fieldId);
    if (!found) throw new Error(`поле «${labelText}» не найдено по id «${fieldId}»`);
    return found;
  });
  fireEvent.mouseDown(input);

  const listId = `${input.id}_list`;
  const list = await waitFor(() => {
    const found = document.getElementById(listId);
    if (!found) throw new Error(`список поля «${labelText}» не открылся`);
    return found;
  });

  // Варианты antd рисует соседом списка-описания: сам `_list` держит только доступные роли.
  return (list.closest('.ant-select-dropdown') ?? list.parentElement!) as HTMLElement;
}

/** Открыть список поля и вернуть его варианты — только из выпадашки этого поля. */
export async function openSelectOptions(labelText: string): Promise<HTMLElement[]> {
  const dropdown = await openSelect(labelText);
  // Варианты тоже ожидаются: список чаще всего приезжает запросом, а открытая пустая выпадашка
  // ничем в разметке не отличается от той, куда данные ещё не пришли.
  return await waitFor(() => {
    const options = [...dropdown.querySelectorAll<HTMLElement>('.ant-select-item-option')];
    if (options.length === 0) throw new Error(`в списке поля «${labelText}» пока нет вариантов`);
    return options;
  });
}

/**
 * Выбрать вариант в поле формы (`Select`/`AutoSelect`).
 *
 * `labelText` — подпись поля, `optionText` — текст варианта.
 */
export async function selectOption(labelText: string, optionText: string | RegExp): Promise<void> {
  const dropdown = await openSelect(labelText);
  const option = await within(dropdown).findByText(optionText, {
    selector: '.ant-select-item-option-content, .ant-select-item-option-content *',
  });
  fireEvent.click(option);
}

/**
 * Поле даты (`DatePicker`) по подписи. Отдельно от `openSelect`: у выбора вариантов возвращается
 * выпадашка, а у даты нужен сам `input` — тесты и читают его значение, и печатают в него.
 */
export function dateInput(labelText: string): HTMLInputElement {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  if (!label) throw new Error(`поля «${labelText}» на экране нет`);
  const fieldId = label.getAttribute('for');
  const found = fieldId ? document.getElementById(fieldId) : null;
  if (!found) throw new Error(`поле «${labelText}» не найдено по id «${fieldId}»`);
  return found as HTMLInputElement;
}

/**
 * Ввести дату руками — так, как её вводит человек: календарь в jsdom не открывается мышью, а
 * набранное значение antd принимает по Enter. Формат тот же, что показывает поле, — «10.08.2026».
 */
export function typeDate(labelText: string, text: string): void {
  const input = dateInput(labelText);
  fireEvent.mouseDown(input);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
  // Поле с уже заполненной датой по Enter значение иногда не принимает — «ввод закончен» antd
  // слышит и по уходу фокуса. Оба события вместе безопасны: второе застаёт уже принятое.
  fireEvent.blur(input);
}
