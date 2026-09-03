import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import type { AuthUser, OfficeEquipmentDto, OfficeEquipmentModelDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { selectOption } from './antd';
import { OfficeEquipmentModelsModal } from '../src/pages/directories/OfficeEquipmentModelsModal';
import { OfficeEquipmentTab } from '../src/pages/directories/OfficeEquipmentTab';

/**
 * Окно «Модели аппаратов» (план `docs/office-equipment-consumables-plan.md`, Р8, Р11, Р12).
 *
 * Закрепляются две вещи, каждая из которых ломается молча.
 *
 * Первое — порядок. Умолчание `baseListQuery` на сервере это `sortOrder: 'desc'`, и окно, не
 * попросившее алфавит явно, открывалось бы «последняя заведённая сверху»: список из полусотни
 * строк читался бы как случайный, и заметил бы это не тест, а человек, ищущий Ricoh в конце.
 *
 * Второе — по какому признаку разрешено удаление. Признаков два, и они отвечают на разные вопросы:
 * `isUsed` — «ссылается ли на модель хоть что-нибудь» (весь парк, включая архив), `equipmentCount`
 * — «сколько таких видит смотрящий» (его область, живые и активные). Перепутать их значит
 * предложить удалить модель, на которую ссылаются чужие карточки: сервер ответит 409, а человек
 * решит, что портал сломан.
 */

const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

const TYPE_OPTIONS = [{ value: 'oet-1', label: 'МФУ' }];

function modelDto(over: Partial<OfficeEquipmentModelDto> = {}): OfficeEquipmentModelDto {
  return {
    id: 'oem-1',
    type: { id: 'oet-1', name: 'МФУ', isActive: true },
    specs: [],
    name: 'Ricoh Aficio MP 201SPF',
    manufacturer: 'Ricoh',
    isActive: true,
    comment: '',
    isUsed: false,
    equipmentCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function renderModels(models: OfficeEquipmentModelDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /office-equipment-models': () => json(list(models)),
    // Форма модели спрашивает характеристики типа (цветность печати); в этом окне их нет.
    'GET /office-equipment-types/:id/specs': () => json([]),
    ...over,
  });
  renderWithUser(
    <OfficeEquipmentModelsModal
      open
      onClose={() => {}}
      typeOptions={TYPE_OPTIONS}
      typesLoading={false}
    />,
    { user: OPERATOR },
  );
  return http;
}

/** Кнопка строки: подпись живёт в `aria-label` — подсказка antd появляется только по наведению. */
function rowButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
    (b) => b.getAttribute('aria-label') === label,
  );
}

describe('окно моделей аппаратов', () => {
  it('просит алфавит явно: умолчание сервера открыло бы список задом наперёд', async () => {
    const http = renderModels([modelDto()]);

    await screen.findByText('Ricoh Aficio MP 201SPF');
    const query = http.lastCall('GET /office-equipment-models')!.query;
    expect(query.get('sortBy')).toBe('name');
    expect(query.get('sortOrder')).toBe('asc');
  });

  it('срез «без расходника» уходит на сервер параметром, а снятый — исчезает вовсе', async () => {
    /*
     * Р15: по этому срезу ИТ-служба дозаполняет номенклатуру, и пустота его означает «заправлять
     * есть чем всё». Отбирать такой перечень на клиенте нечем — в строке модели признака
     * покрытия нет вовсе, и «покажи непокрытые» обязано быть вопросом к серверу.
     */
    const http = renderModels([modelDto()]);

    await screen.findByText('Ricoh Aficio MP 201SPF');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Без расходника' }));
    await waitFor(() =>
      expect(http.lastCall('GET /office-equipment-models')!.query.get('coverage')).toBe(
        'uncovered',
      ),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Без расходника' }));
    // Снятый переключатель — «не фильтруй», а не «покажи покрытые»: обратного значения у
    // параметра нет, и посланное пустое значение сервер отбил бы как недопустимое.
    await waitFor(() =>
      expect(http.lastCall('GET /office-equipment-models')!.query.get('coverage')).toBeNull(),
    );
  });

  it('удаление разрешено по isUsed, а не по счётчику своей области', async () => {
    // Ссылки на модель есть, но не в области смотрящего: счётчик ноль, удалять всё равно нельзя.
    renderModels([modelDto({ isUsed: true, equipmentCount: 0 })]);

    await screen.findByText('Ricoh Aficio MP 201SPF');
    expect(rowButton('Удалить')?.disabled).toBe(true);
  });

  it('правка без переименования имени не шлёт: имя стоит парку блокировки', async () => {
    const http = renderModels([modelDto()], {
      'PATCH /office-equipment-models/:id': () => json(modelDto({ isActive: false })),
    });

    await screen.findByText('Ricoh Aficio MP 201SPF');
    fireEvent.click(rowButton('Редактировать')!);
    await screen.findByText('Редактирование модели');
    // Гасим модель — имя при этом не трогаем вовсе.
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('PATCH /office-equipment-models/:id')).toBe(1));
    const body = http.lastCall('PATCH /office-equipment-models/:id')!.body as Record<
      string,
      unknown
    >;
    expect(body.isActive).toBe(false);
    // Присланное имя маршрут считает переименованием: он запирает таблицу техники и гоняет
    // триггер зеркала по всем карточкам модели — ради снятой галочки это плата без покупки.
    expect(body.name).toBeUndefined();
  });

  it('свободную модель удаляет после подтверждения, даже если в области полон парк', async () => {
    // Обратный случай: аппараты в области есть (68 штук), но ни одной ссылки на модель нет —
    // счётчик про «сколько кормить», а не про «можно ли удалить».
    const http = renderModels([modelDto({ isUsed: false, equipmentCount: 68 })], {
      'DELETE /office-equipment-models/:id': () => json({ ok: true }),
    });

    await screen.findByText('Ricoh Aficio MP 201SPF');
    const button = rowButton('Удалить');
    expect(button?.disabled).toBe(false);
    fireEvent.click(button!);

    const confirm = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-modal-confirm button')].find(
        (b) => b.textContent === 'Удалить',
      );
      if (!found) throw new Error('подтверждение удаления не открылось');
      return found;
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(http.countOf('DELETE /office-equipment-models/:id')).toBe(1));
    expect(http.lastCall('DELETE /office-equipment-models/:id')!.path).toContain('oem-1');
  });

  it('занятое наименование показывает на поле, а не тостом', async () => {
    // 409 с `fields` — обычный ответ маршрута моделей: `err.conflict` их принимает, и двойник
    // называется полем, а не общей фразой поверх формы (ADR 0094).
    renderModels([modelDto()], {
      'POST /office-equipment-models': () =>
        apiError(409, {
          code: 'version_conflict',
          message: 'Модель с таким наименованием уже заведена',
          fields: { name: 'Такая модель уже заведена' },
        }),
    });

    // Кнопка со значком: у antd значок — `role="img"` с подписью, и доступное имя кнопки не
    // совпадает с надписью. Нажимаем по самой надписи, как это делает человек.
    fireEvent.click(await screen.findByText('Добавить модель'));
    await screen.findByText('Новая модель аппарата');
    // По идентификатору поля, а не по подписи: «Наименование» стоит и заголовком сортируемого
    // столбца (`aria-label`), и поиск по подписи нашёл бы оба.
    fireEvent.change(document.getElementById('name')!, {
      target: { value: 'Ricoh Aficio MP 201SPF' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    // Текст стоит под самим полем: иначе человек, не поняв, что занято, заведёт двойник.
    const explain = await screen.findByText('Такая модель уже заведена');
    expect(explain.closest('.ant-form-item-explain-error')).toBeTruthy();
  });
});

/**
 * Поле «Модель» карточки техники (Р1, §6 плана).
 *
 * Проверяется ровно то, из-за чего поле перестало быть строкой ввода: перечень спрашивается по
 * выбранному типу, а смена типа выбранную модель сбрасывает. У модели тип неизменяем, и пара
 * «модель одного типа — карточка другого» отбивается сервером 422; сложиться в форме она не
 * должна вовсе, иначе отказ прилетит уже после одиннадцати заполненных полей.
 */

const MFU_MODEL = modelDto({ id: 'oem-1', name: 'Ricoh Aficio MP 201SPF' });
const PRINTER_MODEL = modelDto({
  id: 'oem-2',
  name: 'Kyocera ECOSYS P2040',
  type: { id: 'oet-2', name: 'Принтер', isActive: true },
  specs: [],
});

function typeDto(id: string, code: string, name: string, sortOrder: number) {
  return {
    id,
    code,
    name,
    sortOrder,
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

/**
 * Что выбрано в поле: в antd 6 это `title` узла `.ant-select-content-has-value`, а не значение
 * `input` — в поле с поиском `value` держит набранное, а не выбранное.
 */
function selectedText(fieldId: string): string {
  const field = document.getElementById(fieldId)?.closest('.ant-select');
  return field?.querySelector('.ant-select-content-has-value')?.getAttribute('title') ?? '';
}

describe('поле «Модель» в карточке техники', () => {
  it('спрашивает модели выбранного типа и сбрасывает выбор при смене типа', async () => {
    const http = mockHttp({
      'GET /office-equipment': () => json(emptyList<OfficeEquipmentDto>()),
      'GET /office-equipment-types': () =>
        json(list([typeDto('oet-1', 'mfp', 'МФУ', 1), typeDto('oet-2', 'printer', 'Принтер', 2)])),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /office-equipment-models': ({ query }) =>
        json(list(query.get('equipmentTypeId') === 'oet-2' ? [PRINTER_MODEL] : [MFU_MODEL])),
    });
    renderWithUser(<OfficeEquipmentTab />, { user: OPERATOR });

    fireEvent.click(await screen.findByText('Добавить технику'));
    await selectOption('Тип', 'МФУ');
    await selectOption('Модель', 'Ricoh Aficio MP 201SPF');
    await waitFor(() => expect(selectedText('modelId')).toBe('Ricoh Aficio MP 201SPF'));

    // Перечень спрашивается по типу: «Модели МФУ» и «Модели принтеров» — разные вопросы.
    await waitFor(() =>
      expect(http.lastCall('GET /office-equipment-models')!.query.get('equipmentTypeId')).toBe(
        'oet-1',
      ),
    );

    await selectOption('Тип', 'Принтер');
    // Модель прежнего типа осталась бы в поле молча, а сервер отбил бы её 422 при сохранении.
    // Пустым поле обязано и остаться: перечень нового типа приходит ответом, и подстановка
    // «единственного варианта» вернула бы в поле модель прежнего типа.
    await waitFor(() => expect(selectedText('modelId')).toBe(''));
    await waitFor(() =>
      expect(http.lastCall('GET /office-equipment-models')!.query.get('equipmentTypeId')).toBe(
        'oet-2',
      ),
    );
  });
});

/**
 * Матрица Р14, вторая сторона: тронули карточку техники — устарел счётчик «В парке» в окне
 * моделей (Р12: он посчитан по живым и активным карточкам области смотрящего).
 *
 * Дыра, ради которой проверка и заведена, невидима глазом на тестовом клиенте: правка карточки
 * гасила только корень техники, окно моделей открывалось со вчерашним числом — и держало его
 * ровно `staleTime`, то есть первые десять секунд после правки. Проверка поэтому идёт на клиенте
 * с ПРОДОВЫМ сроком годности: с нулевым перечень перезапрашивался бы при каждом открытии сам, и
 * пропущенное гашение осталось бы незамеченным до продакшена.
 */

const TYPE_MFU = typeDto('oet-1', 'mfp', 'МФУ', 1);

/** Карточка техники той самой модели: правка её и меняет счётчик. */
function equipmentDto(): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: TYPE_MFU.id, name: TYPE_MFU.name, isActive: true },
    specs: [],
    model: { id: MFU_MODEL.id, name: MFU_MODEL.name },
    name: MFU_MODEL.name,
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
  };
}

/** Тот же срок годности, что у портала (`src/main.tsx`): без него проверка ничего не значит. */
function productionLikeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 10_000 }, mutations: { retry: false } },
  });
}

/** Окно моделей среди прочих окон узнаётся по подписи счётчика — она в нём одна такая. */
function modelsWindow(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((m) =>
    m.textContent?.includes('Столбец «В парке»'),
  );
  if (!found) throw new Error('окно моделей не открыто');
  return found;
}

/** Кнопка вкладки, а не заголовок окна: надпись у них одна и та же. */
function openModelsWindow(): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => !b.closest('.ant-modal') && b.textContent?.includes('Модели аппаратов'),
  );
  if (!button) throw new Error('кнопки «Модели аппаратов» на вкладке нет');
  fireEvent.click(button);
}

/** Правка карточки: у кнопок строки справочника техники подписи нет — узнаём по значку. */
function editEquipmentButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
    (b) => !b.closest('.ant-modal') && b.querySelector('.anticon-edit'),
  );
  if (!button) throw new Error('кнопки правки карточки в строке нет');
  return button;
}

describe('счётчик «В парке» и матрица инвалидации', () => {
  it('правка карточки техники обновляет столбец окна моделей без перезагрузки', async () => {
    // Первый заход в окно видит три карточки, следующий — четыре: правка их и меняет.
    let windowCalls = 0;
    const http = mockHttp({
      'GET /office-equipment': () => json(list([equipmentDto()])),
      // Карточку правки открывает секция обслуживания — она спрашивает единицу отдельно.
      'GET /office-equipment/:id': () => json(equipmentDto()),
      'GET /office-equipment-types': () => json(list([TYPE_MFU])),
      // Форма модели спрашивает характеристики типа (цветность печати); здесь их нет.
      'GET /office-equipment-types/:id/specs': () => json([]),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /office-equipment-models': ({ query }) => {
        // Перечень для поля формы спрашивается по типу; окно моделей — без него.
        if (query.get('equipmentTypeId')) return json(list([MFU_MODEL]));
        windowCalls += 1;
        return json(list([modelDto({ equipmentCount: windowCalls === 1 ? 3 : 4 })]));
      },
      'PATCH /office-equipment/:id': () => json(equipmentDto()),
    });
    renderWithUser(<OfficeEquipmentTab />, { user: OPERATOR, queryClient: productionLikeClient() });

    await screen.findByText('0012345', { exact: false });
    openModelsWindow();
    await waitFor(() => expect(within(modelsWindow()).getByText('3')).toBeTruthy());
    fireEvent.click(modelsWindow().querySelector('.ant-modal-close')!);

    fireEvent.click(editEquipmentButton());
    await screen.findByText('Редактирование карточки');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('PATCH /office-equipment/:id')).toBe(1));

    openModelsWindow();
    // Без гашения корня моделей окно показывало бы прежнюю тройку из кэша — и не спросило бы
    // сервер вовсе: перечень ещё «свежий».
    await waitFor(() => expect(within(modelsWindow()).getByText('4')).toBeTruthy());
    expect(windowCalls).toBe(2);
  });
});
