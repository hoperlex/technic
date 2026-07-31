import { describe, expect, it } from 'vitest';
import {
  flattenOptions,
  isBlankValue,
  optionsKey,
  selectableOptions,
  soleOption,
  withSavedOption,
} from '../src/utils/selectOptions';

describe('flattenOptions', () => {
  it('плоский список отдаётся как есть', () => {
    const options = [{ value: 'a' }, { value: 'b' }];
    expect(flattenOptions(options)).toEqual(options);
  });

  it('группы раскрываются в листья', () => {
    const options = [
      { label: 'Грузовая', options: [{ value: 'a' }, { value: 'b' }] },
      { label: 'Спецтехника', options: [{ value: 'c' }] },
    ];
    expect(flattenOptions(options).map((o) => o.value)).toEqual(['a', 'b', 'c']);
  });

  it('отсутствующий список — пустой результат', () => {
    expect(flattenOptions(undefined)).toEqual([]);
  });
});

describe('selectableOptions', () => {
  it('выключенные и беззначные варианты не в счёт', () => {
    const options = [
      { value: 'a', disabled: true },
      { value: 'b' },
      { value: null },
      { label: 'без значения' },
    ];
    expect(selectableOptions(options).map((o) => o.value)).toEqual(['b']);
  });
});

describe('soleOption', () => {
  it('единственный вариант', () => {
    expect(soleOption([{ value: 'a' }])?.value).toBe('a');
  });

  it('двух вариантов достаточно, чтобы выбор был за человеком', () => {
    expect(soleOption([{ value: 'a' }, { value: 'b' }])).toBeUndefined();
  });

  it('единственный доступный среди выключенных', () => {
    const options = [
      { value: 'a', disabled: true },
      { value: 'b' },
      { value: 'c', disabled: true },
    ];
    expect(soleOption(options)?.value).toBe('b');
  });

  it('единственный лист во всех группах', () => {
    const options = [
      { label: 'Грузовая', options: [{ value: 'a', disabled: true }] },
      { label: 'Спецтехника', options: [{ value: 'b' }] },
    ];
    expect(soleOption(options)?.value).toBe('b');
  });

  it('пустой список и список из одних выключенных', () => {
    expect(soleOption([])).toBeUndefined();
    expect(soleOption([{ value: 'a', disabled: true }])).toBeUndefined();
  });

  it('вариант со значением 0 — тоже вариант', () => {
    expect(soleOption([{ value: 0 }])?.value).toBe(0);
  });
});

describe('optionsKey', () => {
  it('одинаковые наборы дают одинаковую сигнатуру, разные — разную', () => {
    expect(optionsKey([{ value: 'a' }, { value: 'b' }])).toBe(
      optionsKey([{ value: 'a' }, { value: 'b' }]),
    );
    expect(optionsKey([{ value: 'a' }])).not.toBe(optionsKey([{ value: 'b' }]));
  });

  it('сигнатура считается по доступным вариантам: выключение меняет её', () => {
    expect(optionsKey([{ value: 'a' }, { value: 'b', disabled: true }])).toBe(
      optionsKey([{ value: 'a' }]),
    );
    expect(optionsKey([{ value: 'a' }, { value: 'b' }])).not.toBe(
      optionsKey([{ value: 'a' }, { value: 'b', disabled: true }]),
    );
  });

  it('порядок групп не мешает: сигнатура собирается по листьям', () => {
    expect(optionsKey([{ label: 'г', options: [{ value: 'a' }] }])).toBe(
      optionsKey([{ value: 'a' }]),
    );
  });
});

describe('isBlankValue', () => {
  it('пусто', () => {
    expect(isBlankValue(undefined)).toBe(true);
    expect(isBlankValue(null)).toBe(true);
    expect(isBlankValue('')).toBe(true);
    expect(isBlankValue([])).toBe(true);
  });

  it('не пусто', () => {
    expect(isBlankValue('a')).toBe(false);
    expect(isBlankValue(0)).toBe(false);
    expect(isBlankValue(['a'])).toBe(false);
  });
});

/**
 * Списки формы собираются из действующих справочников, а записи правят и через месяц: объект
 * закрыт, тариф выключен, контейнер снят. Приём общий для всех форм правки — без него
 * обязательное поле открывалось бы пустым и молча меняло заказчика или предмет записи.
 */
describe('withSavedOption', () => {
  const OPTIONS = [
    { value: 'a', label: 'Объект А' },
    { value: 'b', label: 'Объект Б' },
  ];

  it('сохранённое значение выпало из справочника — возвращается первым', () => {
    const result = withSavedOption(OPTIONS, { id: 'gone', name: 'Объект закрыт' });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ value: 'gone', label: 'Объект закрыт' });
  });

  it('сохранённое значение в списке есть — список тот же самый', () => {
    expect(withSavedOption(OPTIONS, { id: 'a', name: 'Объект А' })).toBe(OPTIONS);
  });

  it('у новой записи сохранённого нет — список не меняется', () => {
    expect(withSavedOption(OPTIONS, { id: null, name: null })).toBe(OPTIONS);
    expect(withSavedOption(OPTIONS, { id: undefined, name: undefined })).toBe(OPTIONS);
  });

  it('без наименования подписью становится идентификатор — но поле не пустует', () => {
    expect(withSavedOption(OPTIONS, { id: 'gone', name: null })[0]).toEqual({
      value: 'gone',
      label: 'gone',
    });
  });

  it('добавленный вариант не выключен: оставить как есть — законный выбор', () => {
    expect(selectableOptions(withSavedOption(OPTIONS, { id: 'gone', name: 'Закрыт' }))).toHaveLength(
      3,
    );
  });
});
