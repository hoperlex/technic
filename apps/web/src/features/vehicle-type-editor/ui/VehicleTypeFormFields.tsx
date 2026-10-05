import { Checkbox, Form, Input, InputNumber, Switch, Typography, type FormInstance } from 'antd';
import {
  FREIGHT_VEHICLE_KIND_CODE,
  LINEAR_VEHICLE_TYPE_HINT,
  LINEAR_VEHICLE_TYPE_LABEL,
  MAINTENANCE_BASIS_HINT,
  MAINTENANCE_BASIS_LABEL,
  type VehicleTypeDto,
} from '@technic/contracts';
import { AutoSelect } from '@shared/ui';

/**
 * Vehicle type fields are shared by create and edit flows and stay outside the registry
 * presentation (ADR 0005).
 * The form only asks and explains type attributes. The controller owns their commands, including
 * the separate confirmation protocol for switching linear order mode.
 */

export interface VtFormValues {
  kindId?: string;
  code?: string;
  name?: string;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
  /** Passenger transport selects form No. 3 instead of 4-P (ADR 0065). */
  isPassenger?: boolean;
  /** Linear equipment orders are managed by work days rather than standing weeks. */
  isLinear?: boolean;
  /**
   * The checkbox maps to a maintenance basis through contract helpers, so another basis does not
   * turn into a second UI-owned domain mapping.
   */
  maintenanceByOdometer?: boolean;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

interface Props {
  form: FormInstance<VtFormValues>;
  /** Edit receives an immutable type identity; create still asks for kind and code. */
  record: VehicleTypeDto | null;
  kinds: { id: string; code: string; name: string }[];
  kindsLoading: boolean;
}

export function VehicleTypeFormFields({ form, record, kinds, kindsLoading }: Props) {
  const isEdit = !!record;
  const kindOptions = kinds.map((k) => ({ value: k.id, label: k.name }));

  /** Kind decides whether a trip-form question is meaningful; kind itself is immutable on edit. */
  const watchKindId = Form.useWatch('kindId', form);
  const formKindCode = isEdit ? record.kindCode : kinds.find((k) => k.id === watchKindId)?.code;
  // The explanatory copy must follow the same linear-mode value that drives document behavior.
  const watchIsLinear = Form.useWatch('isLinear', form);

  const codeRules = isEdit
    ? []
    : [
        { required: true, message: 'Укажите код' },
        {
          pattern: CODE_PATTERN,
          message: 'Только строчные латинские, цифры и _, первый символ — буква',
        },
      ];

  return (
    <>
      {isEdit ? (
        <Form.Item label="Вид">
          <Input value={record.kindName} disabled />
        </Form.Item>
      ) : (
        <Form.Item name="kindId" label="Вид" rules={[{ required: true, message: 'Выберите вид' }]}>
          <AutoSelect options={kindOptions} loading={kindsLoading} placeholder="Выберите вид" />
        </Form.Item>
      )}

      <Form.Item name="code" label="Код" rules={codeRules}>
        {/* Code is a stable system identifier and cannot change after creation. */}
        <Input disabled={isEdit} placeholder="например truck_cranes" />
      </Form.Item>

      <Form.Item
        name="name"
        label="Наименование типа"
        rules={[{ required: true, message: 'Укажите наименование' }]}
      >
        <Input />
      </Form.Item>

      <Form.Item name="description" label="Описание">
        <Input.TextArea rows={2} />
      </Form.Item>

      <Form.Item name="sortOrder" label="Порядок сортировки">
        <InputNumber style={{ width: '100%' }} min={0} />
      </Form.Item>

      <Form.Item name="isActive" label="Активен" valuePropName="checked">
        <Switch />
      </Form.Item>

      {/* Ask in fleet language instead of exposing a form-code dictionary. Special equipment has
          no choice here: weekly ESM-2 comes from the request and trip documents use 4-P. */}
      {formKindCode === FREIGHT_VEHICLE_KIND_CODE && (
        <Form.Item
          name="isPassenger"
          valuePropName="checked"
          extra="Путевой лист выписывается по форме № 3 (легковой автомобиль) вместо 4-П"
        >
          <Checkbox>Легковой транспорт</Checkbox>
        </Form.Item>
      )}
      {!!formKindCode && formKindCode !== FREIGHT_VEHICLE_KIND_CODE && (
        <Form.Item label="Путевой лист">
          {/* Linear equipment has no portal-created ESM-2 or relocation trip, so the explanation
              must not promise either while still stating that the type owns no form code. */}
          <Typography.Text type="secondary">
            {watchIsLinear
              ? 'ЭСМ-2 по заявке на технику выписывается по требованию, а день работ на объекте печатается по 4-П.'
              : 'ЭСМ-2 портал выписывает сам по заявке на технику, а перегон на объект — по 4-П.'}{' '}
            Бланк такому типу не задаётся.
          </Typography.Text>
        </Form.Item>
      )}

      {/* Linear mode describes order accounting, not a document blank, so every kind can use it.
          Label and hint come from contracts to match the directory export. */}
      <Form.Item name="isLinear" valuePropName="checked" extra={LINEAR_VEHICLE_TYPE_HINT}>
        <Checkbox>{LINEAR_VEHICLE_TYPE_LABEL}</Checkbox>
      </Form.Item>

      {/* The maintenance hint names the unchecked consequence because “not tracked” is a valid
          directory default, not a broken empty value in the garage. */}
      <Form.Item
        name="maintenanceByOdometer"
        valuePropName="checked"
        extra={MAINTENANCE_BASIS_HINT}
      >
        <Checkbox>{MAINTENANCE_BASIS_LABEL}</Checkbox>
      </Form.Item>
    </>
  );
}
