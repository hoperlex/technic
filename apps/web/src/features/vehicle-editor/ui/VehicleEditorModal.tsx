import type { FormInstance, SelectProps } from 'antd';
import { Form, Input, InputNumber, Segmented, Select, Space } from 'antd';
import type { VehicleDto, VehicleOwnership, VehicleStatus } from '@technic/contracts';
import { vehicleOwnershipLabels } from '@technic/contracts';
import { rentalVehicleStatusOptions, vehicleStatusOptions } from '@entities/vehicle';
import { VehicleTrailersField } from '@entities/vehicle-trailer';
import { AutoSelect, FormModal } from '@shared/ui';
import { useIsMobile } from '@shared/lib';

export interface VehicleFormValues {
  ownership: VehicleOwnership;
  /** Classification position key “type:category” (ADR 0028); the API receives two fields. */
  classificationKey: string;
  vehicleModelId?: string;
  registrationNumber?: string;
  passportNumber?: string;
  lessorId?: string;
  description?: string;
  pricePerHour?: number;
  pricePerShift?: number;
  shiftHours?: number;
  status: VehicleStatus;
  note?: string;
}

interface Props {
  open: boolean;
  record: VehicleDto | null;
  form: FormInstance<VehicleFormValues>;
  isRental: boolean;
  watchTypeId?: string;
  blockReason: string | null;
  classificationOptions: SelectProps['options'];
  classificationsLoading: boolean;
  lessorOptions: NonNullable<SelectProps['options']>;
  lessorsLoading: boolean;
  modelOptions: NonNullable<SelectProps['options']>;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: VehicleFormValues) => void;
}

/** Vehicle card fields; the owning hook performs create/update and cache invalidation. */
export function VehicleEditorModal({
  open,
  record,
  form,
  isRental,
  watchTypeId,
  blockReason,
  classificationOptions,
  classificationsLoading,
  lessorOptions,
  lessorsLoading,
  modelOptions,
  pending,
  onCancel,
  onSubmit,
}: Props) {
  const isMobile = useIsMobile();

  return (
    <FormModal
      title={
        record
          ? `Редактирование: ${vehicleOwnershipLabels[record.ownership].toLowerCase()}`
          : 'Новая единица техники'
      }
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      width={560}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={onSubmit}
        onValuesChange={(changed) => {
          // A model belongs to its type, so changing the classification invalidates that choice.
          if ('classificationKey' in changed) form.setFieldValue('vehicleModelId', undefined);
          // Rental offers do not use the full owned-vehicle status set.
          if (changed.ownership === 'rental' && form.getFieldValue('status') !== 'inactive') {
            form.setFieldValue('status', 'active');
          }
        }}
      >
        <Form.Item
          name="ownership"
          label="Принадлежность"
          extra={
            record ? 'Принадлежность неизменяема: это другая сущность, а не правка' : undefined
          }
        >
          <Segmented<VehicleOwnership>
            disabled={!!record}
            options={[
              { value: 'own', label: vehicleOwnershipLabels.own },
              { value: 'rental', label: vehicleOwnershipLabels.rental },
            ]}
          />
        </Form.Item>

        {/* One classification position replaces a type/category pair (ADR 0028): a categorized
            type selects its request-facing category, while an uncategorized type selects itself. */}
        <Form.Item
          name="classificationKey"
          label="Тип/категория ТС"
          rules={[{ required: true, message: 'Выберите тип или категорию' }]}
          extra={
            isRental
              ? 'Категория — то, по чему предложение сопоставляется с заявкой: «Автокран, г/п 130 т»'
              : undefined
          }
        >
          <AutoSelect
            options={classificationOptions}
            loading={classificationsLoading}
            showSearch
            optionFilterProp="label"
            placeholder="Тип или категория"
          />
        </Form.Item>

        {isRental ? (
          <>
            <Form.Item
              name="lessorId"
              label="Арендодатель"
              rules={[{ required: true, message: 'Выберите арендодателя' }]}
            >
              <AutoSelect
                options={lessorOptions}
                loading={lessorsLoading}
                showSearch
                optionFilterProp="label"
                placeholder="Контрагент роли «Арендодатель (ТС)»"
                notFoundContent="Арендодателей нет — заведите их в справочнике контрагентов"
              />
            </Form.Item>
            <Form.Item
              name="description"
              label="Описание"
              extra="Короткий срез вида «Автокран 70 тн» — им различаются предложения одного арендодателя"
            >
              <Input maxLength={120} placeholder="Автокран 70 тн" />
            </Form.Item>
            <Space
              style={{ width: '100%' }}
              size="middle"
              orientation={isMobile ? 'vertical' : 'horizontal'}
            >
              <Form.Item
                name="pricePerHour"
                label="₽ / час"
                style={{ flex: 1 }}
                rules={[
                  {
                    validator: (_rule, value) =>
                      value != null || form.getFieldValue('pricePerShift') != null
                        ? Promise.resolve()
                        : Promise.reject(new Error('Укажите цену за час или за смену')),
                  },
                ]}
              >
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
              <Form.Item name="pricePerShift" label="₽ / смена" style={{ flex: 1 }}>
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
              <Form.Item name="shiftHours" label="Часов в смене" style={{ flex: 1 }}>
                <InputNumber style={{ width: '100%' }} min={1} max={24} placeholder="8" />
              </Form.Item>
            </Space>
            {/* An active offer with an inactive lessor is impossible (ADR 0018 §15), so the option
                is disabled and the server's shared reason is shown beside the field. */}
            <Form.Item name="status" label="Статус" extra={blockReason ?? undefined}>
              <Select
                options={rentalVehicleStatusOptions.map((option) => ({
                  ...option,
                  disabled: !!blockReason && option.value === 'active',
                }))}
              />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item name="vehicleModelId" label="Марка/модель">
              <Select
                options={modelOptions}
                showSearch
                allowClear
                optionFilterProp="label"
                disabled={!watchTypeId}
                placeholder={watchTypeId ? 'Марка/модель (опционально)' : 'Сначала выберите тип'}
                notFoundContent="Нет марок для этого типа"
              />
            </Form.Item>
            <Space
              style={{ width: '100%' }}
              size="middle"
              orientation={isMobile ? 'vertical' : 'horizontal'}
            >
              <Form.Item name="registrationNumber" label="Госномер" style={{ flex: 1 }}>
                <Input maxLength={50} />
              </Form.Item>
              <Form.Item name="status" label="Статус" style={{ flex: 1 }}>
                <Select options={vehicleStatusOptions} />
              </Form.Item>
            </Space>
            <Form.Item name="passportNumber" label="ПТС / ПСМ">
              <Input maxLength={100} />
            </Form.Item>
            {/* The endpoint filters one tractor by hitchedVehicleId, so showing hitches in the
                registry would cost a query per row. The card needs only one query when opened.
                The trailer slice owns eligibility under plan §4.2.3; duplicating it here would
                let this display drift from the rule that releases an ineligible hitch. */}
            <VehicleTrailersField vehicle={record} />
          </>
        )}

        <Form.Item name="note" label="Примечание">
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
