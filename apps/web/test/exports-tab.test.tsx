import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { roleScopeAxis, roleScopeAxisLabels, type Permission, type Role } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type MockResponse } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { objectDto } from './factories/waste';
import { openSelectOptions, selectOption } from './antd';
import { AdministrationPage } from '../src/pages/AdministrationPage';
import { ExportsTab } from '../src/pages/admin/ExportsTab';

/**
 * Реестр служебных выгрузок (`docs/analytics-summary-export-plan.md`, Р1).
 *
 * Книг стало две, вкладка осталась одна, и проверяется здесь ровно то, что от этого решения
 * зависит: дверь открывает **любое** из двух независимых прав (ни одно не входит в ролевые
 * наборы, и держатель одного не должен упираться в закрытый раздел), список видов показывает
 * только доступное, переключение вида меняет панель, а форма аналитики гасит кнопку теми же
 * числами, какими её гасит сервер, — и объясняет отказ словами, а не молчанием.
 *
 * Скачивания в jsdom не происходит: `apiDownload` делает из ответа `Blob` и жмёт невидимую
 * ссылку. Проверять там нечего — важно, что ушло на сервер; `URL.createObjectURL`, которого в
 * jsdom нет вовсе, подменён заглушкой ниже.
 */

const EXPORT = 'GET /analytics/export';
const READINGS = 'Показания автотранспорта';
const ANALYTICS = 'Сводная аналитика по заказчикам';

const OBJECTS = [
  objectDto({ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }),
  objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' }),
];

/** Ответ книги: тело тесту безразлично — важны заголовок имени и сам факт ответа. */
const BOOK: MockResponse = {
  status: 200,
  body: 'PK',
  headers: { 'content-disposition': "attachment; filename*=UTF-8''svod.xlsx" },
};

/** Приметы панелей: по ним видно, какая книга сейчас показана. */
const readingsPanel = () => screen.queryByText(/Книга Excel по показаниям автотранспорта/u);
const analyticsPanel = () => screen.queryByText(/Книга Excel по работе трёх модулей/u);

function renderExports(permissions: Permission[], role: Role = 'dispatcher'): HttpMock {
  const http = mockHttp({
    'GET /objects': () => json(list(OBJECTS)),
    [EXPORT]: () => BOOK,
  });
  // Роль задаётся отдельно от прав: право собранного набора живёт списком (ADR 0106), а область —
  // ролью, и проверяется здесь как раз их сочетание.
  renderWithUser(<ExportsTab />, { user: authUser({ permissions, role }) });
  return http;
}

/**
 * Период — руками в оба поля диапазона: календарь в jsdom мышью не открывается, а набранное
 * значение antd принимает по Enter. Пресетами длинный период не задать — они календарные и
 * длиннее года не бывают, а проверяется как раз запрет на то, что за год выходит.
 */
function setPeriod(from: string, to: string): void {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('.ant-picker-range input')];
  if (inputs.length < 2) throw new Error('поля периода на экране нет');
  for (const [index, value] of [from, to].entries()) {
    const input = inputs[index]!;
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
  }
}

function downloadButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Скачать книгу/u }) as HTMLButtonElement;
}

beforeAll(() => {
  // jsdom не умеет ни того, ни другого, а `apiDownload` зовёт оба: без заглушек падал бы
  // транспорт, а не проверяемое поведение.
  URL.createObjectURL = () => 'blob:exports-tab';
  URL.revokeObjectURL = () => {};
});

describe('вкладка «Выгрузки» открывается любым из двух прав', () => {
  for (const permission of ['vehicleReadings.export', 'analytics.export'] as const) {
    it(`${permission}: вкладка есть`, async () => {
      mockHttp({ 'GET /objects': () => json(list(OBJECTS)) });
      renderWithUser(<AdministrationPage />, { user: authUser({ permissions: [permission] }) });
      // Права независимы: у держателя одного из них это единственная вкладка страницы, и не
      // покажи её страница — выданное право осталось бы без двери.
      expect(await screen.findByRole('tab', { name: 'Выгрузки' })).toBeDefined();
    });
  }
});

describe('реестр выгрузок', () => {
  it('показывает в списке только доступные виды', async () => {
    renderExports(['vehicleReadings.export', 'analytics.export']);

    const options = await openSelectOptions('Вид выгрузки');
    expect(options.map((o) => o.textContent)).toEqual([READINGS, ANALYTICS]);
  });

  it('с одним правом список остаётся на экране, но выбирать в нём нечего', async () => {
    renderExports(['analytics.export']);

    // Список не спрятан: человек видит, что выгрузок в портале несколько, и читает, почему ему
    // видна одна. Спрятанный список соврал бы, что выгрузка одна вообще.
    expect(await screen.findByText(/Выгрузок в портале 2, вам доступно: 1/u)).toBeDefined();
    expect(document.querySelector('.ant-select-disabled')).not.toBeNull();
    expect(analyticsPanel()).not.toBeNull();
    expect(readingsPanel()).toBeNull();
  });

  it('переключение вида меняет панель', async () => {
    renderExports(['vehicleReadings.export', 'analytics.export']);

    // Первой стоит первая строка реестра — выгрузка показаний.
    expect(readingsPanel()).not.toBeNull();
    expect(analyticsPanel()).toBeNull();

    await selectOption('Вид выгрузки', ANALYTICS);

    await waitFor(() => expect(analyticsPanel()).not.toBeNull());
    expect(readingsPanel()).toBeNull();
  });
});

describe('форма сводной аналитики', () => {
  it('называет листы теми же именами, что стоят на корешках в книге', async () => {
    renderExports(['analytics.export']);
    await screen.findByText(/Книга Excel по работе трёх модулей/u);

    /*
     * Имена сокращены сборщиком книги (`services/analytics-export.ts`): у Excel потолок 31 знак, и
     * «Качество данных» с «Параметрами и методикой» стали «Качеством» и «Параметрами». Обещанный
     * формой корешок, которого в книге нет, — это поиск несуществующего листа, поэтому список
     * закреплён проверкой.
     */
    for (const name of [
      'Свод',
      'Детализация',
      'Инфографика',
      'Данные',
      'Сводная',
      'Качество',
      'Параметры',
    ]) {
      expect(screen.getByText(name)).toBeDefined();
    }
  });

  it('учётке с суженной областью объясняет отказ до нажатия и теми же словами, что сервер', async () => {
    // Право выдали полномочием роли без оси, а роль учётки сменили на площадочную: право осталось,
    // ось появилась — и ручка ответит отказом (Р3, `assertWholeOrganizationScope`).
    const http = renderExports(['analytics.export'], 'rukstroy');
    const axis = roleScopeAxis('rukstroy');

    // Ось названа подписью контрактов — той же, которой её называет отказ сервера: разойдись они,
    // человек выбирал бы, какому из двух объяснений верить.
    expect(
      await screen.findByText(
        new RegExp(`область ограничена \\(${roleScopeAxisLabels[axis]}\\)`, 'u'),
      ),
    ).toBeDefined();
    // Формы нет вовсе: поля, которые ни к чему не приведут, сами по себе обещание.
    expect(screen.queryByRole('button', { name: /Скачать книгу/u })).toBeNull();
    expect(http.countOf(EXPORT)).toBe(0);
    // И справочник площадок не спрашивается: выбирать из него нечего.
    expect(http.countOf('GET /objects')).toBe(0);
  });

  it('не пускает период длиннее года и объясняет причину', async () => {
    const http = renderExports(['analytics.export']);
    await screen.findByText(/Книга Excel по работе трёх модулей/u);

    setPeriod('01.01.2025', '31.12.2026');

    // Не «кнопка молча ничего не делает»: рядом написано, сколько дней выбрано и сколько можно.
    expect(await screen.findByText(/Дней в периоде: 730/u)).toBeDefined();
    await waitFor(() => expect(downloadButton().hasAttribute('disabled')).toBe(true));

    fireEvent.click(downloadButton());
    expect(http.countOf(EXPORT)).toBe(0);
  });

  it('шлёт период и шаг, а выбранную площадку — параметром chartObjectId', async () => {
    const http = renderExports(['analytics.export']);
    await screen.findByText(/Книга Excel по работе трёх модулей/u);

    await selectOption('Шаг', 'Квартал');
    await selectOption('Площадка для листа инфографики', 'ОБ-2 — ЖК Южный');
    fireEvent.click(downloadButton());

    await waitFor(() => expect(http.countOf(EXPORT)).toBe(1));
    const call = http.lastCall(EXPORT)!;
    expect(call.query.get('step')).toBe('quarter');
    expect(call.query.get('chartObjectId')).toBe('obj-2');
    // Умолчание периода — прошедший месяц целиком: за него свод и заказывают, когда месяц закрыт.
    expect(call.query.get('from')).toMatch(/^\d{4}-\d{2}-01$/u);
  });

  it('без выбранной площадки параметр не уходит вовсе', async () => {
    const http = renderExports(['analytics.export']);
    await screen.findByText(/Книга Excel по работе трёх модулей/u);

    fireEvent.click(downloadButton());

    await waitFor(() => expect(http.countOf(EXPORT)).toBe(1));
    // Пустой параметр схема запроса отвергает, а не пропускает: «инфографика ни по какой
    // площадке» — не вопрос, и лист в такой книге просто не собирается (Р12а).
    expect(http.lastCall(EXPORT)!.query.has('chartObjectId')).toBe(false);
  });
});
