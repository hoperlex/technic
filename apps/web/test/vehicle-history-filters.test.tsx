import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { classification } from './factories/vehicle';
import { VehicleRequestsHistoryTab } from '../src/pages/vehicle/VehicleRequestsHistoryTab';

/**
 * Отбор журнала закрытых заказов по технике (ADR 0098).
 *
 * Проверяется, что два соседних фильтра отвечают на разные вопросы и не подменяют друг друга:
 * «Все арендодатели» — у кого брали, «Вся техника» — какой машиной закрыли. Одну и ту же единицу
 * берут у одного арендодателя, а у одного арендодателя берут разные единицы, и ответ на второй
 * вопрос первым фильтром не получить.
 */

const OWN_VEHICLE = {
  id: 'v-own',
  ownership: 'own',
  description: '',
  registrationNumber: 'Е646СК799',
  modelName: 'КамАЗ 65115',
  typeName: 'Самосвалы',
  categoryName: null,
  lessorName: null,
} as VehicleDto;

function renderTab() {
  const http = mockHttp({
    'GET /vehicle-requests/history': () => json(emptyList()),
    'GET /vehicle-requests/history/summary': () =>
      json({ total: 0, done: 0, cancelled: 0, totalCost: 0, withoutCost: 0 }),
    'GET /objects': () => json(list([objectDto()])),
    // Справочник отделов — вторая половина подбора «Объект/отдел» (план
    // `docs/department-requests-plan.md`, Р9): у учётки без своей оси в фильтре обе группы.
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () =>
      json(
        list([
          classification({
            key: 'vt-1:vc-1',
            typeName: 'Автокраны',
            kindName: 'Спецтехника',
            label: 'Автокраны, г/п 25 т',
          }),
        ]),
      ),
    'GET /counterparties': () => json(emptyList()),
    'GET /vehicles': () => json(list([OWN_VEHICLE])),
  });
  renderWithUser(<VehicleRequestsHistoryTab />, { user: authUser({ role: 'admin' }) });
  return http;
}

/** Поле панели опознаётся своей подсказкой: подписи у фильтров нет, её место занимает placeholder. */
async function openFilter(placeholder: string) {
  const field = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === placeholder,
    );
    if (!found) throw new Error(`фильтра «${placeholder}» на экране нет`);
    return found;
  });
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
}

/**
 * Отметить вариант в уже открытом списке. Отдельно от открытия: у набора выпадашка после выбора
 * не закрывается, а поле перестаёт показывать подсказку — искать его по ней во второй раз нечем.
 */
async function toggleOption(option: string) {
  await waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
      o.textContent?.includes(option),
    );
    expect(match, `вариант «${option}»`).toBeTruthy();
    fireEvent.click(match!);
  });
}

async function pickFilter(placeholder: string, option: string) {
  await openFilter(placeholder);
  await toggleOption(option);
}

describe('журнал закрытых заказов: отбор по технике', () => {
  it('выбор машины уходит параметром vehicleId и возвращает журнал на первую страницу', async () => {
    const http = renderTab();
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));
    expect(http.lastCall('GET /vehicle-requests/history')!.query.get('vehicleId')).toBeNull();

    await pickFilter('Вся техника', 'Е646СК799 — КамАЗ 65115');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/history')!;
      expect(call.query.get('vehicleId')).toBe('v-own');
      expect(call.query.get('page')).toBe('1');
    });
    // Итог за период считается по тем же фильтрам, что и таблица.
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/history/summary')!.query.get('vehicleId')).toBe(
        'v-own',
      ),
    );
  });

  it('фильтр классификатора остаётся своим вопросом и уезжает набором позиций', async () => {
    const http = renderTab();
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));

    // Обе подсказки стоят рядом и называют разное: тип ТС и единицу парка (ADR 0098).
    expect(screen.getByText('Любой тип ТС')).toBeDefined();
    expect(screen.getByText('Вся техника')).toBeDefined();

    await openFilter('Любой тип ТС');
    await toggleOption('Автокраны — все категории');
    await toggleOption('Автокраны, г/п 25 т');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/history')!;
      // Тип целиком и одна его категория — два самостоятельных ключа одной строки. Свести их в
      // один портал не берётся: объединяет набор сервер, и «весь тип» поглотит категорию сам.
      expect(call.query.get('classifications')).toBe('cvc-1,tvt-1');
      // Старой пары полей в запросе нет вовсе: технику задаёт один параметр.
      expect(call.query.get('vehicleTypeId')).toBeNull();
      expect(call.query.get('vehicleId')).toBeNull();
    });
    // Итог за период считается по тому же набору, что и таблица.
    await waitFor(() =>
      expect(
        http.lastCall('GET /vehicle-requests/history/summary')!.query.get('classifications'),
      ).toBe('cvc-1,tvt-1'),
    );
  });
});
