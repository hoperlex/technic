import { describe, expect, it } from 'vitest';
import {
  flattenOptions,
  isBlankValue,
  optionsKey,
  selectableOptions,
  soleOption,
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
