import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  AuthUser,
  OfficeEquipmentDto,
  OfficeEquipmentModelDto,
  OfficeEquipmentModelSpecDto,
  OfficeEquipmentSpecDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { selectOption } from './antd';
import { OfficeEquipmentTab } from '../src/pages/directories/OfficeEquipmentTab';
import { OfficeEquipmentModelFormModal } from '@entities/office-equipment';

/**
 * Цветность печати второй строкой в колонке «Тип» (план `docs/office-equipment-specs-plan.md`).
 *
 * Закрепляются три вещи, и каждая ломается молча.
 *
 * Первое — **разница между «н/д» и пустотой**. Незаполненное значение обязано называться вслух:
 * молчание рядом с типом читается как «чёрно-белый», а у самой массовой модели парка (68 карточек)
 * печать как раз ч/б — ошибиться было бы нечем. И наоборот: у типа, которому цветность не
 * положена, второй строки нет вовсе — у монитора не «н/д», у монитора вопроса нет (Р3, Р4).
 *
 * Второе — **форма модели присылает набор характеристик ТИПА, а не тронутые поля**: снятое
 * значение уезжает как `valueId: null`, иначе «стереть» нечем выразить, и очищенное поле молча
 * оставалось бы прежним в базе.
 *
 * Третье — сокращения приходят с сервера (`shortName`), портал их не сочиняет: «как это зовут
 * коротко» — свойство значения, и вторая запись правила разошлась бы с первой.
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

const COLOR_VALUE = { id: 'v-color', code: 'color', name: 'Цветная', shortName: 'цв.' };
const MONO_VALUE = { id: 'v-mono', code: 'mono', name: 'Чёрно-белая', shortName: 'ч/б' };

const PRINT_COLOR: OfficeEquipmentSpecDto = {
  id: 's-color',
  code: 'print_color',
  name: 'Цветность печати',
  showInList: true,
  sortOrder: 10,
  values: [COLOR_VALUE, MONO_VALUE],
};

function spec(value: OfficeEquipmentModelSpecDto['value']): OfficeEquipmentModelSpecDto {
  return {
    specId: PRINT_COLOR.id,
    code: PRINT_COLOR.code,
    name: PRINT_COLOR.name,
    showInList: true,
    sortOrder: 10,
    value,
  };
}

function equipmentDto(over: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: TYPE_MFU.id, name: TYPE_MFU.name, isActive: true },
    specs: [spec(MONO_VALUE)],
    model: { id: 'oem-1', name: 'Ricoh Aficio MP 201SPF' },
    name: 'Ricoh Aficio MP 201SPF',
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

function modelDto(over: Partial<OfficeEquipmentModelDto> = {}): OfficeEquipmentModelDto {
  return {
    id: 'oem-1',
    type: { id: TYPE_MFU.id, name: TYPE_MFU.name, isActive: true },
    specs: [spec(MONO_VALUE)],
    name: 'Ricoh Aficio MP 201SPF',
    manufacturer: 'Ricoh',
    isActive: true,
    comment: '',
    isUsed: false,
    equipmentCount: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function renderTab(cards: OfficeEquipmentDto[]): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list(cards)),
    'GET /office-equipment-types': () => json(list([TYPE_MFU])),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /office-equipment-models': () => json(list([modelDto()])),
  });
  renderWithUser(<OfficeEquipmentTab />, { user: OPERATOR });
  return http;
}

/** Ячейка колонки «Тип» первой строки таблицы: вторая строка живёт внутри неё. */
async function typeCell(): Promise<HTMLElement> {
  // Ждём саму строку, а не таблицу: заголовок рисуется сразу, и поиск по ролям без этого ожидания
  // застаёт пустой список.
  await screen.findByText('0012345', { exact: false });
  const row = (await screen.findAllByRole('row')).find((r) =>
    r.textContent?.includes('Ricoh Aficio MP 201SPF'),
  );
  if (!row) throw new Error('строки техники нет в таблице');
  const cell = within(row).getAllByRole('cell')[0];
  if (!cell) throw new Error('в строке нет колонки «Тип»');
  return cell;
}

describe('цветность печати в колонке «Тип»', () => {
  it('показывает сокращение под типом', async () => {
    renderTab([equipmentDto()]);
    const cell = await typeCell();
    expect(cell.textContent).toContain('МФУ');
    // Сокращение — то, что прислал сервер: портал его не сочиняет.
    expect(cell.textContent).toContain('ч/б');
  });

  it('незаполненное значение называет «н/д», а не оставляет пустое место', async () => {
    renderTab([equipmentDto({ specs: [spec(null)] })]);
    expect((await typeCell()).textContent).toContain('н/д');
  });

  it('у типа без характеристик второй строки нет вовсе', async () => {
    // Не «н/д»: у монитора цветности печати не бывает, и вопроса ему не задают.
    renderTab([equipmentDto({ specs: [] })]);
    const cell = await typeCell();
    expect(cell.textContent).toBe('МФУ');
  });
});

describe('карточка единицы', () => {
  it('называет цветность полным словом отдельной строкой', async () => {
    // В списке за место борются восемь колонок, и там «ч/б»; карточку открывают, чтобы прочитать
    // про один аппарат, — здесь сокращать незачем.
    mockHttp({
      'GET /office-equipment': () => json(list([equipmentDto()])),
      'GET /office-equipment/:id': () => json(equipmentDto()),
      'GET /office-equipment-types': () => json(list([TYPE_MFU])),
      'GET /office-equipment-types/:id/specs': () => json([PRINT_COLOR]),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /office-equipment-models': () => json(list([modelDto()])),
    });
    renderWithUser(<OfficeEquipmentTab />, { user: OPERATOR });

    await screen.findByText('0012345', { exact: false });
    const edit = [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
      (b) => b.querySelector('.anticon-edit') !== null,
    );
    fireEvent.click(edit!);

    await screen.findByText('Редактирование карточки');
    await waitFor(() => expect(screen.getByText(/Цветность печати/)).toBeTruthy());
    expect(screen.getByText('Чёрно-белая')).toBeTruthy();
  });
});

describe('поле цветности в форме модели', () => {
  function renderForm(record?: OfficeEquipmentModelDto): HttpMock {
    const http = mockHttp({
      'GET /office-equipment-types/:id/specs': () => json([PRINT_COLOR]),
      'PATCH /office-equipment-models/oem-1': () => json(modelDto()),
      'POST /office-equipment-models': () => json(modelDto(), 201),
    });
    renderWithUser(
      <OfficeEquipmentModelFormModal
        open
        onCancel={() => {}}
        record={record}
        typeOptions={[{ value: TYPE_MFU.id, label: TYPE_MFU.name }]}
        lockedTypeId={TYPE_MFU.id}
      />,
      { user: OPERATOR },
    );
    return http;
  }

  it('спрашивает характеристики выбранного типа и показывает заведённое значение', async () => {
    const http = renderForm(modelDto());
    // Тип — в пути: обязательный параметр строки запроса проверялся бы схемой раньше прав, и
    // читатель без права получал бы 400 про поле вместо честного 403 (`access-conditions`).
    await waitFor(() =>
      expect(http.lastCall('GET /office-equipment-types/:id/specs')!.path).toContain(TYPE_MFU.id),
    );
    expect(await screen.findByText('Цветность печати')).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toContain('Чёрно-белая'));
  });

  it('правка присылает выбранное значение', async () => {
    const http = renderForm(modelDto());
    await screen.findByText('Цветность печати');
    await selectOption('Цветность печати', 'Цветная');
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.lastCall('PATCH /office-equipment-models/oem-1')).toBeTruthy());
    const body = http.lastCall('PATCH /office-equipment-models/oem-1')!.body as {
      specs: { specId: string; valueId: string | null }[];
    };
    expect(body.specs).toEqual([{ specId: PRINT_COLOR.id, valueId: COLOR_VALUE.id }]);
  });

  it('заведение без выбора шлёт «н/д» явным null, а не молчанием', async () => {
    // Набор присылается по характеристикам ТИПА: иначе снятое значение осталось бы в базе, а
    // форма показывала бы пустоту (Р3).
    const http = renderForm();
    await screen.findByText('Цветность печати');
    fireEvent.change(screen.getByLabelText('Наименование'), {
      target: { value: 'Ricoh IM 350' },
    });
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.lastCall('POST /office-equipment-models')).toBeTruthy());
    const body = http.lastCall('POST /office-equipment-models')!.body as {
      specs: { specId: string; valueId: string | null }[];
    };
    expect(body.specs).toEqual([{ specId: PRINT_COLOR.id, valueId: null }]);
  });
});
