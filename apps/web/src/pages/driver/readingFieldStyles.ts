import type { FocusEvent } from 'react';

/**
 * Styles and focus behaviour shared by the fields of a reading block: the number fields
 * ([DriverReadingFields](DriverReadingFields.tsx)), the time fields
 * ([DriverTimeField](DriverTimeField.tsx)) and the comment. A module of their own so that the time
 * field and the number fields read one source without importing each other.
 */

/**
 * Подсказка под полем и текст отказа (план типографики, Р4). `0.9em`, а не прежние `0.85`: строку
 * «предыдущее: 145 320 (10.08)» водитель СВЕРЯЕТ с набранным, стоя у машины, — она мельче
 * набранного намеренно, но читаться обязана без прищура.
 */
export const hintStyle = { fontSize: '0.9em' } as const;

/**
 * Подпись поля — заголовок поля, а не примечание к нему: базовым размером кабинета и обычным
 * цветом (Р4). Серым и мельче основного текста, как было, она читалась как сноска к чужому полю —
 * а это единственное, что называет вводимое число.
 */
export const fieldLabelStyle = { display: 'inline-block', marginBottom: 2 } as const;

/**
 * Экранная клавиатура перекрывает поле, к которому её и вызвали. Браузер прокручивает к нему сам
 * не всегда и не сразу, поэтому доводим сами — с задержкой, за которую клавиатура успевает
 * появиться и сжать окно.
 */
export function keepVisible(event: FocusEvent<HTMLElement>): void {
  const target = event.currentTarget;
  setTimeout(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
}
