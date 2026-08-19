import { describe, expect, it } from 'vitest';
import {
  type CostTargetRef,
  type CostTargetSource,
  costTargetKey,
  costTargetKeyOf,
  costTargetOf,
  parseCostTargetKey,
} from '@technic/contracts';

/**
 * Объект затрат заявки (план `docs/route-trips-plan.md`, Р25).
 *
 * Заказчик у заявки и сегодня ровно один — объект **или** отдел, это держит CHECK
 * `vehicle_requests_customer_check`. Двойственность возникает не в базе, а в чтении: два десятка
 * мест выводят заказчика сами, из пары имён, и каждое вольно решить иначе.
 *
 * Поэтому здесь проверяется не «функция считает», а три границы, за которыми двойственность
 * возвращается: ветвление идёт по **идентификатору**, а не по имени; площадка отдела объект затрат
 * не подменяет; и объект с отделом не сливаются по совпавшему коду.
 */

const empty: CostTargetSource = {
  objectId: null,
  objectCode: null,
  objectName: null,
  departmentId: null,
  departmentCode: null,
  departmentName: null,
};

const UUID_OBJECT = '11111111-1111-4111-8111-111111111111';
const UUID_DEPARTMENT = '22222222-2222-4222-8222-222222222222';

describe('объект затрат заявки', () => {
  it('заявка объекта относится на объект', () => {
    expect(
      costTargetOf({
        ...empty,
        objectId: UUID_OBJECT,
        objectCode: 'СЕВ',
        objectName: 'ЖК Северный',
      }),
    ).toEqual({ kind: 'object', id: UUID_OBJECT, code: 'СЕВ', name: 'ЖК Северный' });
  });

  it('заявка отдела относится на отдел', () => {
    expect(
      costTargetOf({
        ...empty,
        departmentId: UUID_DEPARTMENT,
        departmentCode: 'ПТО',
        departmentName: 'Производственно-технический отдел',
      }),
    ).toEqual({
      kind: 'department',
      id: UUID_DEPARTMENT,
      code: 'ПТО',
      name: 'Производственно-технический отдел',
    });
  });

  /**
   * Площадка отдела (ADR 0062) — про **область видимости**, а не про учёт: она открывает
   * сотрудникам отдела работу со своей площадкой, но заявку завёл отдел, значит и затраты на отдел.
   *
   * Ловится это ветвлением по идентификатору: наименование объекта в строке может оказаться от
   * приджойненной площадки отдела, и функция, решающая по имени, — а именно так решает сегодняшний
   * `requestCustomerName`, — молча отнесла бы расходы отдела на стройку.
   */
  it('наименование объекта без его идентификатора отдел не подменяет', () => {
    expect(
      costTargetOf({
        ...empty,
        objectName: 'ЖК Северный',
        objectCode: 'СЕВ',
        departmentId: UUID_DEPARTMENT,
        departmentCode: 'ПТО',
        departmentName: 'ПТО',
      }),
    ).toEqual({ kind: 'department', id: UUID_DEPARTMENT, code: 'ПТО', name: 'ПТО' });
  });

  /**
   * `null` — заказчика нет ни одного. По базе такого не бывает (CHECK), но эта функция читает и то,
   * что собрано запросом: строка, где заказчика просто не выбрали в `select`. Ронять список заявок
   * из-за подписи одной строки нельзя, поэтому «неизвестно» приходит значением.
   */
  it('пустая пара даёт null, а не выдуманный объект затрат', () => {
    expect(costTargetOf(empty)).toBeNull();
  });
});

describe('ключ объекта затрат', () => {
  it('объект и отдел различаются даже при одинаковом коде', () => {
    const object = costTargetOf({ ...empty, objectId: UUID_OBJECT, objectCode: 'АБВ' })!;
    const department = costTargetOf({
      ...empty,
      departmentId: UUID_DEPARTMENT,
      departmentCode: 'АБВ',
    })!;

    expect(costTargetKey(object)).not.toBe(costTargetKey(department));
    expect(costTargetKey(object)).toBe(`object:${UUID_OBJECT}`);
    expect(costTargetKey(department)).toBe(`department:${UUID_DEPARTMENT}`);
  });

  /**
   * Ключ считается от идентификатора, а не от подписи: объект переименовали — затраты остались
   * теми же. Иначе сводка разъехалась бы ровно в тот день, когда справочник поправили.
   */
  it('переименование объекта ключ не меняет', () => {
    const before = costTargetOf({ ...empty, objectId: UUID_OBJECT, objectName: 'ЖК Северный' })!;
    const after = costTargetOf({ ...empty, objectId: UUID_OBJECT, objectName: 'ЖК «Северный»' })!;

    expect(costTargetKey(before)).toBe(costTargetKey(after));
  });
});

/**
 * Ключ из DTO (план `docs/department-requests-plan.md`, §7).
 *
 * У формы правки на руках только заявка: шесть плоских полей, а не готовый объект затрат. Ключ
 * собирается тем же правилом, что и подпись, — вторым разбором пары он разошёлся бы с `costTargetOf`
 * ровно там, где правило поправят.
 */
describe('ключ объекта затрат из полей заявки', () => {
  it('собирается прямо из DTO — и по объекту, и по отделу', () => {
    expect(
      costTargetKeyOf({
        ...empty,
        objectId: UUID_OBJECT,
        objectCode: 'СЕВ',
        objectName: 'ЖК Северный',
      }),
    ).toBe(`object:${UUID_OBJECT}`);

    expect(
      costTargetKeyOf({
        ...empty,
        departmentId: UUID_DEPARTMENT,
        departmentCode: 'ПТО',
        departmentName: 'Производственно-технический отдел',
      }),
    ).toBe(`department:${UUID_DEPARTMENT}`);
  });

  /** Заказчика в строке не видно — поле правки остаётся пустым, а не показывает выдуманный выбор. */
  it('без заказчика ключа нет', () => {
    expect(costTargetKeyOf(empty)).toBeNull();
  });
});

/**
 * Разбор ключа (план `docs/department-requests-plan.md`, Р2).
 *
 * Это единственное место, где значение поля превращается в пару `{ objectId, departmentId }` тела
 * запроса, поэтому проверяются **обе** половины: род и идентификатор. Одного префикса мало —
 * `object:` с мусором после двоеточия поле показало бы принятым, а сервер вернул бы на нём 400,
 * когда человек уже ушёл со своего действия.
 */
describe('разбор ключа объекта затрат', () => {
  it.each([
    { kind: 'object', id: UUID_OBJECT },
    { kind: 'department', id: UUID_DEPARTMENT },
  ] satisfies CostTargetRef[])('ключ $kind разбирается обратно в исходную ссылку', (ref) => {
    expect(parseCostTargetKey(costTargetKey(ref))).toEqual(ref);
  });

  /**
   * Полный объект затрат ключу подходит структурно — на нём круг тоже замыкается, но подпись и код
   * из ключа не возвращаются: их там нет намеренно.
   */
  it('круг от полного объекта затрат возвращает ссылку без подписи', () => {
    const target = costTargetOf({
      ...empty,
      objectId: UUID_OBJECT,
      objectCode: 'СЕВ',
      objectName: 'ЖК Северный',
    })!;

    expect(parseCostTargetKey(costTargetKey(target))).toEqual({ kind: 'object', id: UUID_OBJECT });
  });

  it.each([
    ['неизвестный род', `site:${UUID_OBJECT}`],
    ['пустой идентификатор', 'object:'],
    ['идентификатор не UUID', 'object:123'],
    ['лишний разделитель', `object:${UUID_OBJECT}:extra`],
    ['ключ без разделителя', 'object'],
    ['пустая строка', ''],
  ])('%s ключом не считается: %j', (_case, key) => {
    expect(parseCostTargetKey(key)).toBeNull();
  });
});
