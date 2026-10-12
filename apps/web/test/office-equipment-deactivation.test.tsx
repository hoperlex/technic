import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type {
  AuthUser,
  OfficeEquipmentDto,
  OfficeEquipmentServiceEntryDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { officeEquipmentKeys } from '../src/entities/office-equipment';
import { OfficeEquipmentTab } from '../src/pages/directories/OfficeEquipmentTab';

/**
 * An unchecked "Active" switch names its consequence (plan `docs/office-equipment-candidate-plan.md`,
 * §13 Ф4).
 *
 * This pins exactly what is easy to lose on the next edit of this form.
 *
 * First, **the window warns, it does not forbid**. Deactivating a card is legitimate and must pass:
 * it is done precisely to a unit that went to repair on a live request. If the "confirmation sends
 * the edit" test ever turns red because of a new refusal, fix the refusal, not the test: a ban here
 * would mean "while equipment is being repaired it cannot be taken out of service".
 *
 * Second, **"these requests are open" differs from "nothing is known about them"**. The numbers come
 * from `openServiceRequestNumbers` (ADR 0169, E5b), which the answer lacks for an operator without
 * `serviceRequests.read`, and exactly such people keep the directory. Silence instead of the phrase
 * would mean a person without the request permission closes the door to new requests unaware.
 *
 * Third, **"not visible" is not passed off as "none"**. The list is narrowed by the request scope, so
 * an empty list says the same general phrase as a missing permission: the portal may not claim
 * "there are no open requests".
 *
 * Fourth, **the numbers are the server's exact list, not the card slice**. `serviceHistory` was cut
 * at ten rows, so an open request beyond them was silently missing from the warning; E6 removes the
 * slice altogether, and the warning must not notice.
 */

const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

const TYPE_MFU = {
  id: 'oet-1',
  code: 'mfp',
  name: 'МФУ',
  sortOrder: 1,
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function equipmentDto(over: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: TYPE_MFU.id, name: TYPE_MFU.name, isActive: true },
    specs: [],
    model: { id: 'oem-1', name: 'Kyocera M3145' },
    name: 'Kyocera M3145',
    serialNumber: '',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    department: null,
    location: 'каб. 214',
    state: 'on_site',
    stateNote: '',
    purchasedOn: null,
    warrantyUntil: null,
    comment: '',
    isActive: true,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

function entry(over: Partial<OfficeEquipmentServiceEntryDto> = {}): OfficeEquipmentServiceEntryDto {
  return {
    id: 'sr-1',
    displayNumber: 'СО-14',
    status: 'in_work',
    createdAt: '2026-08-20T09:00:00.000Z',
    completedAt: null,
    serviceName: null,
    totalAmount: null,
    warranties: [],
    ...over,
  };
}

/**
 * The directory tab with a list of one card. `card` is the `GET /office-equipment/:id` answer: its
 * `openServiceRequestNumbers` (or their absence) decides what the warning says.
 */
function renderTab(card: OfficeEquipmentDto): { http: HttpMock; queryClient: QueryClient } {
  const http = mockHttp({
    'GET /office-equipment': () => json(list([equipmentDto()])),
    'GET /office-equipment/:id': () => json(card),
    // Блок «Показания и события» (план `docs/office-equipment-mail-telemetry-plan.md`, §10)
    // висит в каждой карточке справочника: пустой ответ здесь означает «аппарат ещё не
    // присылал писем» — законное состояние, к предмету этого файла отношения не имеющее.
    'GET /office-equipment/:id/telemetry': () =>
      json({ metrics: [], events: { items: [], hasMore: false, nextCursor: null } }),
    // Рядом с ним — блок «Ключи опознания» (ADR 0200): он спрашивает реестр ключей
    // карточки, и незамоканный запрос уронил бы файл на общей сверке.
    'GET /device-mail/identities': () => json({ items: [], hasMore: false, nextCursor: null }),
    // Секция «Обслуживание и гарантии» карточки читает теперь блок «Связанные заявки» (план
    // истории тремя блоками, Р7), а не срез `serviceHistory` ответа карточки.
    'GET /office-equipment/:id/requests': () =>
      json({ items: [], hasMore: false, nextCursor: null }),
    'GET /office-equipment-types': () => json(list([TYPE_MFU])),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /office-equipment-models': () => json(emptyList()),
    'PATCH /office-equipment/:id': () => json(equipmentDto({ isActive: false })),
  });
  const { queryClient } = renderWithUser(<OfficeEquipmentTab />, { user: OPERATOR });
  return { http, queryClient };
}

/**
 * Wait for the unit card, the answer the warning is computed from.
 *
 * Its arrival is not visible on screen (the "service and warranties" section reads the requests
 * block, plan `docs/office-equipment-history-blocks-plan.md`, Р7), so the test waits for exactly
 * what the warning reads, the query cache entry: a click before the answer would test a race, not
 * the branch with numbers.
 */
async function awaitCard(queryClient: QueryClient): Promise<void> {
  await waitFor(() =>
    expect(queryClient.getQueryData(officeEquipmentKeys.detail('oe-1'))).toBeTruthy(),
  );
}

/** Открыть окно правки первой строки — тем же карандашом, что и человек. */
async function openEdit(): Promise<void> {
  await screen.findByText('0012345', { exact: false });
  const edit = [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
    (b) => b.querySelector('.anticon-edit') !== null,
  );
  fireEvent.click(edit!);
  await screen.findByText('Редактирование карточки');
}

/** Снять «Активна» и нажать «Сохранить». Переключатель в окне один — он же и есть галочка. */
function switchOffAndSave(): void {
  fireEvent.click(screen.getByRole('switch'));
  const save = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find(
    (b) => b.textContent === 'Сохранить',
  );
  fireEvent.click(save!);
}

/** Текст окна подтверждения целиком: заголовок и абзацы. */
async function confirmText(): Promise<string> {
  const box = await waitFor(() => {
    const found = document.querySelector('.ant-modal-confirm');
    if (!found) throw new Error('окна подтверждения нет');
    return found;
  });
  return box.textContent ?? '';
}

/** Нажать «Выключить и сохранить» в окне подтверждения. */
function acceptConfirm(): void {
  const ok = [
    ...document.querySelectorAll<HTMLButtonElement>('.ant-modal-confirm-btns button'),
  ].find((b) => b.textContent === 'Выключить и сохранить');
  fireEvent.click(ok!);
}

describe('выключение карточки оргтехники', () => {
  it('называет незакрытые заявки и не сохраняет, пока человек не подтвердил', async () => {
    const { http, queryClient } = renderTab(equipmentDto({ openServiceRequestNumbers: ['СО-14'] }));
    await openEdit();
    // Wait for the card itself: before it arrives the warning has no numbers, and the test would
    // check a race instead of the branch with numbers.
    await awaitCard(queryClient);
    switchOffAndSave();

    const text = await confirmText();
    expect(text).toContain('Выключить карточку «Kyocera M3145 · инв. 0012345»?');
    expect(text).toContain('Незакрытые заявки на обслуживание: СО-14');
    // Последствие названо словами: ради него окно и показывают.
    expect(text).toContain('новую заявку на этот аппарат завести будет нельзя');
    // Правка не ушла: окно спрашивает ДО сохранения, а не рассказывает о случившемся после.
    expect(http.lastCall('PATCH /office-equipment/:id')).toBeUndefined();
  });

  it('подтверждение выключает карточку — это предупреждение, а не запрет', async () => {
    const { http, queryClient } = renderTab(equipmentDto({ openServiceRequestNumbers: ['СО-14'] }));
    await openEdit();
    await awaitCard(queryClient);
    switchOffAndSave();
    await confirmText();
    acceptConfirm();

    await waitFor(() => expect(http.lastCall('PATCH /office-equipment/:id')).toBeTruthy());
    const body = http.lastCall('PATCH /office-equipment/:id')!.body as { isActive: boolean };
    expect(body.isActive).toBe(false);
  });

  it('без права на заявки предупреждает общей фразой, а не молчит', async () => {
    // An answer without `openServiceRequestNumbers` is what the server gives a viewer without
    // `serviceRequests.read` (and what a server older than E5b gives everyone). There are no
    // numbers to show, the consequence is the same.
    const { queryClient } = renderTab(equipmentDto());
    await openEdit();
    await awaitCard(queryClient);
    switchOffAndSave();

    const text = await confirmText();
    expect(text).toContain('Незакрытые заявки на обслуживание, если они есть');
    expect(text).toContain('новую заявку на этот аппарат завести будет нельзя');
  });

  it('пустой список не выдаётся за «незакрытых заявок нет»', async () => {
    // The permission is there and no open request is visible, but the list is narrowed by the
    // request scope, so the phrase stays conditional.
    const { queryClient } = renderTab(equipmentDto({ openServiceRequestNumbers: [] }));
    await openEdit();
    await awaitCard(queryClient);
    switchOffAndSave();

    const text = await confirmText();
    expect(text).toContain('Незакрытые заявки на обслуживание, если они есть');
    expect(text).not.toContain('заявок нет');
  });

  it('номера — точный список сервера, а не срез `serviceHistory` карточки (E5b)', async () => {
    // The slice still arrives until E6 and disagrees with the list on purpose: an open request in
    // the slice that the server no longer reports, and two open ones beyond the slice's ten rows.
    const { queryClient } = renderTab(
      equipmentDto({
        serviceHistory: [entry({ displayNumber: 'СО-14', status: 'in_work' })],
        openServiceRequestNumbers: ['СО-31', 'СО-32'],
      }),
    );
    await openEdit();
    await awaitCard(queryClient);
    switchOffAndSave();

    const text = await confirmText();
    expect(text).toContain('Незакрытые заявки на обслуживание: СО-31, СО-32.');
    expect(text).not.toContain('СО-14');
  });

  it('правка при включённой галочке идёт сразу, без лишнего окна', async () => {
    const { http, queryClient } = renderTab(equipmentDto({ openServiceRequestNumbers: ['СО-14'] }));
    await openEdit();
    await awaitCard(queryClient);
    const save = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find(
      (b) => b.textContent === 'Сохранить',
    );
    fireEvent.click(save!);

    await waitFor(() => expect(http.lastCall('PATCH /office-equipment/:id')).toBeTruthy());
    expect(document.querySelector('.ant-modal-confirm')).toBeNull();
  });
});
