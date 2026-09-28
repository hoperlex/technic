import { useState, type ChangeEvent, type FocusEvent, type KeyboardEvent } from 'react';
import { Input } from 'antd';
import { normalizePhone, PHONE_DIGITS, PHONE_PLACEHOLDER } from '@technic/contracts';

interface Props {
  /** Значение поля формы: десять цифр, пустая строка или номер старой записи как он в базе. */
  value?: string;
  onChange?: (value: string) => void;
  /**
   * `id` и `onBlur` приходят от `Form.Item`, а не от пишущего форму: первым antd связывает поле с
   * подписью, вторым запускает проверку по уходу из поля. Оба обязаны доехать до `input` — иначе
   * подпись перестаёт нажиматься, а проверка не срабатывает вовсе.
   */
  id?: string;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  size?: 'large' | 'middle' | 'small';
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * Позиции цифр номера в маске «+7 (900) 000 00 00» — по ним каретка возвращается туда, где
 * человек печатал, а не в конец строки. Считаются от вида маски, а не подбираются: разделители
 * в ней фиксированные, и таблица короче, чем разбор строки на каждый ввод.
 */
const DIGIT_POSITIONS = [4, 5, 6, 9, 10, 11, 13, 14, 16, 17];

/** Каретка сразу за `n`-й цифрой; `n = 0` — сразу за подставленным «+7 (». */
const caretAfter = (n: number) => (n === 0 ? 4 : DIGIT_POSITIONS[n - 1]! + 1);

/** Начало маски, которое поле показывает само: код страны человек не набирает (ADR 0066). */
const PREFIX = '+7 (';

/**
 * Номер по мере набора: те же скобки и пробелы, что у готового номера (`formatPhone`), только
 * оборванные там, где человек остановился.
 */
function maskOf(digits: string): string {
  if (digits.length === 0) return '';
  let masked = `${PREFIX}${digits.slice(0, 3)}`;
  if (digits.length > 3) masked += `) ${digits.slice(3, 6)}`;
  if (digits.length > 6) masked += ` ${digits.slice(6, 8)}`;
  if (digits.length > 8) masked += ` ${digits.slice(8, PHONE_DIGITS)}`;
  return masked;
}

/**
 * Цифры номера из того, что оказалось в поле: разделители выбрасываются, ведущие «8», «7» и «+7»
 * съедаются.
 *
 * Съедаются они, пока цифр не ровно десять: и когда номер вставили целиком («8 926 123-45-67»),
 * и когда человек по привычке начал набор с восьмёрки — тогда первая же цифра исчезает, а на её
 * месте остаётся «+7 (». Кода региона, начинающегося с 7 или 8, в России нет, поэтому съеденная
 * цифра — всегда код выхода или код страны, а не начало номера.
 *
 * Возвращает и число съеденных спереди цифр: без него каретка после вставки уезжала бы на цифру
 * вправо от того места, где человек её оставил.
 */
function digitsOf(raw: string): { digits: string; eatenLeading: number } {
  let digits = raw.replace(/\D/g, '');
  let eatenLeading = 0;
  while (digits.length !== PHONE_DIGITS && (digits[0] === '7' || digits[0] === '8')) {
    digits = digits.slice(1);
    eatenLeading += 1;
  }
  return { digits: digits.slice(0, PHONE_DIGITS), eatenLeading };
}

/**
 * Сколько цифр стоит левее каретки — всех, вместе с семёркой маски. Она тоже цифра для
 * `digitsOf`, который её и съедает, и вычесть её из этого счёта — забота вызывающего:
 * два разных правила счёта разъехались бы ровно на неё, и каретка уезжала бы на знак.
 */
function digitsBeforeCaret(text: string, caret: number): number {
  return (text.slice(0, caret).match(/\d/g) ?? []).length;
}

/**
 * Поле телефона с маской «+7 (900) 000 00 00» (ADR 0066).
 *
 * Наружу — в форму и дальше в API — уходят одни цифры без кода страны: столько же, сколько
 * хранит база. Маска живёт только на экране, поэтому ни форме, ни ручке не приходится разбирать
 * скобки, а второй формат в колонке не заводится.
 *
 * Номер записи, заведённой до нормализации, к десяти цифрам не сводится (миграция `0095` такие
 * не трогала) — он показывается как есть, а не прячется за маской: человеку видно, что записано,
 * а проверка поля объясняет, почему так больше нельзя. Первая же правка переводит его в общий вид.
 */
export function PhoneInput({ value, onChange, onBlur, id, size, disabled, autoFocus }: Props) {
  // Пустое поле показывает «+7 (» с фокусом: цифра, набранная следом, встаёт сразу в маску, и
  // человеку не приходится гадать, ждут от него восьмёрку или код страны.
  const [focused, setFocused] = useState(false);

  const raw = value ?? '';
  // Промежуточный ввод («926») цифрами и есть — маскируется. Номер, который к десяти цифрам не
  // сводится, оставлен в поле как есть.
  const digits = /^\d{0,10}$/.test(raw) ? raw : (normalizePhone(raw) ?? null);
  const masked = digits === null ? raw : maskOf(digits);
  const display = masked === '' && focused ? PREFIX : masked;
  const editable = digits !== null;

  /** Новое значение в форму и каретка за `caretDigits`-й цифрой — уже по новой маске. */
  const commit = (next: string, caretDigits: number, input: HTMLInputElement) => {
    onChange?.(next);
    const position = next === '' ? PREFIX.length : caretAfter(caretDigits);
    // После перерисовки: до неё в поле стоит прежняя строка, и каретка уехала бы по её длине.
    requestAnimationFrame(() => input.setSelectionRange(position, position));
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const caret = input.selectionStart ?? input.value.length;
    const before = digitsBeforeCaret(input.value, caret);
    const { digits: next, eatenLeading } = digitsOf(input.value);
    commit(next, Math.max(0, Math.min(before - eatenLeading, next.length)), input);
  };

  /**
   * Backspace на разделителе. Сам по себе он стёр бы скобку или пробел, маска вернула бы их на
   * место, и поле выглядело бы залипшим — поэтому удаляется ближайшая цифра слева.
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    if (e.key !== 'Backspace' || !editable) return;
    const caret = input.selectionStart ?? 0;
    if (caret !== input.selectionEnd || caret === 0) return;
    if (/\d/.test(input.value[caret - 1] ?? '') && caret > PREFIX.length) return;
    // Минус семёрка маски: слева от каретки она есть всегда, а цифрой номера не является.
    const n = digitsBeforeCaret(input.value, caret) - 1;
    e.preventDefault();
    if (n <= 0) return;
    commit(digits!.slice(0, n - 1) + digits!.slice(n), n - 1, input);
  };

  return (
    <Input
      id={id}
      value={display}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        setFocused(false);
        // Проверка поля висит на уходе из него — этот вызов её и запускает.
        onBlur?.(e);
      }}
      placeholder={PHONE_PLACEHOLDER}
      inputMode="tel"
      autoComplete="tel"
      size={size}
      disabled={disabled}
      autoFocus={autoFocus}
      // Маска сама держит длину номера; ограничение нужно старым записям, которые правят прямо
      // в поле, — они в базе не длиннее пятидесяти символов.
      maxLength={50}
    />
  );
}
