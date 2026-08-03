import {
  formatSnils,
  isDriverJobTitle,
  isValidSnils,
  looksLikeDriverLicense,
  normalizeSnils,
  splitFullName,
} from '@technic/contracts';
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
  /** Должность и подразделение строки; не заданы — берутся общие из файла. */
  jobTitle?: string;
  department?: string;
  birthDate?: string;
  employedSince?: string;
  snils: string;
  /** Категории строкой ровно как в источнике («B,B1,C,C1,BE,CE,C1E»). */
  categories?: string;
  /** Полные реквизиты ВУ; старые кадровые выгрузки присылают только категории. */
  license?: {
    series: string;
    number: string;
    issuedOn: string;
    expiresOn: string;
    issuedBy?: string;
  };
}

export interface DriversImportFile {
  department?: string;
  jobTitle?: string;
  drivers: DriverImportRecord[];
}

/** Должность по умолчанию: выгрузку водителей за ней и заводили (ADR 0037). */
const DEFAULT_JOB_TITLE = 'Водитель';

/** Строка выгрузки, приведённая к тому, что примет база. */
export interface PreparedDriver {
  /** ФИО одной строкой — им скрипт называет человека в отчёте. */
  who: string;
  name: PersonNameParts;
  /** 11 цифр: разделители — оформление, а не часть номера. */
  snils: string;
  personnelNo: string;
  /** Должность и подразделение — из строки, а не из файла: в выгрузке отдела они разные. */
  jobTitle: string;
  department: string;
  birthDate: string | null;
  employedSince: string | null;
  /** Только коды, найденные в справочнике; остальные ушли в `unknownCategories`. */
  categories: string[];
  /** Нормализованные реквизиты ВУ, если источник их прислал. */
  license: {
    series: string;
    number: string;
    issuedOn: string;
    expiresOn: string;
    issuedBy: string;
  } | null;
  /**
   * Почему удостоверение не заводится вовсе, хотя категории в строке есть. Пусто — заводится
   * обычным порядком. Заполнено у не водительских должностей (ADR 0049): их категории относятся
   * к другому документу, и приписывать их к ВУ нельзя.
   */
  licenseSkipReason: string;
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
  /** Копилка ошибок разбора: передана — сюда, иначе бросаем (у отдельного вызова копилки нет). */
  problems?: string[],
): string | null {
  if (!value || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(v)) return v;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(v);
  if (!ru) {
    const message = `${who}: ${field} — ожидается ДД.ММ.ГГГГ или ГГГГ-ММ-ДД, получено «${v}»`;
    if (!problems) throw new DriverImportError(message);
    problems.push(message);
    return null;
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
  /**
   * Ошибки собираются по всей выгрузке, а не бросаются первой же. Заводить всё равно нечего —
   * файл не разобран, — но человек с выгрузкой в руках правит её один раз, а не выясняет
   * следующую опечатку каждым новым заходом: в выгрузке отдела на сотню строк их бывает четыре.
   */
  const problems: string[] = [];

  const drivers = file.drivers.map((d) => {
    const who = d.fullName?.trim() ?? '';
    if (who === '') problems.push('В выгрузке есть строка без ФИО');

    const name = splitFullName(who);
    if (who !== '' && (!name.lastName || !name.firstName)) {
      problems.push(`${who}: ожидается «Фамилия Имя Отчество»`);
    }

    const snils = normalizeSnils(d.snils ?? '');
    if (!/^\d{11}$/u.test(snils)) {
      problems.push(`${who}: СНИЛС — 11 цифр, получено «${d.snils}»`);
    } else if (!isValidSnils(snils)) {
      // Контрольная сумма ловит опечатку в одной цифре — то, чего формат не видит. Пропустить её
      // здесь значило бы завести номер, который потом отвергнет форма правки карточки.
      problems.push(`${who}: СНИЛС ${formatSnils(snils)} не проходит проверку контрольной суммы`);
    }

    const jobTitle = d.jobTitle?.trim() || file.jobTitle?.trim() || DEFAULT_JOB_TITLE;
    const department = d.department?.trim() || file.department?.trim() || '';

    const licenseIssuedOn = d.license
      ? parseImportDate(d.license.issuedOn, 'дата выдачи ВУ', who, problems)
      : null;
    const licenseExpiresOn = d.license
      ? parseImportDate(d.license.expiresOn, 'срок действия ВУ', who, problems)
      : null;
    if (licenseIssuedOn && licenseExpiresOn && licenseExpiresOn < licenseIssuedOn) {
      problems.push(`${who}: срок действия ВУ не может быть раньше даты выдачи`);
    }
    const license = d.license
      ? {
          series: d.license.series.trim(),
          number: d.license.number.trim(),
          // Схема требует обе даты, а разбор возвращает null только после уже записанной ошибки.
          issuedOn: licenseIssuedOn ?? '',
          expiresOn: licenseExpiresOn ?? '',
          issuedBy: d.license.issuedBy?.trim() ?? '',
        }
      : null;

    const codes = parseCategoryCodes(d.categories);
    const unknown = codes.filter((c) => !known.has(c));
    /**
     * Водительское ли это удостоверение (ADR 0049). У водителя — да, колонка только про него.
     * У машиниста в той же колонке стоят категории удостоверения тракториста-машиниста, где
     * те же буквы означают другие машины: приписать их к ВУ значит выдать допуск к автобусу.
     *
     * Исключение — набор, который у тракториста невозможен: подкатегория или состав с прицепом
     * (B1, CE, DE) при полном отсутствии незнакомых справочнику кодов. Так распознаётся машинист
     * крана, у которого есть и настоящие права; всё спорное остаётся незаведённым.
     */
    const isDriverLicense =
      license !== null ||
      isDriverJobTitle(jobTitle) ||
      (unknown.length === 0 && looksLikeDriverLicense(codes));
    const licenseSkipReason =
      isDriverLicense || codes.length === 0
        ? ''
        : `должность «${jobTitle}» не водительская: категории ${codes
            .map((c) => c.toUpperCase())
            .join(', ')} относятся к другому удостоверению и не заведены`;
    if (licenseSkipReason === '' && unknown.length > 0) {
      unknownCategories.push({ who, codes: unknown });
    }

    return {
      who,
      name,
      snils,
      personnelNo: d.personnelNo?.trim() ?? '',
      jobTitle,
      department,
      birthDate: parseImportDate(d.birthDate, 'дата рождения', who, problems),
      employedSince: parseImportDate(d.employedSince, 'дата приёма', who, problems),
      categories: isDriverLicense ? codes.filter((c) => known.has(c)) : [],
      license,
      licenseSkipReason,
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
  if (problems.length > 0) {
    const head =
      problems.length === 1
        ? 'Выгрузка не разобрана:'
        : `Выгрузка не разобрана, строк с ошибками — ${problems.length}:`;
    throw new DriverImportError([head, ...problems.map((p) => `· ${p}`)].join('\n'));
  }
  if (duplicates.size > 0) {
    throw new DriverImportError(`СНИЛС повторяется в файле: ${[...duplicates].join(', ')}`);
  }

  return { drivers, unknownCategories };
}
