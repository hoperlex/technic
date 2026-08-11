import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DriverDto, DriverLicenseDto } from '@technic/contracts';
import { DriversTab } from '../src/pages/directories/DriversTab';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';

/**
 * Отбор по комплекту документов для путевого листа (ADR 0037).
 *
 * Полнота считается сервером — фильтр применяется до страницы, — поэтому проверяется то, что от
 * экрана и зависит: с каким запросом он уходит и что говорит про неполный комплект. Пустая графа
 * «Дата выдачи» в строке не видна ничем иным: отобрав неполных, человек должен понимать, что
 * вносить, иначе фильтр отвечает на половину вопроса.
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

/** Заведён кадровой выгрузкой: категории есть, даты выдачи нет — лист напечатается с пустой графой. */
const INCOMPLETE = driver({
  id: 'p2',
  lastName: 'Петров',
  firstName: 'Пётр',
  middleName: 'Петрович',
  fullName: 'Петров Пётр Петрович',
  personnelNo: '0002',
  licenses: [license({ id: 'l2', issuedOn: null })],
});

function mockDirectory(items: DriverDto[] = [driver(), INCOMPLETE]) {
  return mockHttp({
    'GET /drivers': () => json(list(items)),
    'GET /drivers/license-categories': () => json([]),
    'GET /drivers/job-titles': () =>
      json([
        { jobTitle: 'Водитель', credentialTypeCode: 'driver_license', count: 2 },
        { jobTitle: 'машинист экскаватора', credentialTypeCode: 'tractor_license', count: 1 },
      ]),
  });
}

/** Выбор в выпадашке панели: комплект документов стоит первым, должность — второй. */
function pickInFilter(index: number, startsWith: string) {
  const field = document.querySelectorAll('.ant-select')[index]!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  return waitFor(() => {
    const option = [...document.querySelectorAll('.ant-select-item-option')].find((o) =>
      o.textContent?.startsWith(startsWith),
    );
    expect(option).toBeTruthy();
    fireEvent.click(option!);
  });
}

const pickDocumentSet = (label: string) => pickInFilter(0, label);
const pickJobTitle = (label: string) => pickInFilter(1, label);

describe('справочник водителей: комплект документов', () => {
  it('без выбора список не сужается: фильтр в запрос не уходит', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);

    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));
    expect(http.lastCall('GET /drivers')!.query.get('documents')).toBeNull();
  });

  it('«Неполный комплект» уходит на сервер отдельным параметром', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));

    await pickDocumentSet('Неполный комплект');

    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(2));
    expect(http.lastCall('GET /drivers')!.query.get('documents')).toBe('incomplete');
    // Список возвращается на первую страницу: та же страница при другом отборе — другие записи.
    expect(http.lastCall('GET /drivers')!.query.get('page')).toBe('1');
  });

  it('обратное значение отбирает тех, кем можно закрывать рейсы', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));

    await pickDocumentSet('Полный комплект');

    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(2));
    expect(http.lastCall('GET /drivers')!.query.get('documents')).toBe('complete');
  });

  it('строка называет недостающее: пустой даты выдачи иначе не видно нигде', async () => {
    mockDirectory();
    renderWithUser(<DriversTab />);

    await screen.findByText('Петров Пётр Петрович');
    // Документ назван своим именем: у водителя это ВУ, у машиниста экскаватора было бы УТМ.
    expect(screen.getByText('Дата выдачи ВУ не внесена')).toBeTruthy();
    // У полного комплекта пометки нет: предупреждение при заполненной карточке обесценивает себя.
    expect(screen.queryByText('СНИЛС не внесён')).toBeNull();
  });

  it('колонки чужого документа фильтр по должности не строит', async () => {
    // Машинист экскаватора допущен тракторным (ADR 0095): колонки ВУ у отобранных пусты у всех
    // строк и лишь занимают ширину, а «Категории ВУ» рядом с «Категориями УТМ» читаются как
    // второй набор букв у одного человека.
    const http = mockDirectory();
    renderWithUser(<DriversTab />);
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));
    expect(screen.getAllByText('ВУ').length).toBeGreaterThan(0);

    await pickJobTitle('машинист экскаватора');

    await waitFor(() =>
      expect(http.lastCall('GET /drivers')!.query.get('jobTitle')).toBe('машинист экскаватора'),
    );
    await waitFor(() => expect(screen.queryAllByText('ВУ')).toHaveLength(0));
    expect(screen.queryAllByText('Категории ВУ')).toHaveLength(0);
    expect(screen.getAllByText('УТМ').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Категории УТМ').length).toBeGreaterThan(0);
  });
});
