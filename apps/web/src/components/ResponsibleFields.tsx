import { Col, Form, Input, Row, Space, Typography } from 'antd';
import { contactIssue } from '@technic/contracts';
import { PhoneLink } from './PhoneField';
import { PhoneInput } from './PhoneInput';

/**
 * Имя поля формы: строка либо путь. Путь нужен спискам — контакты ездок лежат в
 * `trips.3.fromResponsibleName` (план `docs/route-trips-plan.md`, §4.1), и адресовать их одной
 * строкой нечем.
 */
type FieldName = string | (string | number)[];

interface Props {
  /** Имя поля ФИО в форме; телефон лежит в `phoneName`. */
  nameField: FieldName;
  phoneField: FieldName;
  nameLabel: string;
  phoneLabel: string;
  disabled?: boolean;
  /**
   * Прежние значения, которые правку **не блокируют**, пока их не меняют (Р2а плана
   * `docs/route-trips-plan.md`).
   *
   * Зачем понадобилось послабление. Контакт обязателен, и правило поля это держит — но в базе
   * лежит то, что жёсткая модель сегодня уже не пропустила бы: пустой контакт у записей старше
   * миграции `0062` и номер, не сводимый к десяти цифрам, у записей старше ADR 0066 п. 7. Правится
   * такая запись **полным** составом (у списка нет понятия «поле не прислали»), и без послабления
   * заявку, которую вчера спокойно редактировали, завтра нельзя было бы сохранить, пока кто-нибудь
   * не выдумает за прошлое ответственного. Ровно это принимает и сервер
   * (`storedContactNameSchema`, `storedContactPhoneSchema`), а требование верификации возвращает
   * на **изменившееся** значение.
   *
   * Поэтому послабление узкое: пропускается только значение, **совпадающее** с сохранённым.
   * Тронули поле — правило вернулось целиком. Не задано (`undefined`) — контакт заводится заново,
   * и послаблять нечего: так работают все прочие места, где стоит этот компонент.
   */
  kept?: { name: string; phone: string };
}

/**
 * Те же правила, что у сервера: проверяет функция из контрактов, а не копия схемы на фронте.
 *
 * `kept` — прежнее значение поля; совпадающее с ним принимается как есть (Р2а). Сравнение строгое
 * и по строке: нормализация телефона (ADR 0066) значения не меняет, пока его не трогали, — поле
 * отдаёт форме ровно то, что в него положили.
 */
function rule(kind: 'name' | 'phone', kept?: string) {
  return () => ({
    validator: (_: unknown, value: unknown) => {
      const text = typeof value === 'string' ? value : '';
      const issue = contactIssue(text, kind);
      if (!issue) return Promise.resolve();
      if (kept !== undefined && text === kept) return Promise.resolve();
      return Promise.reject(new Error(issue));
    },
  });
}

/**
 * Ответственный по заявке и его телефон — парой полей. Компонент общий для всех трёх мест, где
 * контакт заводят (техника на объект, погрузка и разгрузка грузоперевозки, вывоз мусора):
 * подписи там разные, а правила ввода обязаны совпадать.
 *
 * Телефон — под общей маской «+7 (900) 000 00 00» (ADR 0066): номер по нему набирают с площадки,
 * и вид у него тот же, что в справочниках и в путевом листе.
 */
export function ResponsibleFields({
  nameField,
  phoneField,
  nameLabel,
  phoneLabel,
  disabled,
  kept,
}: Props) {
  return (
    // На десктопе ФИО и телефон встают в строку, на телефоне Row переносит их сам (ADR 0030).
    <Row gutter={12}>
      <Col xs={24} sm={14}>
        {/* Звёздочка остаётся и при послаблении: контакт обязателен по существу — без него рейс
            заканчивается простоем у закрытых ворот, — а `kept` лишь не заставляет вписывать его
            задним числом в чужую старую запись. */}
        <Form.Item name={nameField} label={nameLabel} required rules={[rule('name', kept?.name)]}>
          <Input placeholder="Фамилия и имя" disabled={disabled} maxLength={200} />
        </Form.Item>
      </Col>
      <Col xs={24} sm={10}>
        {/* Проверка по уходу из поля: под маской недобранный номер невалиден, и проверка по
            вводу держала бы поле красным весь набор. */}
        <Form.Item
          name={phoneField}
          label={phoneLabel}
          required
          validateTrigger="onBlur"
          rules={[rule('phone', kept?.phone)]}
        >
          <PhoneInput disabled={disabled} />
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
