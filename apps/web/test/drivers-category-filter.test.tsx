import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DriverDto, DriverLicenseDto } from '@technic/contracts';
import { DriversTab } from '../src/pages/directories/DriversTab';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { MOBILE_VIEWPORT } from './viewport';

/**
 * Категории прав в справочнике водителей (ADR 0055).
 *
 * Отбор под машину категорией больше не сужается, и справочник — единственное место, где о ней
 * узнают: «кого можно посадить за седельный тягач» спрашивают здесь. Поэтому категории стоят своей
 * колонкой, а не хвостом номера удостоверения, и отбираются запросом — глазами по страницам такой
 * вопрос не решается.
 */

function license(over: Partial<DriverLicenseDto> = {}): DriverLicenseDto {
  return {
    id: 'l1',
    credentialTypeCode: 'driver_license',
    series: '99 39',
    number: '482645',
    issuedOn: '2021-03-12',
    expiresOn: '2031-03-12',
    issuedBy: '',
    verificationStatus: 'verified',
    verifiedByName: null,
    verifiedAt: '2021-03-13T00:00:00.000Z',
    revokedAt: null,
    revokeReason: '',
    categories: [
      {
        categoryId: 'cat-c',
        code: 'c',
        name: 'C',
        validFrom: null,
        validTo: null,
        restrictions: '',
      },
      {
        categoryId: 'cat-ce',
        code: 'ce',
        name: 'CE',
        validFrom: null,
        validTo: null,
        restrictions: '',
      },
    ],
    ...over,
  };
}

function driver(over: Partial<DriverDto> = {}): DriverDto {
  return {
    id: 'p1',
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович',
    fullName: 'Иванов Иван Иванович',
    birthDate: null,
    phone: '',
    email: '',
    snils: '11223344595',
    comment: '',
    personnelNo: '0001',
    jobTitle: 'Водитель',
    employedSince: null,
    licenses: [license()],
    version: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

const CATEGORIES = [
  { id: 'cat-c', code: 'c', name: 'C', description: 'Грузовые свыше 3,5 т' },
  { id: 'cat-ce', code: 'ce', name: 'CE', description: 'Грузовые с прицепом' },
];

function mockDirectory(items: DriverDto[] = [driver()]) {
  return mockHttp({
    'GET /drivers': () => json(list(items)),
    'GET /drivers/license-categories': () => json(CATEGORIES),
    'GET /drivers/job-titles': () =>
      json([{ jobTitle: 'Водитель', credentialTypeCode: 'driver_license', count: 1 }]),
  });
}

/** Категория выбирается третьим фильтром панели: перед ней комплект документов и должность. */
async function pickCategory(label: string) {
  const field = document.querySelectorAll('.ant-select')[2]!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  await waitFor(() => {
    const option = [...document.querySelectorAll('.ant-select-item-option')].find((o) =>
      o.textContent?.startsWith(label),
    );
    expect(option).toBeTruthy();
    fireEvent.click(option!);
  });
}

describe('справочник водителей: категории прав', () => {
  it('на телефоне не сохраняет категорию прежнего удостоверения при смене должности в одной шторке', async () => {
    const http = mockHttp({
      'GET /drivers': () => json(list([driver()])),
      'GET /drivers/license-categories': ({ query }) =>
        json(
          query.get('type') === 'tractor_license'
            ? [{ id: 'tractor-c', code: 'c', name: 'C', description: 'Трактор' }]
            : CATEGORIES,
        ),
      'GET /drivers/job-titles': () =>
        json([
          { jobTitle: 'Водитель', credentialTypeCode: 'driver_license', count: 1 },
          { jobTitle: 'Машинист экскаватора', credentialTypeCode: 'tractor_license', count: 1 },
        ]),
    });
    renderWithUser(<DriversTab />, { viewport: MOBILE_VIEWPORT });
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));

    const selectInSheet = async (label: string, option: string) => {
      const row = [...document.querySelectorAll<HTMLElement>('.filter-sheet__row')].find((node) =>
        node.querySelector('.filter-sheet__label')?.textContent?.startsWith(label),
      );
      expect(row, label).toBeTruthy();
      fireEvent.mouseDown(row!.querySelector('.ant-select-selector')!);
      fireEvent.click(
        await screen.findByText(option, { selector: '.ant-select-item-option-content' }),
      );
    };

    fireEvent.click(screen.getByRole('button', { name: /Фильтры/ }));
    await selectInSheet('Должность', 'Водитель');
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() =>
      expect(http.lastCall('GET /drivers')?.query.get('jobTitle')).toBe('Водитель'),
    );

    fireEvent.click(screen.getByRole('button', { name: /Фильтры/ }));
    await selectInSheet('Должность', 'Машинист экскаватора');
    // The still-open sheet offers the applied title's category dictionary.
    await selectInSheet('Категория', 'C — Грузовые свыше 3,5 т');
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));

    await waitFor(() =>
      expect(http.lastCall('GET /drivers')?.query.get('jobTitle')).toBe('Машинист экскаватора'),
    );
    expect(http.lastCall('GET /drivers')?.query.has('categoryId')).toBe(false);
  });
  it('показывает категории отдельной колонкой', async () => {
    mockDirectory();
    renderWithUser(<DriversTab />);

    await screen.findByText('Иванов Иван Иванович');
    // Заголовок таблица рисует дважды (видимая шапка и слой измерения) — важно, что он есть.
    // Колонка названа видом документа: «C» водительского и «C» тракториста — разные машины.
    expect(screen.getAllByText('Категории ВУ').length).toBeGreaterThan(0);
    expect(screen.getByText('C, CE')).toBeTruthy();
  });

  it('водитель без удостоверения колонку не ломает', async () => {
    mockDirectory([driver({ id: 'p2', fullName: 'Петров Пётр Петрович', licenses: [] })]);
    renderWithUser(<DriversTab />);

    await screen.findByText('Петров Пётр Петрович');
    // Прочерк стоит у обеих колонок категорий: документов у человека нет ни того вида, ни другого.
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('без выбора категории список не сужается: параметр в запрос не уходит', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);

    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));
    expect(http.lastCall('GET /drivers')!.query.get('categoryId')).toBeNull();
  });

  it('выбранная категория уходит на сервер: считает её он, а не страница', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));

    await pickCategory('CE');

    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(2));
    expect(http.lastCall('GET /drivers')!.query.get('categoryId')).toBe('cat-ce');
    // Список возвращается на первую страницу: та же страница при другом отборе — другие записи.
    expect(http.lastCall('GET /drivers')!.query.get('page')).toBe('1');
  });
});
