import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  MECH_LESSOR_RECEIPT_CAP_MESSAGE,
  MECH_LESSOR_RECEIPT_LESSOR_CAP,
  MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE,
  type AuthUser,
  type MechLessorReceiptVersionView,
  type MechLessorRentalDto,
} from '@technic/contracts';
import { MechRequestsPage } from '../src/pages/mech/MechRequestsPage';
import { MechLessorRentalCard } from '../src/pages/mech/lessor/MechLessorRentalCard';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { MOBILE_VIEWPORT } from './viewport';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { mechLessorReceiptView, mechLessorRental } from './factories/mech';

/**
 * The mechanization lessor's page (plan `docs/mechanization-lessor-receipt-plan.md`, W4).
 *
 * Pinned here: the section greets a lessor with his own list and never mounts the office tabs (their
 * doors refuse him — an unmocked call fails the test by itself, see `test/http.ts`); there is no
 * create button; the list and the card draw his allow-list and nothing else, even when a payload
 * carries more; «Прикрепить чек» uploads and attaches with the version of the fresh card and
 * refreshes his list; «Заменить чек» exists only over a pending or rejected version (O13) and within
 * his cap, the refusal's words standing in for the button otherwise.
 */

const COUNTERPARTY = 'cp-mech-7';

const lessor: AuthUser = authUser({
  id: 'user-lessor',
  email: 'lessor@example.test',
  lastName: 'Арендов',
  firstName: 'Алексей',
  middleName: 'Олегович',
  role: 'operator',
  counterpartyType: 'mech_lessor',
  counterpartyId: COUNTERPARTY,
});

const LIST = 'GET /mech-requests/lessor-rentals';
const CARD = 'GET /mech-requests/lessor-rentals/:id';
const ATTACH = 'POST /mech-requests/:id/lessor-receipt';

const UPLOAD: RouteMap = {
  'POST /files/upload-session': () =>
    json({
      fileId: 'f-new',
      uploadUrl: 'https://storage.test/put/f-new',
      objectKey: 'mech/f-new.pdf',
      expiresIn: 900,
    }),
  'POST /files/:id/complete': () =>
    json({
      id: 'f-new',
      filename: 'чек.pdf',
      contentType: 'application/pdf',
      size: 2,
      status: 'active',
      createdAt: '2026-11-09T08:00:00.000Z',
    }),
};

/** The lessor's own routes: the list and the card answer the same rental. */
function lessorRoutes(rentals: MechLessorRentalDto[], extra: RouteMap = {}) {
  return mockHttp({
    [LIST]: () => json(list(rentals)),
    [CARD]: ({ params }) => json(rentals.find((r) => r.id === params.id)),
    ...extra,
  });
}

function withReceipt(
  current: MechLessorReceiptVersionView | null,
  over: Partial<MechLessorRentalDto['lessorReceipt']> = {},
): MechLessorRentalDto {
  return mechLessorRental({
    lessorReceipt: {
      audience: 'lessor',
      required: true,
      current,
      retired: [],
      ownVersionCount: current?.createdAs === 'lessor' ? 1 : 0,
      ...over,
    },
  });
}

async function openCard() {
  fireEvent.click(await screen.findByRole('button', { name: 'Открыть аренду' }));
  return within(await screen.findByRole('dialog'));
}

describe('the section for a lessor', () => {
  it('is his list: no office tab, no create button, only his doors are asked', async () => {
    const http = lessorRoutes([mechLessorRental()]);
    renderWithUser(<MechRequestsPage />, { route: '/mech?tab=archive', user: lessor });

    expect(await screen.findByText('МХ-42')).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toEqual([]);
    for (const tab of ['Заявки', 'В аренде', 'История', 'Архив']) {
      expect(screen.queryByText(tab)).toBeNull();
    }
    expect(screen.queryByText('Заказать технику')).toBeNull();
    // Every request went to his doors: the office list, summary and dictionaries refuse him.
    expect(http.calls.map((call) => call.path)).toEqual(
      http.calls.map(() => '/mech-requests/lessor-rentals'),
    );
  });

  it('sorts by the soonest return and sends his two filters to his door', async () => {
    const http = lessorRoutes([mechLessorRental()]);
    renderWithUser(<MechRequestsPage />, { route: '/mech', user: lessor });
    await screen.findByText('МХ-42');

    const first = http.lastCall(LIST)!.query;
    expect(first.get('sortBy')).toBe('plannedTo');
    expect(first.get('sortOrder')).toBe('asc');

    const placeholder = await screen.findByText('Чек: любой');
    fireEvent.mouseDown(placeholder.closest('.ant-select')!.querySelector('.ant-select-content')!);
    await waitFor(() => {
      const item = [...document.querySelectorAll('.ant-select-item-option')].find(
        (option) => option.textContent === 'отклонён',
      );
      expect(item).toBeTruthy();
      fireEvent.click(item!);
    });
    await waitFor(() => expect(http.lastCall(LIST)?.query.get('lessorReceipt')).toBe('rejected'));
  });

  it('shows the rental as a card on the phone, the receipt mark as its badge', async () => {
    lessorRoutes([withReceipt(mechLessorReceiptView({ status: 'rejected' }))]);
    renderWithUser(<MechRequestsPage />, {
      route: '/mech',
      user: lessor,
      viewport: MOBILE_VIEWPORT,
    });

    const card = (await screen.findByText('ЖК Северный')).closest('.list-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText('чек отклонён')).toBeTruthy();
    expect(within(card).getByText(/за смену/)).toBeTruthy();
  });
});

/*
 * A payload that carries more than his DTO — as if the server's allow-list broke. His page draws by
 * its own allow-list too, so none of these may appear: the department and requester, the comment,
 * the requester's files, the visa, the worked units and the final cost, staff names on the request
 * and on the versions, the office's reasons and the versions of an earlier deal.
 */
const LEAKS = {
  departmentId: 'dep-1',
  departmentCode: 'ОГМ',
  departmentName: 'Отдел главного механика',
  comment: 'Внутренний комментарий офиса',
  files: [
    { id: 'f-req', filename: 'смета-заявителя.pdf', contentType: 'application/pdf', size: 1 },
  ],
  approvedByName: 'Визирующий В. В.',
  approvedAt: '2026-11-01T08:00:00.000Z',
  createdByName: 'Заявителев З. З.',
  lessorName: 'СтройАренда',
  actualUnits: 13,
  finalCost: 987654,
  lessorReceiptRetired: [
    {
      id: 'lr-old-deal',
      versionNo: 1,
      status: 'approved',
      file: { id: 'f-old', filename: 'чек-прошлой-сделки.pdf', contentType: 'application/pdf' },
      createdByName: 'Прежний Арендодатель',
    },
  ],
};

const VERSION_LEAKS = {
  createdByName: 'Диспетчеров Д. П.',
  decidedByName: 'Прорабов П. П.',
  decisionComment: 'Сверено с бухгалтерией',
};

function leakingRental(): MechLessorRentalDto {
  const current = {
    ...mechLessorReceiptView({
      id: 'lrv-2',
      versionNo: 2,
      status: 'rejected',
      file: { id: 'f-lr-2', filename: 'чек-2.pdf', contentType: 'application/pdf', size: 2048 },
      decidedAt: '2026-11-06T08:00:00.000Z',
      rejectionReason: 'Не видно суммы',
    }),
    ...VERSION_LEAKS,
  };
  const retired = {
    ...mechLessorReceiptView({
      status: 'rejected',
      decidedAt: '2026-11-04T08:00:00.000Z',
      rejectionReason: 'Нет печати',
      retiredAt: '2026-11-05T08:00:00.000Z',
      retiredReason: 'replaced',
    }),
    ...VERSION_LEAKS,
  };
  return {
    ...withReceipt(current, { retired: [retired], ownVersionCount: 2 }),
    ...LEAKS,
  } as MechLessorRentalDto;
}

const HIDDEN_WORDS = [
  'Отдел главного механика',
  'ОГМ',
  'Внутренний комментарий офиса',
  'смета-заявителя.pdf',
  'Визирующий В. В.',
  'Заявителев З. З.',
  'СтройАренда',
  '987',
  'Диспетчеров Д. П.',
  'Прорабов П. П.',
  'Сверено с бухгалтерией',
  'чек-прошлой-сделки.pdf',
  'Прежний Арендодатель',
];

const HIDDEN_LABELS = [
  'Заявитель',
  'Комментарий',
  'Файлы',
  'Виза площадки',
  'Арендодатель',
  'Отработано',
  'Итоговая стоимость',
  'Заведена',
  'История',
];

describe('only his fields are drawn (O7, P12)', () => {
  it('the list and the card, the versions of his deal opened, show nothing beyond his DTO', async () => {
    lessorRoutes([leakingRental()]);
    renderWithUser(<MechRequestsPage />, { route: '/mech', user: lessor });
    const card = await openCard();
    await card.findByText('Аренда МХ-42');
    // Expanded: a collapsed list would hide a leak instead of proving there is none.
    fireEvent.click(card.getByText('Версии чека (1)'));
    await card.findByText('чек-1.pdf');

    // What he is shown: his fields, his receipt and the rejection he has to fix.
    for (const shown of [
      'ЖК Северный',
      'г. Москва, ул. Северная, 1',
      'Виброплита реверсивная Wacker DPU 3070Н',
      'Петров П. П.',
      'чек-2.pdf',
    ]) {
      expect(card.getAllByText(shown).length, shown).toBeGreaterThan(0);
    }
    expect(card.getByText(/Причина отказа: Не видно суммы/)).toBeTruthy();
    expect(card.getByText(/Причина отказа: Нет печати/)).toBeTruthy();
    expect(card.getAllByText(/Прикрепил арендодатель/)).toHaveLength(2);
    // No name after the verb: the outcome is named instead of a decider cut off.
    expect(card.getAllByText(/^Отклонён · /)).toHaveLength(2);
    expect(card.queryByText(/Отклонил/)).toBeNull();

    const text = document.body.textContent ?? '';
    for (const word of HIDDEN_WORDS) expect(text, word).not.toContain(word);
    for (const label of HIDDEN_LABELS) expect(card.queryByText(label), label).toBeNull();
  });
});

describe('«Прикрепить чек»', () => {
  it('uploads, attaches with the fresh card version and refreshes his list and card', async () => {
    const row = mechLessorRental({ version: 7 });
    const fresh = mechLessorRental({ version: 8 });
    const http = mockHttp({
      [LIST]: () => json(list([row])),
      [CARD]: () => json(fresh),
      ...UPLOAD,
      [ATTACH]: () =>
        json({
          version: 9,
          lessorReceipt: { ...fresh.lessorReceipt, current: mechLessorReceiptView() },
        }),
    });
    renderWithUser(<MechRequestsPage />, { route: '/mech', user: lessor });
    const card = await openCard();
    await waitFor(() => expect(http.countOf(CARD)).toBe(1));
    const listReads = http.countOf(LIST);
    const cardReads = http.countOf(CARD);

    fireEvent.click(await card.findByRole('button', { name: 'Прикрепить чек' }));
    // The upload window opens inside the card (ADR 0140): the second dialog, titled by the rental.
    const title = await screen.findByText('Прикрепить чек арендодателя · МХ-42');
    const modal = within(title.closest('.ant-modal') as HTMLElement);
    fireEvent.change(modal.getByLabelText('Файл чека'), {
      target: {
        files: [new File([new Uint8Array([0x25, 0x50])], 'чек.pdf', { type: 'application/pdf' })],
      },
    });
    fireEvent.click(modal.getByRole('button', { name: 'Прикрепить' }));

    await waitFor(() => expect(http.countOf(ATTACH)).toBe(1));
    const attach = http.lastCall(ATTACH)!;
    expect(attach.path).toBe('/mech-requests/mech-1/lessor-receipt');
    expect(attach.body).toEqual({ fileId: 'f-new', version: 8 });
    expect(await screen.findByText('Чек прикреплён')).toBeTruthy();
    await waitFor(() => {
      expect(http.countOf(LIST)).toBeGreaterThan(listReads);
      expect(http.countOf(CARD)).toBeGreaterThan(cardReads);
    });
  });
});

describe('«Заменить чек» only over a pending or rejected version (O13)', () => {
  async function renderCard(rental: MechLessorRentalDto) {
    lessorRoutes([rental]);
    renderWithUser(<MechLessorRentalCard rental={rental} today="2026-11-09" onClose={() => {}} />, {
      user: lessor,
    });
    const card = within(await screen.findByRole('dialog'));
    await card.findByText('Чек арендодателя');
    return card;
  }

  const buttonOf = (card: ReturnType<typeof within>) =>
    card.queryByRole('button', { name: /чек$/ })?.textContent ?? null;

  it.each([
    ['none attached', null, 'Прикрепить чек'],
    ['pending', mechLessorReceiptView({ status: 'pending' }), 'Заменить чек'],
    [
      'rejected',
      mechLessorReceiptView({ status: 'rejected', rejectionReason: 'Не видно суммы' }),
      'Заменить чек',
    ],
  ])('%s → %s', async (_name, current, button) => {
    const card = await renderCard(withReceipt(current));
    expect(buttonOf(card)).toBe(button);
  });

  it.each([
    ['approved', mechLessorReceiptView({ status: 'approved', decidedAt: '2026-11-06T08:00:00Z' })],
    [
      'waived',
      mechLessorReceiptView({
        status: 'waived',
        file: null,
        createdAs: 'office',
        decidedAt: '2026-11-06T08:00:00Z',
      }),
    ],
  ])('%s → no button, the office replaces it', async (_name, current) => {
    const card = await renderCard(withReceipt(current));
    expect(buttonOf(card)).toBeNull();
    expect(card.getByText(MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE)).toBeTruthy();
  });

  it('at his cap → no button, the cap named', async () => {
    const card = await renderCard(
      withReceipt(mechLessorReceiptView({ status: 'rejected' }), {
        ownVersionCount: MECH_LESSOR_RECEIPT_LESSOR_CAP,
      }),
    );
    expect(buttonOf(card)).toBeNull();
    expect(card.getByText(MECH_LESSOR_RECEIPT_CAP_MESSAGE)).toBeTruthy();
  });

  it('a rental that left his list → no button, said so', async () => {
    const rental = withReceipt(null);
    mockHttp({
      [CARD]: () => json({ code: 'NOT_FOUND', message: 'Заявка не найдена' }, 404),
    });
    renderWithUser(<MechLessorRentalCard rental={rental} today="2026-11-09" onClose={() => {}} />, {
      user: lessor,
    });
    const card = within(await screen.findByRole('dialog'));
    expect(await card.findByText('Аренда ушла из вашего списка')).toBeTruthy();
    expect(buttonOf(card)).toBeNull();
  });
});
