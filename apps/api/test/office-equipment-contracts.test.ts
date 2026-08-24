import { describe, expect, it } from 'vitest';
import {
  createOfficeEquipmentSchema,
  moveOfficeEquipmentSchema,
  createOfficeEquipmentTypeSchema,
  officeEquipmentListQuerySchema,
  officeEquipmentTitle,
  officeEquipmentTypeListQuerySchema,
  updateOfficeEquipmentSchema,
  updateOfficeEquipmentTypeSchema,
} from '@technic/contracts';

// Контракт справочника оргтехники (ADR 0085): единицу опознают номером, а не строкой в списке —
// поэтому хотя бы один номер обязателен, и это единственное правило, которого нет у соседних
// справочников. Остальное как везде: обязательное — обязательно, необязательное приходит пустой
// строкой и означает «не заполнено», а не «стёрто».
//
// Второе такое правило приехало с выпуском A моделей (план `docs/office-equipment-consumables-plan.md`,
// Р2): модель называют ЛИБО ссылкой `modelId` (новая форма), ЛИБО именем `name` (старый клиент и
// заливка файлом в окне выката), и хотя бы одно из двух обязано быть. Оба поля по отдельности
// необязательны — обязательна их пара, и проверяет это `.refine`, а не `z.object`.

const TYPE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT_ID = '33333333-3333-4333-8333-333333333333';
const MODEL_ID = '44444444-4444-4444-8444-444444444444';

/**
 * Минимально допустимая единица: тип, объект, один номер и модель — здесь именем, путём старого
 * клиента. Фикстура намеренно осталась на нём: пока идёт выпуск A, именно эта форма запроса и
 * обязана проходить, а ссылку проверяет отдельный случай ниже.
 */
const minimal = {
  equipmentTypeId: TYPE_ID,
  name: 'Kyocera ECOSYS M3145',
  objectId: OBJECT_ID,
  inventoryNumber: '0012345',
};

/** Та же единица глазами новой формы: модель ссылкой, имени нет вовсе — его напишет зеркало (Р3). */
const byModel = {
  equipmentTypeId: TYPE_ID,
  modelId: MODEL_ID,
  objectId: OBJECT_ID,
  inventoryNumber: '0012345',
};

describe('контракт единицы оргтехники', () => {
  it('требует тип, объект и модель; место, комментарий и владелец — необязательные уточнения', () => {
    const parsed = createOfficeEquipmentSchema.parse({
      ...minimal,
      name: '  Kyocera ECOSYS M3145  ',
      inventoryNumber: '  0012345  ',
    });
    expect(parsed.name).toBe('Kyocera ECOSYS M3145');
    expect(parsed.inventoryNumber).toBe('0012345');
    expect(parsed.serialNumber).toBe('');
    expect(parsed.location).toBe('');
    expect(parsed.comment).toBe('');
    expect(parsed.isActive).toBe(true);
    // Отдел-владелец и даты не подставляются: «не закреплена» и «срок неизвестен» — состояния,
    // а не пропущенные поля.
    expect(parsed.departmentId).toBeUndefined();
    expect(parsed.purchasedOn).toBeUndefined();
    expect(parsed.warrantyUntil).toBeUndefined();
    // Ссылки на модель у старого клиента нет и не подставляется: `null` в колонке означал бы
    // «модели нет», а её проставит триггер зеркала, разобрав имя (Р3).
    expect(parsed.modelId).toBeUndefined();
  });

  /**
   * Модель называют ссылкой или именем — и хотя бы одним из двух (Р2). Правило живёт `.refine`-ом,
   * потому что по отдельности необязательны оба поля: `modelId` ещё не шлёт старый клиент, `name`
   * уже не шлёт новая форма, а карточка без модели не бывает ни в ту, ни в другую сторону.
   *
   * Проверяется в обе стороны намеренно: схема, принимающая всё, и схема, отвергающая всё, ошибаются
   * одинаково молча — первая пропустит карточку без модели, вторая отобьёт половину работающих
   * клиентов в окне выката.
   */
  it('модель называют ссылкой или именем, но хотя бы одним из двух (выпуск A)', () => {
    // Новая форма: одна ссылка, имени нет — его перепишет из модели `BEFORE INSERT` раньше, чем
    // сработает CHECK на непустоту.
    const byRef = createOfficeEquipmentSchema.parse(byModel);
    expect(byRef.modelId).toBe(MODEL_ID);
    expect(byRef.name).toBeUndefined();

    // Старый клиент: одно имя, ссылки нет.
    expect(createOfficeEquipmentSchema.parse(minimal).name).toBe('Kyocera ECOSYS M3145');

    // Оба разом — тоже законный запрос: форма вправе слать карточку целиком, а спор между полями
    // решает не схема, а маршрут (при ссылке имя в `SET` не попадает вовсе).
    const both = createOfficeEquipmentSchema.parse({ ...minimal, modelId: MODEL_ID });
    expect(both.modelId).toBe(MODEL_ID);
    expect(both.name).toBe('Kyocera ECOSYS M3145');

    // Ни того, ни другого — отказ, и адресован он полю `modelId`: форма выпуска A спрашивает
    // именно модель, и подсветить нужно то поле, которое человек видит. Номер при этом на месте —
    // иначе первым сработал бы отказ по номерам, и путь ошибки был бы не тот.
    const { name: _noName, ...withoutModel } = minimal;
    const refused = createOfficeEquipmentSchema.safeParse(withoutModel);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['modelId']);
    expect(refused.error?.issues[0]?.message).toBe('Выберите модель аппарата');
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

  it('не принимает кривые ссылки и пустую модель', () => {
    expect(() =>
      createOfficeEquipmentSchema.parse({ ...minimal, equipmentTypeId: 'мфу' }),
    ).toThrow();
    expect(() => createOfficeEquipmentSchema.parse({ ...minimal, objectId: 'объект-1' })).toThrow();
    const { objectId: _noObject, ...withoutObject } = minimal;
    expect(() => createOfficeEquipmentSchema.parse(withoutObject)).toThrow();
    expect(() => createOfficeEquipmentSchema.parse({ ...minimal, name: '' })).toThrow();
    expect(() => createOfficeEquipmentSchema.parse({ ...minimal, name: '   ' })).toThrow();
    // Дата гарантии — календарные сутки: «31 февраля» отсеивается вместе с вольным форматом.
    expect(() =>
      createOfficeEquipmentSchema.parse({ ...minimal, warrantyUntil: '2026-02-31' }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentSchema.parse({ ...minimal, warrantyUntil: '07.08.2026' }),
    ).toThrow();
  });

  it('правка называет модель одной ссылкой — имени при ней не нужно', () => {
    // У правки своего `.refine` про модель нет и быть не должно: PATCH присылает изменившееся, и
    // «ни ссылки, ни имени» здесь означает «модель не трогали», а не «карточка без модели».
    expect(updateOfficeEquipmentSchema.parse({ modelId: MODEL_ID }).modelId).toBe(MODEL_ID);
    expect(updateOfficeEquipmentSchema.parse({ modelId: MODEL_ID }).name).toBeUndefined();
    // Старая правка — одним именем, и она же остаётся законной до выпуска B.
    expect(updateOfficeEquipmentSchema.parse({ name: 'Ricoh IM 350' }).name).toBe('Ricoh IM 350');
    expect(updateOfficeEquipmentSchema.safeParse({ location: 'каб. 312' }).success).toBe(true);
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
