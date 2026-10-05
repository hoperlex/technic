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
 * presentation (ADR 0005). The type has more questions than the list has columns — waybill blank,
 * linear mode, maintenance marking — each with its own explanation.
 *
 * The form only asks and explains type attributes. The controller owns their commands, including
 * the separate confirmation protocol for switching linear order mode (ADR 0107).
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
   * Whether maintenance is tracked by odometer (R13). A checkbox in the form, a calculation basis
   * in the model: maintenanceBasisOf / isOdometerMaintenance translate it, so a third basis (engine
   * hours) becomes an edit of the contract mapping, not a second UI-owned domain mapping.
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

  /**
   * The form's vehicle kind: on edit the type's own (kind is immutable), on create the selected
   * one. It decides whether to ask about passenger transport: a blank exists only where the
   * vehicle runs trips.
   */
  const watchKindId = Form.useWatch('kindId', form);
  const formKindCode = isEdit ? record.kindCode : kinds.find((k) => k.id === watchKindId)?.code;
  // Watched because it changes the truth about the type's waybills: ESM-2 is not issued
  // automatically for a linear type, and the hint must say what the portal will actually do.
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

      {/* The blank is asked as «is this passenger transport», not as a form choice: that is how
          the directory keeper sets it and how the fleet speaks. The default is 4-П: an own
          vehicle always has a waybill (ADR 0065).

          Special equipment has no such field: its weekly ESM-2 is not set by the type's blank (it
          comes from the request), and everything printed per trip — relocation to the site and a
          linear equipment day — goes on 4-П regardless of the type. There is nothing to answer. */}
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
          {/* The first half depends on the flag: for a linear type the portal neither issues ESM-2
              by itself nor creates a relocation trip — the equipment returns to the garage
              nightly — so the old wording would be a promise the portal does not keep. The second
              half holds in both cases: no blank is assigned to such a type. */}
          <Typography.Text type="secondary">
            {watchIsLinear
              ? 'ЭСМ-2 по заявке на технику выписывается по требованию, а день работ на объекте печатается по 4-П.'
              : 'ЭСМ-2 портал выписывает сам по заявке на технику, а перегон на объект — по 4-П.'}{' '}
            Бланк такому типу не задаётся.
          </Typography.Text>
        </Form.Item>
      )}

      {/* Linear mode is about how the order is run, not about the blank, so it is asked for every
          kind: a dump truck is ordered to a site for soil removal and works shifts there like an
          excavator. The neighbouring «Легковой транспорт» stays with the freight kind — it is
          about the waybill form, which special equipment cannot answer.

          Label and hint come from contracts: the server prints the same wording as the column
          header of the directory export, and the two must not diverge. */}
      <Form.Item name="isLinear" valuePropName="checked" extra={LINEAR_VEHICLE_TYPE_HINT}>
        <Checkbox>{LINEAR_VEHICLE_TYPE_LABEL}</Checkbox>
      </Form.Item>

      {/* Maintenance marking (R13). Asked for every kind and next to linear mode because the same
          person answers it in the same pass: creating a type, they know whether the equipment has
          an odometer and whether maintenance is tracked by it.

          The hint must name the consequence of the unchecked box, not only the meaning of the
          checked one: the directory default is «not tracked», and without this phrase an empty
          maintenance column in the garage reads as a portal failure rather than an unmarked
          type. */}
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
