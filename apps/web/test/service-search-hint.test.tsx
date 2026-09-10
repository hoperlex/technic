import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  OFFICE_EQUIPMENT_SELECTOR_SEARCH_MIN,
  type AuthUser,
  type OfficeEquipmentRequestOptionDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { equipmentSelectorOption, equipmentSelectorRoutes } from './factories/officeEquipment';
import { serviceCustomer, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';

/**
 * Подсказка о поиске аппарата в форме заявки (просьба заказчика от 10.09.2026).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ НА САМОМ ДЕЛЕ — не текст, а ОБЕЩАНИЕ. Поиск идёт по всему справочнику
 * компании (ADR 0177), но список без набранного показывает свою площадку, а весь парк включается
 * с трёх символов. Между этими двумя правдами и живёт человек, у которого сломался принтер: он
 * видит короткий список, не находит в нём свой аппарат и уходит, не узнав, что искать можно было
 * дальше.
 *
 * Поэтому проверок три, и каждая закрывает свой способ соврать:
 *
 * 1. **подсказка есть при заведении и называет порог числом.** Без числа «начните печатать» — не
 *    обещание, а ловушка: на первых двух буквах поиск ещё идёт по своей области;
 * 2. **при правке подсказки нет.** Единицу там не выбирают вовсе (поле заперто), и совет искать
 *    читался бы как предложение действия, которого нет;
 * 3. **короткий набор объясняется отдельно от «не нашлось».** Прежний ответ «техники нет в
 *    справочнике» врал ровно тому, ради кого поиск по парку и заводили: на двух символах сервер
 *    смотрел только свою площадку.
 *
 * Число берётся из константы контрактов, а не пишется в тест словом: разойдись портал с сервером —
 * тест обязан упасть, а собственная копия «3» в проверке сделала бы его слепым.
 */

const NORTH = objectDto();

/** Обычный заявитель: аппарат он назвать обязан, право «без аппарата» ему не выдано. */
const REQUESTER: AuthUser = serviceCustomer({
  constructionObjectIds: [NORTH.id],
  phone: '9001234567',
});

/** Единственная единица выдачи: сценариям важен не состав списка, а тексты вокруг него. */
const UNIT: OfficeEquipmentRequestOptionDto = equipmentSelectorOption();

const HINT = new RegExp(
  `Нет вашего аппарата в списке\\?.*${OFFICE_EQUIPMENT_SELECTOR_SEARCH_MIN} символов`,
);

function renderForm(request: Parameters<typeof serviceRequest>[0] | null = null): void {
  mockHttp({
    ...equipmentSelectorRoutes([UNIT]),
    'GET /objects': () => json(list([NORTH])),
    'GET /departments': () => json(list([])),
  });
  renderWithUser(
    <ServiceRequestForm
      open
      request={request ? serviceRequest(request) : null}
      onClose={() => {}}
    />,
    { user: REQUESTER },
  );
}

/**
 * Набрать в поле «Какой аппарат» и вернуть ЕГО выпадашку.
 *
 * Выпадашка возвращается не для удобства: тексты подсказки под полем и пустого списка нарочно
 * похожи — оба про порог, — и поиск по всему экрану ловил бы первый, ничего не зная про второй.
 * Такой тест проходит и на старом коде: проверено откатом правки, он не упал.
 */
function typeSearch(text: string): HTMLElement {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === 'Какой аппарат',
  );
  const input = document.getElementById(label!.getAttribute('for')!)!;
  fireEvent.mouseDown(input);
  fireEvent.change(input, { target: { value: text } });
  const list = document.getElementById(`${input.id}_list`)!;
  return (list.closest('.ant-select-dropdown') ?? list.parentElement!) as HTMLElement;
}

describe('подсказка о поиске аппарата', () => {
  it('при заведении стоит под полем и называет порог', async () => {
    renderForm();

    expect(await screen.findByText(HINT)).toBeDefined();
  });

  it('при правке заявки подсказки нет: единицу там не выбирают', async () => {
    renderForm({});

    // Форма правки ждёт саму заявку, поэтому сначала — признак того, что она отрисована.
    expect(await screen.findByLabelText('Описание')).toBeDefined();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('короткий набор объясняется порогом, а не «ничего не нашлось»', async () => {
    renderForm();
    await screen.findByText(HINT);

    const dropdown = typeSearch('Ки');

    await waitFor(() => {
      expect(
        within(dropdown).getByText(
          new RegExp(`Введите не меньше ${OFFICE_EQUIPMENT_SELECTOR_SEARCH_MIN} символов`),
        ),
      ).toBeDefined();
    });
    expect(within(dropdown).queryByText(/техники нет в справочнике/)).toBeNull();
  });

  it('с порога и дальше пустая выдача называется своим именем', async () => {
    renderForm();
    await screen.findByText(HINT);

    const dropdown = typeSearch('Ксерокс');

    await waitFor(() => {
      expect(within(dropdown).getByText(/техники нет в справочнике/)).toBeDefined();
    });
  });
});
