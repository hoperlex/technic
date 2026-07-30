import { z } from 'zod';

// ── Прочность пароля ──
// Одной длины мало: «1234567890» и «Иванов1234» её проходят, а подбираются мгновенно. Правила
// общие для формы и сервера — иначе клиент разрешил бы то, что API отклонит, и наоборот.

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/**
 * Пароли, которые перебираются первыми. Список намеренно короткий: он закрывает очевидное,
 * а не заменяет проверку по утечкам — от неё защищает лимит попыток входа.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwerty123',
  'qwertyuiop',
  'qwerty12345',
  '1234567890',
  '12345678901',
  '123456789012',
  'adminadmin',
  'administrator',
  'welcome123',
  'letmein123',
  'iloveyou123',
  'parol12345',
  'parolparol',
  'пароль1234',
  'пароль12345',
]);

/** Клавиатурные и числовые дорожки: пароль-отрезок любой из них подбирается перебором ряда. */
const SEQUENCES = [
  '01234567890123456789',
  'qwertyuiopasdfghjklzxcvbnm',
  'йцукенгшщзхъфывапролджэячсмитьбю',
  'abcdefghijklmnopqrstuvwxyz',
  'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
];

function isSequenceSlice(lower: string): boolean {
  return SEQUENCES.some(
    (seq) => seq.includes(lower) || [...seq].reverse().join('').includes(lower),
  );
}

function isSingleCharacter(lower: string): boolean {
  return new Set(lower).size === 1;
}

/** Общая проверка, без привязки к учётной записи. `null` — пароль допустим. */
export function passwordWeakness(password: string): string | null {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Слишком распространённый пароль';
  if (isSingleCharacter(lower)) return 'Пароль из одного повторяющегося символа';
  if (isSequenceSlice(lower)) return 'Подряд идущие символы на клавиатуре легко подбираются';
  return null;
}

/**
 * Пароль не должен содержать то, что о человеке и так известно: email, фамилию, имя. Такие
 * пароли — первое, что пробует адресный перебор. Части короче 4 символов не проверяются:
 * имя «Ян» встречалось бы почти в любом пароле случайно.
 */
export function passwordContainsIdentity(password: string, identityParts: string[]): boolean {
  const lower = password.toLowerCase();
  return identityParts
    .flatMap((part) => part.toLowerCase().split(/[\s@.\-_']+/u))
    .filter((part) => part.length >= 4)
    .some((part) => lower.includes(part));
}

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Не менее ${PASSWORD_MIN} символов`)
  .max(PASSWORD_MAX)
  .superRefine((value, ctx) => {
    const issue = passwordWeakness(value);
    if (issue) ctx.addIssue({ code: 'custom', message: issue });
  });

/**
 * Проверка пароля против данных учётки. Вынесена отдельно, потому что применяется в
 * `superRefine` схем, где эти данные доступны рядом с паролем.
 */
export function passwordIdentityIssue(password: string, identityParts: string[]): string | null {
  return passwordContainsIdentity(password, identityParts)
    ? 'Пароль не должен содержать email, фамилию или имя'
    : null;
}

/** Оценка для индикатора в форме: 0 — недопустим, 3 — надёжный. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 {
  if (password.length < PASSWORD_MIN || passwordWeakness(password) !== null) return 0;
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\d/u, /[^\p{L}\d]/u].filter((re) =>
    re.test(password),
  ).length;
  if (password.length >= 16 && classes >= 2) return 3;
  if (password.length >= 12 && classes >= 2) return 2;
  return 1;
}
