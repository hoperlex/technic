import {
  moscowDateKeyOf,
  type RecognizedWasteTicket,
  WASTE_TICKET_WORK_KINDS,
  type WasteTicketWorkKind,
  wasteTicketWorkKindLabels,
} from '@technic/contracts';

// ── Нормализации и разбор полей талона вывоза (ADR 0114, план `docs/waste-ticket-ocr-plan.md`) ──
//
// Здесь нет ни базы, ни сети, ни моделей: только правила, по которым написанное на бумаге
// превращается в значения портала. Отдельным файлом от сверки (`waste-ticket-checks.ts`) потому,
// что пользователей у этих правил трое и живут они в разное время: движок распознавания разбирает
// ими ответ модели, маршрут — то, что человек вписал руками, а сверка сравнивает уже разобранное.
// Разойдись эти три разбора, «12-34» с бумаги и «12-34» из формы стали бы разными номерами.
//
// ГЛАВНОЕ ПРАВИЛО РАЗБОРА: не распарсилось — поле пустое (Р4). Догадка запрещена везде, и дороже
// всего она стоит в номере: правдоподобно дописанный номер уйдёт в уникальность и займёт бумагу,
// которой на свете нет.

// ── Номер: две нормализации (Р16) ──

// Нормализации номера переехали в `@technic/contracts` (`waste-ticket-number.ts`): строку талона
// заводят двое — воркер машинную, API ручную, — и оба пишут `number_key`, на котором стоит
// ограничение уникальности. Две копии функции разъехались бы молча, дав один номер двумя ключами.
// Здесь остаётся реэкспорт, чтобы вызывающий код и тесты не знали о переезде.
export { wasteTicketNumberFuzzy, wasteTicketNumberKey } from '@technic/contracts';

// ── Разбор полей из ответа модели (Р2, Р4) ──

/** Сколько дней в месяце: `Date.UTC(y, m, 0)` — последний день предыдущего, то есть месяца `m`. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Сборка календарного ключа с проверкой существования дня. Регулярное выражение пропускает
 * `31.02`, а такой даты не бывает: записать её значило бы получить расхождение с датой вывоза на
 * пустом месте и заставить человека разбирать ошибку разбора, а не бумагу.
 */
function dateKeyOf(year: number, month: number, day: number): string | null {
  // Год за пределами XX–XXI веков — это не дата, а неудачно прочитанные цифры: талоны собирают
  // с 2024 года, и «1808» в графе года означает, что разбор пошёл не тем форматом.
  if (year < 1900 || year > 2999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Двузначный год — к ТЕКУЩЕМУ веку: «17.08.26» на талоне 2026 года это 2026, а не 1926. Век берётся
 * из календаря, а не зашит числом 2000, чтобы правило пережило смену столетия само.
 */
function yearOf(value: number, digits: number, now: Date): number {
  if (digits === 4) return value;
  const century = Math.floor(Number(moscowDateKeyOf(now).slice(0, 4)) / 100) * 100;
  return century + value;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
/** Разделителем считается ЛЮБОЙ нецифровой знак: на бланке между числами стоит точка, пробел, дробь. */
const SEPARATED_DATE_RE = /^(\d{1,2})\D+(\d{1,2})\D+(\d{2}|\d{4})$/u;
const COMPACT_DATE_RE = /^\d{8}$/u;

/**
 * Дата с талона в календарный ключ `YYYY-MM-DD` (Р19). Форматы взяты с настоящих бланков:
 * `17.08.2026`, `17 08 2026`, `17.08.26`, `18082026` — плюс `2026-08-17`, потому что ровно этого
 * формата промпт просит у модели, и разбирать её собственный ответ вторым правилом незачем.
 *
 * Не разобралось — `null`, и талон уходит человеку с пустой датой. Подставить сегодняшнюю или
 * плановую было бы худшим из возможных: сверка сравнила бы выдумку с фактом и промолчала.
 */
export function parseWasteTicketDate(raw: unknown, now: Date = new Date()): string | null {
  // Число здесь законно: `18082026` без разделителей модель отдаёт то строкой, то числом, и
  // отказывать по типу значило бы терять дату из-за формата JSON, а не из-за бумаги.
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;

  const iso = ISO_DATE_RE.exec(text);
  if (iso) return dateKeyOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = SEPARATED_DATE_RE.exec(text);
  if (parts) {
    const year = yearOf(Number(parts[3]), parts[3]!.length, now);
    return dateKeyOf(year, Number(parts[2]), Number(parts[1]));
  }

  if (COMPACT_DATE_RE.test(text)) {
    // Восемь цифр читаются двумя способами, и разводит их только правдоподобие года: `20260818` —
    // это `YYYYMMDD`, а `18082026` годом `1808` быть не может. Сначала пробуется машинный порядок:
    // он однозначен, а человеческий `DDMMYYYY` подхватывает всё остальное.
    const asIso = dateKeyOf(
      Number(text.slice(0, 4)),
      Number(text.slice(4, 6)),
      Number(text.slice(6, 8)),
    );
    if (asIso) return asIso;
    return dateKeyOf(Number(text.slice(4, 8)), Number(text.slice(2, 4)), Number(text.slice(0, 2)));
  }

  return null;
}

/**
 * Объём в графе «Объем» пишут вместе с единицей и видом отходов: «20 м3», «8,5 куб.м», «20 м³ бой».
 * Единицы вычищаются ДО поиска числа, и это не косметика: в «м3» есть цифра `3`, и поиск первого
 * числа по сырой строке вернул бы объём в три куба с талона на двадцать.
 */
const VOLUME_UNIT_RE = /м\s*[3³]|куб[а-я.]*|m\s*3/giu;
const VOLUME_NUMBER_RE = /(-?)(\d+(?:[.,]\d+)?)/u;

/**
 * Объём талона, м³ (Р18). Не разобралось — `null`, и это законный ответ дважды: у талона простоя
 * объёма нет вовсе, а у смазанной графы его нет для нас.
 *
 * Ноль и отрицательное возвращаются как «не разобралось»: схема талона требует положительного
 * (`ticketVolumeSchema`), на бумаге ноль кубов не пишут, а минус в графе — это прочерк, принятый
 * за знак. Записав их числом, мы вычли бы из суммы вывезенного то, чего никто не заявлял.
 */
export function parseWasteTicketVolume(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!text.trim()) return null;

  const cleaned = text.replace(VOLUME_UNIT_RE, ' ');
  const found = VOLUME_NUMBER_RE.exec(cleaned);
  if (!found || found[1]) return null;

  // Буквы рядом с числом законны — в графе объёма пишут вид отходов («20 м3 строй мусор»). А вот
  // ВТОРАЯ группа цифр означает, что в графе не объём: «Простой с 9:10 по 10:10» прочитался бы
  // девятью кубами, которых никто не вывозил, и сумма талонов разошлась бы с закрытием на ровном
  // месте. Неоднозначное здесь лучше оставить человеку (Р4).
  if (/\d/u.test(cleaned.replace(found[0], ' '))) return null;

  const value = Number(found[2]!.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0 || value > 999_999.999) return null;
  // Точность колонки — `numeric(12,3)`, ею же считается сумма в сверке. Лишние знаки округляются
  // здесь, а не в базе: округление на записи создало бы расхождение в третьем знаке между тем, что
  // человек видит в талоне, и тем, что сложила проверка.
  return Math.round(value * 1000) / 1000;
}

/** Обратный словарь к подписям: модель иногда отвечает словом с бланка, а не кодом перечисления. */
const WORK_KIND_BY_LABEL = new Map<string, WasteTicketWorkKind>(
  WASTE_TICKET_WORK_KINDS.map((kind) => [wasteTicketWorkKindLabels[kind], kind]),
);

/**
 * Вид работ (Р2). Обнуляемым он не сделан ни в схеме, ни здесь: `other` — это честный ответ «бланк
 * не про простой и не подписан как вывоз», и второе «неизвестно» рядом с ним отличить в
 * интерфейсе было бы нечем. Поэтому нераспознанное значение становится `other`, а НЕ `removal`:
 * умолчание «вывоз» тихо втянуло бы непонятую бумагу в сумму объёма.
 */
export function parseWasteTicketWorkKind(raw: unknown): WasteTicketWorkKind {
  if (typeof raw !== 'string') return 'other';
  const text = raw.trim().toLowerCase();
  const known = WASTE_TICKET_WORK_KINDS.find((kind) => kind === text);
  return known ?? WORK_KIND_BY_LABEL.get(text) ?? 'other';
}

/** Пределы полей повторяют схему ответа модели (`recognizedWasteTicketSchema`). */
const MAX_NUMBER_LENGTH = 64;
const MAX_ADDRESS_LENGTH = 500;

/** Сырой талон, как он приходит из JSON модели: типы полей не гарантированы никем (Р4). */
export interface RawRecognizedWasteTicket {
  number?: unknown;
  issuedOn?: unknown;
  volumeM3?: unknown;
  workKind?: unknown;
  addressRaw?: unknown;
}

/**
 * Талон из ответа модели в форму контракта (`RecognizedWasteTicket`). Разбор идёт ДО проверки
 * схемой, а не вместо неё: схема отвечает на вопрос «можно ли это хранить», разбор — «что здесь
 * написано», и «17.08.2026» на второй вопрос отвечает, а первую не проходит.
 *
 * Номер длиннее предела становится пустым, а адрес — обрезается, и разница между ними
 * содержательная: обрезанный номер это ДРУГОЙ номер, который займёт чужую бумагу в уникальности,
 * а обрезанный адрес остаётся тем же местом — он участвует только в нестрогом сравнении.
 */
export function parseRecognizedWasteTicket(
  raw: RawRecognizedWasteTicket,
  now: Date = new Date(),
): RecognizedWasteTicket {
  const numberText = typeof raw.number === 'string' ? raw.number.trim() : '';
  const addressText = typeof raw.addressRaw === 'string' ? raw.addressRaw.trim() : '';
  return {
    number: numberText && numberText.length <= MAX_NUMBER_LENGTH ? numberText : null,
    issuedOn: parseWasteTicketDate(raw.issuedOn, now),
    volumeM3: parseWasteTicketVolume(raw.volumeM3),
    workKind: parseWasteTicketWorkKind(raw.workKind),
    addressRaw: addressText ? addressText.slice(0, MAX_ADDRESS_LENGTH) : null,
  };
}

// ── Адрес: нестрогое сравнение (Р18) ──

/**
 * Слова, которые на адресе ничего не различают: виды улиц, единицы застройки и уровни адреса. Их
 * пишут то полностью, то сокращением, то не пишут вовсе («Волоколамское ш. 71/14» и
 * «Волоколамское шоссе, 71к14» — один и тот же въезд), поэтому в сравнении они только шум.
 *
 * Однобуквенные сокращения (`д`, `к`, `г`, `с`, `п`) в списке не нужны: их снимает правило «слово
 * короче двух букв в сравнении не участвует».
 */
const ADDRESS_NOISE_WORDS = new Set([
  'ул',
  'улица',
  'пр',
  'прт',
  'просп',
  'проспект',
  'ш',
  'шоссе',
  'пер',
  'переулок',
  'бр',
  'бул',
  'бульвар',
  'наб',
  'набережная',
  'пл',
  'площадь',
  'проезд',
  'туп',
  'тупик',
  'тракт',
  'мкр',
  'микрорайон',
  'квл',
  'квартал',
  'гор',
  'город',
  'пос',
  'поселок',
  'дер',
  'деревня',
  'село',
  'дом',
  'влд',
  'владение',
  'уч',
  'участок',
  'стр',
  'строение',
  'корп',
  'корпус',
  'лит',
  'литера',
  'оф',
  'офис',
  'кв',
  'квартира',
  'обл',
  'область',
  'рн',
  'район',
  'тер',
  'территория',
  'снт',
  'днп',
]);

/** Адрес, разобранный на то, что в нём различает место: значимые слова и числа. */
export interface WasteAddressParts {
  words: string[];
  numbers: string[];
}

/**
 * Разбор адреса на слова и числа. Три решения, каждое проверено на настоящих бланках:
 *
 * - стык цифры и буквы разрезается (`71к14` → `71 к 14`): корпус пишут и дробью, и буквой, и без
 *   разделителя вовсе, а слипшийся `71к14` не совпал бы с `71/14` никогда;
 * - знаки препинания выбрасываются целиком, в отличие от адресов маршрута (`addressKeyOf`): там
 *   сравнение строгое и точка различает `к.1` и `к1`, здесь оно нестрогое и рукописное, и точка
 *   различает только почерк;
 * - ведущие нули в числах снимаются: `дом 07` и `дом 7` — один дом.
 */
export function wasteAddressParts(raw: string): WasteAddressParts {
  const text = raw
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/(\d)([а-яa-z])/gu, '$1 $2')
    .replace(/([а-яa-z])(\d)/gu, '$1 $2')
    .replace(/[^0-9а-яa-z]+/gu, ' ');

  const words: string[] = [];
  const numbers: string[] = [];
  for (const token of text.split(' ')) {
    if (!token) continue;
    if (/^\d+$/u.test(token)) {
      numbers.push(token.replace(/^0+(?=\d)/u, ''));
      continue;
    }
    if (token.length < 2 || ADDRESS_NOISE_WORDS.has(token)) continue;
    words.push(token);
  }
  return { words, numbers };
}

/**
 * Похожи ли два слова адреса. Совпадение по началу, а не целиком: улицу пишут в разных падежах и
 * сокращают с конца («Садовническая», «Садовническ.», «Волоколамское» против «Волоколамский»), и
 * различает их всегда хвост, а не начало.
 *
 * Пять общих букв — или полное совпадение по началу от четырёх: короче четырёх начало не значит
 * ничего («Ленинский» и «Лениногорская» и так проходят, и это осознанная цена — проверка мягкая,
 * и лишнее молчание в ней дешевле ложного предупреждения, которое приучает не читать замечания).
 */
function wordsAlike(a: string, b: string): boolean {
  if (a === b) return true;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return common >= 5 || (common >= 4 && common === Math.min(a.length, b.length));
}

/**
 * Один ли это адрес — нестрого (Р18). Проверка адреса мягкая по построению: его пишут от руки и
 * сокращают как придётся, а ловит она бумагу, приехавшую с ЧУЖОЙ площадки, — то есть случай, где
 * не совпадает ничего, а не случай, где разошлось написание.
 *
 * Пустая сторона считается похожей: сравнивать не с чем, и предупреждать не о чем. Числа сверяются
 * только когда они есть с обеих сторон: на талоне дом пишут не всегда, и требовать его значило бы
 * ругаться на каждую вторую бумагу.
 */
export function similarWasteAddress(a: string, b: string): boolean {
  const left = wasteAddressParts(a);
  const right = wasteAddressParts(b);
  if (left.words.length + left.numbers.length === 0) return true;
  if (right.words.length + right.numbers.length === 0) return true;

  if (left.words.length > 0 && right.words.length > 0) {
    if (!left.words.some((w) => right.words.some((v) => wordsAlike(w, v)))) return false;
  }
  if (left.numbers.length > 0 && right.numbers.length > 0) {
    if (!left.numbers.some((n) => right.numbers.includes(n))) return false;
  }
  return true;
}
