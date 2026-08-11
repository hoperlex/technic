import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DriverDto, DriverLicenseDto } from '@technic/contracts';
import { DriversTab } from '../src/pages/directories/DriversTab';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';

/**
 * Два вида документа в справочнике водителей (ADR 0095).
 *
 * За погрузчик и экскаватор садятся по удостоверению тракториста-машиниста, а буквы категорий у
 * него те же, что у водительского: «C» тракториста — не грузовик. Поэтому документы разведены
 * колонками и блоками карточки, а какой из них у человека спрашивают, решает должность.
 *
 * Проверяется то, ради чего правило вводилось: строка показывает документ в своей колонке, пробел
 * комплекта назван той бумагой, которую понесут в кабину, а окно заведения открывается с видом по
 * должности и этим же видом уходит на сервер.
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
    verifiedAt: null,
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

/** Машинист экскаватора: тракторное заведено без даты выдачи, водительского нет вовсе. */
const MACHINIST = driver({
  id: 'p2',
  lastName: 'Петров',
  firstName: 'Пётр',
  middleName: 'Петрович',
  fullName: 'Петров Пётр Петрович',
  personnelNo: '0002',
  jobTitle: 'Машинист экскаватора',
  licenses: [
    license({
      id: 'l2',
      credentialTypeCode: 'tractor_license',
      issuedOn: null,
      categories: [
        {
          categoryId: 'utm-c',
          code: 'c',
          name: 'C',
          validFrom: null,
          validTo: null,
          restrictions: '',
        },
      ],
    }),
  ],
});

const DRIVER_CATEGORIES = [
  { id: 'cat-c', code: 'c', name: 'C', description: 'Грузовые свыше 3,5 т' },
];
const TRACTOR_CATEGORIES = [
  { id: 'utm-c', code: 'c', name: 'C', description: 'Колёсные машины от 25,7 до 110,3 кВт' },
];

function mockDirectory(items: DriverDto[] = [MACHINIST]) {
  return mockHttp({
    'GET /drivers': () => json(list(items)),
    // Категории спрашиваются видом документа: перепутанный вид виден тем, что в форме окажутся
    // чужие буквы, и подмена по виду — самый прямой способ это поймать.
    'GET /drivers/license-categories': ({ query }) =>
      json(query.get('type') === 'tractor_license' ? TRACTOR_CATEGORIES : DRIVER_CATEGORIES),
    'GET /drivers/job-titles': () =>
      json([{ jobTitle: 'Машинист экскаватора', credentialTypeCode: 'tractor_license', count: 1 }]),
    'POST /drivers/:id/licenses': () => json(MACHINIST),
  });
}

describe('справочник водителей: два вида документа', () => {
  it('документ стоит в колонке своего вида, а пробел назван его именем', async () => {
    mockDirectory();
    renderWithUser(<DriversTab />);

    await screen.findByText('Петров Пётр Петрович');
    expect(screen.getByText('Машинист экскаватора')).toBeTruthy();
    // Номер тракторного — один на строку: в колонке ВУ у машиниста стоит «Не заведено».
    expect(screen.getByText('99 39 482645')).toBeTruthy();
    expect(screen.getByText('Не заведено')).toBeTruthy();
    // Пробел назван той бумагой, которую понесут в кабину, а не водительским удостоверением.
    expect(screen.getByText('Дата выдачи УТМ не внесена')).toBeTruthy();
  });

  it('карточка показывает оба документа своими блоками', async () => {
    mockDirectory();
    renderWithUser(<DriversTab />);

    await screen.findByText('Петров Пётр Петрович');
    fireEvent.click(document.querySelector('.ant-table-tbody .anticon-edit')!.closest('button')!);

    await screen.findByText('Карточка водителя');
    expect(screen.getByText('Водительское удостоверение')).toBeTruthy();
    expect(screen.getByText('Удостоверение тракториста-машиниста')).toBeTruthy();
    // У ненужного по должности документа отсутствие объяснено, а не подано пробелом карточки.
    expect(screen.getByText(/По должности этот документ от человека и не требуется/)).toBeTruthy();
  });

  it('окно заведения открывается видом по должности и им же уходит на сервер', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);

    await screen.findByText('Петров Пётр Петрович');
    fireEvent.click(document.querySelector('[title="Заменить удостоверение"]')!);

    await screen.findByText('Новое удостоверение');
    // Вид подставлен должностью: заводить машинисту водительское никто не запрещает, но
    // спрашивать его первым значило бы предлагать не ту бумагу (ADR 0095).
    expect(screen.getByText('Удостоверение тракториста-машиниста')).toBeTruthy();
    await waitFor(() =>
      expect(http.lastCall('GET /drivers/license-categories')!.query.get('type')).toBe(
        'tractor_license',
      ),
    );

    fireEvent.change(screen.getByPlaceholderText('482645'), { target: { value: 'СВ 123456' } });
    fireEvent.click(screen.getByText('Сохранить').closest('button')!);

    // Категорий у тракторного в кадровой выгрузке не бывает — форма их и не требует.
    await waitFor(() => expect(http.countOf('POST /drivers/:id/licenses')).toBe(1));
    expect(http.lastCall('POST /drivers/:id/licenses')!.body).toMatchObject({
      credentialType: 'tractor_license',
      number: 'СВ 123456',
      categories: [],
    });
  });
});
