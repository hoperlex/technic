import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type {
  AutoPartReceiptDto,
  ServiceRequestDto,
  ServiceRequestItemDto,
} from '@technic/contracts';
import { autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { EstimateEditorModal } from '../src/features/estimate-editor';
import { AutoPartReceiptCardModal } from '../src/pages/garage/AutoPartReceiptCardModal';
import { json, mockHttp, type HttpMock, type MockResponse } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { SERVICE_COUNTERPARTY, serviceExecutor, serviceRequest } from './factories/service';

/**
 * The way out of a version conflict without losing the input (stage 5 plan §4.5, decision R6-a;
 * coordinator's decisions on the wave 1 findings 1–3).
 *
 * - The receipt windows used to close on 409 together with what was typed; now they stay open, the
 *   receipt is reread, and the notice offers "Reload".
 * - The scope-of-work window answered 409 with a toast only: nothing reread the request, and the
 *   person could not see what had changed. Now it rereads its own request, and the notice appears.
 * - The receipt card closed on any error of its query, a background one included, and took the
 *   edit and mark windows with it.
 */

const NOTICE = 'Запись изменена другим пользователем';

/* ─── receipt card and its windows ───────────────────────────────────────────────────────────── */

const RECEIPT: AutoPartReceiptDto = {
  id: 'r-1',
  purchasedOn: '2026-07-18',
  sellerName: 'ООО «Автодеталь»',
  documentNumber: '214',
  note: '',
  lines: [
    {
      id: 'l-1',
      seq: 1,
      destination: 'unassigned',
      vehicleId: null,
      vehicleLabel: '',
      article: '',
      name: 'Перчатки',
      quantity: 1,
      unit: 'уп',
      amount: 300,
      unitPrice: 300,
      note: '',
    },
  ],
  files: [{ id: 'f-1', filename: 'chek.pdf', contentType: 'application/pdf', size: 1024 }],
  total: 300,
  unassignedTotal: 300,
  warehouseTotal: 0,
  deletion: null,
  version: 3,
  createdAt: '2026-07-19T09:00:00.000Z',
  createdByName: 'Механиков М.М.',
  updatedAt: '2026-07-19T09:00:00.000Z',
  updatedByName: '',
};

/** The colleague's save that the conflict is about. */
const THEIRS: AutoPartReceiptDto = { ...RECEIPT, version: 4, documentNumber: '215' };

const DETAIL = 'GET /auto-part-receipts/:id';
const CONFLICT = (): MockResponse =>
  json({ code: 'version_conflict', message: 'Чек изменили — откройте его заново' }, 409);

interface CardSetup {
  http: HttpMock;
  queryClient: QueryClient;
  onClose: ReturnType<typeof vi.fn>;
  /** What the server answers on the next read of the receipt. */
  answer: (next: MockResponse) => void;
}

function renderCard(): CardSetup {
  let answer: MockResponse = json(RECEIPT);
  const http = mockHttp({
    [DETAIL]: () => answer,
    'GET /vehicles': () => json(emptyList()),
    'GET /auto-part-receipts/scans/:id/recognition': ({ params }) =>
      json({
        fileId: params.id,
        status: 'done',
        queuedAt: null,
        delayed: false,
        totalPages: 1,
        processedPages: 1,
        draft: null,
        errorClass: null,
        errorScope: null,
        message: '',
        duplicate: null,
      }),
    'PATCH /auto-part-receipts/:id': () => {
      answer = json(THEIRS);
      return CONFLICT();
    },
    'POST /auto-part-receipts/:id/deletion-mark': () => {
      answer = json(THEIRS);
      return CONFLICT();
    },
  });
  const onClose = vi.fn();
  const { queryClient } = renderWithUser(
    <AutoPartReceiptCardModal
      receiptId="r-1"
      onClose={onClose}
      vehicleSpend={{ href: () => '#', open: () => {} }}
    />,
    { user: authUser({ role: 'mechanic' }) },
  );
  return { http, queryClient, onClose, answer: (next) => (answer = next) };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

async function openEdit() {
  fireEvent.click(await screen.findByText('Изменить'));
  await waitFor(() => expect(field('Номер чека').value).toBe('214'));
  fireEvent.change(field('Номер чека'), { target: { value: '214-А' } });
}

describe('receipt windows on 409', () => {
  it('the edit window stays open with the input; after the reread the notice offers «Перечитать»', async () => {
    const { http, onClose } = renderCard();
    await openEdit();

    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.countOf('PATCH /auto-part-receipts/:id')).toBe(1));

    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(field('Номер чека').value).toBe('214-А');
    expect(onClose).not.toHaveBeenCalled();
    // The card behind already shows the colleague's receipt: the reread did happen.
    expect(screen.getByText('Чек № 215')).toBeDefined();

    fireEvent.click(screen.getByText('Перечитать'));
    await waitFor(() => expect(field('Номер чека').value).toBe('215'));
  });

  it('the deletion mark window stays open with the typed reason and shows the notice', async () => {
    const { http, onClose } = renderCard();
    fireEvent.click(await screen.findByText('Пометить к удалению'));
    fireEvent.change(await screen.findByLabelText('Причина'), {
      target: { value: 'задвоили с чеком № 213' },
    });

    fireEvent.click(screen.getByText('Пометить'));
    await waitFor(() => expect(http.countOf('POST /auto-part-receipts/:id/deletion-mark')).toBe(1));

    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(field('Причина').value).toBe('задвоили с чеком № 213');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('receipt card and a failed reread', () => {
  async function failReread({ http, queryClient, answer }: CardSetup, failure: MockResponse) {
    answer(failure);
    const before = http.countOf(DETAIL);
    await act(() => queryClient.invalidateQueries({ queryKey: autoPartReceiptKeys.root }));
    await waitFor(() => expect(http.countOf(DETAIL)).toBeGreaterThan(before));
    await waitFor(() =>
      expect(queryClient.getQueryState(autoPartReceiptKeys.detail('r-1'))?.status).toBe('error'),
    );
    // Let the card's effects see the error before asserting what they did with it.
    await act(async () => {});
  }

  it('a background 503 keeps the card and the edit window inside it, input included', async () => {
    const setup = renderCard();
    await openEdit();

    await failReread(setup, json({ code: 'service_unavailable', message: 'Недоступно' }, 503));

    expect(setup.onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Чек № 214')).toBeDefined();
    expect(field('Номер чека').value).toBe('214-А');
  });

  it('a 404 closes the card: the receipt is gone', async () => {
    const setup = renderCard();
    await screen.findByText('Чек № 214');

    await failReread(setup, json({ code: 'not_found', message: 'Чек не найден' }, 404));

    await waitFor(() => expect(setup.onClose).toHaveBeenCalled());
  });
});

/* ─── scope-of-work window ───────────────────────────────────────────────────────────────────── */

function item(name: string): ServiceRequestItemDto {
  return {
    id: 'sri-1',
    kind: 'service',
    name,
    quantity: 1,
    unitPrice: 1800,
    amount: 1800,
    performed: null,
    actualQuantity: null,
    actualAmount: null,
    warrantyMonths: null,
    warrantyUntil: null,
    warrantyUntilManual: false,
  };
}

const REQUEST: ServiceRequestDto = serviceRequest({
  status: 'in_work',
  service: { ...SERVICE_COUNTERPARTY },
  estimatePendingRevision: null,
  items: [item('Замена узла подачи')],
});

/** The card as the service request view holds it: the window gets the live request from it. */
function Card() {
  const { data } = useQuery({
    queryKey: serviceRequestKeys.detail(REQUEST.id),
    queryFn: () => serviceRequestsApi.get(REQUEST.id),
  });
  return <EstimateEditorModal request={data ?? null} onClose={() => {}} />;
}

describe('scope-of-work window on 409', () => {
  it('rereads its own request, keeps the composition and shows the notice', async () => {
    let current = REQUEST;
    const http = mockHttp({
      'GET /service-requests/:id': () => json(current),
      'PUT /service-requests/:id/estimate': () => {
        current = { ...REQUEST, version: REQUEST.version + 1, items: [item('Чистка')] };
        return json({ code: 'version_conflict', message: 'Заявку изменили' }, 409);
      },
    });
    renderWithUser(<Card />, { user: serviceExecutor() });
    const description = () => screen.getByLabelText('Описание объёма работ') as HTMLTextAreaElement;
    await waitFor(() => expect(description().value).toBe('Замена узла подачи'));
    fireEvent.change(description(), { target: { value: 'Замена узла подачи и ролика' } });

    fireEvent.click(screen.getByText('Сохранить черновик'));
    await waitFor(() => expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(1));

    await waitFor(() => expect(http.countOf('GET /service-requests/:id')).toBe(2));
    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(description().value).toBe('Замена узла подачи и ролика');
  });
});
