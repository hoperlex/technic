import { Form, Input, InputNumber, Select, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  checkContainerOwner,
  FOREIGN_CONTAINER_SPLIT_MESSAGE,
  isPricedRequestType,
  isVolumeAllowed,
  MIN_WASTE_VOLUME_M3,
  presentGroupLabel,
  REQUEST_TYPES,
  requestTypeLabels,
  volumeStepMessage,
  WASTE_REMOVAL_CONTAINER_KIND,
  type WasteRequestDto,
} from '@technic/contracts';
import {
  containerGroupKey,
  containerGroupOptions,
  findContainerGroup,
  presentGroupsHint,
  wastePricingHint,
  wasteRequestKeys,
  wasteRequestsApi,
} from '@entities/waste-request';
import { wasteTariffResolveQuery } from '@entities/waste-tariff';
import { withSavedOption } from '@shared/lib';
import { AutoSelect, FormGrid, FormModal, type FormBlockersApi } from '@shared/ui';
import type { FormInstance } from 'antd';
import type {
  WasteRequestEditorFile,
  WasteRequestEditorSources,
  WasteRequestFormValues,
} from '../model/types';
import { WasteRequestEditorSchedule } from './WasteRequestEditorSchedule';

interface Props {
  blockers: FormBlockersApi;
  canAssignOperator: boolean;
  files: WasteRequestEditorFile[];
  form: FormInstance<WasteRequestFormValues>;
  onCancel: () => void;
  onFinish: (values: WasteRequestFormValues) => void;
  onRemoveFile: (file: WasteRequestEditorFile) => void;
  onUpload: (file: File) => void;
  open: boolean;
  record: WasteRequestDto | null;
  saving: boolean;
  sources: WasteRequestEditorSources;
  uploading: boolean;
}

const requestTypeOptions = REQUEST_TYPES.map((type) => ({
  value: type,
  label: requestTypeLabels[type],
}));

/** Render the editor while preserving the domain-owned pricing and container-group rules. */
export function WasteRequestEditorModal({
  blockers,
  canAssignOperator,
  files,
  form,
  onCancel,
  onFinish,
  onRemoveFile,
  onUpload,
  open,
  record,
  saving,
  sources,
  uploading,
}: Props) {
  const objectId = Form.useWatch('objectId', form);
  const requestType = Form.useWatch('requestType', form);
  const wasteTypeId = Form.useWatch('wasteTypeId', form);
  const volumeM3 = Form.useWatch('volumeM3', form);
  const operatorId = Form.useWatch('operatorCounterpartyId', form);
  const groupKey = Form.useWatch('containerGroupKey', form);
  const priced = requestType ? isPricedRequestType(requestType) : false;

  const formWasteTypes = withSavedOption(sources.wasteTypes.options, {
    id: record?.wasteTypeId,
    name: record?.wasteTypeName,
  });
  const savedContainerType = { id: record?.containerTypeId, name: record?.containerTypeName };
  const operatorOptions = sources.operatorOptionsFor(objectId, {
    id: record?.operatorCounterpartyId ?? null,
    name: record?.operatorName ?? null,
  });

  const { data: tariffResult, isError: tariffRequestFailed } = useQuery({
    ...wasteTariffResolveQuery({
      wasteTypeId,
      target: { containerKind: WASTE_REMOVAL_CONTAINER_KIND },
      operatorCounterpartyId: operatorId,
    }),
    enabled: priced && !!wasteTypeId,
  });
  const tariff = tariffResult?.tariff ?? null;
  const volumeStepM3 = tariff?.volumeStepM3 ?? null;
  const pricingHint = wastePricingHint({
    isPriced: priced,
    wasteTypeId,
    operatorSelected: !!operatorId,
    tariff,
    resolved: tariffResult != null,
    requestFailed: tariffRequestFailed,
    volumeM3: priced ? (volumeM3 ?? null) : null,
  });

  const { data: presentGroups, isLoading: presentLoading } = useQuery({
    queryKey: wasteRequestKeys.presentGroups(objectId),
    queryFn: () => wasteRequestsApi.presentGroups(objectId),
    enabled: !!objectId,
  });
  const groups = presentGroups ?? [];
  const selectedGroup = findContainerGroup(groups, groupKey);
  const savedGroupKey = record?.containerTypeId
    ? containerGroupKey({
        containerTypeId: record.containerTypeId,
        ownerCounterpartyId: record.containerOwnerCounterpartyId,
      })
    : undefined;
  // A request being edited already removed its containers from presence, so add them back to cap.
  const ownContribution =
    record?.requestType === 'container_removal' && groupKey === savedGroupKey
      ? record.containersCount
      : 0;
  const maxContainers = Math.max(1, (selectedGroup?.quantity ?? 1) + ownContribution);
  const fromObjectField = {
    options: withSavedOption(containerGroupOptions(groups), {
      id: savedGroupKey,
      name: savedContainerType.name
        ? presentGroupLabel({
            containerTypeName: savedContainerType.name,
            ownerName: record?.containerOwnerName ?? null,
            quantity: record?.containersCount ?? 1,
          })
        : undefined,
    }),
    loading: presentLoading,
    placeholder: 'Контейнер, стоящий на объекте',
  };
  const subjectField =
    requestType === 'container_replace'
      ? {
          label: 'Заменяемый контейнер',
          message: 'Выберите контейнер для замены',
          countLabel: 'Сколько заменить',
          ...fromObjectField,
        }
      : requestType === 'container_removal'
        ? {
            label: 'Снимаемый контейнер',
            message: 'Выберите контейнер для снятия',
            countLabel: 'Сколько снять',
            ...fromObjectField,
          }
        : null;
  const ownerVerdict = requestType
    ? checkContainerOwner(
        {
          requestType,
          operatorCounterpartyId: operatorId ?? null,
          containerOwnerCounterpartyId: selectedGroup?.ownerCounterpartyId ?? null,
        },
        false,
      )
    : 'ok';

  const resetSubject = () =>
    form.setFieldsValue({
      containerTypeId: undefined,
      containerGroupKey: undefined,
      containersCount: 1,
      ownerMismatchReason: undefined,
    });

  return (
    <FormModal
      title={record ? 'Редактирование заявки' : 'Новая заявка'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={saving}
      width={880}
    >
      <Form form={form} layout="vertical" onFinish={onFinish} {...blockers.formProps}>
        <FormGrid>
          <Form.Item
            name="objectId"
            label="Объект строительства"
            rules={[{ required: true, message: 'Выберите объект' }]}
          >
            <AutoSelect
              options={sources.objectOptions}
              loading={sources.objectsLoading}
              showSearch
              optionFilterProp="label"
              disabled={sources.objectFieldDisabled}
              onChange={resetSubject}
            />
          </Form.Item>
          <Form.Item
            name="requestType"
            label="Тип заявки"
            rules={[{ required: true, message: 'Выберите тип заявки' }]}
          >
            <AutoSelect
              options={requestTypeOptions}
              placeholder={objectId ? 'Выберите тип заявки' : 'Сначала выберите объект'}
              disabled={!objectId}
              onChange={() =>
                form.setFieldsValue({
                  containerTypeId: undefined,
                  containerGroupKey: undefined,
                  containersCount: 1,
                  ownerMismatchReason: undefined,
                  wasteTypeId: undefined,
                  volumeM3: undefined,
                })
              }
            />
          </Form.Item>

          {requestType === 'container_install' && (
            <Form.Item
              name="containerTypeId"
              label="Тип контейнера"
              rules={[{ required: true, message: 'Выберите тип контейнера' }]}
            >
              <AutoSelect
                options={withSavedOption(sources.containerTypes.cont, savedContainerType)}
                loading={sources.containerTypes.loading}
                showSearch
                optionFilterProp="label"
              />
            </Form.Item>
          )}

          {priced && (
            <>
              <Form.Item
                name="wasteTypeId"
                label="Тип мусора"
                rules={[{ required: true, message: 'Выберите тип мусора' }]}
              >
                <AutoSelect
                  options={formWasteTypes}
                  loading={sources.wasteTypes.loading}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Что вывозим"
                />
              </Form.Item>
              <Form.Item
                name="volumeM3"
                label="Объём, м³"
                rules={[
                  { required: true, message: 'Укажите объём' },
                  {
                    type: 'number',
                    min: MIN_WASTE_VOLUME_M3,
                    message: `Не менее ${MIN_WASTE_VOLUME_M3} м³`,
                  },
                  {
                    validator: (_rule, value: number | undefined) =>
                      value == null || isVolumeAllowed(value, volumeStepM3)
                        ? Promise.resolve()
                        : Promise.reject(new Error(volumeStepMessage(volumeStepM3!))),
                  },
                ]}
              >
                <InputNumber
                  min={MIN_WASTE_VOLUME_M3}
                  step={volumeStepM3 ?? 1}
                  precision={0}
                  style={{ width: '100%' }}
                  placeholder={volumeStepM3 ? `Кратно ${volumeStepM3}` : 'Например, 20'}
                />
              </Form.Item>
            </>
          )}
          {pricingHint && (
            <FormGrid.Full>
              <div style={{ marginTop: -16, marginBottom: 24 }}>
                <Typography.Text type={pricingHint.tone}>{pricingHint.text}</Typography.Text>
              </div>
            </FormGrid.Full>
          )}

          {subjectField && (
            <>
              <Form.Item
                name="containerGroupKey"
                label={subjectField.label}
                rules={[{ required: true, message: subjectField.message }]}
                extra={groups.length === 0 ? 'На объекте нет контейнеров' : undefined}
              >
                <AutoSelect
                  options={subjectField.options}
                  loading={subjectField.loading}
                  showSearch
                  optionFilterProp="label"
                  placeholder={subjectField.placeholder}
                  notFoundContent="Нет контейнеров на объекте"
                />
              </Form.Item>
              <Form.Item
                name="containersCount"
                label={subjectField.countLabel}
                tooltip="Одной заявкой снимают несколько контейнеров одного типа от одного оператора"
                rules={[
                  { required: true, message: 'Укажите количество' },
                  {
                    type: 'number',
                    min: 1,
                    max: maxContainers,
                    message: `На объекте ${maxContainers} шт.`,
                  },
                ]}
              >
                <InputNumber
                  min={1}
                  max={maxContainers}
                  precision={0}
                  style={{ width: '100%' }}
                  disabled={!selectedGroup}
                />
              </Form.Item>
            </>
          )}

          {canAssignOperator && record && (
            <Form.Item
              name="operatorCounterpartyId"
              label="Оператор вывоза"
              tooltip="Контрагент, который выполняет заявку; он увидит её в своём списке"
              extra={
                operatorOptions.length === 0
                  ? 'Нет активных контрагентов типа «Оператор» — заведите его в справочнике'
                  : presentGroupsHint(groups)
              }
            >
              <Select
                options={operatorOptions}
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="Можно назначить позже"
              />
            </Form.Item>
          )}

          {ownerVerdict !== 'ok' && (
            <FormGrid.Full>
              <div style={{ marginTop: -8, marginBottom: 16 }}>
                <Typography.Text type="warning">
                  {`Контейнер установил «${selectedGroup?.ownerName ?? '—'}». `}
                  {ownerVerdict === 'splitRequired'
                    ? FOREIGN_CONTAINER_SPLIT_MESSAGE
                    : 'Назначьте его либо объясните, почему вывозит другой оператор'}
                </Typography.Text>
              </div>
              {ownerVerdict !== 'splitRequired' && (
                <Form.Item
                  name="ownerMismatchReason"
                  label="Причина вывоза чужого контейнера"
                  rules={[{ required: true, message: 'Укажите причину' }]}
                >
                  <Input.TextArea
                    rows={2}
                    maxLength={500}
                    placeholder="Например: контейнеры переданы по акту"
                  />
                </Form.Item>
              )}
            </FormGrid.Full>
          )}

          <WasteRequestEditorSchedule
            files={files}
            onRemoveFile={onRemoveFile}
            onUpload={onUpload}
            record={record}
            uploading={uploading}
          />
        </FormGrid>
      </Form>
    </FormModal>
  );
}
