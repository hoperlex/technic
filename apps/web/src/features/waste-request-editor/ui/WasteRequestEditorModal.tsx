import { Form, Input, InputNumber, Select, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  checkContainerOwner,
  FOREIGN_CONTAINER_SPLIT_MESSAGE,
  presentGroupLabel,
  REQUEST_TYPES,
  requestTypeLabels,
  type WasteRequestDto,
} from '@technic/contracts';
import {
  containerGroupKey,
  containerGroupOptions,
  findContainerGroup,
  presentGroupsHint,
  wasteRequestKeys,
  wasteRequestsApi,
} from '@entities/waste-request';
import { withSavedOption } from '@shared/lib';
import { AutoSelect, FormGrid, FormModal, type FormBlockersApi } from '@shared/ui';
import type { FormInstance } from 'antd';
import type {
  WasteRequestEditorFile,
  WasteRequestEditorSources,
  WasteRequestFormValues,
} from '../model/types';
import { WasteRequestEditorRemovalFields } from './WasteRequestEditorRemovalFields';
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
  const operatorId = Form.useWatch('operatorCounterpartyId', form);
  const groupKey = Form.useWatch('containerGroupKey', form);

  // The saved container type is kept selectable the same way as the saved waste type: the
  // directory entry may have been disabled (installation), or the container may have been removed
  // from the site by another request (replacement and removal). The edit field is required, and
  // without this it would open empty on a request whose subject was chosen long ago.
  const savedContainerType = { id: record?.containerTypeId, name: record?.containerTypeName };
  // Executor options follow the selected site: a different site means a different list.
  const operatorOptions = sources.operatorOptionsFor(objectId, {
    id: record?.operatorCounterpartyId ?? null,
    name: record?.operatorName ?? null,
  });

  // The editor has no completion fact: it is submitted when the request is closed and corrected by
  // a repeated completion (ADR 0035), where the price-list estimate is in front of the user.

  // What stands on the site and whose it is (ADR 0054): presence groups. They are the choice for
  // replacement and removal, the cap on the count and the "whom to call" hint.
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
  // Nothing beyond what stands on the site can be removed. A request being edited has already
  // subtracted its own units from presence, so its own count is added back to the cap, the same
  // way the server counts it.
  const ownContribution =
    record?.requestType === 'container_removal' && groupKey === savedGroupKey
      ? record.containersCount
      : 0;
  const maxContainers = Math.max(1, (selectedGroup?.quantity ?? 1) + ownContribution);
  // Replacement and removal choose among containers currently on the site. Removal names no
  // equipment at all (ADR 0022): the volume is ordered and the operator reports vehicles at
  // completion.
  const fromObjectField = {
    // Presence is counted per site and may no longer contain the request's own choice, so it is
    // added separately. The "no containers on the site" hint stays truthful: it describes the site,
    // not what the edited request refers to.
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
  // Whoever installed a container removes it (ADR 0054). The form evaluates the mismatch with the
  // same contract rule as the server: a warning before submit beats a rejection after it.
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

  // A site change resets the container: both the directory type and the presence group depend on it.
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
        {/* Fields go in pairs (FormGrid): a narrow modal hid half the form below the fold while
            the right side stayed empty. Phones get one column in the same field order. */}
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
                  // The count returns to one container: "3" from the previous request type means
                  // nothing for the new one, and installation and removal have no count at all.
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
                // A type disabled in the directory stays visible on an existing request.
                options={withSavedOption(sources.containerTypes.cont, savedContainerType)}
                loading={sources.containerTypes.loading}
                showSearch
                optionFilterProp="label"
              />
            </Form.Item>
          )}

          <WasteRequestEditorRemovalFields
            form={form}
            record={record}
            wasteTypes={sources.wasteTypes}
          />

          {/* The container is chosen as a presence group, type together with owner (ADR 0054): a
              site can hold two identical containers from different operators, and a type without
              an owner does not answer "which one is being removed". */}
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

          {/* The executor is chosen only on an existing request: at creation it is usually not
              known yet, and an extra field would distract. A new request gets its operator by a
              separate list action or when it is moved into work. */}
          {canAssignOperator && record && (
            <Form.Item
              name="operatorCounterpartyId"
              label="Оператор вывоза"
              tooltip="Контрагент, который выполняет заявку; он увидит её в своём списке"
              // Who already works on the site is shown where the executor is chosen (ADR 0054): it
              // answers both "whom to call" and "why not this one".
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

          {/* "The remover is not the installer": removal passes with an explained reason, while
              replacement never passes, because it would change the container owner on the site. */}
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
