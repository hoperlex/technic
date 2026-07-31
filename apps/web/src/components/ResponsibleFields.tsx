import { Col, Form, Input, Row, Space, Typography } from 'antd';
import { contactIssue } from '@technic/contracts';
import { PhoneLink } from './PhoneField';

interface Props {
  /** Имя поля ФИО в форме; телефон лежит в `phoneName`. */
  nameField: string;
  phoneField: string;
  nameLabel: string;
  phoneLabel: string;
  disabled?: boolean;
}

/** Те же правила, что у сервера: проверяет функция из контрактов, а не копия схемы на фронте. */
function rule(kind: 'name' | 'phone') {
  return () => ({
    validator: (_: unknown, value: unknown) => {
      const issue = contactIssue(typeof value === 'string' ? value : '', kind);
      return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
    },
  });
}

/**
 * Ответственный по заявке и его телефон — парой полей. Компонент общий для всех трёх мест, где
 * контакт заводят (техника на объект, погрузка и разгрузка грузоперевозки, вывоз мусора):
 * подписи там разные, а правила ввода обязаны совпадать.
 *
 * Телефон не маскуется намеренно: в заявку переносят номер из переписки — и с добавочным, и
 * городской, — а маска заставляла бы человека переделывать то, что он только что прочитал.
 */
export function ResponsibleFields({
  nameField,
  phoneField,
  nameLabel,
  phoneLabel,
  disabled,
}: Props) {
  return (
    // На десктопе ФИО и телефон встают в строку, на телефоне Row переносит их сам (ADR 0030).
    <Row gutter={12}>
      <Col xs={24} sm={14}>
        <Form.Item name={nameField} label={nameLabel} required rules={[rule('name')]}>
          <Input placeholder="Фамилия и имя" disabled={disabled} maxLength={200} />
        </Form.Item>
      </Col>
      <Col xs={24} sm={10}>
        <Form.Item name={phoneField} label={phoneLabel} required rules={[rule('phone')]}>
          <Input
            placeholder="+7 900 000-00-00"
            inputMode="tel"
            autoComplete="tel"
            disabled={disabled}
            maxLength={50}
          />
        </Form.Item>
      </Col>
    </Row>
  );
}

/**
 * Контакт в карточке заявки: ФИО и телефон ссылкой `tel:`. Пусто — заявка заведена до появления
 * контакта (миграция 0062).
 */
export function ResponsibleValue({ name, phone }: { name: string; phone: string }) {
  if (!name && !phone) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={8} wrap>
      <span>{name || '—'}</span>
      {!!phone && <PhoneLink phone={phone} />}
    </Space>
  );
}
