import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AuthUser,
  ConfirmOfficeEquipmentCandidateInput,
  OfficeEquipmentCandidateDto,
  OfficeEquipmentModelDto,
  OfficeEquipmentTypeDto,
  UpdateOfficeEquipmentCandidateInput,
} from '@technic/contracts';
import { officeEquipmentCandidateKeys } from '../src/entities/office-equipment-candidate';
import { CandidateReviewModal } from '../src/features/candidate-review';
import { selectOption } from './antd';
import { json, mockHttp, type HttpMock, type MockResponse } from './http';
import { renderWithProps } from './propsDriver';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';

/**
 * The review window against rereads (stage 5 plan §4.5, wave 1; decision R6-a).
 *
 * The window rereads the candidate by its own query (R12), and the reread used to refill the form:
 * whatever the reviewer had typed was gone, and the confirmation went with the live version — a
 * colleague's edit was silently confirmed over. Now the form keeps the input under the notice, every
 * door sends the version taken at the fill, and the "declared" block of the same window moves that
 * version with its own save.
 */

const TYPE: OfficeEquipmentTypeDto = {
  id: 'oet-1',
  code: 'mfu',
  name: 'МФУ',
  sortOrder: 1,
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/** Two models so that `AutoSelect` does not pick one by itself and touch the form. */
const MODELS: OfficeEquipmentModelDto[] = ['Kyocera M3145', 'Canon i-SENSYS'].map((name, i) => ({
  id: `oem-${i + 1}`,
  type: { id: TYPE.id, name: TYPE.name, isActive: true },
  specs: [],
  name,
  manufacturer: '',
  isActive: true,
  comment: '',
  isUsed: false,
  equipmentCount: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}));

function candidateDto(
  over: Partial<OfficeEquipmentCandidateDto> = {},
): OfficeEquipmentCandidateDto {
  return {
    id: 'oec-1',
    status: 'pending',
    contentVersion: 3,
    equipmentType: { id: TYPE.id, name: TYPE.name, isActive: true },
    declaredModel: 'Kyocera M3145',
    serialNumber: '',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    location: 'каб. 214',
    comment: 'стоит у бухгалтерии',
    author: { id: 'user-9', name: 'Иванов Иван', departmentName: 'Бухгалтерия' },
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedByName: null,
    updatedAt: '2026-09-01T09:00:00.000Z',
    decidedByName: null,
    decidedAt: null,
    decisionReason: '',
    resultEquipment: null,
    request: null,
    ...over,
  };
}

const REVIEWER: AuthUser = authUser({
  id: 'user-review',
  role: 'shtab',
  addons: ['office_equipment_operator'],
  constructionObjectIds: ['obj-1'],
});

const DETAIL = 'GET /office-equipment-candidates/:id';
const CONFIRM = 'POST /office-equipment-candidates/:id/confirm';
const NOTICE = 'Запись изменена другим пользователем';

interface Setup {
  http: HttpMock;
  /** What the server holds now: the next reread returns it. */
  serve: (next: OfficeEquipmentCandidateDto) => void;
  /** A reread the way any neighbouring invalidation causes it. */
  reread: () => Promise<void>;
  update: (next: { candidateId: string | null }) => void;
}

function renderWindow(confirm: () => MockResponse = () => json(candidateDto())): Setup {
  let current = candidateDto();
  const http = mockHttp({
    'GET /office-equipment-types': () => json(list([TYPE])),
    'GET /office-equipment-types/:id/specs': () => json([]),
    'GET /office-equipment-models': () => json(list(MODELS)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    [DETAIL]: () => json(current),
    [CONFIRM]: confirm,
    'PATCH /office-equipment-candidates/:id': ({ body }) => {
      const input = body as UpdateOfficeEquipmentCandidateInput;
      current = candidateDto({ ...input, contentVersion: current.contentVersion + 1 });
      return json(current);
    },
  });
  const { update, queryClient } = renderWithProps(
    CandidateReviewModal,
    { candidateId: 'oec-1' as string | null, onClose: () => {} },
    { user: REVIEWER },
  );
  return {
    http,
    serve: (next) => (current = next),
    reread: async () => {
      const before = http.countOf(DETAIL);
      await act(() =>
        queryClient.invalidateQueries({ queryKey: officeEquipmentCandidateKeys.root }),
      );
      await waitFor(() => expect(http.countOf(DETAIL)).toBeGreaterThan(before));
    },
    update,
  };
}

/**
 * A field of one of the window's forms by its name. Not by label: the "declared" block, once
 * edited, is a second form with the same field names, and antd gives both the same element ids —
 * a label lookup would land in whichever comes first.
 */
function fieldOf(which: 'declared' | 'review', name: string): HTMLInputElement {
  const forms = [...document.querySelectorAll('form')];
  const form = which === 'declared' ? forms[0] : forms[forms.length - 1];
  const input = form?.querySelector(`[id="${name}"]`);
  if (!input) throw new Error(`поля «${name}» в форме «${which}» нет`);
  return input as HTMLInputElement;
}
const reviewField = (name: string) => fieldOf('review', name);

async function formFilled() {
  await waitFor(() => expect(reviewField('location').value).toBe('каб. 214'));
}

describe('a colleague edits the candidate while the review form is open', () => {
  it('a changed form keeps the input, shows the notice and confirms with the old version', async () => {
    const { http, serve, reread } = renderWindow(() =>
      json({ code: 'version_conflict', message: 'Решение уже принято' }, 409),
    );
    await formFilled();
    fireEvent.change(reviewField('location'), { target: { value: 'каб. 215' } });

    serve(candidateDto({ contentVersion: 4, location: 'каб. 300', comment: 'переехал' }));
    await reread();

    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(reviewField('location').value).toBe('каб. 215');
    // Untouched fields stay too: half of the form from a version the reviewer has not read would
    // be a third version nobody wrote.
    expect(reviewField('comment').value).toBe('стоит у бухгалтерии');

    await selectOption('Модель', 'Kyocera M3145');
    fireEvent.click(screen.getByText('Завести карточку'));
    await waitFor(() => expect(http.countOf(CONFIRM)).toBe(1));
    expect(
      (http.lastCall(CONFIRM)!.body as ConfirmOfficeEquipmentCandidateInput).expectedVersion,
    ).toBe(3);
    expect(await screen.findByText(/Решение уже приняли или форма устарела/)).toBeDefined();
  });

  it('«Перечитать» drops the input by consent and takes the fresh version', async () => {
    const { http, serve, reread } = renderWindow();
    await formFilled();
    fireEvent.change(reviewField('location'), { target: { value: 'каб. 215' } });
    serve(candidateDto({ contentVersion: 4, location: 'каб. 300' }));
    await reread();

    fireEvent.click(await screen.findByText('Перечитать'));
    await waitFor(() => expect(reviewField('location').value).toBe('каб. 300'));
    expect(screen.queryByText(NOTICE)).toBeNull();

    await selectOption('Модель', 'Kyocera M3145');
    fireEvent.click(screen.getByText('Завести карточку'));
    await waitFor(() => expect(http.countOf(CONFIRM)).toBe(1));
    expect(
      (http.lastCall(CONFIRM)!.body as ConfirmOfficeEquipmentCandidateInput).expectedVersion,
    ).toBe(4);
  });

  it('an untouched form follows the fresh candidate silently, version included', async () => {
    const { http, serve, reread } = renderWindow();
    await formFilled();

    serve(candidateDto({ contentVersion: 4, location: 'каб. 300' }));
    await reread();
    await waitFor(() => expect(reviewField('location').value).toBe('каб. 300'));
    expect(screen.queryByText(NOTICE)).toBeNull();

    await selectOption('Модель', 'Kyocera M3145');
    fireEvent.click(screen.getByText('Завести карточку'));
    await waitFor(() => expect(http.countOf(CONFIRM)).toBe(1));
    expect(
      (http.lastCall(CONFIRM)!.body as ConfirmOfficeEquipmentCandidateInput).expectedVersion,
    ).toBe(4);
  });
});

describe('own change in the same window', () => {
  it('a save of the declared block moves the snapshot and refills untouched fields only', async () => {
    const { http } = renderWindow();
    await formFilled();
    fireEvent.change(reviewField('comment'), { target: { value: 'проверил на месте' } });

    fireEvent.click(screen.getByText('Поправить сообщённое'));
    await waitFor(() => expect(document.querySelectorAll('form')).toHaveLength(2));
    fireEvent.change(fieldOf('declared', 'location'), { target: { value: 'каб. 216' } });
    fireEvent.click(screen.getByText('Сохранить правку'));

    await waitFor(() => expect(reviewField('location').value).toBe('каб. 216'));
    expect(
      (
        http.lastCall('PATCH /office-equipment-candidates/:id')!
          .body as UpdateOfficeEquipmentCandidateInput
      ).expectedVersion,
    ).toBe(3);
    // The reviewer's own words survive the neighbouring save; no notice — the change was ours.
    expect(reviewField('comment').value).toBe('проверил на месте');
    expect(screen.queryByText(NOTICE)).toBeNull();

    await selectOption('Модель', 'Kyocera M3145');
    fireEvent.click(screen.getByText('Завести карточку'));
    await waitFor(() => expect(http.countOf(CONFIRM)).toBe(1));
    expect(
      (http.lastCall(CONFIRM)!.body as ConfirmOfficeEquipmentCandidateInput).expectedVersion,
    ).toBe(4);
  });
});

describe('window session', () => {
  it('reopening the same candidate fills the form anew', async () => {
    const { update } = renderWindow();
    await formFilled();
    fireEvent.change(reviewField('location'), { target: { value: 'каб. 215' } });

    update({ candidateId: null });
    update({ candidateId: 'oec-1' });
    await waitFor(() => expect(reviewField('location').value).toBe('каб. 214'));
  });
});
