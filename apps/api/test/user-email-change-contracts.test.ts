import { describe, expect, it } from 'vitest';
import { changeUserEmailSchema } from '@technic/contracts';
// Маскирование живёт на сервере, а не в контрактах: его знает только письмо, и второй копии у
// портала нет — показывать маскированный адрес ему негде.
import { maskEmail } from '../src/services/mail-templates';

/**
 * Контракт смены адреса учётной записи (ADR 0092): что портал вправе прислать и что уходит в
 * письмо на прежний ящик.
 *
 * Схема здесь узкая намеренно (`strict`): в теле только новый адрес и — для своей учётки — пароль.
 * Всё остальное о смене решает сервер, и лишнее поле в теле означало бы, что клиент рассчитывает
 * на правило, которого нет.
 */

const NEW_EMAIL = 'i.ivanov@su10.ru';

describe('схема смены адреса', () => {
  it('принимает адрес и обрезает пробелы по краям', () => {
    // Адрес копируют из письма или из таблицы — с хвостовым пробелом; отказывать по нему значит
    // придираться к тому, что портал умеет поправить сам.
    expect(changeUserEmailSchema.parse({ newEmail: `  ${NEW_EMAIL} ` })).toEqual({
      newEmail: NEW_EMAIL,
    });
  });

  it('принимает пароль подтверждения — он нужен своей учётке', () => {
    expect(
      changeUserEmailSchema.parse({ newEmail: NEW_EMAIL, currentPassword: 'secret-123' }),
    ).toEqual({ newEmail: NEW_EMAIL, currentPassword: 'secret-123' });
  });

  it('отвергает негодный адрес и пустое поле', () => {
    expect(changeUserEmailSchema.safeParse({ newEmail: 'не адрес' }).success).toBe(false);
    expect(changeUserEmailSchema.safeParse({ newEmail: '' }).success).toBe(false);
    expect(changeUserEmailSchema.safeParse({}).success).toBe(false);
  });

  it('отвергает пустой пароль: «поле прислали, но не заполнили» — это не подтверждение', () => {
    expect(
      changeUserEmailSchema.safeParse({ newEmail: NEW_EMAIL, currentPassword: '' }).success,
    ).toBe(false);
  });

  it('отвергает лишние поля — решение о письмах и подтверждённости принимает сервер', () => {
    // Ни «не отправлять письма», ни «считать адрес подтверждённым» клиент не заказывает: письма
    // здесь правило, а не просьба, и снять их галочкой нельзя.
    expect(
      changeUserEmailSchema.safeParse({ newEmail: NEW_EMAIL, notifyUser: false }).success,
    ).toBe(false);
    expect(
      changeUserEmailSchema.safeParse({ newEmail: NEW_EMAIL, emailVerified: true }).success,
    ).toBe(false);
  });
});

describe('маскирование адреса в письме на прежний ящик', () => {
  it('оставляет первую букву и домен целиком', () => {
    expect(maskEmail('i.ivanov@su10.ru')).toBe('i***@su10.ru');
    expect(maskEmail('a@su10.ru')).toBe('a***@su10.ru');
  });

  it('не выдаёт локальную часть нового адреса', () => {
    // Письмо уходит на ящик, который учётке уже чужой: полный новый адрес подсказал бы тому, кто
    // затеял смену не будучи владельцем, куда именно увели вход.
    const masked = maskEmail('ivanov.director@su10.ru');
    expect(masked).not.toContain('ivanov.director');
    expect(masked).toBe('i***@su10.ru');
  });

  it('строку без «собаки» не превращает в адрес', () => {
    expect(maskEmail('без адреса')).toBe('***');
  });
});
