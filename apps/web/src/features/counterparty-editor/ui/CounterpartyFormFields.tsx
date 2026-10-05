import { Form, Input, Select, Switch } from 'antd';
import type { FormInstance } from 'antd';
import {
  type CounterpartyType,
  type CreateCounterpartyInput,
  type UpdateCounterpartyInput,
  EMAIL_FORMAT_MESSAGE,
  INN_CHECKSUM_MESSAGE,
  INN_MESSAGE,
  isValidInn,
  normalizeEmail,
  optionalEmailSchema,
} from '@technic/contracts';
import { counterpartyTypeOptions } from '@entities/counterparty';
import { AutoSelect } from '@shared/ui';

/**
 * Counterparty card fields live apart from the registry. This is a behavior boundary, not a
 * cosmetic split: the registry grows with filters, columns and archive actions, while this form
 * changes with card fields and validation. The split first became necessary when the request-email
 * field from ADR 0153 pushed the old page beyond its quality budget.
 */
export interface CounterpartyFormValues {
  type: CounterpartyType;
  name: string;
  inn: string;
  synonyms?: string[];
  /** Served construction sites belong only to waste operators (ADR 0010). */
  objectIds?: string[];
  /** Shared organization mailbox used for service-company notifications (ADR 0153). */
  email?: string;
  comment?: string;
  isActive: boolean;
}

/**
 * Build API input beside the fields it depends on. Email is visible only for a service company,
 * so the “send what is shown” rule must change with the visibility rule rather than in a registry.
 *
 * Email is sent only for a service company, for both create and update. A hidden field is not
 * validated below, and sending its stale value would turn a silent form trap into an API 400 for a
 * field the person cannot see.
 *
 * Create and update express “there is no address here” differently for a material reason:
 *
 * - PATCH omits the field, meaning “preserve the mailbox”; the address survives a type change as
 *   ADR 0153 promises and is cleared only while the service field is visible.
 * - POST sends an empty string because it needs a complete body and there is no prior card to keep.
 *
 * The old create path trusted the current form value. A person could enter an address as a service
 * company, switch type, hide validation and still submit that stale address, which the API rejected.
 */
export function counterpartyCreatePayload(values: CounterpartyFormValues): CreateCounterpartyInput {
  return { ...counterpartyFields(values), email: serviceEmailOf(values) };
}

export function counterpartyUpdatePayload(values: CounterpartyFormValues): UpdateCounterpartyInput {
  const fields = counterpartyFields(values);
  return values.type === 'service' ? { ...fields, email: serviceEmailOf(values) } : fields;
}

/** Return an address only for the type that owns it, regardless of stale form state. */
function serviceEmailOf(values: CounterpartyFormValues): string {
  return values.type === 'service' ? (values.email ?? '') : '';
}

function counterpartyFields(values: CounterpartyFormValues) {
  return {
    type: values.type,
    name: values.name,
    inn: values.inn,
    synonyms: values.synonyms ?? [],
    // Other types have no site field; the API accepts an empty list and rejects a populated one.
    objectIds: values.type === 'operator' ? (values.objectIds ?? []) : [],
    comment: values.comment ?? '',
    isActive: values.isActive,
  };
}

export function CounterpartyFormFields({
  form,
  objectOptions,
  onFinish,
}: {
  form: FormInstance<CounterpartyFormValues>;
  /** Construction-site options for the waste-operator-only field. */
  objectOptions: { value: string; label: string }[];
  onFinish: (values: CounterpartyFormValues) => void;
}) {
  // Fields follow the selected type: sites belong to operators, mailboxes to service companies.
  const watchType = Form.useWatch('type', form);

  return (
    <Form form={form} layout="vertical" onFinish={onFinish}>
      <Form.Item name="type" label="Тип" rules={[{ required: true, message: 'Выберите тип' }]}>
        <AutoSelect options={counterpartyTypeOptions} />
      </Form.Item>
      <Form.Item
        name="name"
        label="Наименование"
        tooltip="Как называем контрагента мы; варианты из документов вносятся в синонимы"
        rules={[{ required: true, message: 'Укажите наименование' }]}
      >
        <Input maxLength={255} />
      </Form.Item>
      <Form.Item
        name="inn"
        label="ИНН"
        rules={[
          { required: true, message: INN_MESSAGE },
          {
            validator: (_rule, v: string | undefined) => {
              if (!v) return Promise.resolve();
              if (!/^(\d{10}|\d{12})$/.test(v.trim())) {
                return Promise.reject(new Error(INN_MESSAGE));
              }
              // The checksum catches a one-digit typo that the length-only format cannot see.
              return isValidInn(v.trim())
                ? Promise.resolve()
                : Promise.reject(new Error(INN_CHECKSUM_MESSAGE));
            },
          },
        ]}
      >
        <Input maxLength={12} placeholder="10 или 12 цифр" />
      </Form.Item>
      <Form.Item
        name="synonyms"
        label="Синонимы наименования"
        tooltip="Как контрагента пишут в накладных и выгрузках. Enter — добавить вариант"
        extra="Один и тот же синоним не может принадлежать двум контрагентам"
      >
        <Select
          mode="tags"
          tokenSeparators={[';']}
          open={false}
          suffixIcon={null}
          placeholder="ООО «Ромашка», Ромашка ООО…"
        />
      </Form.Item>
      {watchType === 'operator' && (
        <Form.Item
          name="objectIds"
          label="Обслуживаемые объекты"
          tooltip="Объекты, с которых оператор вывозит мусор; из них подставляется исполнитель заявки"
          extra="Пусто — оператор доступен только на объектах, где операторы не заданы"
        >
          <Select
            mode="multiple"
            options={objectOptions}
            showSearch
            optionFilterProp="label"
            placeholder="Не ограничивать"
          />
        </Form.Item>
      )}
      <Form.Item
        name="email"
        label="Email для заявок"
        hidden={watchType !== 'service'}
        normalize={normalizeEmail}
        validateTrigger="onBlur"
        /**
         * Validate only while the field is shown. Ant Form's `hidden` is visual, not removal from
         * validation; checking an old malformed address would lock a non-service card behind an
         * invisible error. The value itself remains because the organization's mailbox survives a
         * temporary type change, which is why this uses `hidden` rather than conditional mounting.
         *
         * Read the type from the form store, not nearby `useWatch`. The watch value arrives through
         * a render and is initially undefined, so a quick submit could otherwise skip validation.
         */
        rules={[
          ({ getFieldValue }) => ({
            validator: (_: unknown, value: unknown) =>
              getFieldValue('type') !== 'service' ||
              optionalEmailSchema.safeParse(typeof value === 'string' ? value : '').success
                ? Promise.resolve()
                : Promise.reject(new Error(EMAIL_FORMAT_MESSAGE)),
          }),
        ]}
        tooltip="Общий ящик компании: сюда портал пишет о назначенных ей заявках на обслуживание оргтехники"
        extra="Пусто — письма получат только учётки этой компании в портале, а если их нет, то никто"
      >
        <Input type="email" maxLength={255} placeholder="service@example.ru" autoComplete="off" />
      </Form.Item>
      <Form.Item name="comment" label="Комментарий">
        <Input.TextArea rows={2} maxLength={2000} showCount />
      </Form.Item>
      <Form.Item
        name="isActive"
        label="Активен"
        valuePropName="checked"
        // An inactive lessor cannot own active offers (ADR 0018 §15): deactivation switches every
        // offer off, while reactivation restores only those not independently disabled.
        extra={
          watchType === 'vehicle_lessor'
            ? 'Деактивация выключит всю технику этого арендодателя, активация — вернёт ровно её (позиции, выключенные вручную, останутся выключенными)'
            : undefined
        }
      >
        <Switch />
      </Form.Item>
    </Form>
  );
}
