import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ContainerTypeDto } from '@technic/contracts';
import { ContainerTypesTab } from '../src/pages/directories/ContainerTypesTab';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';

/**
 * Состав тела правки типа контейнера.
 *
 * Тест заведён по итогам разбора, а не «для покрытия»: `updateContainerTypeSchema` объявлена
 * `.strict()` и колонки `code` не знает, а форма отдавала её в теле — `disabled` у поля убирает
 * ввод, но не значение из формы antd. Сервер отвечал на ЛЮБУЮ правку ошибкой валидации: ни
 * переименовать тип, ни подвинуть порядок сортировки было нельзя, и заметить это можно было только
 * руками — типы проверяются на входе, а не на теле запроса.
 *
 * Проверяются оба случая в одном месте нарочно: разойдись они, починка правки сломала бы заведение
 * молча — код обязателен при создании и запрещён при обновлении.
 */

function containerType(over: Partial<ContainerTypeDto> = {}): ContainerTypeDto {
  return {
    id: 'ct-1',
    code: 'cont8',
    name: 'Контейнер 8 м³',
    type: 'cont',
    volumeM3: 8,
    sortOrder: 10,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function renderTab(items: ContainerTypeDto[]): HttpMock {
  const http = mockHttp({
    'GET /container-types': () => json(list(items)),
    'POST /container-types': () => json(containerType({ id: 'ct-2' })),
    'PATCH /container-types/:id': ({ params }) => json(containerType({ id: params.id })),
  });
  renderWithUser(<ContainerTypesTab />, { user: authUser({ id: 'user-admin', role: 'admin' }) });
  return http;
}

const rowActionButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>('tbody td.no-row-click button'),
];

const saveButton = () =>
  [...document.querySelectorAll('.ant-modal button')].find(
    (b) => b.textContent === 'Сохранить',
  ) as HTMLElement;

function fieldByLabel(label: string): HTMLInputElement {
  const body = document.querySelector('.ant-modal-body');
  if (!body) throw new Error('карточка типа не открыта');
  return within(body as HTMLElement).getByLabelText(label) as HTMLInputElement;
}

describe('справочник типов контейнеров: состав тела', () => {
  it('правка уходит без кода — строгая схема сервера его не принимает', async () => {
    const http = renderTab([containerType()]);

    await screen.findByText('Контейнер 8 м³');
    const edit = rowActionButtons()[0];
    if (!edit) throw new Error('кнопок в строке нет');
    fireEvent.click(edit);
    fireEvent.change(fieldByLabel('Название'), { target: { value: 'Контейнер 8 м³ (новый)' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(http.countOf('PATCH /container-types/:id')).toBe(1));
    const body = http.lastCall('PATCH /container-types/:id')!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('code');
    expect(body.name).toBe('Контейнер 8 м³ (новый)');
  });

  it('заведение код по-прежнему шлёт: без него сервер не примет', async () => {
    const http = renderTab([]);

    fireEvent.click(await screen.findByRole('button', { name: /Добавить/ }));
    fireEvent.change(fieldByLabel('Код'), { target: { value: 'cont20' } });
    fireEvent.change(fieldByLabel('Название'), { target: { value: 'Контейнер 20 м³' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(http.countOf('POST /container-types')).toBe(1));
    expect(http.lastCall('POST /container-types')!.body).toMatchObject({ code: 'cont20' });
  });
});
