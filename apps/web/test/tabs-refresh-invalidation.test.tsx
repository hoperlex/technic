import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { DirectoriesPage } from '../src/pages/DirectoriesPage';

/**
 * Переключение вкладки справочников обновляет то, что покажет.
 *
 * Скрытая вкладка `Tabs` не размонтируется, поэтому по возвращении она показывает кэш, набранный
 * до правок на соседней. Для справочников это больнее, чем для прочих разделов: они ссылаются
 * друг на друга, и сервер приклеивает поля соседа к списку — у техники названия типа и категории,
 * у прайса объём контейнера, по которому считают стоимость. Пока обновления не было, переименовал
 * тип на одной вкладке — и на другой видишь старое название до перезагрузки страницы, а не
 * десять секунд `staleTime`.
 *
 * Проверяется пометка кэша, а не перерисовка: у тестового `QueryClient` `staleTime` равен нулю,
 * поэтому вкладка перезапросила бы данные и сама.
 */

/** Посторонний запрос в кэше: он и показывает, что обновление задевает не только свою вкладку. */
const OTHER_KEY = ['vehicles', {}];

describe('справочники: переключение вкладки обновляет данные', () => {
  it('переключение помечает кэш соседних вкладок устаревшим', async () => {
    mockHttp({
      'GET /objects': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      // Ответственных за объект выбирают из учёток — вкладка объектов спрашивает их сразу.
      'GET /users': () => json(emptyList()),
    });

    const { queryClient } = renderWithUser(<DirectoriesPage />, {
      user: authUser({ role: 'admin' }),
    });

    // Первая вкладка отрисована — остальные antd монтирует только при показе.
    expect(await screen.findByRole('tab', { name: 'Отделы' })).toBeDefined();

    queryClient.setQueryData(OTHER_KEY, { items: [], total: 0 });
    expect(queryClient.getQueryState(OTHER_KEY)?.isInvalidated).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Отделы' }));

    await waitFor(() => expect(queryClient.getQueryState(OTHER_KEY)?.isInvalidated).toBe(true));
  });
});
