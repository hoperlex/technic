import { useEffect } from 'react';
import { Alert, Form, Input } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  candidateObjectChoice,
  isDepartmentScopedRole,
  type EquipmentCandidateInput,
} from '@technic/contracts';
import { objectActivityOptionsQuery } from '@entities/object';
import { officeEquipmentTypeOptionsQuery } from '@entities/office-equipment';
import { useAuth } from '@entities/session';
import { flattenOptions } from '@shared/lib';
import { AutoSelect, FormModal, useFormBlockers } from '@shared/ui';
import { equipmentCandidateDraft, type EquipmentCandidateDraft } from '../model/draft';

type Values = EquipmentCandidateInput;

/**
 * A requester reports observable device details; accounting fields belong to the reviewer who
 * creates the directory card. The model stays free text so reporting does not become a second
 * way to edit the model directory. The draft travels with the service request in one transaction,
 * since separate submissions would leave orphaned reports after a connection failure.
 */
export function ReportEquipmentModal({
  open,
  draft,
  onClose,
  onFilled,
}: {
  open: boolean;
  /** Reopening edits the same unsent observation instead of starting another report. */
  draft: EquipmentCandidateDraft | null;
  onClose: () => void;
  /** The request form owns submission so the report and request are created atomically. */
  onFilled: (draft: EquipmentCandidateDraft) => void;
}) {
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const { user } = useAuth();
  const choice = candidateObjectChoice(user);

  // Most requesters never open this window, so its dictionaries are loaded only when needed.
  const { data: typeOptions = [], isFetching: typesLoading } = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    enabled: open,
  });
  const { data: objectOptions = [] } = useQuery({
    ...objectActivityOptionsQuery(),
    enabled: open,
  });

  /*
   * ADR 0249 keeps offered locations aligned with the server, including inactive sites and wide
   * scope. Departments temporarily choose any existing site while directory data is incomplete;
   * their linked sites guide the choice without overriding the place the person actually reports.
   */
  const available = objectOptions
    .filter((o) => choice.allowedObjectIds === null || choice.allowedObjectIds.includes(o.value))
    .map((o) => ({ ...o, label: o.isActive ? o.label : `${o.label} (неактивен)` }))
    .sort((a, b) => Number(b.isActive) - Number(a.isActive));
  const ownIds = new Set(choice.ownObjectIds);
  const own = available.filter((o) => ownIds.has(o.value));
  const other = available.filter((o) => !ownIds.has(o.value));
  const objects =
    own.length > 0 && other.length > 0
      ? [
          {
            label: isDepartmentScopedRole(user?.role) ? 'Площадки вашего отдела' : 'Ваши объекты',
            options: own,
          },
          { label: 'Другие объекты', options: other },
        ]
      : available;

  useEffect(() => {
    if (!open) return;
    // Preserve the unsent observation on reopen; an empty form would look like lost input.
    form.resetFields();
    if (draft) form.setFieldsValue(draft.input);
  }, [open, draft, form]);

  const finish = (values: Values) => {
    // One form-level error covers the pair: attaching the same requirement to both number
    // fields would report the same missing identifier twice.
    if (
      blockers.raise({
        inventoryNumber:
          !values.serialNumber?.trim() &&
          !values.inventoryNumber?.trim() &&
          'Укажите серийный или инвентарный номер с шильдика',
      })
    ) {
      return;
    }
    const objectId = values.objectId;
    onFilled(
      equipmentCandidateDraft(
        {
          equipmentTypeId: values.equipmentTypeId,
          declaredModel: values.declaredModel.trim(),
          serialNumber: values.serialNumber?.trim() ?? '',
          inventoryNumber: values.inventoryNumber?.trim() ?? '',
          objectId,
          location: values.location.trim(),
          comment: values.comment?.trim() ?? '',
        },
        {
          typeName: typeOptions.find((t) => t.value === values.equipmentTypeId)?.label ?? '',
          objectLabel: String(
            flattenOptions(objects).find((o) => o.value === objectId)?.label ?? '',
          ),
        },
      ),
    );
    onClose();
  };

  return (
    <FormModal
      title="Сообщить об аппарате"
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      okText="Отправить с заявкой"
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={finish} {...blockers.formProps}>
        {/* A photo helps reviewers catch mistyped identifiers, but requiring it would block
            reports from people who cannot take a picture at the device. */}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="Приложите фото шильдика к заявке"
          description="Так карточку заведут точнее: номера видно глазами, и опечатка не уедет в справочник. Обязательным снимок не является."
        />

        <Form.Item
          name="equipmentTypeId"
          label="Что за аппарат"
          rules={[{ required: true, message: 'Выберите тип' }]}
        >
          <AutoSelect
            options={typeOptions}
            loading={typesLoading}
            showSearch
            optionFilterProp="label"
            placeholder="МФУ, принтер, ноутбук"
          />
        </Form.Item>

        <Form.Item
          name="declaredModel"
          label="Модель с шильдика"
          rules={[{ required: true, message: 'Укажите модель с шильдика' }]}
        >
          <Input placeholder="Kyocera ECOSYS M3145" maxLength={255} />
        </Form.Item>

        <Form.Item name="serialNumber" label="Серийный номер">
          <Input placeholder="с шильдика" maxLength={100} />
        </Form.Item>
        <Form.Item
          name="inventoryNumber"
          label="Инвентарный номер"
          extra="Хотя бы один номер обязателен: по нему аппарат и ищут в справочнике"
        >
          <Input placeholder="с наклейки бухгалтерии" maxLength={100} />
        </Form.Item>

        <Form.Item
          name="objectId"
          label="Где стоит"
          rules={[{ required: true, message: 'Выберите площадку' }]}
        >
          <AutoSelect options={objects} showSearch optionFilterProp="label" />
        </Form.Item>
        <Form.Item
          name="location"
          label="Место"
          rules={[{ required: true, message: 'Укажите место: «каб. 214»' }]}
        >
          <Input placeholder="каб. 214" maxLength={255} />
        </Form.Item>

        <Form.Item name="comment" label="Что ещё важно знать">
          <Input.TextArea
            rows={2}
            maxLength={2000}
            placeholder="стоит у бухгалтерии, наклейки нет"
          />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
