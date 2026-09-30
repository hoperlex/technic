import { describe, expect, it } from 'vitest';
import { grantErrorMessage } from '@entities/grant';
import { mailingErrorMessage } from '@entities/mailing';
import { moduleMailErrorMessage } from '@entities/module-mail';
import { userAccountErrorMessage } from '@entities/user-account';

const validationFailure = (fields: Record<string, string>): unknown => ({
  code: 'validation_error',
  message: 'Ошибка валидации данных',
  fields,
  status: 400,
});

describe('admin domain error labels', () => {
  it('подписывает поля учётной записи', () => {
    expect(
      userAccountErrorMessage(
        validationFailure({ newEmail: 'Занят', grants: 'Неверный состав' }),
      ),
    ).toBe('Ошибка валидации данных: Новый email, Полномочия');
  });

  it('подписывает поля полномочия', () => {
    expect(grantErrorMessage(validationFailure({ code: 'Занят', permissions: 'Пусто' }))).toBe(
      'Ошибка валидации данных: Код, Права',
    );
  });

  it('подписывает поля служебной почты', () => {
    expect(
      moduleMailErrorMessage(validationFailure({ toEmail: 'Неверный', comment: 'Длинный' })),
    ).toBe('Ошибка валидации данных: Адрес службы, Комментарий');
  });

  it('подписывает поля расписания', () => {
    expect(
      mailingErrorMessage(validationFailure({ name: 'Пусто', runWeekdays: 'Пусто' })),
    ).toBe('Ошибка валидации данных: Название, Дни выполнения');
  });
});
