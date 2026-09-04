import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
import { OfficeEquipmentTab } from '../src/pages/directories/OfficeEquipmentTab';

/**
 * Снятая галочка «Активна» называет своё последствие (план
 * `docs/office-equipment-candidate-plan.md`, §13 Ф4).
 *
 * Закрепляется ровно то, что легко потерять при следующей правке этой формы.
 *
 * Первое — **окно предупреждает, а не запрещает**. Выключение карточки законно и обязано
 * проходить: гасят её как раз у аппарата, который уехал в ремонт по живой заявке. Если тест на
 * «подтверждение отправляет правку» однажды покраснеет из-за нового отказа, чинить нужно отказ, а
 * не тест: запрет здесь означал бы «пока техника чинится, вывести её из эксплуатации нельзя».
 *
 * Второе — **разница между «незакрытые заявки вот эти» и «про них ничего не известно»**. Номера
 * берутся из среза `serviceHistory`, которого в ответе нет вовсе у оператора без
 * `serviceRequests.read`, — а такие справочник как раз и ведут. Молчание вместо фразы означало бы,
 * что человек без права заявок закрывает вход новым заявкам, ничего об этом не узнав.
 *
 * Третье — **«не видно» не выдаётся за «нет»**. Срез сужен областью заявок и обрезан десятью
 * последними, поэтому пустой список открытых говорит ту же общую фразу, что и отсутствие права:
 * утверждать «незакрытых заявок нет» портал не вправе.
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
 * Вкладка справочника со списком из одной карточки. `card` — ответ `GET /office-equipment/:id`:
 * именно его срез `serviceHistory` (или его отсутствие) и решает, что скажет предупреждение.
 */
function renderTab(card: OfficeEquipmentDto): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list([equipmentDto()])),
    'GET /office-equipment/:id': () => json(card),
    'GET /office-equipment-types': () => json(list([TYPE_MFU])),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /office-equipment-models': () => json(emptyList()),
    'PATCH /office-equipment/:id': () => json(equipmentDto({ isActive: false })),
  });
  renderWithUser(<OfficeEquipmentTab />, { user: OPERATOR });
  return http;
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
    const http = renderTab(equipmentDto({ serviceHistory: [entry()] }));
    await openEdit();
    // Дожидаемся самой карточки: до её прихода номеров у предупреждения нет, и тест проверял бы
    // не ветку с номерами, а гонку.
    await screen.findByText('СО-14');
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
    const http = renderTab(equipmentDto({ serviceHistory: [entry()] }));
    await openEdit();
    await screen.findByText('СО-14');
    switchOffAndSave();
    await confirmText();
    acceptConfirm();

    await waitFor(() => expect(http.lastCall('PATCH /office-equipment/:id')).toBeTruthy());
    const body = http.lastCall('PATCH /office-equipment/:id')!.body as { isActive: boolean };
    expect(body.isActive).toBe(false);
  });

  it('без права на заявки предупреждает общей фразой, а не молчит', async () => {
    // Ответ без среза `serviceHistory` — так сервер отвечает тому, у кого нет
    // `serviceRequests.read`. Номера показать нечем, последствие — то же самое.
    const http = renderTab(equipmentDto());
    await openEdit();
    await waitFor(() => expect(http.lastCall('GET /office-equipment/:id')).toBeTruthy());
    switchOffAndSave();

    const text = await confirmText();
    expect(text).toContain('Незакрытые заявки на обслуживание, если они есть');
    expect(text).toContain('новую заявку на этот аппарат завести будет нельзя');
  });

  it('пустой срез не выдаётся за «незакрытых заявок нет»', async () => {
    // Право есть, открытых в срезе не видно — но срез сужен областью и обрезан десятью
    // последними, поэтому фраза та же сослагательная.
    renderTab(equipmentDto({ serviceHistory: [entry({ status: 'accepted' })] }));
    await openEdit();
    await screen.findByText('СО-14');
    switchOffAndSave();

    const text = await confirmText();
    expect(text).toContain('Незакрытые заявки на обслуживание, если они есть');
    expect(text).not.toContain('заявок нет');
  });

  it('правка при включённой галочке идёт сразу, без лишнего окна', async () => {
    const http = renderTab(equipmentDto({ serviceHistory: [entry()] }));
    await openEdit();
    await screen.findByText('СО-14');
    const save = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find(
      (b) => b.textContent === 'Сохранить',
    );
    fireEvent.click(save!);

    await waitFor(() => expect(http.lastCall('PATCH /office-equipment/:id')).toBeTruthy());
    expect(document.querySelector('.ant-modal-confirm')).toBeNull();
  });
});
