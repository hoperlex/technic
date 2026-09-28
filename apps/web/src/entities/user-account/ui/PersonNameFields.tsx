import { Col, Form, Input, Row } from 'antd';
import { namePartIssue, normalizeNamePart } from '@technic/contracts';

interface Props {
  /** Крупные поля формы регистрации; в модалках справочника — обычный размер. */
  size?: 'large' | 'middle';
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * Фамилия, имя и отчество тремя полями (ADR 0034). Одно поле «ФИО» давало разнобой — «Иванов
 * И.И.», «иван иванов», — по которому нельзя ни отсортировать по фамилии, ни сверить учётку с
 * физлицом. Компонент общий для регистрации и карточки пользователя: правила ввода в них
 * обязаны совпадать.
 */
export function PersonNameFields({ size = 'middle', disabled, autoFocus }: Props) {
  const form = Form.useFormInstance();

  /**
   * Схлопывание пробелов по уходу с поля, а не на каждое нажатие: normalize срезал бы пробел
   * сразу после ввода, и «ван дер Берг» набрать было бы нельзя.
   */
  const normalizeOnBlur = (name: string) => () => {
    const value: unknown = form.getFieldValue(name);
    if (typeof value !== 'string') return;
    const normalized = normalizeNamePart(value);
    if (normalized !== value) form.setFieldValue(name, normalized);
  };

  /** Те же правила, что у сервера: проверяет функция из контрактов, а не копия регулярки. */
  const rule = (required: boolean) => () => ({
    validator: (_: unknown, value: unknown) => {
      const issue = namePartIssue(
        normalizeNamePart(typeof value === 'string' ? value : ''),
        required,
      );
      return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
    },
  });

  return (
    <>
      <Form.Item name="lastName" label="Фамилия" required rules={[rule(true)]}>
        <Input
          size={size}
          autoComplete="family-name"
          disabled={disabled}
          autoFocus={autoFocus}
          onBlur={normalizeOnBlur('lastName')}
        />
      </Form.Item>
      {/* На десктопе имя и отчество встают в строку, на телефоне Row переносит их сам. */}
      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item name="firstName" label="Имя" required rules={[rule(true)]}>
            <Input
              size={size}
              autoComplete="given-name"
              disabled={disabled}
              onBlur={normalizeOnBlur('firstName')}
            />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item name="middleName" label="Отчество" extra="Если есть" rules={[rule(false)]}>
            <Input
              size={size}
              autoComplete="additional-name"
              disabled={disabled}
              onBlur={normalizeOnBlur('middleName')}
            />
          </Form.Item>
        </Col>
      </Row>
    </>
  );
}
