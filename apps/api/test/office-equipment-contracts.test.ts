import { describe, expect, it } from 'vitest';
import {
  createOfficeEquipmentSchema,
  OFFICE_EQUIPMENT_REQUEST_OPTION_FIELDS,
  OFFICE_EQUIPMENT_SELECTOR_SEARCH_MIN,
  officeEquipmentSelectorQuerySchema,
  OFFICE_EQUIPMENT_SPEC_UNKNOWN,
  officeEquipmentSpecLine,
  type OfficeEquipmentModelSpecDto,
  moveOfficeEquipmentSchema,
  createOfficeEquipmentTypeSchema,
  officeEquipmentListQuerySchema,
  officeEquipmentTitle,
  officeEquipmentTypeListQuerySchema,
  updateOfficeEquipmentSchema,
  updateOfficeEquipmentTypeSchema,
} from '@technic/contracts';

// The office equipment directory contract (ADR 0085): a unit is identified by a number, not by a
// line in a list, so at least one number is required — the one rule the neighbouring directories
// do not have. The rest is as everywhere: required is required, an optional field arrives as an
// empty string and means "not filled", not "erased".
//
// The second such rule came with the models (ADR 0132): the model is named by the `modelId`
// reference and only by it since release B. `name` is not an input — the database mirror writes it
// from the model — and the schema refuses it instead of dropping it silently.

const TYPE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT_ID = '33333333-3333-4333-8333-333333333333';
const MODEL_ID = '44444444-4444-4444-8444-444444444444';

/** The smallest valid unit: type, model by reference, site and one number. */
const minimal = {
  equipmentTypeId: TYPE_ID,
  modelId: MODEL_ID,
  objectId: OBJECT_ID,
  inventoryNumber: '0012345',
};

describe('контракт единицы оргтехники', () => {
  it('требует тип, модель, объект; место, комментарий и владелец — необязательные уточнения', () => {
    const parsed = createOfficeEquipmentSchema.parse({
      ...minimal,
      inventoryNumber: '  0012345  ',
    });
    expect(parsed.modelId).toBe(MODEL_ID);
    expect(parsed.inventoryNumber).toBe('0012345');
    expect(parsed.serialNumber).toBe('');
    expect(parsed.location).toBe('');
    expect(parsed.comment).toBe('');
    expect(parsed.isActive).toBe(true);
    // The owner department and the dates are not defaulted: "not assigned" and "term unknown" are
    // states, not missing fields.
    expect(parsed.departmentId).toBeUndefined();
    expect(parsed.purchasedOn).toBeUndefined();
    expect(parsed.warrantyUntil).toBeUndefined();
  });

  /**
   * Release B of ADR 0132: the model is a required reference, and `name` is refused rather than
   * stripped. Both directions are checked on purpose: a schema that silently drops `name` would let
   * a `PATCH { name }` answer 200 while the card keeps its old model — the silent edit the decision
   * rules out — and a schema that still accepts it would keep the door release B closes.
   */
  it('модель называют только ссылкой: без неё отказ, имя — отказ полем name (выпуск B)', () => {
    const { modelId: _noModel, ...withoutModel } = minimal;
    const refused = createOfficeEquipmentSchema.safeParse(withoutModel);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['modelId']);

    // A model named in words is no longer a way to create a card — with or without the reference.
    for (const body of [
      { ...withoutModel, name: 'Kyocera ECOSYS M3145' },
      { ...minimal, name: 'Kyocera ECOSYS M3145' },
    ]) {
      const named = createOfficeEquipmentSchema.safeParse(body);
      expect(named.success).toBe(false);
      const nameIssue = named.error?.issues.find((issue) => issue.path[0] === 'name');
      expect(nameIssue?.message).toBe(
        'Наименование карточки задаёт модель: выберите модель из справочника',
      );
    }
  });

  /**
   * Идентичность единицы (Р32): тот же CHECK держит и БД. Без номеров «МФУ Kyocera» в акте приёмки
   * из ремонта ничем не отличается от соседнего такого же.
   */
  it('единицу без единого номера завести нельзя, с любым одним — можно', () => {
    const { inventoryNumber: _drop, ...noNumbers } = minimal;
    expect(() => createOfficeEquipmentSchema.parse(noNumbers)).toThrow();
    expect(
      createOfficeEquipmentSchema.parse({ ...noNumbers, serialNumber: 'VKG1234567' }).serialNumber,
    ).toBe('VKG1234567');
    expect(createOfficeEquipmentSchema.parse(minimal).inventoryNumber).toBe('0012345');
    // Пробелы номером не считаются: тримминг идёт до проверки, и «заполненное пробелом» поле
    // не должно проходить там, где пустое не проходит.
    expect(() =>
      createOfficeEquipmentSchema.parse({ ...noNumbers, serialNumber: '   ', inventoryNumber: '' }),
    ).toThrow();
  });

  it('ошибка адресуется полю номера, а не форме целиком', () => {
    const { inventoryNumber: _drop, ...noNumbers } = minimal;
    const parsed = createOfficeEquipmentSchema.safeParse(noNumbers);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['inventoryNumber']);
  });

  it('не принимает кривые ссылки', () => {
    expect(() =>
      createOfficeEquipmentSchema.parse({ ...minimal, equipmentTypeId: 'мфу' }),
    ).toThrow();
    expect(() => createOfficeEquipmentSchema.parse({ ...minimal, objectId: 'объект-1' })).toThrow();
    const { objectId: _noObject, ...withoutObject } = minimal;
    expect(() => createOfficeEquipmentSchema.parse(withoutObject)).toThrow();
    expect(() => createOfficeEquipmentSchema.parse({ ...minimal, modelId: 'ricoh' })).toThrow();
    // Дата гарантии — календарные сутки: «31 февраля» отсеивается вместе с вольным форматом.
    expect(() =>
      createOfficeEquipmentSchema.parse({ ...minimal, warrantyUntil: '2026-02-31' }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentSchema.parse({ ...minimal, warrantyUntil: '07.08.2026' }),
    ).toThrow();
  });

  it('правка называет модель одной ссылкой, а правка одним именем — отказ (выпуск B)', () => {
    // The edit has no `.refine` about the model and must not: a PATCH sends what changed, and "no
    // reference" here means "the model was not touched", not "a card without a model".
    expect(updateOfficeEquipmentSchema.parse({ modelId: MODEL_ID }).modelId).toBe(MODEL_ID);
    expect(updateOfficeEquipmentSchema.safeParse({ location: 'каб. 312' }).success).toBe(true);
    // Release A's edit by name moved the card to another model through the mirror trigger; since
    // release B it is refused by the field instead of being dropped and answered with 200.
    const byName = updateOfficeEquipmentSchema.safeParse({ name: 'Ricoh IM 350' });
    expect(byName.success).toBe(false);
    expect(byName.error?.issues[0]?.path).toEqual(['name']);
  });

  it('правка без поля не подставляет умолчание', () => {
    const parsed = updateOfficeEquipmentSchema.parse({ location: 'каб. 312' });
    expect(parsed.location).toBe('каб. 312');
    expect(parsed.isActive).toBeUndefined();
    expect(parsed.serialNumber).toBeUndefined();
    expect(parsed.inventoryNumber).toBeUndefined();
    expect(parsed.comment).toBeUndefined();
  });

  /**
   * Схема ловит только явную попытку стереть оба номера разом: в PATCH приходит одно изменённое
   * поле, и второй колонки схема не видит — «остался ли хоть один номер» проверяет сервер.
   */
  it('стереть оба номера одним запросом не даёт, по одному — оставляет серверу', () => {
    expect(() =>
      updateOfficeEquipmentSchema.parse({ serialNumber: '', inventoryNumber: '' }),
    ).toThrow();
    expect(updateOfficeEquipmentSchema.parse({ serialNumber: '' }).serialNumber).toBe('');
    expect(updateOfficeEquipmentSchema.parse({ inventoryNumber: '' }).inventoryNumber).toBe('');
    expect(
      updateOfficeEquipmentSchema.parse({ serialNumber: '', inventoryNumber: '0012345' })
        .inventoryNumber,
    ).toBe('0012345');
  });

  it('правка перезакрепляет единицу за отделом, но объект ею не меняется (ADR 0097)', () => {
    // Объект убран из правки: переезд — событие с датой, причиной и журналом, и тихая смена
    // площадки в форме оставляла бы вопрос «где этот аппарат стоял в мае» без ответа.
    expect(updateOfficeEquipmentSchema.safeParse({ objectId: OBJECT_ID }).success).toBe(false);
    expect(
      moveOfficeEquipmentSchema.parse({
        objectId: OBJECT_ID,
        movedOn: '2026-08-11',
        reason: 'Перевод бухгалтерии',
      }).objectId,
    ).toBe(OBJECT_ID);
    // «На складе» без уточнения не проходит: искать такую технику негде.
    expect(
      moveOfficeEquipmentSchema.safeParse({
        objectId: OBJECT_ID,
        state: 'in_stock',
        movedOn: '2026-08-11',
        reason: 'До переезда',
      }).success,
    ).toBe(false);
    expect(updateOfficeEquipmentSchema.parse({ departmentId: DEPARTMENT_ID }).departmentId).toBe(
      DEPARTMENT_ID,
    );
    // `null` и «поля нет» — разное: первое снимает владельца, второе его не трогает.
    expect(updateOfficeEquipmentSchema.parse({ departmentId: null }).departmentId).toBeNull();
    expect(updateOfficeEquipmentSchema.parse({}).departmentId).toBeUndefined();
    expect(updateOfficeEquipmentSchema.parse({ warrantyUntil: null }).warrantyUntil).toBeNull();
  });

  it('список фильтруется по месту, владельцу, типу и гарантии', () => {
    const q = officeEquipmentListQuerySchema.parse({
      objectId: OBJECT_ID,
      equipmentTypeId: TYPE_ID,
      departmentId: DEPARTMENT_ID,
      warranty: 'expiring',
      isActive: 'true',
      sortBy: 'warrantyUntil',
    });
    expect(q.isActive).toBe(true);
    expect(q.warranty).toBe('expiring');
    expect(q.sortBy).toBe('warrantyUntil');
    expect(officeEquipmentListQuerySchema.parse({ isActive: 'false' }).isActive).toBe(false);
    // Фильтра нет — «любая», а не «активная»: строка справочника гасится, а не исчезает.
    expect(officeEquipmentListQuerySchema.parse({}).isActive).toBeUndefined();
    expect(
      officeEquipmentListQuerySchema.parse({ unassignedDepartment: 'true' }).unassignedDepartment,
    ).toBe(true);
    expect(officeEquipmentListQuerySchema.parse({}).unassignedDepartment).toBe(false);
  });

  it('архив по умолчанию не показывается, а гарантия спрашивается тремя вопросами', () => {
    expect(officeEquipmentListQuerySchema.parse({}).archive).toBe('exclude');
    expect(officeEquipmentListQuerySchema.parse({ archive: 'only' }).archive).toBe('only');
    for (const warranty of ['active', 'expiring', 'expired']) {
      expect(officeEquipmentListQuerySchema.parse({ warranty }).warranty, warranty).toBe(warranty);
    }
    // Четвёртого состояния фильтр не знает: `none` в списке — это отсутствие срока, и спрашивают
    // его пустым фильтром, а не выдуманным значением.
    expect(() => officeEquipmentListQuerySchema.parse({ warranty: 'none' })).toThrow();
    expect(() => officeEquipmentListQuerySchema.parse({ warranty: 'soon' })).toThrow();
    expect(() => officeEquipmentListQuerySchema.parse({ archive: 'all' })).toThrow();
    expect(() => officeEquipmentListQuerySchema.parse({ isActive: 'да' })).toThrow();
    expect(() => officeEquipmentListQuerySchema.parse({ objectId: 'объект-1' })).toThrow();
    // Сортировка — по перечню полей, а не по любому идентификатору из запроса.
    expect(() => officeEquipmentListQuerySchema.parse({ sortBy: 'comment' })).toThrow();
  });

  it('называют единицу моделью и номером, которым её опознают', () => {
    expect(
      officeEquipmentTitle({
        name: 'Kyocera M3145',
        inventoryNumber: '0012345',
        serialNumber: 'VKG1234567',
      }),
    ).toBe('Kyocera M3145 · инв. 0012345');
    // Инвентарного нет — по серийному: он есть всегда, когда нет инвентарного (Р32).
    expect(
      officeEquipmentTitle({
        name: 'Kyocera M3145',
        inventoryNumber: '',
        serialNumber: 'VKG1234567',
      }),
    ).toBe('Kyocera M3145 · SN VKG1234567');
    // Обоих номеров не бывает у живой карточки, но название не должно кончаться висящим «·».
    expect(
      officeEquipmentTitle({ name: 'Kyocera M3145', inventoryNumber: '', serialNumber: '' }),
    ).toBe('Kyocera M3145');
  });
});

describe('контракт типа оргтехники', () => {
  it('код типа — латиница, цифры и подчёркивание; название обязательно', () => {
    const parsed = createOfficeEquipmentTypeSchema.parse({ code: '  mfp  ', name: '  МФУ  ' });
    expect(parsed.code).toBe('mfp');
    expect(parsed.name).toBe('МФУ');
    expect(parsed.sortOrder).toBe(100);
    expect(parsed.isActive).toBe(true);
    expect(
      createOfficeEquipmentTypeSchema.parse({ code: 'network_gear', name: 'Сетевое' }).code,
    ).toBe('network_gear');
    // Код — машинное имя: он попадает в код портала и в фильтры, поэтому ни кириллицы, ни
    // пробелов, ни верхнего регистра в нём не бывает.
    for (const code of ['МФУ', 'mfp printer', 'MFP', 'mfp-2', 'm']) {
      expect(() => createOfficeEquipmentTypeSchema.parse({ code, name: 'МФУ' }), code).toThrow();
    }
    expect(() => createOfficeEquipmentTypeSchema.parse({ code: 'mfp' })).toThrow();
    expect(() => createOfficeEquipmentTypeSchema.parse({ code: 'mfp', name: '   ' })).toThrow();
    expect(() => createOfficeEquipmentTypeSchema.parse({ code: 'mfp', name: 'П' })).toThrow();
  });

  it('правка типа без поля не переставляет порядок и не включает погашенную строку', () => {
    const parsed = updateOfficeEquipmentTypeSchema.parse({ name: 'МФУ и принтеры' });
    expect(parsed.name).toBe('МФУ и принтеры');
    expect(parsed.sortOrder).toBeUndefined();
    expect(parsed.isActive).toBeUndefined();
    expect(updateOfficeEquipmentTypeSchema.parse({ isActive: false }).isActive).toBe(false);
    expect(updateOfficeEquipmentTypeSchema.parse({ sortOrder: 0 }).sortOrder).toBe(0);
    expect(() => updateOfficeEquipmentTypeSchema.parse({ sortOrder: -1 })).toThrow();
    expect(() => updateOfficeEquipmentTypeSchema.parse({ code: 'МФУ' })).toThrow();
  });

  it('перечень типов фильтруется по активности и сортируется по разрешённым полям', () => {
    expect(officeEquipmentTypeListQuerySchema.parse({ isActive: 'true' }).isActive).toBe(true);
    expect(officeEquipmentTypeListQuerySchema.parse({}).isActive).toBeUndefined();
    expect(officeEquipmentTypeListQuerySchema.parse({ sortBy: 'sortOrder' }).sortBy).toBe(
      'sortOrder',
    );
    expect(() => officeEquipmentTypeListQuerySchema.parse({ sortBy: 'createdAt' })).toThrow();
  });
});

/**
 * Вторая строка колонки «Тип»: сокращения характеристик, помеченных `showInList`
 * (план `docs/office-equipment-specs-plan.md`, Р3, Р8).
 *
 * Правило одно на портал, письма и обмен файлом, и живёт оно в контрактах — потому что мест показа
 * четыре, а разъехаться им нельзя: «н/д» в списке техники и «н/д» в перечне моделей обязаны
 * означать одно и то же.
 *
 * Три исхода различаются намеренно и проверяются порознь: значение есть, значения нет («н/д» —
 * вопрос законен, ответа нет), характеристик у типа нет вовсе (строки нет — вопроса не задают).
 */
describe('officeEquipmentSpecLine', () => {
  const value = { id: 'v-1', code: 'mono', name: 'Чёрно-белая', shortName: 'ч/б' };
  const spec = (over: Partial<OfficeEquipmentModelSpecDto> = {}): OfficeEquipmentModelSpecDto => ({
    specId: 's-1',
    code: 'print_color',
    name: 'Цветность печати',
    showInList: true,
    sortOrder: 10,
    value: null,
    ...over,
  });

  it('показывает сокращение заполненного значения', () => {
    expect(officeEquipmentSpecLine([spec({ value })])).toBe('ч/б');
  });

  it('незаполненное значение называет «н/д», а не молчит', () => {
    // Молчание читалось бы как «чёрно-белый»: у самой массовой модели парка (68 карточек) печать
    // ч/б, и пустая строка рядом с ней ничем не отличалась бы от честного ответа.
    expect(officeEquipmentSpecLine([spec()])).toBe(OFFICE_EQUIPMENT_SPEC_UNKNOWN);
  });

  it('у типа без характеристик строки нет вовсе', () => {
    // Не «н/д»: у монитора цветности печати не бывает, и задавать по нему вопрос незачем.
    expect(officeEquipmentSpecLine([])).toBe('');
  });

  it('в строку идут только помеченные для списка, остальные ждут карточки', () => {
    const hidden = spec({ specId: 's-2', code: 'paper', showInList: false, value });
    expect(officeEquipmentSpecLine([spec({ value }), hidden])).toBe('ч/б');
  });

  it('несколько пометок разделяются точкой — тем же знаком, что и в заголовке единицы', () => {
    const second = spec({
      specId: 's-2',
      code: 'paper',
      value: { id: 'v-2', code: 'a3', name: 'A3', shortName: 'A3' },
    });
    expect(officeEquipmentSpecLine([spec({ value }), second])).toBe('ч/б · A3');
  });
});

/**
 * ПРОЕКЦИЯ ДЛЯ ВЫБОРА ПРЕДМЕТА ЗАЯВКИ (план `docs/office-equipment-request-subject-plan.md`, Р1):
 * в ней нет ни одного тяжёлого поля карточки.
 *
 * Зачем это проверять прогоном, если состав задан типом. Поля интерфейса стираются при сборке, а
 * `apps/api/tsconfig.json` не включает каталог `test/` — то есть проверка, написанная здесь типами,
 * не проверялась бы ничем и зеленела бы всегда. Поэтому контракт отдаёт перечень своих полей
 * значением (`OFFICE_EQUIPMENT_REQUEST_OPTION_FIELDS`), и смотреть на него можно глазами прогона.
 *
 * Тяжёлые поля названы поимённо, а не «всё, чего нет в перечне»: смысл случая — назвать вслух то,
 * что по этой ручке видно ВСЕМУ парку компании, и список этих имён обязан быть виден ревьюеру
 * рядом с ожиданием. Каждое из них есть у `OfficeEquipmentDto` или у её карточки, и попасть сюда
 * они могли бы ровно одним способом — «заодно, раз уж выборка всё равно ходит в ту же таблицу».
 */
describe('проекция единицы для выбора предмета заявки', () => {
  /**
   * What exactly is not sent and why it is costly: the comment and the purchase date are company
   * accounting data; the state with its note is "with Ivanov", that is, a person; specs and the
   * model are the whole model card; consumables are warehouse stock; the service history is money
   * and work on other people's requests, and so are the open request numbers (ADR 0169, E5b);
   * timestamps and the archive mark are the record's life, unrelated to picking a request subject.
   */
  const HEAVY_FIELDS = [
    'comment',
    'purchasedOn',
    'state',
    'stateNote',
    'specs',
    'model',
    'type',
    'consumables',
    'serviceHistory',
    'openServiceRequestNumbers',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ] as const;

  it('не несёт ни одного тяжёлого поля карточки', () => {
    for (const field of HEAVY_FIELDS) {
      expect(OFFICE_EQUIPMENT_REQUEST_OPTION_FIELDS, field).not.toContain(field);
    }
  });

  it('состоит ровно из одиннадцати полей поля выбора и плашки', () => {
    /*
     * Равенство множеств, а не «содержит нужное»: проверка «нет тяжёлых» пропустила бы любое
     * ТРИНАДЦАТОЕ поле, которого сегодня нет в списке выше, — а завтрашний `purchasePrice` был бы
     * ровно им. Здесь же лишнее поле краснеет само, каким бы оно ни было.
     */
    expect([...OFFICE_EQUIPMENT_REQUEST_OPTION_FIELDS].sort()).toEqual(
      [
        'id',
        'inOwnScope',
        'inventoryNumber',
        'isActive',
        'location',
        'name',
        'object',
        'objectInOwnScope',
        'ownerDepartment',
        'serialNumber',
        'warrantyUntil',
      ].sort(),
    );
  });

  it('подпись собирается тем же `officeEquipmentTitle`, что и у карточки', () => {
    // Проекция беднее карточки, но три поля подписи в ней те же — и подпись обязана читаться
    // одинаково: она печатается в письмах и в истории заявки.
    expect(
      officeEquipmentTitle({
        name: 'Kyocera ECOSYS M3145',
        inventoryNumber: '0012345',
        serialNumber: 'SN-77',
      }),
    ).toBe('Kyocera ECOSYS M3145 · инв. 0012345');
  });

  it('страница спрашивается общими правилами, а сортировка и отборы — не спрашиваются вовсе', () => {
    const q = officeEquipmentSelectorQuerySchema.parse({});
    expect(q.page).toBe(1);
    // Размер — из общего перечня, а не любое число: своим числом клиент выгрузил бы весь парк
    // одним запросом мимо правила, общего для всех списков портала.
    expect(officeEquipmentSelectorQuerySchema.parse({ pageSize: '200' }).pageSize).toBe(200);
    expect(officeEquipmentSelectorQuerySchema.safeParse({ pageSize: '150' }).success).toBe(false);
    expect(officeEquipmentSelectorQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    /*
     * Порядок выдачи задан жёстко (по наименованию), отборов у неё нет, и поле, которое сервер
     * обязан игнорировать, было бы обещанием, которого он не выполняет. Проверяется не «отбито», а
     * то, что таких ключей нет в разобранном запросе: лишнее базовая схема просто отбрасывает, и
     * `safeParse` на нём зеленел бы, ничего не проверив.
     */
    const parsed = officeEquipmentSelectorQuerySchema.parse({
      sortBy: 'name',
      sortOrder: 'asc',
      objectId: '11111111-1111-4111-8111-111111111111',
      search: '  инв-12  ',
    });
    expect(Object.keys(parsed).sort()).toEqual(['page', 'pageSize', 'search']);
    // Набранное обрезается схемой: «три пробела» — пустой запрос, а не выход за область учётки.
    expect(parsed.search).toBe('инв-12');
    expect(officeEquipmentSelectorQuerySchema.parse({ search: '   ' }).search).toBe('');
  });

  it('порог общего поиска назван числом в контракте — портал и сервер меряют одним', () => {
    // Два числа разошлись бы на первой правке, и портал обещал бы поиск, которого сервер не делает.
    expect(OFFICE_EQUIPMENT_SELECTOR_SEARCH_MIN).toBe(3);
  });
});
