import { formatSnils, isValidSnils, normalizeSnils, splitFullName } from '@technic/contracts';
import type { PersonNameParts } from '@technic/contracts';

// Разбор кадровой выгрузки водителей (ADR 0037).
//
// Отделено от записи в справочник (`driver-import-apply.ts`) намеренно: здесь решения о том, что
// считать корректной строкой выгрузки. Правила, по которым в прод попадают ФИО, СНИЛС и допуски
// живых людей, проверять тестом надо, а модуль с записью тянет за собой соединение с базой.

/**
 * Строка выгрузки не разобрана. Свой класс, а не голый Error: файл грузят из портала, и там
 * «человек прислал не тот файл» обязано отличаться от «сервер сломался» — первое объясняют
 * загрузившему дословно, второе прячут за 500.
 */
export class DriverImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverImportError';
  }
}

/** Что кадровая выгрузка даёт по одному человеку. Даты — «ДД.ММ.ГГГГ» или «ГГГГ-ММ-ДД». */
export interface DriverImportRecord {
  fullName: string;
  personnelNo?: string;
  birthDate?: string;
  employedSince?: string;
  snils: string;
  /** Категории строкой ровно как в источнике («B,B1,C,C1,BE,CE,C1E»). */
  categories?: string;
}

export interface DriversImportFile {
  department?: string;
  jobTitle?: string;
  drivers: DriverImportRecord[];
}

/** Строка выгрузки, приведённая к тому, что примет база. */
export interface PreparedDriver {
  /** ФИО одной строкой — им скрипт называет человека в отчёте. */
  who: string;
  name: PersonNameParts;
  /** 11 цифр: разделители — оформление, а не часть номера. */
  snils: string;
  personnelNo: string;
  birthDate: string | null;
  employedSince: string | null;
  /** Только коды, найденные в справочнике; остальные ушли в `unknownCategories`. */
  categories: string[];
}

export interface PreparedImport {
  drivers: PreparedDriver[];
  /** Коды, которых нет в справочнике: их заводит администратор, сверившись с документом. */
  unknownCategories: { who: string; codes: string[] }[];
}

/**
 * Дата из выгрузки. Оба формата приняты сознательно: «ГГГГ-ММ-ДД» кладёт скрипт, «ДД.ММ.ГГГГ»
 * набирает человек — файл правит кадровик, а не программист, и заставлять его переставлять
 * части даты значит получить опечатку вместо экономии десяти строк кода.
 */
export function parseImportDate(
  value: string | undefined,
  field: string,
  who: string,
): string | null {
  if (!value || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(v)) return v;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(v);
  if (!ru) {
    throw new DriverImportError(
      `${who}: ${field} — ожидается ДД.ММ.ГГГГ или ГГГГ-ММ-ДД, получено «${v}»`,
    );
  }
  return `${ru[3]}-${ru[2]}-${ru[1]}`;
}

/**
 * Коды категорий из строки источника. Регистр снимается («C1E» → «c1e»), пустые элементы
 * отбрасываются: в выгрузке встречается «C,C1,,BE» — это мусор разделителей, а не категория.
 */
export function parseCategoryCodes(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter((c) => c !== ''),
    ),
  ];
}

/**
 * Выгрузка целиком: либо разобрана вся, либо не выполнено ничего. Половина заведённого
 * справочника хуже невыполненного запуска — её придётся сверять руками построчно.
 *
 * Неизвестные коды не угадываются. «AM», «CE1» и одиночная «E» похожи на M, C1E и старую
 * докатегорийную E, но речь о допуске живого человека к грузовику: такую догадку подтверждают
 * удостоверением в руках, а не эвристикой в сиде. Строка при этом не отбрасывается целиком —
 * человек заводится с теми категориями, которые справочник знает, остальные добавит
 * администратор. Потерять водителя из-за одной непонятной буквы хуже, чем завести его без неё.
 */
export function prepareDriverImport(
  file: DriversImportFile,
  knownCategoryCodes: Iterable<string>,
): PreparedImport {
  const known = new Set(knownCategoryCodes);
  const unknownCategories: PreparedImport['unknownCategories'] = [];

  const drivers = file.drivers.map((d) => {
    const who = d.fullName?.trim() ?? '';
    if (who === '') throw new DriverImportError('В выгрузке есть строка без ФИО');

    const name = splitFullName(who);
    if (!name.lastName || !name.firstName) {
      throw new DriverImportError(`${who}: ожидается «Фамилия Имя Отчество»`);
    }

    const snils = normalizeSnils(d.snils ?? '');
    if (!/^\d{11}$/u.test(snils))
      throw new DriverImportError(`${who}: СНИЛС — 11 цифр, получено «${d.snils}»`);
    // Контрольная сумма ловит опечатку в одной цифре — то, чего формат не видит. Пропустить её
    // здесь значило бы завести номер, который потом отвергнет форма правки карточки.
    if (!isValidSnils(snils)) {
      throw new DriverImportError(
        `${who}: СНИЛС ${formatSnils(snils)} не проходит проверку контрольной суммы`,
      );
    }

    const codes = parseCategoryCodes(d.categories);
    const unknown = codes.filter((c) => !known.has(c));
    if (unknown.length > 0) unknownCategories.push({ who, codes: unknown });

    return {
      who,
      name,
      snils,
      personnelNo: d.personnelNo?.trim() ?? '',
      birthDate: parseImportDate(d.birthDate, 'дата рождения', who),
      employedSince: parseImportDate(d.employedSince, 'дата приёма', who),
      categories: codes.filter((c) => known.has(c)),
    };
  });

  // Один СНИЛС — один человек (ADR 0037). Повтор внутри файла означает ошибку выгрузки: второй
  // такой строкой сид молча пропустил бы человека как «уже заведённого».
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const d of drivers) {
    if (seen.has(d.snils)) duplicates.add(formatSnils(d.snils));
    seen.add(d.snils);
  }
  if (duplicates.size > 0) {
    throw new DriverImportError(`СНИЛС повторяется в файле: ${[...duplicates].join(', ')}`);
  }

  return { drivers, unknownCategories };
}
