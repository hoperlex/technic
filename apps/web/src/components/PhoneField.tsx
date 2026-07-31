import type { ReactNode } from 'react';
import { Form, Input, Typography } from 'antd';
import { contactIssue } from '@technic/contracts';

interface Props {
  /** Имя поля в форме; по умолчанию `phone`. */
  name?: string;
  label?: string;
  /** Крупные поля формы регистрации; в модалках справочника — обычный размер. */
  size?: 'large' | 'middle';
  extra?: ReactNode;
  disabled?: boolean;
}

/**
 * Необязательный контактный телефон (ADR 0043) — учётка, водитель, любая карточка, где номер
 * оставляют по желанию. Не маскуется намеренно, как и телефон ответственного по заявке: номер
 * переносят из переписки — с добавочным, городской, — и маска заставляла бы его переделывать.
 *
 * Правило проверки берётся из контрактов, а не пишется копией: пустое поле годится, а «нет» или
 * «—» — нет, потому что выглядит заполненным.
 */
export function PhoneField({ name = 'phone', label = 'Телефон', size, extra, disabled }: Props) {
  return (
    <Form.Item
      name={name}
      label={label}
      extra={extra}
      rules={[
        () => ({
          validator: (_: unknown, value: unknown) => {
            const issue = contactIssue(typeof value === 'string' ? value : '', 'optionalPhone');
            return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
          },
        }),
      ]}
    >
      <Input
        size={size}
        placeholder="+7 900 000-00-00"
        inputMode="tel"
        autoComplete="tel"
        disabled={disabled}
        maxLength={50}
      />
    </Form.Item>
  );
}

/**
 * Номер ссылкой `tel:`: портал открывают с телефона (ADR 0030), и звонок — самое частое, что
 * после этого делают, поэтому номер нажимается, а не перепечатывается.
 */
export function PhoneLink({ phone }: { phone: string }) {
  return <Typography.Link href={`tel:${phone.replace(/[^+\d]/g, '')}`}>{phone}</Typography.Link>;
}
