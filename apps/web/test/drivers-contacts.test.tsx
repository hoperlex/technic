import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DriverDto } from '@technic/contracts';
import { DriversTab } from '../src/pages/directories/DriversTab';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { MOBILE_VIEWPORT } from './viewport';

/**
 * Контакты водителя в справочнике: одна графа в две строки вместо колонки «Email».
 *
 * Адрес и телефон читают вместе — вопрос у человека один: «как достать этого водителя». Отсюда две
 * вещи, которые проверяются здесь. Первая — отсутствие пишется словом: пустая ячейка читается как
 * «не досмотрели», а «не указан» — как «звонить некуда, и это известно». Вторая — поиск в шапке
 * графы уходит на сервер: ключ столбца сменился с `email` на `contacts`, и связка `searchKeys`
 * рвётся молча — поле поиска остаётся на месте и перестаёт что-либо отбирать.
 */

function driver(over: Partial<DriverDto> = {}): DriverDto {
  return {
    id: 'p1',
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович',
    fullName: 'Иванов Иван Иванович',
    birthDate: null,
    phone: '9261234567',
    email: 'ivanov@example.com',
    snils: '11223344595',
    comment: '',
    personnelNo: '0001',
    jobTitle: 'Водитель',
    employedSince: null,
    licenses: [],
    version: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

function mockDirectory(items: DriverDto[] = [driver()]) {
  return mockHttp({
    'GET /drivers': () => json(list(items)),
    'GET /drivers/license-categories': () => json([]),
    'GET /drivers/job-titles': () =>
      json([{ jobTitle: 'Водитель', credentialTypeCode: 'driver_license', count: 1 }]),
  });
}

/** Поиск в шапке графы: кнопка-лупа, поле выпадающего окна, кнопка «Найти». */
async function searchInContacts(term: string) {
  const header = [...document.querySelectorAll('th')].find((th) =>
    th.textContent?.includes('Контакты'),
  );
  expect(header).toBeTruthy();
  fireEvent.click(header!.querySelector('.ant-table-filter-trigger')!);

  const input = await screen.findByPlaceholderText('Поиск');
  fireEvent.change(input, { target: { value: term } });
  fireEvent.click(screen.getByText('Найти').closest('button')!);
}

describe('справочник водителей: графа «Контакты»', () => {
  it('показывает адрес и номер вместе, номер — в общем формате', async () => {
    mockDirectory();
    renderWithUser(<DriversTab />);

    await screen.findByText('Иванов Иван Иванович');
    // Заголовок таблица рисует дважды (видимая шапка и слой измерения) — важно, что он есть.
    expect(screen.getAllByText('Контакты').length).toBeGreaterThan(0);
    expect(screen.getByText('ivanov@example.com')).toBeTruthy();
    expect(screen.getByText('+7 (926) 123 45 67')).toBeTruthy();
  });

  it('номер набирается нажатием: ссылка tel: с кодом страны', async () => {
    mockDirectory();
    renderWithUser(<DriversTab />);

    const link = await screen.findByText('+7 (926) 123 45 67');
    expect(link.getAttribute('href')).toBe('tel:+79261234567');
  });

  it('пустые контакты названы словом, каждый своей строкой', async () => {
    mockDirectory([driver({ email: '', phone: '' })]);
    renderWithUser(<DriversTab />);

    await screen.findByText('Иванов Иван Иванович');
    expect(screen.getByText('email не указан')).toBeTruthy();
    expect(screen.getByText('телефон не указан')).toBeTruthy();
  });

  it('заполнена половина — вторая строка всё равно на месте', async () => {
    mockDirectory([driver({ phone: '' })]);
    renderWithUser(<DriversTab />);

    await screen.findByText('Иванов Иван Иванович');
    expect(screen.getByText('ivanov@example.com')).toBeTruthy();
    expect(screen.getByText('телефон не указан')).toBeTruthy();
    expect(screen.queryByText('email не указан')).toBeNull();
  });

  it('на телефоне карточка говорит то же самое: обе строки контактов', async () => {
    // Карточками справочник читают с телефона (ADR 0030), и расходиться с таблицей она не должна:
    // «не указан» на большом экране и пропуск строки на маленьком — это два разных ответа.
    mockDirectory([driver(), driver({ id: 'p2', email: '', phone: '' })]);
    renderWithUser(<DriversTab />, { viewport: MOBILE_VIEWPORT });

    await screen.findAllByText('Иванов Иван Иванович');
    expect(screen.getByText('+7 (926) 123 45 67')).toBeTruthy();
    expect(screen.getByText('Email не указан')).toBeTruthy();
    expect(screen.getByText('Телефон не указан')).toBeTruthy();
  });

  it('поиск в шапке графы уходит на сервер: адрес', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));

    await searchInContacts('ivanov@');

    await waitFor(() => expect(http.lastCall('GET /drivers')!.query.get('search')).toBe('ivanov@'));
    // Список возвращается на первую страницу: та же страница при другом отборе — другие записи.
    expect(http.lastCall('GET /drivers')!.query.get('page')).toBe('1');
  });

  it('поиск в шапке графы уходит на сервер: номер, набранный как придётся', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));

    // Разбирает написание сервер (`phoneSearchCondition`) — страница отдаёт строку как набрали.
    await searchInContacts('8 (926) 123-45-67');

    await waitFor(() =>
      expect(http.lastCall('GET /drivers')!.query.get('search')).toBe('8 (926) 123-45-67'),
    );
  });
});
