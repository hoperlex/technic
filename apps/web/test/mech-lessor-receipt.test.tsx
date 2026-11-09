import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  MECH_LESSOR_RECEIPT_ACCEPT,
  MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE,
  MECH_LESSOR_RECEIPT_STALE_MESSAGE,
  type AuthUser,
  type MechLessorReceiptVersionDto,
  type MechRequestDto,
  type Permission,
  type RequestHistoryEntryDto,
  type Role,
} from '@technic/contracts';
import { MechStateTag } from '@entities/mech-request';
import {
  MechLessorReceiptReasonModal,
  MechLessorReceiptUploadModal,
  MechLessorReceiptVisaModal,
  type MechLessorReceiptReasonKind,
} from '../src/features/mech-lessor-receipt';
import {
  MECH_RENTAL_ACTION_KEYS,
  mechMenuItems,
  type MechMenuOptions,
} from '../src/pages/mech/mechRequestMenu';
import { MechRequestViewModal } from '../src/pages/mech/MechRequestViewModal';
import { MechRequestsPage } from '../src/pages/mech/MechRequestsPage';
import { apiError, json, mockHttp, type RouteMap } from './http';
import { renderWithProps } from './propsDriver';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { mechRequest } from './factories/mech';

/**
 * The lessor's receipt in the office portal (plan `docs/mechanization-lessor-receipt-plan.md`, W3).
 *
 * Pinned here: the menu offers each receipt action exactly to whom the server allows it, by the
 * server's permission list; «Завершить аренду» stays in the menu, disabled with the gate's words,
 * while the receipt is neither approved nor waived; the upload takes one PDF or JPG; the visa
 * window shows a JPEG as a picture and hands a PDF to pdf.js with one plain GET of the signed URL;
 * every decision but approval needs its reason; the window signs the version it shows and closes
 * on a 409 with the server's words; the marks and the filter «Чек»; a version opens from its
 * history line.
 */

/*
 * pdf.js is replaced as a module: the renderer must be CALLED with the file's link and the two
 * settings that keep it to one plain GET — a check that a canvas host exists would pass with any
 * div. The fake document has one page that "renders" at once.
 */
const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: pdfjs.getDocument,
  GlobalWorkerOptions: { workerSrc: '' },
  version: '6.4.299',
}));

beforeEach(() => {
  pdfjs.getDocument.mockReset();
  pdfjs.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      }),
    }),
    destroy: () => Promise.resolve(),
  }));
});

const PDF_URL = 'https://storage.test/receipt-2.pdf?signature=1';
const JPEG_URL = 'https://storage.test/receipt-2.jpg?signature=1';

function version(over: Partial<MechLessorReceiptVersionDto> = {}): MechLessorReceiptVersionDto {
  return {
    id: 'lr-2',
    versionNo: 2,
    status: 'pending',
    file: { id: 'f-2', filename: 'чек-2.pdf', contentType: 'application/pdf', size: 2048 },
    createdBy: 'user-1',
    createdByName: 'Диспетчеров Д. П.',
    createdAs: 'office',
    createdAt: '2026-11-05T08:00:00.000Z',
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionComment: '',
    retiredAt: null,
    retiredByName: null,
    retiredReason: null,
    ...over,
  };
}

/** The first version, rejected and replaced by the current one. */
const REJECTED_V1 = version({
  id: 'lr-1',
  versionNo: 1,
  status: 'rejected',
  file: { id: 'f-1', filename: 'чек-1.pdf', contentType: 'application/pdf', size: 1024 },
  decidedBy: 'user-r',
  decidedByName: 'Прорабов П. П.',
  decidedAt: '2026-11-04T10:00:00.000Z',
  decisionComment: 'Не видно суммы',
  retiredAt: '2026-11-05T08:00:00.000Z',
  retiredByName: 'Диспетчеров Д. П.',
  retiredReason: 'replaced',
});

/** A running rental taken into work after the release: completion waits for its receipt. */
const rental = (over: Partial<MechRequestDto> = {}): MechRequestDto =>
  mechRequest({
    status: 'confirmed',
    approvedAt: '2026-11-01T08:00:00.000Z',
    approvedBy: 'user-r',
    approvedByName: 'Прорабов П. П.',
    lessorId: 'cp-1',
    lessorName: 'СтройАренда',
    lessorType: 'mech_lessor',
    rate: 1500,
    rateUnit: 'shift',
    actualFrom: '2026-11-02',
    plannedFrom: '2026-11-02',
    plannedTo: '2026-11-20',
    version: 7,
    lessorReceiptRequired: true,
    ...over,
  });

/** The rental with a pending receipt, its first version rejected (card view: retired loaded). */
const withPending = (over: Partial<MechRequestDto> = {}) =>
  rental({
    lessorReceipt: version(),
    lessorReceiptVersionCount: 2,
    lessorReceiptRetired: [REJECTED_V1],
    ...over,
  });

const userOf = (role: Role, over: Partial<AuthUser> = {}): AuthUser =>
  authUser({ id: `user-${role}`, role, ...over });

const dispatcher = userOf('dispatcher');
const holder = userOf('rukstroy', { constructionObjectIds: ['obj-1'] });

const noop = () => {};

function menu(user: AuthUser, request: MechRequestDto) {
  const granted = new Set<Permission>(user.permissions);
  const options: MechMenuOptions = {
    user,
    can: (permission) => granted.has(permission),
    open: {
      takeInWork: noop,
      editDeal: noop,
      issue: noop,
      revokeIssue: noop,
      extend: noop,
      decideExtension: noop,
      complete: noop,
      cancel: noop,
      rollbackToNew: noop,
      lessorReceipt: {
        attach: noop,
        review: noop,
        waive: noop,
        revokeApproval: noop,
        revokeWaiver: noop,
      },
    },
    run: {
      rollback: noop,
      setApproval: noop,
      duplicate: noop,
      remove: noop,
      withdrawExtension: noop,
    },
  };
  return mechMenuItems(request, options);
}

const receiptKeys = (user: AuthUser, request: MechRequestDto): string[] =>
  menu(user, request)
    .filter((item) => item.key.startsWith('lessor-receipt:'))
    .map((item) => `${item.key}:${item.label}`);

describe('menu by role', () => {
  it('the dispatcher attaches and replaces, and never decides', () => {
    expect(receiptKeys(dispatcher, rental())).toEqual(['lessor-receipt:attach:Прикрепить чек']);
    expect(receiptKeys(dispatcher, withPending())).toEqual(['lessor-receipt:attach:Заменить чек']);
  });

  it('the visa holder of the site checks a pending receipt; «Без чека» is then inside the window', () => {
    expect(receiptKeys(holder, withPending())).toEqual(['lessor-receipt:review:Проверить чек']);
    // Nothing to look at — no receipt, or a rejected one: «Без чека» is its own item.
    expect(receiptKeys(holder, rental())).toEqual(['lessor-receipt:waive:Без чека']);
    expect(receiptKeys(holder, rental({ lessorReceipt: version({ status: 'rejected' }) }))).toEqual(
      ['lessor-receipt:waive:Без чека'],
    );
  });

  it('the visa holder undoes his decision while the rental is in work', () => {
    const approved = version({ status: 'approved', decidedAt: '2026-11-06T08:00:00.000Z' });
    expect(receiptKeys(holder, rental({ lessorReceipt: approved }))).toEqual([
      'lessor-receipt:revoke-approval:Отозвать утверждение',
    ]);
    const waived = version({ status: 'waived', file: null, decidedAt: '2026-11-06T08:00:00.000Z' });
    expect(receiptKeys(holder, rental({ lessorReceipt: waived }))).toEqual([
      'lessor-receipt:revoke-waiver:Отменить «без чека»',
    ]);
  });

  it('a holder of another site, the requester and an archived rental get nothing', () => {
    const neighbour = userOf('rukstroy', { constructionObjectIds: ['obj-2'] });
    expect(receiptKeys(neighbour, withPending())).toEqual([]);
    const site = userOf('site', { constructionObjectIds: ['obj-1'] });
    expect(receiptKeys(site, withPending())).toEqual([]);
    expect(menu(dispatcher, withPending({ deletedAt: '2026-11-07T08:00:00.000Z' }))).toEqual([]);
  });

  it('the «В аренде» tab keeps the receipt items', () => {
    const kept = menu(holder, withPending()).filter((item) =>
      MECH_RENTAL_ACTION_KEYS.includes(item.key),
    );
    expect(kept.map((item) => item.key)).toContain('lessor-receipt:review');
  });
});

describe('«Завершить аренду» waits for the receipt', () => {
  const done = (request: MechRequestDto) =>
    menu(dispatcher, request).find((item) => item.key === 'status:done');

  it('is shown disabled with the gate words while the receipt is not decided', () => {
    expect(done(withPending())).toMatchObject({
      label: 'Завершить аренду',
      disabled: true,
      disabledReason: 'Чек арендодателя ждёт визы — аренду завершают после неё',
    });
    expect(done(rental())).toMatchObject({
      disabled: true,
      disabledReason: 'Прикрепите чек арендодателя или получите визу «без чека»',
    });
  });

  it('is enabled by an approval, a waiver, or a rental taken before the release', () => {
    expect(done(rental({ lessorReceipt: version({ status: 'approved' }) }))?.disabled).toBe(false);
    expect(
      done(rental({ lessorReceipt: version({ status: 'waived', file: null }) }))?.disabled,
    ).toBe(false);
    expect(done(rental({ lessorReceiptRequired: false }))?.disabled).toBe(false);
  });

  it('other blocked moves are still dropped, not disabled', () => {
    // Issued equipment is not cancelled: the item is absent, as before the receipt.
    expect(menu(dispatcher, withPending()).some((item) => item.key === 'status:cancelled')).toBe(
      false,
    );
  });
});

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

const reply = (request: MechRequestDto) =>
  json({
    version: request.version + 1,
    lessorReceipt: { audience: 'office', required: true, current: version(), retired: [] },
  });

describe('the upload window', () => {
  const pick = (name: string, type: string) => {
    const input = screen.getByLabelText('Файл чека') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([0x25, 0x50])], name, { type })] },
    });
  };

  it('takes one PDF or JPG: the input accepts only them, a PNG is refused before any upload', async () => {
    const request = rental();
    const http = mockHttp({
      ...UPLOAD,
      'POST /mech-requests/:id/lessor-receipt': () => reply(request),
    });
    renderWithProps(MechLessorReceiptUploadModal, {
      rental: request,
      replace: false,
      onClose: noop,
    });

    const input = screen.getByLabelText('Файл чека') as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe(MECH_LESSOR_RECEIPT_ACCEPT);
    expect(input.multiple).toBe(false);
    // Inside antd's form `hidden` would lose to its stylesheet and show the browser's own picker.
    expect(window.getComputedStyle(input).display).toBe('none');

    pick('чек.png', 'image/png');
    fireEvent.click(screen.getByRole('button', { name: 'Прикрепить' }));
    expect(await screen.findByText(MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE)).toBeTruthy();
    expect(http.countOf('POST /files/upload-session')).toBe(0);

    pick('чек.pdf', 'application/pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Прикрепить' }));
    await waitFor(() => expect(http.countOf('POST /mech-requests/:id/lessor-receipt')).toBe(1));
    expect(http.lastCall('POST /mech-requests/:id/lessor-receipt')?.body).toEqual({
      fileId: 'f-new',
      version: request.version,
    });
  });

  it('a JPEG photo goes through as well', async () => {
    const request = rental();
    const http = mockHttp({
      ...UPLOAD,
      'POST /mech-requests/:id/lessor-receipt': () => reply(request),
    });
    renderWithProps(MechLessorReceiptUploadModal, {
      rental: request,
      replace: true,
      onClose: noop,
    });
    pick('IMG_0001.jpg', 'image/jpeg');
    fireEvent.click(screen.getByRole('button', { name: 'Заменить' }));
    await waitFor(() => expect(http.countOf('POST /mech-requests/:id/lessor-receipt')).toBe(1));
  });
});

/** The visa window over the pending version, as the visa holder opens it. */
function renderVisa(request: MechRequestDto, routes: RouteMap = {}, fileUrl = PDF_URL) {
  const onClose = vi.fn();
  const http = mockHttp({
    'GET /mech-requests/:id': () => json(request),
    'GET /files/:id/download': () => json({ url: fileUrl, expiresIn: 300 }),
    ...routes,
  });
  renderWithProps(
    MechLessorReceiptVisaModal,
    { target: { request, receipt: request.lessorReceipt! }, onClose },
    { user: holder },
  );
  return { http, onClose };
}

const dialog = () => screen.getByRole('dialog');

describe('the visa window', () => {
  it('hands a PDF to pdf.js: the signed link, one plain GET, no WebAssembly', async () => {
    renderVisa(withPending());
    await waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(1));
    expect(pdfjs.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: PDF_URL,
        disableRange: true,
        disableStream: true,
        useWasm: false,
      }),
    );
    // The CMaps and fonts come from the portal's own origin, beside the worker.
    const params = pdfjs.getDocument.mock.calls[0]![0] as Record<string, string>;
    expect(params.cMapUrl).toBe('/assets/pdfjs-6.4.299/cmaps/');
    expect(params.standardFontDataUrl).toBe('/assets/pdfjs-6.4.299/standard_fonts/');
    expect(await screen.findByRole('img', { name: 'Страница 1 из 1' })).toBeTruthy();
    // No frame: Android Chrome shows a PDF in a frame as nothing at all.
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('shows a JPEG as a picture and never calls pdf.js', async () => {
    const jpeg = withPending({
      lessorReceipt: version({
        file: { id: 'f-2', filename: 'чек-2.jpg', contentType: 'image/jpeg', size: 4096 },
      }),
    });
    renderVisa(jpeg, {}, JPEG_URL);
    const picture = await screen.findByRole('img', { name: 'чек-2.jpg' });
    expect(picture.getAttribute('src')).toBe(JPEG_URL);
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
  });

  it('names the facts it is signed against, the previous rejection included', async () => {
    renderVisa(withPending());
    const window = within(dialog());
    expect(window.getByText('Версия 2 из 2')).toBeTruthy();
    expect(window.getByText('СтройАренда')).toBeTruthy();
    expect(await window.findByText('отклонена: Не видно суммы')).toBeTruthy();
    expect(window.getByRole('button', { name: /Скачать/ })).toBeTruthy();
  });

  it('approves the version it shows, with the request version of the opening', async () => {
    const request = withPending();
    const { http, onClose } = renderVisa(request, {
      'PATCH /mech-requests/:id/lessor-receipt': () => reply(request),
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Утвердить' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(http.lastCall('PATCH /mech-requests/:id/lessor-receipt')?.body).toEqual({
      receiptId: 'lr-2',
      decision: 'approve',
      comment: '',
      version: 7,
    });
  });

  it('a rejection needs its reason', async () => {
    const request = withPending();
    const { http } = renderVisa(request, {
      'PATCH /mech-requests/:id/lessor-receipt': () => reply(request),
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Отклонить' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Отклонить' }));
    expect(await screen.findByText('Укажите причину отказа')).toBeTruthy();
    expect(http.countOf('PATCH /mech-requests/:id/lessor-receipt')).toBe(0);

    fireEvent.change(screen.getByLabelText('Причина отказа'), {
      target: { value: 'Сумма не читается' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(http.countOf('PATCH /mech-requests/:id/lessor-receipt')).toBe(1));
    expect(http.lastCall('PATCH /mech-requests/:id/lessor-receipt')?.body).toMatchObject({
      receiptId: 'lr-2',
      decision: 'reject',
      comment: 'Сумма не читается',
    });
  });

  it('«Без чека» from the window needs its reason and goes to the waiver door', async () => {
    const request = withPending();
    const { http } = renderVisa(request, {
      'POST /mech-requests/:id/lessor-receipt/waiver': () => reply(request),
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Без чека' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Разрешить без чека' }));
    expect(await screen.findByText('Укажите, почему аренду завершают без чека')).toBeTruthy();
    expect(http.countOf('POST /mech-requests/:id/lessor-receipt/waiver')).toBe(0);
  });

  it('a 409 closes the window with the server words, not the generic «reread»', async () => {
    const request = withPending();
    const { onClose } = renderVisa(request, {
      'PATCH /mech-requests/:id/lessor-receipt': () =>
        apiError(409, { code: 'version_conflict', message: MECH_LESSOR_RECEIPT_STALE_MESSAGE }),
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Утвердить' }));
    expect(await screen.findByText(MECH_LESSOR_RECEIPT_STALE_MESSAGE)).toBeTruthy();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('decisions without a file', () => {
  function renderReason(request: MechRequestDto, kind: MechLessorReceiptReasonKind) {
    const http = mockHttp({
      'PATCH /mech-requests/:id/lessor-receipt': () => reply(request),
      'POST /mech-requests/:id/lessor-receipt/waiver': () => reply(request),
    });
    renderWithProps(
      MechLessorReceiptReasonModal,
      { target: { request, kind }, onClose: noop },
      { user: holder },
    );
    return http;
  }
  const submit = (name: string) => fireEvent.click(within(dialog()).getByRole('button', { name }));

  it('the waiver goes to its own door without any file or version id', async () => {
    const request = rental();
    const http = renderReason(request, 'waive');
    submit('Разрешить без чека');
    expect(await screen.findByText('Укажите, почему аренду завершают без чека')).toBeTruthy();
    expect(http.countOf('POST /mech-requests/:id/lessor-receipt/waiver')).toBe(0);

    fireEvent.change(screen.getByLabelText('Почему аренду завершают без чека'), {
      target: { value: 'Арендодатель закрылся' },
    });
    submit('Разрешить без чека');
    await waitFor(() =>
      expect(http.countOf('POST /mech-requests/:id/lessor-receipt/waiver')).toBe(1),
    );
    expect(http.lastCall('POST /mech-requests/:id/lessor-receipt/waiver')?.body).toEqual({
      comment: 'Арендодатель закрылся',
      version: request.version,
    });
  });

  it.each([
    ['revokeApproval', 'approved', 'Отозвать', 'Укажите причину отзыва', 'Причина отзыва'],
    ['revokeWaiver', 'waived', 'Отменить «без чека»', 'Укажите причину отмены', 'Причина отмены'],
  ] as const)('%s needs its reason and names the version it withdraws', async (...args) => {
    const [kind, status, button, required, label] = args;
    const request = rental({
      lessorReceipt: version({
        status,
        file: status === 'waived' ? null : version().file,
        decidedAt: '2026-11-06T08:00:00.000Z',
      }),
    });
    const http = renderReason(request, kind);
    submit(button);
    expect(await screen.findByText(required)).toBeTruthy();
    expect(http.countOf('PATCH /mech-requests/:id/lessor-receipt')).toBe(0);

    fireEvent.change(screen.getByLabelText(label), { target: { value: 'Ошибся' } });
    submit(button);
    await waitFor(() => expect(http.countOf('PATCH /mech-requests/:id/lessor-receipt')).toBe(1));
    expect(http.lastCall('PATCH /mech-requests/:id/lessor-receipt')?.body).toEqual({
      receiptId: 'lr-2',
      decision: 'revoke',
      comment: 'Ошибся',
      version: request.version,
    });
  });
});

describe('marks', () => {
  const marks = (request: MechRequestDto) => {
    const { container } = renderWithUser(<MechStateTag row={request} />);
    return [...container.querySelectorAll('.ant-tag')].map((tag) => tag.textContent);
  };

  it('pending, rejected and missing are marked next to the state', () => {
    expect(marks(withPending())).toContain('чек ждёт визы');
    expect(marks(rental({ lessorReceipt: version({ status: 'rejected' }) }))).toContain(
      'чек отклонён',
    );
    expect(marks(rental())).toContain('нет чека');
  });

  it('approved, not required and archived rows carry no mark', () => {
    const none = (request: MechRequestDto) =>
      expect(marks(request).filter((text) => text?.startsWith('чек') || text === 'нет чека'));
    none(rental({ lessorReceipt: version({ status: 'approved' }) })).toEqual([]);
    none(rental({ lessorReceiptRequired: false })).toEqual([]);
    none(withPending({ deletedAt: '2026-11-07T08:00:00.000Z' })).toEqual([]);
  });
});

describe('the filter «Чек»', () => {
  const DICTIONARIES: RouteMap = {
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /mech-models': () => json(emptyList()),
  };

  async function choose(option: string) {
    const placeholder = await screen.findByText('Чек: любой');
    fireEvent.mouseDown(placeholder.closest('.ant-select')!.querySelector('.ant-select-content')!);
    await waitFor(() => {
      const item = [...document.querySelectorAll('.ant-select-item-option')].find(
        (o) => o.textContent === option,
      );
      expect(item).toBeTruthy();
      fireEvent.click(item!);
    });
  }

  it('goes to the server as lessorReceipt in the working list', async () => {
    const http = mockHttp({
      ...DICTIONARIES,
      'GET /mech-requests': () => json(list([withPending()])),
      'GET /mech-requests/summary': () =>
        json({ pending: 0, awaitingIssue: 0, rental: 1, overdue: 0 }),
    });
    renderWithUser(<MechRequestsPage />, { route: '/mech?tab=requests', user: holder });
    await choose('ждёт визы');
    await waitFor(() =>
      expect(http.lastCall('GET /mech-requests')?.query.get('lessorReceipt')).toBe('pending'),
    );
  });

  it('and in the journal, where «what closed without a receipt» is asked', async () => {
    const http = mockHttp({
      ...DICTIONARIES,
      'GET /mech-requests/history': () => json(list([])),
      'GET /mech-requests/history/summary': () =>
        json({ closed: 0, rentals: 0, cancelled: 0, days: 0, hours: 0, shifts: 0, cost: '0' }),
    });
    renderWithUser(<MechRequestsPage />, { route: '/mech?tab=history', user: holder });
    await choose('без чека');
    await waitFor(() =>
      expect(http.lastCall('GET /mech-requests/history')?.query.get('lessorReceipt')).toBe(
        'waived',
      ),
    );
    expect(http.lastCall('GET /mech-requests/history/summary')?.query.get('lessorReceipt')).toBe(
      'waived',
    );
  });
});

describe('the card history', () => {
  it('opens a version from the line that attached it', async () => {
    const request = withPending();
    const attached: RequestHistoryEntryDto = {
      id: 'audit-1',
      kind: 'mechLessorReceiptAttached',
      at: '2026-11-03T08:00:00.000Z',
      actorId: 'user-1',
      actorName: 'Диспетчеров Д. П.',
      fromStatus: null,
      toStatus: null,
      comment: '',
      changes: [
        { field: 'lessorReceiptVersion', from: null, to: '1' },
        {
          field: 'filesAdded',
          from: null,
          to: 'чек-1.pdf',
          files: [{ id: 'f-1', filename: 'чек-1.pdf' }],
        },
      ],
    };
    mockHttp({
      'GET /mech-requests/:id': () => json(request),
      'GET /mech-requests/:id/history': () => json([attached]),
      'GET /files/:id/download': ({ params }) =>
        json({ url: `https://storage.test/${params.id}.pdf`, expiresIn: 300 }),
    });
    renderWithUser(<MechRequestViewModal request={request} today="2026-11-09" onClose={noop} />, {
      user: holder,
    });

    fireEvent.click(await screen.findByRole('tab', { name: 'История' }));
    const historyPanel = await screen.findByRole('tabpanel', { name: 'История' });
    fireEvent.click(await within(historyPanel).findByText('чек-1.pdf'));
    await waitFor(() =>
      expect(pdfjs.getDocument).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://storage.test/f-1.pdf' }),
      ),
    );
  });
});
