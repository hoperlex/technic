import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

/** The documents table, not the calendar grid of a date picker: role queries would find both. */
function documentRows(): string[] {
  return [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')].map(
    (row) => row.textContent ?? '',
  );
}
import type { VehicleRequestDocumentDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { typeDate } from './antd';
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

    // Nothing chosen yet: the window names the fields, it does not send.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(await within(dialog).findByText('Выберите файл')).toBeDefined();
    expect(http.countOf('POST /vehicle-requests/vr-1/documents')).toBe(0);

    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File([new Uint8Array([0x25, 0x50])], 'upd-2000.pdf', { type: 'application/pdf' }),
        ],
      },
    });
    fireEvent.change(within(dialog).getByLabelText('Тип документа'), { target: { value: 'УПД' } });
    // Any date: a document dated ahead of today is accepted (owner correction to P4).
    typeDate('Дата документа', '15.01.2027');
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
});
