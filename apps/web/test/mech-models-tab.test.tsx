import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MechModelDto } from '@technic/contracts';
import { MechModelsTab } from '../src/pages/directories/MechModelsTab';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';

/**
 * Справочник моделей малой механизации (план `docs/mechanization-models-directory-plan.md`, Э1).
 *
 * Вкладка собрана по образцу «Типов контейнеров», и проверяется то, что от образца отличается или
 * ломается молча.
 *
 * Первое — куда уходят заведение и правка. Ручки у справочника свои (`/mech-models`), и ошибиться
 * адресом, копируя соседнюю вкладку, легче всего: заявка на механизацию отвечает по соседнему
 * пути, а промах виден только на сервере.
 *
 * Второе — правка не заводит второй строки: `PATCH` по id, а не `POST` заново. Код при этом не
 * трогается вовсе — он стабильный идентификатор позиции.
 *
 * Третье — удаление насовсем (ADR 0060) предлагается только у погашенной строки. Показанное на
 * действующей, оно обещало бы то, чего делать нельзя: на модель ссылаются заявки на аренду, и
 * сервер откажет.
 */

function mechModel(over: Partial<MechModelDto> = {}): MechModelDto {
  return {
    id: 'mm-1',
    code: 'vibroplita-wacker-dpu-3070n',
    name: 'Виброплита Wacker DPU 3070Н',
    sortOrder: 100,
    isActive: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const admin = authUser({ id: 'user-admin', role: 'admin' });

function renderTab(items: MechModelDto[], user = admin): HttpMock {
  const http = mockHttp({
    'GET /mech-models': () => json(list(items)),
    'POST /mech-models': () => json(mechModel({ id: 'mm-2' })),
    'PATCH /mech-models/:id': ({ params }) => json(mechModel({ id: params.id })),
    'DELETE /mech-models/:id/purge': () => json({ ok: true }),
  });
  renderWithUser(<MechModelsTab />, { user });
  return http;
}

/**
 * Кнопки строки берутся из колонки действий, а не из всей строки: переключатель активности antd
 * рисует тем же `<button>`, и поиск по `tbody` нашёл бы сперва его — тест правки открывал бы
 * подтверждение деактивации вместо карточки.
 */
const rowActionButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>('tbody td.no-row-click button'),
];

/** Кнопка удаления насовсем — вторая в колонке действий; у действующей модели её нет вовсе. */
const purgeButton = (): HTMLButtonElement | undefined =>
  rowActionButtons().find((b) => b.getAttribute('title') === 'Удалить окончательно');

/** Кнопка правки — первая в колонке действий. */
function editButton(): HTMLButtonElement {
  const found = rowActionButtons()[0];
  if (!found) throw new Error('кнопок в строке нет');
  return found;
}

const saveButton = () =>
  [...document.querySelectorAll('.ant-modal button')].find(
    (b) => b.textContent === 'Сохранить',
  ) as HTMLElement;

/**
 * Поле открытой карточки по подписи. Ищется внутри окна, а не по всей странице: подпись
 * «Название» стоит ещё и в заголовке столбца таблицы, и поиск по документу нашёл бы оба.
 */
function fieldByLabel(label: string): HTMLInputElement {
  const body = document.querySelector('.ant-modal-body');
  if (!body) throw new Error('карточка модели не открыта');
  return within(body as HTMLElement).getByLabelText(label) as HTMLInputElement;
}

describe('вкладка «Модели механизации»', () => {
  it('просит алфавит явно: умолчание сервера открыло бы справочник задом наперёд', async () => {
    const http = renderTab([mechModel()]);

    await screen.findByText('Виброплита Wacker DPU 3070Н');
    const query = http.lastCall('GET /mech-models')!.query;
    expect(query.get('sortBy')).toBe('name');
    expect(query.get('sortOrder')).toBe('asc');
  });

  it('заведение уходит в свою ручку со своими полями', async () => {
    const http = renderTab([]);

    fireEvent.click(await screen.findByRole('button', { name: /Добавить модель/ }));
    fireEvent.change(fieldByLabel('Код'), { target: { value: 'kompressor-xas-970' } });
    fireEvent.change(fieldByLabel('Название'), { target: { value: 'Компрессор XAS 970' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(http.countOf('POST /mech-models')).toBe(1));
    expect(http.lastCall('POST /mech-models')!.body).toMatchObject({
      code: 'kompressor-xas-970',
      name: 'Компрессор XAS 970',
      isActive: true,
      sortOrder: 100,
    });
    // Правку заведение не задевает: второго запроса не было.
    expect(http.countOf('PATCH /mech-models/:id')).toBe(0);
  });

  it('правка уходит в свою ручку по id, а код в ней не трогают', async () => {
    const http = renderTab([mechModel()]);

    await screen.findByText('Виброплита Wacker DPU 3070Н');
    fireEvent.click(editButton());

    // Код — стабильный идентификатор позиции: в открытой на правку карточке он заперт.
    expect(fieldByLabel('Код').disabled).toBe(true);
    fireEvent.change(fieldByLabel('Название'), {
      target: { value: 'Виброплита Wacker DPU 3070Н (см)' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => expect(http.countOf('PATCH /mech-models/:id')).toBe(1));
    const call = http.lastCall('PATCH /mech-models/:id')!;
    expect(call.path).toContain('mm-1');
    expect(call.body).toMatchObject({ name: 'Виброплита Wacker DPU 3070Н (см)' });
    // Кода в теле правки нет вовсе: `updateMechModelSchema` строгая и отвергла бы весь запрос
    // вместе с переименованием — а поле в карточке стоит и значение своё держит.
    expect(Object.keys(call.body as object)).not.toContain('code');
    // Заведения не случилось: правка не должна плодить вторую строку того же справочника.
    expect(http.countOf('POST /mech-models')).toBe(0);
  });

  it('у действующей модели удаления насовсем нет даже у администратора', async () => {
    renderTab([mechModel()]);

    await screen.findByText('Виброплита Wacker DPU 3070Н');
    expect(purgeButton()).toBeUndefined();
  });

  it('погашенную модель администратор сносит насовсем после подтверждения', async () => {
    const http = renderTab([mechModel({ isActive: false })]);

    await screen.findByText('Виброплита Wacker DPU 3070Н');
    const button = purgeButton();
    expect(button).toBeTruthy();
    fireEvent.click(button!);

    // Подтверждение называет запись и предупреждает о необратимости. Заголовок antd рисует
    // дважды (шапка и тело подтверждения) — важно, что он есть.
    const title = await screen.findAllByText(
      'Удалить модель «Виброплита Wacker DPU 3070Н» окончательно?',
    );
    expect(title.length).toBeGreaterThan(0);

    const confirm = [...document.querySelectorAll('.ant-modal button')].find(
      (b) => b.textContent === 'Удалить окончательно',
    );
    fireEvent.click(confirm!);

    await waitFor(() => expect(http.countOf('DELETE /mech-models/:id/purge')).toBe(1));
    expect(http.lastCall('DELETE /mech-models/:id/purge')!.path).toContain('mm-1');
  });

  it('без права `records.purge` кнопки нет и на погашенной модели', async () => {
    // Диспетчер ведёт справочники, но записи не сносит.
    renderTab([mechModel({ isActive: false })], authUser());

    await screen.findByText('Виброплита Wacker DPU 3070Н');
    expect(purgeButton()).toBeUndefined();
  });
});
