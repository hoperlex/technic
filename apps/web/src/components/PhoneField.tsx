import type { ReactNode } from 'react';
import { Form, Typography } from 'antd';
import { contactIssue, formatPhone, normalizePhone } from '@technic/contracts';
import { PhoneInput } from './PhoneInput';

interface Props {
  /** Имя поля в форме; по умолчанию `phone`. */
  name?: string;
  label?: string;
  /** Крупные поля формы регистрации; в модалках справочника — обычный размер. */
  size?: 'large' | 'middle';
  extra?: ReactNode;
  disabled?: boolean;
  /** Номер обязателен: форма регистрации (ADR 0066). По умолчанию поле можно оставить пустым. */
  required?: boolean;
}

/**
 * Контактный телефон — учётка, водитель, склад, любая карточка с номером. Ввод под маской
 * «+7 (900) 000 00 00» (ADR 0066): код страны поле подставляет само, а «8» и «+7», набранные по
 * привычке, съедает.
 *
 * Правило проверки берётся из контрактов, а не пишется копией: разница обязательного и
 * необязательного поля ровно одна — пустая строка. И там, и там «нет» или «—» вместо номера не
 * годится: такое поле выглядит заполненным, и по нему звонят.
 */
export function PhoneField({
  name = 'phone',
  label = 'Телефон',
  size,
  extra,
  disabled,
  required,
}: Props) {
  return (
    <Form.Item
      name={name}
      label={label}
      extra={extra}
      required={required}
      // Проверка по уходу из поля, а не на каждую цифру: под маской любой недобранный номер
      // невалиден, и проверка по вводу подсвечивала бы поле красным всё время набора.
      validateTrigger="onBlur"
      rules={[
        () => ({
          validator: (_: unknown, value: unknown) => {
            const issue = contactIssue(
              typeof value === 'string' ? value : '',
              required ? 'phone' : 'optionalPhone',
            );
            return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
          },
        }),
      ]}
    >
      <PhoneInput size={size} disabled={disabled} />
    </Form.Item>
  );
}

/**
 * Номер ссылкой `tel:`: портал открывают с телефона (ADR 0030), и звонок — самое частое, что
 * после этого делают, поэтому номер нажимается, а не перепечатывается.
 *
 * Показывается общим видом «+7 (900) 000 00 00», набирается — с кодом страны: у хранимых десяти
 * цифр его нет, а телефон без него наберёт не всякая трубка. Номер записи, оставшейся от
 * свободного формата, идёт в ссылку как есть — очищенным от всего, кроме цифр и плюса.
 */
export function PhoneLink({ phone }: { phone: string }) {
  const local = normalizePhone(phone);
  const href = local === null ? `tel:${phone.replace(/[^+\d]/g, '')}` : `tel:+7${local}`;
  return <Typography.Link href={href}>{formatPhone(phone)}</Typography.Link>;
}
