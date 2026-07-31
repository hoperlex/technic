import { describe, expect, it } from 'vitest';
import {
  parseCategoryCodes,
  parseImportDate,
  prepareDriverImport,
} from '../src/services/driver-import';

/**
 * Разбор кадровой выгрузки водителей (ADR 0037).
 *
 * Проверяется тестом, потому что этим кодом в прод попадают ФИО, СНИЛС и допуски живых людей, а
 * запускается он один раз и вручную: ошибку разбора некому заметить по нарастающим жалобам —
 * она сразу становится записью в справочнике, которую потом сверяют глазами по бумажной выгрузке.
 */

/** Справочник по миграции 0058: 16 категорий ст. 25 ФЗ «О БДД», коды в нижнем регистре. */
const KNOWN = ['a', 'a1', 'b', 'b1', 'c', 'c1', 'd', 'd1', 'be', 'ce', 'c1e', 'de', 'd1e', 'm'];

/** Настоящий СНИЛС с верной контрольной суммой — из тестового набора сида. */
const SNILS = '11111111145';

function file(overrides: Partial<Parameters<typeof prepareDriverImport>[0]['drivers'][0]> = {}) {
  return {
    drivers: [{ fullName: 'Иванов Иван Иванович', snils: SNILS, categories: 'B,C', ...overrides }],
  };
}

describe('дата из выгрузки', () => {
  it('принимает набранное человеком «ДД.ММ.ГГГГ»: файл правит кадровик, а не программист', () => {
    expect(parseImportDate('27.07.1968', 'дата рождения', 'кто')).toBe('1968-07-27');
  });

  it('машинный «ГГГГ-ММ-ДД» проходит как есть', () => {
    expect(parseImportDate('1968-07-27', 'дата рождения', 'кто')).toBe('1968-07-27');
  });

  it('пусто — не заполнено, а не ошибка: дата рождения необязательна', () => {
    expect(parseImportDate(undefined, 'дата рождения', 'кто')).toBeNull();
    expect(parseImportDate('   ', 'дата рождения', 'кто')).toBeNull();
  });

  it('американский порядок частей отвергается, а не читается наоборот', () => {
    expect(() => parseImportDate('07/27/1968', 'дата рождения', 'Иванов')).toThrow(/Иванов/u);
  });
});

describe('категории из строки источника', () => {
  it('регистр снимается: в удостоверении «C1E», в справочнике «c1e»', () => {
    expect(parseCategoryCodes('B,C1E,CE')).toEqual(['b', 'c1e', 'ce']);
  });

  it('пустые элементы — мусор разделителей: в выгрузке встречается «C,C1,,BE»', () => {
    expect(parseCategoryCodes('C,C1,,BE')).toEqual(['c', 'c1', 'be']);
  });

  it('повтор одной категории не даёт двух допусков', () => {
    expect(parseCategoryCodes('B,B,b')).toEqual(['b']);
  });

  it('пустая строка — это отсутствие категорий, а не одна безымянная', () => {
    expect(parseCategoryCodes('')).toEqual([]);
    expect(parseCategoryCodes(undefined)).toEqual([]);
  });
});

describe('неизвестные коды не угадываются', () => {
  it('«AM», «CE1» и одиночная «E» не превращаются в M, C1E и BE молчаливой заменой', () => {
    const { drivers, unknownCategories } = prepareDriverImport(
      file({ categories: 'B,C,AM,CE1,E' }),
      KNOWN,
    );
    expect(drivers[0]!.categories).toEqual(['b', 'c']);
    expect(unknownCategories).toEqual([{ who: 'Иванов Иван Иванович', codes: ['am', 'ce1', 'e'] }]);
  });

  it('водитель не теряется целиком из-за одной непонятной буквы', () => {
    const { drivers } = prepareDriverImport(file({ categories: 'AM' }), KNOWN);
    expect(drivers).toHaveLength(1);
    expect(drivers[0]!.categories).toEqual([]);
  });
});

describe('СНИЛС — ключ человека', () => {
  it('разделители снимаются: «171-292-254 56» и «17129225456» — один номер', () => {
    const { drivers } = prepareDriverImport(file({ snils: '111-111-111 45' }), KNOWN);
    expect(drivers[0]!.snils).toBe(SNILS);
  });

  it('опечатка в одной цифре не проходит контрольную сумму', () => {
    expect(() => prepareDriverImport(file({ snils: '11111111146' }), KNOWN)).toThrow(
      /контрольной суммы/u,
    );
  });

  it('десять цифр — не СНИЛС', () => {
    expect(() => prepareDriverImport(file({ snils: '1111111114' }), KNOWN)).toThrow(/11 цифр/u);
  });

  it('повтор внутри файла — ошибка выгрузки: иначе второго человека молча пропустят', () => {
    const two = {
      drivers: [
        { fullName: 'Иванов Иван Иванович', snils: SNILS },
        { fullName: 'Петров Пётр Петрович', snils: '111-111-111 45' },
      ],
    };
    expect(() => prepareDriverImport(two, KNOWN)).toThrow(/повторяется в файле/u);
  });
});

describe('ФИО', () => {
  it('разбирается на части — единственная точка правды по имени считается базой', () => {
    const { drivers } = prepareDriverImport(file({ fullName: 'Сары Валерий Николаевич' }), KNOWN);
    expect(drivers[0]!.name).toEqual({
      lastName: 'Сары',
      firstName: 'Валерий',
      middleName: 'Николаевич',
    });
  });

  it('двойное отчество целиком уходит в отчество, а не теряется', () => {
    const { drivers } = prepareDriverImport(file({ fullName: 'Ким Ир СенОвич' }), KNOWN);
    expect(drivers[0]!.name.middleName).toBe('СенОвич');
  });

  it('одной фамилии мало: человека без имени в справочник не заводят', () => {
    expect(() => prepareDriverImport(file({ fullName: 'Иванов' }), KNOWN)).toThrow(/Фамилия Имя/u);
  });
});

describe('выгрузка разбирается целиком или не разбирается вовсе', () => {
  it('ошибка в последней строке не даёт завести первые', () => {
    const mixed = {
      drivers: [
        { fullName: 'Иванов Иван Иванович', snils: SNILS },
        { fullName: 'Петров Пётр Петрович', snils: 'мусор' },
      ],
    };
    expect(() => prepareDriverImport(mixed, KNOWN)).toThrow(/Петров/u);
  });
});
