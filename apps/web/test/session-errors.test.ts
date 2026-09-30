import { describe, expect, it } from 'vitest';
import { sessionErrorMessage } from '@entities/session';

const validationFailure = (fields: Record<string, string>): unknown => ({
  code: 'validation_error',
  message: 'Ошибка валидации данных',
  fields,
  status: 400,
});

describe('sessionErrorMessage', () => {
  it('подписывает поля входа, пароля и регистрации', () => {
    expect(
      sessionErrorMessage(
        validationFailure({
          email: 'Некорректный адрес',
          currentPassword: 'Неверный пароль',
          requestedObject: 'Обязательное поле',
          captchaToken: 'Проверка не пройдена',
        }),
      ),
    ).toBe('Ошибка валидации данных: Email, Текущий пароль, Подразделение, Проверка');
  });

  it('сохраняет общий текст ошибки без полей', () => {
    expect(sessionErrorMessage(new Error('Сеть недоступна'))).toBe('Сеть недоступна');
  });
});
