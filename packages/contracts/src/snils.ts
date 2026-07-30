import { z } from 'zod';

// ── СНИЛС ──
// Страховой номер индивидуального лицевого счёта: обязательный реквизит путевого листа
// (ADR 0037, приказ Минтранса № 390). Правила живут в контрактах, потому что форма и сервер
// обязаны понимать один и тот же ввод одинаково: человек набирает номер так, как он напечатан
// в документе — «112-233-445 95», — а хранится и сравнивается он одиннадцатью цифрами.

const SNILS_DIGITS = 11;
export const SNILS_MESSAGE = 'СНИЛС — 11 цифр';
export const SNILS_CHECKSUM_MESSAGE = 'СНИЛС не проходит проверку контрольной суммы';

/** «112-233-445 95», «112 233 445 95», «11223344595» — один и тот же номер. */
export function normalizeSnils(value: string): string {
  return value.replace(/[\s-]/gu, '');
}

/**
 * Контрольная сумма (правила ПФР): первые девять цифр умножаются на позиции 9…1, остаток от
 * деления суммы на 101 и есть контрольное число. Проверка ловит опечатку в одной цифре — то,
 * чего формат не видит.
 *
 * Номера до 001-001-998 выданы до введения контрольного числа, и у них оно не считается —
 * без этой оговорки старейшие СНИЛС отвергались бы как ошибочные.
 */
export function isValidSnils(value: string): boolean {
  const snils = normalizeSnils(value);
  if (!/^\d{11}$/u.test(snils)) return false;
  if (Number(snils.slice(0, 9)) <= 1001998) return true;

  const sum = [...snils.slice(0, 9)].reduce((acc, digit, i) => acc + Number(digit) * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  // Остаток 100 (как и суммы 100 и 101) даёт контрольное число 00.
  const checksum = rest === 100 ? 0 : rest;
  return checksum === Number(snils.slice(9));
}

/** Как номер напечатан в документе: «112-233-445 95». Не нормализованный вход возвращается как есть. */
export function formatSnils(value: string): string {
  const snils = normalizeSnils(value);
  if (!/^\d{11}$/u.test(snils)) return value;
  return `${snils.slice(0, 3)}-${snils.slice(3, 6)}-${snils.slice(6, 9)} ${snils.slice(9)}`;
}

/**
 * Формат номера; контрольную сумму проверяет сервис — тем же приёмом, что ИНН контрагента
 * (`isValidInn`). Разделители снимаются до проверки: они оформление, а не часть номера, и два
 * представления одного значения дали бы два способа не найти дубль.
 */
export const snilsSchema = z
  .string()
  // Отсечка до нормализации: без неё мегабайт пробелов дошёл бы до регулярного выражения.
  .max(SNILS_DIGITS * 4, SNILS_MESSAGE)
  .transform(normalizeSnils)
  .refine((v) => /^\d{11}$/u.test(v), SNILS_MESSAGE);
