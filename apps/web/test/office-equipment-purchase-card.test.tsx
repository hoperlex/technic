import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { permissionsFor, type AuthUser } from '@technic/contracts';
import { json, mockHttp, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { OfficeEquipmentPurchaseViewModal } from '../src/pages/service/OfficeEquipmentPurchaseViewModal';
import {
  consumableDto,
  detailDto,
  purchaseItem,
  PURCHASES,
} from './factories/officeEquipmentPurchase';

/**
 * Карточка плановой закупки: ходы по циклу и правка черновика (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р10, Р11, Р18).
 *
 * ПРАВКА ТОЛЬКО В «НОВОЙ», и это не оформление кнопок: после проведения бумага у снабжения, и
 * переписанный задним числом состав разошёлся бы с тем, по чему заказывают. Ошибку исправляют
 * отменой с причиной и новой закупкой.
 *
 * ДВА РАЗНЫХ 409 У ПРАВКИ, и различать их обязан портал: «уже провели» (документ ушёл дальше) и
 * «правил другой» (черновик тот же, версия не та). Исходы разные — первый закрывает правку вовсе,
 * второй показывает чужой состав, — и один ответ на два случая заставил бы человека гадать, куда
 * делась его правка.
 *
 * ГАЛОЧКА ПРИ ЗАКРЫТИИ ничего не доказывает и не притворяется проверкой (Р11): порядок «сначала
 * приход, потом закрытие» портал проверить не может, и текст обязан говорить это прямо.
 */

const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  permissions: [
    ...permissionsFor({ role: 'shtab', counterpartyType: null, addons: [] }),
    'officeEquipment.read',
    'officeEquipmentPurchases.manage',
  ],
});

const CONSUMABLES = 'GET /office-equipment-consumables';

function renderCard(over: RouteMap = {}) {
  const http = mockHttp({
    [PURCHASES.detail]: () => json(detailDto()),
    // Перечень действующих позиций: он нужен подбору «дописать строку» в форме правки.
    [CONSUMABLES]: () => json(list([consumableDto()])),
    ...over,
  });
  renderWithUser(<OfficeEquipmentPurchaseViewModal purchaseId="oep-1" onClose={() => {}} />, {
    user: OPERATOR,
  });
  return http;
}

/** Отказ 409 с разбором машиной: `apiError` поля `details` не знает, а именно им и различают три. */
function conflict(code: string, message: string, details?: unknown): MockResponse {
  return { status: 409, body: { code, message, details } };
}

const openEditor = async () => {
  fireEvent.click(await screen.findByText('Править'));
  await screen.findByText('Состав закупки ЗК-14');
};

describe('карточка плановой закупки', () => {
  it('в «Новой» правится и проводится, а в «В работе» — только закрывается или отменяется', async () => {
    renderCard();
    await screen.findByText('Плановая закупка ЗК-14');
    expect(screen.getByText('Править')).toBeTruthy();
    expect(screen.getByText('Провести')).toBeTruthy();
    expect(screen.queryByText('Закрыть')).toBeNull();
  });

  it('после проведения правки нет вовсе', async () => {
    renderCard({
      [PURCHASES.detail]: () =>
        json(
          detailDto({
            status: 'in_work',
            submittedByName: 'Иванов И. И.',
            submittedAt: '2026-08-31T10:00:00.000Z',
          }),
        ),
    });
    await screen.findByText('Плановая закупка ЗК-14');
    // Состав неизменяем с самого перехода в «В работе» (Р18): кнопки нет, а не «есть и отвечает».
    expect(screen.queryByText('Править')).toBeNull();
    expect(screen.getByText('Закрыть')).toBeTruthy();
    expect(screen.getByText('Отменить')).toBeTruthy();
    // Лента строится из колонок документа, а не из журнала аудита (Р9).
    expect(screen.getByText('Проведена')).toBeTruthy();
  });

  it('«Провести» несёт версию содержимого', async () => {
    const http = renderCard({
      [PURCHASES.submit]: () => json(detailDto({ status: 'in_work' })),
    });
    await screen.findByText('Плановая закупка ЗК-14');
    fireEvent.click(screen.getByText('Провести'));

    await waitFor(() => expect(http.countOf(PURCHASES.submit)).toBe(1));
    // В снабжение обязан уехать тот состав, который человек видел на экране (Р18): правка соседа,
    // приехавшая между открытием карточки и нажатием, меняет именно его.
    expect(http.lastCall(PURCHASES.submit)!.body).toEqual({ expectedVersion: 1 });
  });

  it('правка проведённой отбивается словами «уже провели»', async () => {
    renderCard({
      [PURCHASES.update]: () =>
        conflict(
          'office_equipment_purchase_status',
          'Закупку уже провели — состав правится только в «Новой»',
          { kind: 'status', status: 'in_work', displayNumber: 'ЗК-14' },
        ),
    });
    await screen.findByText('Плановая закупка ЗК-14');
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await screen.findByText('Закупку уже провели');
    // Это не «конфликт версий»: править нечего вовсе, и текст зовёт закрыть окно, а не повторить.
    expect(screen.getByText(/Состав правится только в «Новой»/)).toBeTruthy();
  });

  it('чужая правка черновика показывает свежий состав, а не только номер версии', async () => {
    renderCard({
      [PURCHASES.update]: () =>
        conflict(
          'office_equipment_purchase_version',
          'Закупку изменил другой человек — посмотрите свежий состав и повторите',
          {
            kind: 'version',
            purchase: detailDto({
              contentVersion: 3,
              items: [purchaseItem({ quantity: 20 })],
            }),
          },
        ),
    });
    await screen.findByText('Плановая закупка ЗК-14');
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await screen.findByText('Черновик изменил другой человек');
    /*
     * Состав целиком, а не один номер версии: «версия 3, а у вас 2» человек прочитает как отказ
     * портала и нажмёт ту же кнопку ещё раз. Здесь видно, ЧТО именно поменял сосед.
     */
    expect(screen.getByText(/Сейчас в закупке 1 позиций на 20 шт/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Взять свежий состав' })).toBeTruthy();
  });

  it('правка черновика уходит с версией содержимого', async () => {
    const http = renderCard({ [PURCHASES.update]: () => json(detailDto({ contentVersion: 2 })) });
    await screen.findByText('Плановая закупка ЗК-14');
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf(PURCHASES.update)).toBe(1));
    const body = http.lastCall(PURCHASES.update)!.body as {
      contentVersion: number;
      items: { expectedStock: number }[];
    };
    // Версия — «не изменил ли документ кто-то другой»; снимок берётся из самой строки закупки: он
    // записан на том же основании, на котором сервер сверяет правку (Р18).
    expect(body.contentVersion).toBe(1);
    expect(body.items[0]!.expectedStock).toBe(5);
  });

  it('закрытие требует подтверждения «приход занесён» и честно говорит, что не проверяет его', async () => {
    const http = renderCard({
      [PURCHASES.detail]: () => json(detailDto({ status: 'in_work' })),
      [PURCHASES.close]: () => json(detailDto({ status: 'closed' })),
    });
    await screen.findByText('Плановая закупка ЗК-14');
    fireEvent.click(screen.getByText('Закрыть'));

    await screen.findByText('Закрыть закупку ЗК-14');
    expect(screen.getByText('Сначала приход, потом закрытие')).toBeTruthy();
    // Оговорка стоит рядом с галочкой: портал не может проверить утверждение и не притворяется.
    expect(screen.getByText(/Портал это не проверяет и проверить не может/)).toBeTruthy();

    const ok = screen.getByRole('button', { name: 'Закрыть закупку' });
    expect(ok.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByText('Приход по этой закупке занесён в остатки'));
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть закупку' }));
    await waitFor(() => expect(http.countOf(PURCHASES.close)).toBe(1));
    // Снятая галочка — это «не закрывать», а не «закрыть без подтверждения»: схема принимает
    // только `true`, и другого значения в теле быть не может.
    expect(http.lastCall(PURCHASES.close)!.body).toEqual({ stockReceiptConfirmed: true });
  });
});
