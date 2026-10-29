import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

/** The documents table, not the calendar grid of a date picker: role queries would find both. */
function documentRows(): string[] {
  return [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')].map(
    (row) => row.textContent ?? '',
  );
}
import type { VehicleRequestDocumentDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { vehicleRequest } from './factories/vehicle';
import { VehicleRequestDocuments } from '../src/features/vehicle-request-documents';

/**
 * The documents section of a vehicle request card (plan
 * `docs/vehicle-rental-completion-documents-plan.md`, D5–D8, P5, P10): one table of the requester's
 * attachments and typed, dated paper; the table hidden while empty, the «Добавить файл» button from
 * «В работе» on for whoever runs requests, removal of one's own document only.
 */

const ROUTE = 'GET /vehicle-requests/vr-1/documents';

function pdf(name: string): File {
  return new File([new Uint8Array([0x25, 0x50])], name, { type: 'application/pdf' });
}

/** Rows are 1-based as the person counts them; each has its own hidden input. */
function pickFile(dialog: HTMLElement, row: number, picked: File): void {
  const input = dialog.querySelector(`input[aria-label="Файл, строка ${row}"]`) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [picked] } });
}

/** The date fields carry no caption, so the row's own `aria-label` finds them. */
function typeRowDate(row: number, text: string): void {
  const input = screen
    .getAllByLabelText(`Дата документа, строка ${row}`)
    .find((el) => el.closest('.ant-modal-wrap')?.getAttribute('style') !== 'display: none;')!;
  fireEvent.mouseDown(input);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
  fireEvent.blur(input);
}

function file(id: string, filename: string) {
  return {
    id,
    filename,
    contentType: 'application/pdf',
    size: 2048,
    status: 'active' as const,
    createdAt: '2026-10-12T09:00:00.000Z',
  };
}

const ATTACHMENT: VehicleRequestDocumentDto = {
  kind: 'attachment',
  file: file('f-1', 'схема.pdf'),
  docType: null,
  docDate: null,
  addedAt: '2026-10-12T09:00:00.000Z',
  uploadedBy: 'user-9',
  uploadedByName: 'Заявитель З. З.',
};

const OWN_UPD: VehicleRequestDocumentDto = {
  kind: 'document',
  file: file('f-2', 'upd-1234.pdf'),
  docType: 'УПД',
  docDate: '2026-10-14',
  addedAt: '2026-10-15T09:00:00.000Z',
  uploadedBy: 'user-1',
  uploadedByName: 'Диспетчеров Д. П.',
};

const FOREIGN_ACT: VehicleRequestDocumentDto = {
  ...OWN_UPD,
  file: file('f-3', 'act-77.pdf'),
  docType: 'Акт',
  uploadedBy: 'user-2',
  uploadedByName: 'Другой Д. Д.',
};

const UPLOAD: RouteMap = {
  'POST /files/upload-session': () =>
    json({
      fileId: 'f-new',
      uploadUrl: 'https://storage.test/put/f-new',
      objectKey: 'vehicle/f-new.pdf',
      expiresIn: 900,
    }),
  'POST /files/:id/complete': () => json(file('f-new', 'upd-2000.pdf')),
};

function render(
  items: VehicleRequestDocumentDto[],
  options: {
    status?: 'new' | 'confirmed' | 'done';
    role?: 'dispatcher' | 'site';
    routes?: RouteMap;
  } = {},
): HttpMock {
  const http = mockHttp({ [ROUTE]: () => json({ items }), ...UPLOAD, ...options.routes });
  renderWithUser(
    <VehicleRequestDocuments request={vehicleRequest({ status: options.status ?? 'confirmed' })} />,
    { user: authUser({ role: options.role ?? 'dispatcher' }) },
  );
  return http;
}

describe('vehicle request documents', () => {
  it('shows the button without a table while there is nothing to list', async () => {
    const http = render([]);
    expect(await screen.findByRole('button', { name: /Добавить файл/ })).toBeDefined();
    await waitFor(() => expect(http.countOf(ROUTE)).toBe(1));
    expect(document.querySelector('.ant-table')).toBeNull();
  });

  it('draws nothing on a «Новая» request without files', async () => {
    const http = render([], { status: 'new' });
    await waitFor(() => expect(http.countOf(ROUTE)).toBe(1));
    expect(screen.queryByText('Документы')).toBeNull();
    expect(screen.queryByRole('button', { name: /Добавить файл/ })).toBeNull();
  });

  it('lists attachments and documents in one table and lets remove only one’s own document', async () => {
    render([ATTACHMENT, OWN_UPD, FOREIGN_ACT]);
    await screen.findByText('upd-1234.pdf');
    expect(documentRows()).toEqual([
      expect.stringContaining('Вложение заявителя'),
      expect.stringContaining('УПД14.10.2026'),
      expect.stringContaining('Акт14.10.2026'),
    ]);
    expect(screen.getByLabelText('Снять upd-1234.pdf')).toBeDefined();
    expect(screen.queryByLabelText('Снять act-77.pdf')).toBeNull();
    expect(screen.queryByLabelText('Снять схема.pdf')).toBeNull();
  });

  it('a site user sees the table but neither adds nor removes', async () => {
    render([OWN_UPD], { role: 'site' });
    expect(await screen.findByText('upd-1234.pdf')).toBeDefined();
    expect(screen.queryByText('Добавить файл')).toBeNull();
    expect(screen.queryByLabelText('Снять upd-1234.pdf')).toBeNull();
  });

  it('opens with one row of three fields and no way to delete it', async () => {
    render([]);
    fireEvent.click(await screen.findByRole('button', { name: /Добавить файл/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Выбрать файл/ })).toBeDefined();
    expect(within(dialog).getByLabelText('Тип документа, строка 1')).toBeDefined();
    expect(within(dialog).getByLabelText('Дата документа, строка 1')).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /Убрать строку/ })).toBeNull();
  });

  it('shows the chosen file on the button only: the native input stays out of sight', async () => {
    render([]);
    fireEvent.click(await screen.findByRole('button', { name: /Добавить файл/ }));
    const dialog = await screen.findByRole('dialog');
    // The form's own stylesheet gives every file input `display: block`, which beats the `hidden`
    // attribute: the browser's «Choose file / No file chosen» then sits over the button and, with
    // the value cleared after the pick, keeps saying that nothing was chosen.
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    expect(window.getComputedStyle(input).display).toBe('none');
  });

  it('adds a row on «Прикрепить ещё документ» and deletes any row once there are several', async () => {
    render([]);
    fireEvent.click(await screen.findByRole('button', { name: /Добавить файл/ }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: /Прикрепить ещё документ/ }));
    expect(within(dialog).getByLabelText('Тип документа, строка 2')).toBeDefined();
    expect(within(dialog).getAllByRole('button', { name: /Убрать строку/ })).toHaveLength(2);

    // The first row is the one kept: what was typed in it stays, the second goes.
    fireEvent.change(within(dialog).getByLabelText('Тип документа, строка 1'), {
      target: { value: 'Акт' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Убрать строку 2' }));
    expect(within(dialog).queryByLabelText('Тип документа, строка 2')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Убрать строку/ })).toBeNull();
    expect(
      (within(dialog).getByLabelText('Тип документа, строка 1') as HTMLInputElement).value,
    ).toBe('Акт');
  });

  it('names the empty fields of the row without sending', async () => {
    const http = render([]);
    fireEvent.click(await screen.findByRole('button', { name: /Добавить файл/ }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(await within(dialog).findByText('Выберите файл')).toBeDefined();
    expect(within(dialog).getByText('Укажите тип документа')).toBeDefined();
    expect(within(dialog).getByText('Укажите дату')).toBeDefined();
    expect(http.countOf('POST /files/upload-session')).toBe(0);
    expect(http.countOf('POST /vehicle-requests/vr-1/documents')).toBe(0);
  });

  it('keeps a file over the limit in its row with the reason under it', async () => {
    const http = render([]);
    fireEvent.click(await screen.findByRole('button', { name: /Добавить файл/ }));
    const dialog = await screen.findByRole('dialog');

    const big = new File([new Uint8Array([1])], 'scan.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
    pickFile(dialog, 1, big);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));

    expect(await within(dialog).findByText('Файл больше 50 МБ')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /scan\.pdf/ })).toBeDefined();
    expect(http.countOf('POST /files/upload-session')).toBe(0);
  });

  it('uploads the file, then links it with its type and date', async () => {
    const http = render([], {
      routes: {
        'POST /vehicle-requests/vr-1/documents': () =>
          json({
            items: [{ ...OWN_UPD, file: file('f-new', 'upd-2000.pdf'), docDate: '2027-01-15' }],
          }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Добавить файл/ }));
    const dialog = await screen.findByRole('dialog');

    pickFile(dialog, 1, pdf('upd-2000.pdf'));
    fireEvent.change(within(dialog).getByLabelText('Тип документа, строка 1'), {
      target: { value: 'УПД' },
    });
    // Any date: a document dated ahead of today is accepted (owner correction to P4).
    typeRowDate(1, '15.01.2027');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-requests/vr-1/documents')).toBe(1));
    expect(http.countOf('POST /files/upload-session')).toBe(1);
    expect(http.lastCall('POST /vehicle-requests/vr-1/documents')?.body).toEqual({
      fileId: 'f-new',
      docType: 'УПД',
      docDate: '2027-01-15',
    });
    // The answer is the table whole and goes in place: the new row shows without a refetch.
    await waitFor(() => expect(documentRows()).toEqual([expect.stringContaining('15.01.2027')]));
    expect(http.countOf(ROUTE)).toBe(1);
  });

  it('sends several rows in the order of the window, one document each', async () => {
    let sessions = 0;
    const http = render([], {
      routes: {
        'POST /files/upload-session': () => {
          sessions += 1;
          return json({
            fileId: `f-new-${sessions}`,
            uploadUrl: `https://storage.test/put/f-new-${sessions}`,
            objectKey: `vehicle/f-new-${sessions}.pdf`,
            expiresIn: 900,
          });
        },
        'POST /files/:id/complete': ({ params }) => json(file(params.id!, 'any.pdf')),
        'POST /vehicle-requests/vr-1/documents': () => json({ items: [OWN_UPD] }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Добавить файл/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Прикрепить ещё документ/ }));

    pickFile(dialog, 1, pdf('upd-1.pdf'));
    fireEvent.change(within(dialog).getByLabelText('Тип документа, строка 1'), {
      target: { value: 'УПД' },
    });
    typeRowDate(1, '14.10.2026');
    pickFile(dialog, 2, pdf('act-2.pdf'));
    fireEvent.change(within(dialog).getByLabelText('Тип документа, строка 2'), {
      target: { value: ' Акт ' },
    });
    typeRowDate(2, '15.10.2026');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-requests/vr-1/documents')).toBe(2));
    expect(
      http.calls
        .filter(
          (call) => call.method === 'POST' && call.path === '/vehicle-requests/vr-1/documents',
        )
        .map((call) => call.body),
    ).toEqual([
      { fileId: 'f-new-1', docType: 'УПД', docDate: '2026-10-14' },
      { fileId: 'f-new-2', docType: 'Акт', docDate: '2026-10-15' },
    ]);
  });

  it('stops at the first refusal: the added rows leave the window, the rest stay', async () => {
    let links = 0;
    const http = render([], {
      routes: {
        'POST /vehicle-requests/vr-1/documents': () => {
          links += 1;
          return links === 1
            ? json({ items: [OWN_UPD] })
            : apiError(422, {
                code: 'UNPROCESSABLE',
                message: 'К заявке приложено 50 документов — больше добавить нельзя',
              });
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Добавить файл/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Прикрепить ещё документ/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Прикрепить ещё документ/ }));

    for (const [row, name, type, date] of [
      [1, 'upd-1.pdf', 'УПД', '14.10.2026'],
      [2, 'act-2.pdf', 'Акт', '15.10.2026'],
      [3, 'inv-3.pdf', 'Счёт', '16.10.2026'],
    ] as const) {
      pickFile(dialog, row, pdf(name));
      fireEvent.change(within(dialog).getByLabelText(`Тип документа, строка ${row}`), {
        target: { value: type },
      });
      typeRowDate(row, date);
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));

    expect(
      await screen.findByText(/Добавлено 1 из 3\. «act-2\.pdf»: К заявке приложено 50/),
    ).toBeDefined();
    // The third row was not tried; the second is the new first.
    expect(http.countOf('POST /vehicle-requests/vr-1/documents')).toBe(2);
    expect(http.countOf('POST /files/upload-session')).toBe(2);
    await waitFor(() =>
      expect(within(dialog).getAllByRole('button', { name: /Убрать строку/ })).toHaveLength(2),
    );
    expect(within(dialog).getByRole('button', { name: /act-2\.pdf/ })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /inv-3\.pdf/ })).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /upd-1\.pdf/ })).toBeNull();
    expect(
      (within(dialog).getByLabelText('Тип документа, строка 1') as HTMLInputElement).value,
    ).toBe('Акт');
    // The window stays open for the retry.
    expect(within(dialog).getByRole('button', { name: 'Добавить' })).toBeDefined();
  });
});
