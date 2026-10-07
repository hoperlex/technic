import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto, ServiceRequestItemDto } from '@technic/contracts';
import { EstimateEditorModal } from '../src/features/estimate-editor';
import { json, mockHttp, type MockResponse } from './http';
import { renderWithProps } from './propsDriver';
import { SERVICE_COUNTERPARTY, serviceExecutor, serviceRequest } from './factories/service';

/**
 * The scope-of-work window against rereads (stage 5 plan §4.5 and appendix A4, wave 1).
 *
 * The breakdown window gets the card's live request, and the card is invalidated by every action
 * on the request: the window reset the rows, the comment and the attached invoice, and took the
 * live version. Now it keeps the composition under the notice, sends the version of its fill, and
 * moves that version with its own draft save.
 */

const EXECUTOR: AuthUser = serviceExecutor();
const NOTICE = 'Запись изменена другим пользователем';
const SAVE = 'PUT /service-requests/:id/estimate';
const SUBMIT = 'PATCH /service-requests/:id/estimate/submit';

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
const V = REQUEST.version;

/** A colleague's save: one more version, another description. */
const theirs = (name: string): ServiceRequestDto => ({
  ...REQUEST,
  version: V + 1,
  items: [item(name)],
});

const description = () => screen.getByLabelText('Описание объёма работ') as HTMLTextAreaElement;

function renderEditor(save: () => MockResponse = () => json(theirs('Замена узла'))) {
  const http = mockHttp({
    [SAVE]: save,
    [SUBMIT]: () => json({ ...REQUEST, version: V + 2, estimatePendingRevision: 1 }),
  });
  const view = renderWithProps(
    EstimateEditorModal,
    { request: REQUEST as ServiceRequestDto | null, onClose: () => {} },
    { user: EXECUTOR },
  );
  return { http, ...view };
}

async function opened() {
  await waitFor(() => expect(description().value).toBe('Замена узла подачи'));
}

describe('a colleague saves the request while the window is open', () => {
  it('a changed window keeps the composition, shows the notice and saves with the old version', async () => {
    const { http, update } = renderEditor(() =>
      json({ code: 'version_conflict', message: 'Заявку изменили' }, 409),
    );
    await opened();
    fireEvent.change(description(), { target: { value: 'Замена узла подачи и ролика' } });

    update({ request: theirs('Чистка') });
    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(description().value).toBe('Замена узла подачи и ролика');

    fireEvent.click(screen.getByText('Сохранить черновик'));
    await waitFor(() => expect(http.countOf(SAVE)).toBe(1));
    expect((http.lastCall(SAVE)!.body as { version: number }).version).toBe(V);
  });

  it('«Перечитать» shows the colleague’s composition', async () => {
    const { update } = renderEditor();
    await opened();
    fireEvent.change(description(), { target: { value: 'Замена узла подачи и ролика' } });
    update({ request: theirs('Чистка') });

    fireEvent.click(await screen.findByText('Перечитать'));
    await waitFor(() => expect(description().value).toBe('Чистка'));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('an untouched window follows the reread silently and saves with the new version', async () => {
    const { http, update } = renderEditor();
    await opened();

    update({ request: theirs('Чистка') });
    await waitFor(() => expect(description().value).toBe('Чистка'));
    expect(screen.queryByText(NOTICE)).toBeNull();

    fireEvent.change(description(), { target: { value: 'Чистка и смазка' } });
    fireEvent.click(screen.getByText('Сохранить черновик'));
    await waitFor(() => expect(http.countOf(SAVE)).toBe(1));
    expect((http.lastCall(SAVE)!.body as { version: number }).version).toBe(V + 1);
  });
});

describe('own save of the window', () => {
  it('a draft save moves the snapshot: the reread of our own save is no conflict', async () => {
    const saved = { ...REQUEST, version: V + 1, items: [item('Замена узла подачи и ролика')] };
    const { http, update } = renderEditor(() => json(saved));
    await opened();
    fireEvent.change(description(), { target: { value: 'Замена узла подачи и ролика' } });
    fireEvent.click(screen.getByText('Сохранить черновик'));
    await waitFor(() => expect(http.countOf(SAVE)).toBe(1));

    // The card rereads after the save and hands the window our own version.
    update({ request: saved });
    await waitFor(() => expect(description().value).toBe('Замена узла подачи и ролика'));
    expect(screen.queryByText(NOTICE)).toBeNull();

    fireEvent.click(screen.getByText('Предъявить на согласование'));
    await waitFor(() => expect(http.countOf(SUBMIT)).toBe(1));
    expect((http.lastCall(SUBMIT)!.body as { version: number }).version).toBe(V + 1);
  });
});
