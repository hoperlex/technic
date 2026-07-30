import { z } from 'zod';

// ── ФИО по частям ──
// Общие правила ввода и нормализации фамилии, имени и отчества (ADR 0034). Живут в контрактах,
// потому что форма и сервер обязаны нормализовать один и тот же ввод одинаково: иначе клиент
// показал бы «Иванов  Иван», а в базу легла бы другая строка. Отсюда же берёт правила будущий
// CRUD физлиц (persons, ADR 0008) — модель ФИО у учётки и у человека одна.

const NAME_MAX = 100;

/** Разделители внутри одной части: «Салтыков-Щедрин», «ван дер Берг», «О'Коннор». */
const NAME_SEPARATORS = /[-' ]/;

/** Буква, дефис, апостроф, пробел; каждая группа символов начинается и кончается буквой. */
const NAME_PATTERN = /^\p{L}+(?:[-' ]\p{L}+)*$/u;

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

/** Схлопывает любые пробельные последовательности в один пробел и обрезает края. */
export function normalizeNamePart(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Кириллица и латиница в одном слове — почти всегда подделка через гомоглифы («Ивaнов» с
 * латинской «a»): визуально это то же ФИО, а для поиска, сортировки и сверки с физлицом — другое.
 * Между словами смешение допустимо: «Иванов Jean» — редкий, но законный случай.
 */
function hasMixedScripts(value: string): boolean {
  return value.split(NAME_SEPARATORS).some((word) => CYRILLIC.test(word) && LATIN.test(word));
}

/**
 * Проверка одной части ФИО: `null` — годится. Отдельной функцией, а не только правилом zod,
 * потому что форма проверяет ввод теми же правилами — иначе клиент принимал бы то, что API
 * отклоняет.
 *
 * @param value — уже нормализованное значение (см. `normalizeNamePart`).
 */
export function namePartIssue(value: string, required: boolean): string | null {
  if (value === '') return required ? 'Обязательное поле' : null;
  if (value.length > NAME_MAX) return `Не длиннее ${NAME_MAX} символов`;
  if (!NAME_PATTERN.test(value)) return 'Допустимы только буквы, дефис, апостроф и пробел';
  if (hasMixedScripts(value)) return 'Не смешивайте кириллицу и латиницу в одном слове';
  return null;
}

function namePart(required: boolean) {
  return (
    z
      .string()
      // Отсечка до нормализации: без неё мегабайт пробелов дошёл бы до regexp.
      .max(NAME_MAX * 4, `Не длиннее ${NAME_MAX} символов`)
      .transform(normalizeNamePart)
      .superRefine((value, ctx) => {
        const issue = namePartIssue(value, required);
        if (issue) ctx.addIssue({ code: 'custom', message: issue });
      })
  );
}

/** Поля ФИО для схем создания: фамилия и имя обязательны, отчество — если есть. */
export const personNameFields = {
  lastName: namePart(true),
  firstName: namePart(true),
  middleName: namePart(false).default(''),
};

/** Те же поля для схем частичного обновления. */
export const personNamePartialFields = {
  lastName: namePart(true).optional(),
  firstName: namePart(true).optional(),
  middleName: namePart(false).optional(),
};

export interface PersonNameParts {
  lastName: string;
  firstName: string;
  middleName: string;
}

/**
 * Полное ФИО одной строкой. Повторяет generated-колонку `full_name` в БД — нужен там, где
 * сервер ещё не ответил: предпросмотр в форме и подписи в оптимистичных обновлениях.
 */
export function formatFullName(parts: PersonNameParts): string {
  return normalizeNamePart(`${parts.lastName} ${parts.firstName} ${parts.middleName}`);
}

/**
 * Разбор ФИО, введённого одной строкой: первое слово — фамилия, второе — имя, весь остаток —
 * отчество. Остаток берётся целиком, а не третьим словом: «Иванов Иван Иванович оглы» и двойные
 * имена иначе теряли бы хвост. Тем же правилом разбирает накопленные данные миграция 0055.
 */
export function splitFullName(value: string): PersonNameParts {
  const parts = normalizeNamePart(value)
    .split(' ')
    .filter((p) => p.length > 0);
  return {
    lastName: parts[0] ?? '',
    firstName: parts[1] ?? '',
    middleName: parts.slice(2).join(' '),
  };
}

/** «Иванов И. И.» — для таблиц и телефона, где полное ФИО не помещается. */
export function formatShortName(parts: PersonNameParts): string {
  const initials = [parts.firstName, parts.middleName]
    .map((p) => normalizeNamePart(p))
    .filter((p) => p.length > 0)
    .map((p) => `${p[0]!.toUpperCase()}.`)
    .join(' ');
  return normalizeNamePart(`${parts.lastName} ${initials}`);
}
