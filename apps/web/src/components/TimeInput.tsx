import { useEffect, useState } from 'react';
import { Input } from 'antd';
import {
  TIME_PATTERN,
  TIME_FORMAT_MESSAGE,
  WORK_TIME_MESSAGE,
  isWithinWorkTime,
  normalizeTimeInput,
} from '@technic/contracts';
import type { Rule } from 'antd/es/form';

interface TimeInputProps {
  /** Значение в каноническом виде `HH:mm`; пустая строка/undefined — время не задано. */
  value?: string;
  onChange?: (value: string | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Ручной ввод времени: только цифры, 24 часа, без выпадающего списка (в отличие от antd
 * TimePicker — диспетчеру быстрее набрать «730», чем выбирать в двух колонках).
 *
 * Приведение к `HH:mm` происходит на потере фокуса, а не по каждой клавише: пока пользователь
 * печатает, «730» ещё может стать «7300», и ранняя нормализация ломала бы набор. Незаполненные
 * знаки добиваются нулями — см. `normalizeTimeInput` в контрактах (там же тесты).
 */
export function TimeInput({ value, onChange, placeholder = 'чч:мм', disabled }: TimeInputProps) {
  const [text, setText] = useState(value ?? '');

  // Внешние изменения (сброс формы, загрузка заявки в редактирование) перебивают локальный текст.
  useEffect(() => setText(value ?? ''), [value]);

  const handleChange = (raw: string) => {
    // Значимы только цифры и разделитель; остальное молча отбрасывается.
    const cleaned = raw.replace(/[^\d:]/g, '').slice(0, 5);
    setText(cleaned);
    onChange?.(cleaned || undefined);
  };

  const handleBlur = () => {
    const normalized = normalizeTimeInput(text);
    // Нераспознанный ввод оставляем как есть — ошибку покажет правило формы.
    if (normalized === undefined) {
      if (!text.trim()) onChange?.(undefined);
      return;
    }
    setText(normalized);
    onChange?.(normalized);
  };

  return (
    <Input
      value={text}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={handleBlur}
      onPressEnter={handleBlur}
      placeholder={placeholder}
      disabled={disabled}
      allowClear
      maxLength={5}
      inputMode="numeric"
      style={{ width: '100%' }}
    />
  );
}

/**
 * Правило формы для необязательного времени: пустое значение допустимо, заполненное обязано быть
 * корректным `HH:mm` и попадать в рабочее окно. Нормализация к этому моменту уже прошла (blur),
 * поэтому «7» здесь не встречается — но если поле отправили без потери фокуса, правило доберёт
 * тот же разбор.
 */
export const optionalWorkTimeRule: Rule = () => ({
  validator(_rule, value: string | undefined) {
    const raw = (value ?? '').trim();
    if (!raw) return Promise.resolve();
    const normalized = TIME_PATTERN.test(raw) ? raw : normalizeTimeInput(raw);
    if (!normalized) return Promise.reject(new Error(TIME_FORMAT_MESSAGE));
    if (!isWithinWorkTime(normalized)) return Promise.reject(new Error(WORK_TIME_MESSAGE));
    return Promise.resolve();
  },
});
