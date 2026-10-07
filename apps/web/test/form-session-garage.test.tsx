import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AutoPartReceiptDto,
  AutoPartWarehouseLotDto,
  ReceiptDeletionMarkInput,
  UpdateReceiptBody,
} from '@technic/contracts';
import { AutoPartReceiptFormModal } from '../src/pages/garage/AutoPartReceiptFormModal';
import { ReceiptDeletionMarkModal } from '../src/pages/garage/ReceiptDeletionMarkModal';
import { AutoPartApplicationModal } from '../src/pages/garage/AutoPartApplicationModal';
import { dateInput } from './antd';
import { json, mockHttp, type MockResponse } from './http';
import { renderWithProps } from './propsDriver';
import { emptyList } from './factories/common';

/**
 * Garage windows against rereads (stage 5 plan §4.5 and appendix A4, wave 1; decision R6-a).
 *
 * The receipt windows live inside the receipt card (ADR 0140), and the card rereads the receipt
 * after any neighbouring action. Keyed by the receipt object, the edit form wiped what the mechanic
 * was typing and the save went with the live version. The application window kept "today" in its
 * reset dependencies and rewrote the chosen date at midnight.
 */

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

const NOTICE = 'Запись изменена другим пользователем';
const UPDATE = 'PATCH /auto-part-receipts/:id';
const MARK = 'POST /auto-part-receipts/:id/deletion-mark';

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

function renderReceiptForm(update: () => MockResponse = () => json(RECEIPT)) {
  const http = mockHttp({
    'GET /vehicles': () => json(emptyList()),
    // The scan block asks how the attached scan was recognized: long ago, nothing to apply.
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
    [UPDATE]: update,
  });
  const view = renderWithProps(AutoPartReceiptFormModal, {
    receipt: RECEIPT,
    open: true,
    onClose: () => {},
  });
  return { http, ...view };
}

describe('receipt edit window', () => {
  it('a colleague’s save over a changed form: input kept, notice, the save carries the old version', async () => {
    const { http, update } = renderReceiptForm(() =>
      json({ code: 'version_conflict', message: 'Чек изменили' }, 409),
    );
    await waitFor(() => expect(field('Номер чека').value).toBe('214'));
    fireEvent.change(field('Номер чека'), { target: { value: '214-А' } });

    update({ receipt: { ...RECEIPT, version: 4, documentNumber: '215', sellerName: 'ИП Петров' } });

    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(field('Номер чека').value).toBe('214-А');
    expect(field('Продавец').value).toBe('ООО «Автодеталь»');

    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.countOf(UPDATE)).toBe(1));
    expect((http.lastCall(UPDATE)!.body as UpdateReceiptBody).version).toBe(3);
  });

  it('«Перечитать» fills the colleague’s receipt and the save goes with its version', async () => {
    const { http, update } = renderReceiptForm();
    await waitFor(() => expect(field('Номер чека').value).toBe('214'));
    fireEvent.change(field('Номер чека'), { target: { value: '214-А' } });
    update({ receipt: { ...RECEIPT, version: 4, documentNumber: '215' } });

    fireEvent.click(await screen.findByText('Перечитать'));
    await waitFor(() => expect(field('Номер чека').value).toBe('215'));
    expect(screen.queryByText(NOTICE)).toBeNull();

    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.countOf(UPDATE)).toBe(1));
    expect((http.lastCall(UPDATE)!.body as UpdateReceiptBody).version).toBe(4);
  });

  it('an untouched form follows the reread silently', async () => {
    const { update } = renderReceiptForm();
    await waitFor(() => expect(field('Номер чека').value).toBe('214'));

    update({ receipt: { ...RECEIPT, version: 4, documentNumber: '215' } });
    await waitFor(() => expect(field('Номер чека').value).toBe('215'));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('an edited line counts as a change too: rows live outside the form fields', async () => {
    const { update } = renderReceiptForm();
    const name = (await screen.findByDisplayValue('Перчатки')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Перчатки рабочие' } });

    update({ receipt: { ...RECEIPT, version: 4, documentNumber: '215' } });
    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(screen.getByDisplayValue('Перчатки рабочие')).toBeDefined();
    expect(field('Номер чека').value).toBe('214');
  });

  it('mounted closed with the receipt loaded, the window fills on opening and anew on reopening', async () => {
    renderReceiptForm();
    const { update } = renderWithProps(AutoPartReceiptFormModal, {
      receipt: { ...RECEIPT, id: 'r-2', documentNumber: '300' },
      open: false,
      onClose: () => {},
    });
    update({ open: true });
    await waitFor(() => expect(screen.getAllByDisplayValue('300')).toHaveLength(1));
    fireEvent.change(screen.getByDisplayValue('300'), { target: { value: '301' } });

    update({ open: false });
    update({ open: true });
    await waitFor(() => expect(screen.getAllByDisplayValue('300')).toHaveLength(1));
    expect(screen.queryByDisplayValue('301')).toBeNull();
  });
});

describe('deletion mark window', () => {
  it('a reread keeps the typed reason and the mark carries the version of the opening', async () => {
    const http = mockHttp({ [MARK]: () => json({ code: 'version_conflict', message: '—' }, 409) });
    const { update } = renderWithProps(ReceiptDeletionMarkModal, {
      receipt: RECEIPT as AutoPartReceiptDto | null,
      onClose: () => {},
    });
    fireEvent.change(await screen.findByLabelText('Причина'), {
      target: { value: 'задвоили с чеком № 213' },
    });

    update({ receipt: { ...RECEIPT, version: 4 } });
    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(field('Причина').value).toBe('задвоили с чеком № 213');

    fireEvent.click(screen.getByText('Пометить'));
    await waitFor(() => expect(http.countOf(MARK)).toBe(1));
    expect((http.lastCall(MARK)!.body as ReceiptDeletionMarkInput).version).toBe(3);
  });
});

describe('warehouse application window', () => {
  afterEach(() => vi.useRealTimers());

  const LOT: AutoPartWarehouseLotDto = {
    lineId: 'l-9',
    receiptId: 'r-1',
    purchasedOn: '2026-07-18',
    sellerName: '',
    receiptDocumentNumber: '214',
    article: '',
    name: 'Фильтр в запас',
    unit: 'шт',
    quantity: 4,
    appliedQuantity: 0,
    remainingQuantity: 4,
    amount: 2000,
    appliedAmount: 0,
    remainingAmount: 2000,
  };

  it('opened before midnight, the form keeps yesterday and the typed quantity after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 23:59 Moscow time on 7 October.
    vi.setSystemTime(new Date('2026-10-07T20:59:00.000Z'));
    mockHttp({ 'GET /vehicles': () => json(emptyList()) });
    const { update } = renderWithProps(AutoPartApplicationModal, {
      lot: LOT as AutoPartWarehouseLotDto | null,
      onClose: () => {},
    });
    await waitFor(() => expect(dateInput('Дата применения').value).toBe('07.10.2026'));
    fireEvent.change(field('Количество, шт'), { target: { value: '2' } });

    vi.setSystemTime(new Date('2026-10-07T21:01:00.000Z'));
    // Any re-render of the parent: before, a new day in the reset dependencies refilled the form.
    update({ lot: { ...LOT } });
    expect(dateInput('Дата применения').value).toBe('07.10.2026');
    expect(field('Количество, шт').value).toBe('2');

    // A new opening takes the new day.
    update({ lot: null });
    update({ lot: LOT });
    await waitFor(() => expect(dateInput('Дата применения').value).toBe('08.10.2026'));
  });
});
