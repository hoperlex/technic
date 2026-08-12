import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DriverDto, DriverLicenseDto } from '@technic/contracts';
import { DriversTab } from '../src/pages/directories/DriversTab';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { selectOption } from './antd';
import { authUser } from './factories/auth';
import { list } from './factories/common';

/**
 * Убрать документ из карточки водителя (право `records.purge`).
 *
 * Не аннулирование: то говорит «документ был и перестал действовать», а это — «его тут быть не
 * должно»: опечатка в номере, чужая строка кадровой выгрузки, второй экземпляр того же
 * удостоверения. Пока лишняя запись лежит в карточке, она держит серию с номером, и настоящий
 * документ с теми же реквизитами не заводится вовсе — поэтому у замены есть галочка снятия
 * прежнего, а у каждой строки истории своя кнопка.
 *
 * Проверяется то, ради чего действие разведено с ведением документов: кнопка стоит у КАЖДОГО
 * документа (и у прежнего, и у тракторного), без права её нет ни у одного, а галочка замены
 * доходит до тела запроса — молча потерянная, она оставила бы человека с занятым номером.
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

/**
 * Водитель с полной историей: действующее ВУ, прежнее ВУ и тракторное. Все три случая в одной
 * карточке — кнопка обязана стоять у каждого, а не только у той бумаги, о которой говорит панель
 * действий блока.
 */
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
    licenses: [
      license(),
      license({ id: 'l2', series: '77 01', number: '000002', expiresOn: '2021-03-11' }),
      license({
        id: 'l3',
        credentialTypeCode: 'tractor_license',
        series: 'СВ',
        number: '123456',
        categories: [],
      }),
    ],
    version: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

const admin = authUser({ id: 'user-admin', role: 'admin' });

const DRIVER_CATEGORIES = [
  { id: 'cat-c', code: 'c', name: 'C', description: 'Грузовые свыше 3,5 т' },
];

function mockDirectory(items: DriverDto[] = [driver()]) {
  return mockHttp({
    'GET /drivers': () => json(list(items)),
    'GET /drivers/license-categories': () => json(DRIVER_CATEGORIES),
    'GET /drivers/job-titles': () =>
      json([{ jobTitle: 'Водитель', credentialTypeCode: 'driver_license', count: 1 }]),
    'POST /drivers/:id/licenses': () => json(items[0]),
    'DELETE /drivers/:id/licenses/:licenseId': () => json(items[0]),
  });
}

/**
 * Кнопки снятия документа — по подписи для читалки: иконка одна и та же у удаления водителя в
 * строке таблицы, и поиск по `.anticon-delete` брал бы то одну, то другую.
 */
const deleteButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Убрать документ"]'),
];

/** Открыть карточку водителя — оттуда видны блоки документов. */
async function openCard() {
  await screen.findByText('Иванов Иван Иванович');
  fireEvent.click(document.querySelector('.ant-table-tbody .anticon-edit')!.closest('button')!);
  await screen.findByText('Карточка водителя');
}

describe('снятие документа с карточки водителя', () => {
  it('администратор видит кнопку у каждого документа, включая прежний и тракторное', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />, { user: admin });

    await openCard();

    // Кнопка у каждой строки: убирают чаще как раз не действующий документ, а лишний — второй
    // экземпляр или опечатку, и до неё через панель действий блока было бы не добраться.
    expect(deleteButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Убрать документ 99 39 482645',
      'Убрать документ 77 01 000002',
      'Убрать документ СВ 123456',
    ]);

    fireEvent.click(deleteButtons()[1]!);

    // Подтверждение называет саму бумагу: документов у человека три, и «убрать удостоверение?»
    // без реквизитов не сказало бы, какой из них исчезнет. Заголовок antd рисует дважды.
    const title = await screen.findAllByText('Убрать ВУ 77 01 000002?');
    expect(title.length).toBeGreaterThan(0);
    expect(screen.getByText(/выданные по нему путевые листы сохранятся/i)).toBeTruthy();

    fireEvent.click(
      [...document.querySelectorAll('.ant-modal-confirm-btns button')].find(
        (b) => b.textContent === 'Убрать',
      )!,
    );

    // Документ адресуется своим идентификатором, а не «действующим у водителя»: снимают именно
    // ту строку, у которой нажали.
    await waitFor(() => expect(http.countOf('DELETE /drivers/:id/licenses/:licenseId')).toBe(1));
    expect(http.lastCall('DELETE /drivers/:id/licenses/:licenseId')!.path).toBe(
      '/drivers/p1/licenses/l2',
    );
  });

  it('без права `records.purge` кнопок нет ни у одного документа', async () => {
    mockDirectory();
    // Диспетчер ведёт водителей (`drivers.write`), но стирать заведённое — полномочие
    // администратора: показанная ему кнопка вела бы в 403.
    renderWithUser(<DriversTab />);

    await openCard();

    // Карточка та же и документы в ней те же — не видно именно кнопок.
    expect(screen.getByText(/Действующее: 99 39 482645/)).toBeTruthy();
    expect(screen.getByText(/Прежнее: 77 01 000002/)).toBeTruthy();
    expect(deleteButtons()).toHaveLength(0);
  });
});

/** Галочка окна замены — тот же снос, но заодно с заведением нового документа. */
const previousCheckbox = () =>
  [...document.querySelectorAll('label.ant-checkbox-wrapper')].find((l) =>
    l.textContent?.includes('Убрать прежнее'),
  );

async function openReplace() {
  await screen.findByText('Иванов Иван Иванович');
  fireEvent.click(document.querySelector('[title="Заменить удостоверение"]')!);
  await screen.findByText('Новое удостоверение');
}

/** Заполнить окно замены минимумом, который примет форма: номер и категория ВУ. */
async function fillLicense() {
  fireEvent.change(screen.getByPlaceholderText('482645'), { target: { value: 'СВ 999999' } });
  await selectOption('Категории ВУ', /Грузовые свыше 3,5 т/);
}

describe('замена удостоверения со снятием прежнего', () => {
  it('администратор отмечает снятие прежнего, и оно уходит в теле запроса', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />, { user: admin });

    await openReplace();

    // Галочка перечисляет то, что снимет, — все документы этого вида, а не только действующий:
    // номер держит любая запись, и оставленная история снова упрётся в занятые реквизиты.
    const checkbox = previousCheckbox();
    expect(checkbox).toBeTruthy();
    expect(checkbox!.textContent).toContain('99 39 482645');
    expect(checkbox!.textContent).toContain('77 01 000002');
    // Тракторное к замене ВУ отношения не имеет и в списке снимаемого стоять не должно.
    expect(checkbox!.textContent).not.toContain('СВ 123456');

    fireEvent.click(checkbox!.querySelector('input')!);
    await fillLicense();
    fireEvent.click(screen.getByText('Сохранить').closest('button')!);

    await waitFor(() => expect(http.countOf('POST /drivers/:id/licenses')).toBe(1));
    expect(http.lastCall('POST /drivers/:id/licenses')!.body).toMatchObject({
      credentialType: 'driver_license',
      number: 'СВ 999999',
      deletePrevious: true,
    });
  });

  it('без права галочки нет, и прежнее остаётся историей', async () => {
    const http = mockDirectory();
    renderWithUser(<DriversTab />);

    await openReplace();

    expect(previousCheckbox()).toBeUndefined();
    // Окно объясняет судьбу прежнего документа и без галочки: иначе замена читалась бы как
    // затирание, и человек искал бы, где включить сохранение истории.
    expect(screen.getByText(/Прежнее удостоверение останется в карточке/)).toBeTruthy();

    await fillLicense();
    fireEvent.click(screen.getByText('Сохранить').closest('button')!);

    // Поле уходит явным `false`, а не пропуском: сервер разбирает тело схемой, и умолчание
    // «снять» на стороне сервера означало бы снос по недосмотру портала.
    await waitFor(() => expect(http.countOf('POST /drivers/:id/licenses')).toBe(1));
    expect(http.lastCall('POST /drivers/:id/licenses')!.body).toMatchObject({
      deletePrevious: false,
    });
  });
});
