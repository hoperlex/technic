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
 * Выбрать вариант в поле формы (`Select`/`AutoSelect`).
 *
 * Искать `.ant-select-item-option` по всему документу нельзя: закрытые выпадашки других полей
 * остаются в разметке, и выбор молча уходит в чужой список. Список поля — это `<id поля>_list`,
 * поэтому вариант ищется внутри него.
 *
 * `labelText` — подпись поля; она же связывает `Form.Item` с самим полем через `id`.
 */
export async function selectOption(labelText: string, optionText: string | RegExp): Promise<void> {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  if (!label) throw new Error(`поля «${labelText}» на экране нет`);
  const fieldId = label.getAttribute('for');
  if (!fieldId) throw new Error(`подпись «${labelText}» ни с чем не связана — у поля нет id`);

  const input = document.getElementById(fieldId);
  if (!input) throw new Error(`поле «${labelText}» не найдено по id «${fieldId}»`);
  fireEvent.mouseDown(input);

  const listId = `${fieldId}_list`;
  const list = await waitFor(() => {
    const found = document.getElementById(listId);
    if (!found) throw new Error(`список поля «${labelText}» не открылся`);
    return found;
  });

  // Варианты antd рисует соседом списка-описания: сам `_list` держит только доступные роли.
  const dropdown = list.closest('.ant-select-dropdown') ?? list.parentElement!;
  const option = await within(dropdown as HTMLElement).findByText(optionText, {
    selector: '.ant-select-item-option-content, .ant-select-item-option-content *',
  });
  fireEvent.click(option);
}
