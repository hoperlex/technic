import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { PhoneInput } from '../src/components/PhoneInput';

/**
 * Маска телефона (ADR 0066). Проверяется ровно то, ради чего её заводили: человек набирает номер
 * привычно — с восьмёрки, с «+7», со скобками или без, — а форма получает одни и те же десять
 * цифр, которые и лежат в базе. Вид на экране при этом один: «+7 (900) 000 00 00».
 */

/** Поле со своим состоянием — как его держит `Form.Item`: значение внутрь, цифры наружу. */
function Field({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PhoneInput value={value} onChange={setValue} />
      {/* Что уехало бы в API: значение формы, а не то, что видно в поле. */}
      <output>{value}</output>
    </>
  );
}

const field = () => screen.getByRole('textbox') as HTMLInputElement;
const formValue = () => screen.getByText((_, el) => el?.tagName === 'OUTPUT')?.textContent ?? '';

/** Ввод: то же, что делает браузер, — в поле оказывается новая строка целиком. */
function type(text: string) {
  fireEvent.change(field(), { target: { value: text } });
}

describe('маска телефона', () => {
  it('код страны подставляется сам, а набранная восьмёрка съедается', () => {
    render(<Field />);
    // Человек начинает с «8» по привычке: цифра уходит, а на её месте встаёт «+7 (».
    type('8');
    expect(formValue()).toBe('');
    type('+7 (9');
    expect(formValue()).toBe('9');
    expect(field().value).toBe('+7 (9');
  });

  it('номер целиком принимается в любом написании', () => {
    for (const entered of ['89261234567', '+7 926 123-45-67', '9261234567', '7 (926) 1234567']) {
      const { unmount } = render(<Field />);
      type(entered);
      expect(formValue()).toBe('9261234567');
      expect(field().value).toBe('+7 (926) 123 45 67');
      unmount();
    }
  });

  it('лишние цифры за десятой не набираются', () => {
    render(<Field />);
    type('92612345678888');
    expect(formValue()).toBe('9261234567');
  });

  it('буквы в поле не попадают вовсе', () => {
    render(<Field />);
    type('нет');
    expect(formValue()).toBe('');
  });

  it('Backspace на разделителе стирает цифру, а не скобку', () => {
    // Иначе поле выглядело бы залипшим: маска возвращала бы скобку на место, и нажатие ничего
    // не меняло бы.
    render(<Field initial="9261234567" />);
    const input = field();
    expect(input.value).toBe('+7 (926) 123 45 67');
    input.setSelectionRange(8, 8); // сразу за «)» в «+7 (926)»
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(formValue()).toBe('921234567');
  });

  it('номер старой записи показывается как есть, а не прячется за маской', () => {
    // Записи, не сводившиеся к десяти цифрам, миграция 0095 не трогала: человеку видно, что
    // записано, и по этому номеру всё ещё звонят.
    render(<Field initial="8(495)123-45-67 доб. 12" />);
    expect(field().value).toBe('8(495)123-45-67 доб. 12');
  });
});
