import type { RowContext } from './types';

/**
 * Ячейка файла ↔ значение справочника (ADR 0073). Общий набор на все описания: иначе «да/нет» в
 * одном справочнике окажется «true/false» в соседнем, и человек, заполнивший один файл по образцу
 * другого, получит отказ на ровном месте.
 *
 * Все преобразования разбора возвращают `undefined` на пустой ячейке, а не значение по умолчанию.
 * Это и есть правило «пустая ячейка ничего не меняет»: колонка, получив `undefined`, оставляет в
 * модели то, что уже заведено (у новой записи — то, что задала `blank()`). Колонки, где пусто
 * означает «стереть» — комментарий, описание, — присваивают текст напрямую, минуя эти функции.
 */

/** Флаг в файле. Пишется словом: «1» в колонке «Активен» человек читает как количество. */
export function boolCell(value: boolean): string {
  return value ? 'да' : 'нет';
}

const TRUE_WORDS = new Set(['да', 'true', '1', '+', 'yes', 'истина', 'y', 'д']);
const FALSE_WORDS = new Set(['нет', 'false', '0', '-', 'no', 'ложь', 'n', 'н']);

/** Разбор флага. Принимается всё, чем люди отвечают «да» в таблицах, — отказ тут был бы придиркой. */
export function parseBool(text: string, ctx: RowContext, label: string): boolean | undefined {
  const v = text.trim().toLowerCase();
  if (v === '') return undefined;
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  ctx.fail(`${label} — ожидается «да» или «нет», получено «${text.trim()}»`);
  return undefined;
}

/** Целое в файле; `null` — не заполнено. */
export function intCell(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

export function parseInt10(
  text: string,
  ctx: RowContext,
  label: string,
  bounds?: { min?: number; max?: number },
): number | undefined {
  const v = text.trim().replace(/\s/gu, '');
  if (v === '') return undefined;
  if (!/^-?\d+$/u.test(v)) {
    ctx.fail(`${label} — ожидается целое число, получено «${text.trim()}»`);
    return undefined;
  }
  const n = Number(v);
  if (bounds?.min !== undefined && n < bounds.min) {
    ctx.fail(`${label} — не меньше ${bounds.min}, получено ${n}`);
    return undefined;
  }
  if (bounds?.max !== undefined && n > bounds.max) {
    ctx.fail(`${label} — не больше ${bounds.max}, получено ${n}`);
    return undefined;
  }
  return n;
}

/**
 * Дробное в файле. Хранится в базе строкой (numeric), и такой же строкой едет в файл: перевод в
 * число и обратно на цене в 1875.50 даёт 1875.5, и человек видит правку там, где её не делал.
 */
export function decimalCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);
  // Хвостовые нули у numeric из базы («1875.5000») человеку не нужны, а сравнение идёт по тексту:
  // без обрезки повторная загрузка выгруженного файла показала бы правку каждой цены.
  return text.includes('.') ? text.replace(/\.?0+$/u, '') : text;
}

export function parseDecimal(
  text: string,
  ctx: RowContext,
  label: string,
  bounds?: { min?: number; max?: number },
): string | undefined {
  // Запятая — то, чем дробную часть отделяет русская раскладка и сам Excel.
  const v = text.trim().replace(/\s/gu, '').replace(',', '.');
  if (v === '') return undefined;
  if (!/^-?\d+(\.\d+)?$/u.test(v)) {
    ctx.fail(`${label} — ожидается число, получено «${text.trim()}»`);
    return undefined;
  }
  const n = Number(v);
  if (bounds?.min !== undefined && n < bounds.min) {
    ctx.fail(`${label} — не меньше ${bounds.min}, получено ${text.trim()}`);
    return undefined;
  }
  if (bounds?.max !== undefined && n > bounds.max) {
    ctx.fail(`${label} — не больше ${bounds.max}, получено ${text.trim()}`);
    return undefined;
  }
  return decimalCell(v);
}

/** Дата в файле — «ДД.ММ.ГГГГ»: так её пишет и читает человек, а не «ГГГГ-ММ-ДД» из базы. */
export function dateCell(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/u.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/**
 * Разбор даты. Принимаются оба порядка частей: «ДД.ММ.ГГГГ» набирает человек, «ГГГГ-ММ-ДД»
 * оставляет выгрузка из учётной системы. Ячейку-дату Excel в текст «ДД.ММ.ГГГГ» превращает
 * чтение книги — сюда она приходит уже в этом виде.
 */
export function parseDate(text: string, ctx: RowContext, label: string): string | undefined {
  const v = text.trim();
  if (v === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(v)) return v;
  const ru = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/u.exec(v);
  if (!ru) {
    ctx.fail(`${label} — ожидается ДД.ММ.ГГГГ, получено «${v}»`);
    return undefined;
  }
  const [, d, mo, y] = ru;
  const iso = `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  // Календарь проверяет Date, а не регулярка: «31.02.2026» формату соответствует, а дате — нет.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(iso)) {
    ctx.fail(`${label} — такой даты нет в календаре: «${v}»`);
    return undefined;
  }
  return iso;
}

/**
 * Список в одной ячейке: коды ТТХ у типа, синонимы контрагента. Разделитель — точка с запятой:
 * запятая живёт внутри наименований («ООО Ромашка, филиал»), и разделять ею значит рвать значение.
 */
export function listCell(items: readonly string[]): string {
  return items.join('; ');
}

/** Разбор списка. Запятая тоже принимается: её ставят по привычке, и отказ был бы придиркой. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[;,\n]/u)
        .map((p) => p.trim())
        .filter((p) => p !== ''),
    ),
  ];
}

/**
 * Разбор списка, где разделитель — **только** точка с запятой.
 *
 * Отличие от `parseList` ровно одно, и оно принципиальное: тот делит ещё и по запятой «по
 * привычке», а здесь запятая — законный знак ВНУТРИ значения. Разделять ею значит молча порвать
 * значение надвое и получить два, которых человек не писал: у площадок отдела (ADR 0144) элемент
 * списка — код объекта, произвольный текст до 50 знаков, и запятая в нём допустима так же, как в
 * наименовании контрагента («ООО Ромашка, филиал»), про которое ровно то же сказано у `listCell`.
 *
 * Функция общая, а не спрятана в описании отделов, именно потому, что выбор между двумя разборами
 * — общий вопрос всякого списка в ячейке: «может ли запятая стоять внутри элемента». Стой строгий
 * разбор в стороне от снисходительного, следующий автор списка увидел бы только `parseList` и не
 * узнал бы, что тот режет по запятой, — а узнал бы от человека, у которого пропала половина
 * значения.
 *
 * **Обязательство того, кто этим разбором пользуется**: экранирования здесь нет намеренно —
 * неявные правила разбора дают молчаливые потери, — поэтому запись обязана проверять, что «;»
 * внутри значения нет, и отказывать выгрузкой, а не собирать файл, который сама же не прочтёт
 * (§6 п. 2 плана «Площадки отдела множеством»). Повторы снимаются здесь же: два одинаковых
 * элемента в ячейке — опечатка, а не намерение.
 */
export function parseSemicolonList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p !== ''),
    ),
  ];
}

/**
 * Обязательный текст. Возвращает `undefined` и записывает ошибку, если ячейка пуста, — но только
 * когда поле в модели ещё не заполнено: у заведённой записи пустая ячейка означает «не трогать».
 */
export function parseRequired(
  text: string,
  ctx: RowContext,
  label: string,
  current: string,
): string | undefined {
  const v = text.trim();
  if (v !== '') return v;
  if (current.trim() === '') ctx.fail(`${label} — обязательная колонка, а ячейка пуста`);
  return undefined;
}

/**
 * Значение из перечисления по его человеческому названию. В файле стоят слова («Контейнер»,
 * «Аренда»), а не коды: файл читает и правит человек, а коды перечислений — внутреннее дело базы.
 */
export function parseChoice<T extends string>(
  text: string,
  labels: Readonly<Record<T, string>>,
  ctx: RowContext,
  label: string,
): T | undefined {
  const v = text.trim().toLowerCase();
  if (v === '') return undefined;
  for (const [value, title] of Object.entries(labels) as [T, string][]) {
    if (title.toLowerCase() === v || value.toLowerCase() === v) return value;
  }
  ctx.fail(
    `${label} — допустимые значения: ${Object.values<string>(labels).join(', ')}; получено «${text.trim()}»`,
  );
  return undefined;
}
