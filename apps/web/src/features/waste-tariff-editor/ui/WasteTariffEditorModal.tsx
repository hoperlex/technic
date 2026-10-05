import { Alert, Button, Form, Input, InputNumber, Radio, Space, Switch } from 'antd';
import { DeleteFilled } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import {
  CONTAINER_KINDS,
  type ContainerTypeDto,
  findSimilarWasteTypes,
  findWasteTypeByName,
  pricePerM3FromContainer,
  type WasteTariffDto,
  wasteTypeDuplicateMessage,
  type WasteTypeDto,
} from '@technic/contracts';
import { wasteTariffKindLabels } from '@entities/waste-tariff';
import { formatMoney } from '@shared/lib';
import { AutoSelect, FormModal, type FormBlockersApi } from '@shared/ui';

const kindOptions = CONTAINER_KINDS.map((kind) => ({
  value: kind,
  label: wasteTariffKindLabels[kind],
}));

export interface WasteTariffFormValues {
  /** The price belongs to this waste operator (ADR 0026). */
  operatorCounterpartyId?: string;
  /** A waste type is selected from the directory or created atomically with its first price. */
  wasteTypeSource: 'existing' | 'new';
  wasteTypeId?: string;
  wasteTypeName?: string;
  /** Exactly one target is submitted: a concrete type or an entire vehicle kind. */
  target: 'container_type' | 'container_kind';
  containerTypeId?: string;
  containerKind?: (typeof CONTAINER_KINDS)[number];
  /** The entered price is either per cubic metre or for one complete container. */
  pricing: 'per_m3' | 'per_container';
  pricePerM3?: number;
  pricePerContainer?: number;
  note?: string;
  isActive: boolean;
}

interface Option {
  value: string;
  label: string;
}

export interface PurgeControl {
  allowed: boolean;
  pending: boolean;
  confirm: (id: string, name: string) => void;
}

interface Props {
  open: boolean;
  record: WasteTariffDto | null;
  form: FormInstance<WasteTariffFormValues>;
  formProps: FormBlockersApi['formProps'];
  pending: boolean;
  wasteTypes: WasteTypeDto[];
  wasteTypesLoading: boolean;
  containerTypes: ContainerTypeDto[];
  containerTypesLoading: boolean;
  operatorOptions: Option[];
  operatorsLoading: boolean;
  purge: PurgeControl;
  onCancel: () => void;
  onSubmit: (values: WasteTariffFormValues) => void;
}

/** Price fields for create and edit; the owning hook performs the command and cache effects. */
export function WasteTariffEditorModal({
  open,
  record,
  form,
  formProps,
  pending,
  wasteTypes,
  wasteTypesLoading,
  containerTypes,
  containerTypesLoading,
  operatorOptions,
  operatorsLoading,
  purge,
  onCancel,
  onSubmit,
}: Props) {
  const wasteTypeSource = Form.useWatch('wasteTypeSource', form);
  const wasteTypeName = Form.useWatch('wasteTypeName', form);
  const target = Form.useWatch('target', form);
  const containerTypeId = Form.useWatch('containerTypeId', form);
  const pricing = Form.useWatch('pricing', form);
  const pricePerContainer = Form.useWatch('pricePerContainer', form);

  const wasteTypeOptions = wasteTypes.map((type) => ({
    value: type.id,
    label: type.isActive ? type.name : `${type.name} (неактивен)`,
  }));
  const containerTypeOptions = containerTypes.map((type) => ({
    value: type.id,
    label: `${type.isActive ? type.name : `${type.name} (неактивен)`}${
      type.volumeM3 == null ? ' — вместимость не задана' : ''
    }`,
  }));

  // The browser gives immediate duplicate feedback, but the server and its unique constraint have
  // the final word because this already-loaded directory can become stale before submission.
  const newTypeName = (wasteTypeName ?? '').trim();
  const duplicateType = newTypeName ? findWasteTypeByName(newTypeName, wasteTypes) : undefined;
  const similarTypes = duplicateType ? [] : findSimilarWasteTypes(newTypeName, wasteTypes);
  const selectedVolumeM3 =
    containerTypes.find((type) => type.id === containerTypeId)?.volumeM3 ?? null;
  // A per-container price requires capacity to derive both the per-m³ price and volume multiple.
  const perContainerAvailable = target === 'container_type' && selectedVolumeM3 != null;
  const derivedPricePerM3 =
    pricing === 'per_container' && selectedVolumeM3 && pricePerContainer
      ? pricePerM3FromContainer(Number(pricePerContainer), selectedVolumeM3)
      : null;

  const pickExistingType = (type: WasteTypeDto) => {
    form.setFieldsValue({
      wasteTypeSource: 'existing',
      wasteTypeId: type.id,
      wasteTypeName: '',
    });
  };

  return (
    <FormModal
      title={record ? 'Редактирование цены' : 'Новая цена'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      width={560}
      footerExtra={
        record && !record.isActive && purge.allowed ? (
          <Button
            danger
            icon={<DeleteFilled />}
            loading={purge.pending}
            onClick={() => {
              onCancel();
              purge.confirm(record.id, `${record.wasteTypeName} — ${record.operatorName}`);
            }}
          >
            Удалить окончательно
          </Button>
        ) : undefined
      }
    >
      <Form form={form} layout="vertical" onFinish={onSubmit} {...formProps}>
        <Form.Item
          name="operatorCounterpartyId"
          label="Оператор"
          extra="Цена действует только для этого оператора"
          rules={[{ required: true, message: 'Выберите оператора' }]}
        >
          <AutoSelect
            options={operatorOptions}
            loading={operatorsLoading}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>

        {/* A new tariff can create its waste type atomically; there is no separate type screen. */}
        {!record && (
          <Form.Item name="wasteTypeSource" label="Тип мусора" style={{ marginBottom: 12 }}>
            <Radio.Group
              options={[
                { value: 'existing', label: 'Из заведённых' },
                { value: 'new', label: 'Новый' },
              ]}
              optionType="button"
            />
          </Form.Item>
        )}

        {!record && wasteTypeSource === 'new' ? (
          <>
            <Form.Item
              name="wasteTypeName"
              extra={
                duplicateType ? (
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: 'auto' }}
                    onClick={() => pickExistingType(duplicateType)}
                  >
                    Выбрать «{duplicateType.name}»
                  </Button>
                ) : (
                  'Тип заведётся вместе с этой ценой'
                )
              }
              rules={[
                { required: true, message: 'Укажите название типа мусора' },
                {
                  // A spelling variant of an existing type would split one waste/vehicle pair
                  // into competing prices, so equality is a blocker rather than a suggestion.
                  validator: (_rule, value: string) => {
                    const clash = value ? findWasteTypeByName(value, wasteTypes) : undefined;
                    return clash
                      ? Promise.reject(new Error(wasteTypeDuplicateMessage(clash.name)))
                      : Promise.resolve();
                  },
                },
              ]}
            >
              <Input maxLength={255} placeholder="Например, бетонный бой" />
            </Form.Item>
            {similarTypes.length > 0 && (
              // Similarity warns rather than blocks: a person decides whether the name is new.
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                title="Есть похожие типы"
                description={
                  <>
                    <div>Если речь об одном и том же — выберите заведённый тип:</div>
                    <Space wrap style={{ marginTop: 8 }}>
                      {similarTypes.map((type) => (
                        <Button key={type.id} size="small" onClick={() => pickExistingType(type)}>
                          {type.name}
                        </Button>
                      ))}
                    </Space>
                  </>
                }
              />
            )}
          </>
        ) : (
          <Form.Item
            name="wasteTypeId"
            label={record ? 'Тип мусора' : undefined}
            rules={[{ required: true, message: 'Выберите тип мусора' }]}
          >
            <AutoSelect
              options={wasteTypeOptions}
              loading={wasteTypesLoading}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
        )}

        <Form.Item name="target" label="Цена действует для">
          <Radio.Group
            options={[
              { value: 'container_type', label: 'Конкретной техники' },
              { value: 'container_kind', label: 'Вида техники целиком' },
            ]}
            optionType="button"
          />
        </Form.Item>

        {target === 'container_kind' ? (
          <Form.Item
            name="containerKind"
            label="Вид техники"
            extra="Точная цена на конкретный тип контейнера побеждает цену вида"
            rules={[{ required: true, message: 'Выберите вид техники' }]}
          >
            <AutoSelect options={kindOptions} />
          </Form.Item>
        ) : (
          <Form.Item
            name="containerTypeId"
            label="Тип машины/контейнера"
            rules={[{ required: true, message: 'Выберите тип машины/контейнера' }]}
          >
            <AutoSelect
              options={containerTypeOptions}
              loading={containerTypesLoading}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
        )}

        <Form.Item name="pricing" label="Цена задана">
          <Radio.Group
            options={[
              { value: 'per_m3', label: 'За кубометр' },
              {
                value: 'per_container',
                label: 'За контейнер целиком',
                disabled: !perContainerAvailable,
              },
            ]}
            optionType="button"
          />
        </Form.Item>

        {pricing === 'per_container' ? (
          <Form.Item
            name="pricePerContainer"
            label="Цена за контейнер"
            extra={
              derivedPricePerM3 != null
                ? `В прайсе хранится ${formatMoney(derivedPricePerM3)} за м³; объём заявки должен быть кратен ${selectedVolumeM3} м³`
                : 'Цену за м³ выведет сервер из вместимости контейнера'
            }
            rules={[{ required: true, message: 'Укажите цену за контейнер' }]}
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0.01}
              precision={2}
              step={100}
              addonAfter="₽"
            />
          </Form.Item>
        ) : (
          <Form.Item
            name="pricePerM3"
            label="Цена за м³"
            rules={[{ required: true, message: 'Укажите цену за м³' }]}
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0.01}
              precision={2}
              step={50}
              addonAfter="₽/м³"
            />
          </Form.Item>
        )}

        <Form.Item name="note" label="Пункт прайса">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        <Form.Item name="isActive" label="Действует" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
