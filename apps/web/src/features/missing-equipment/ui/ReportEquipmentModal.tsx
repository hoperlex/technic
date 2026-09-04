import { useEffect } from 'react';
import { Alert, Form, Input } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { isDepartmentScopedRole, type EquipmentCandidateInput } from '@technic/contracts';
import { objectOptionsQuery } from '@entities/object';
import { officeEquipmentTypeOptionsQuery } from '@entities/office-equipment';
import { AutoSelect, FormModal, useFormBlockers } from '@shared/ui';
import { equipmentCandidateDraft, type EquipmentCandidateDraft } from '../model/draft';
import { useAuth } from '../../../auth/AuthContext';
import { useObjectScope } from '../../../hooks/useObjectScope';

/** Значения окна: те же шесть реквизитов (Р7), без единого поля учёта. */
type Values = EquipmentCandidateInput;

/**
 * «Сообщить об аппарате» — окно заявителя, у которого нужной техники в справочнике нет (план
 * `docs/office-equipment-candidate-plan.md`, Р7, §9).
 *
 * ШЕСТЬ ПОЛЕЙ НАБЛЮДЕНИЯ, А НЕ ОДИННАДЦАТЬ ПОЛЕЙ УЧЁТА, и это главное отличие от соседнего окна
 * быстрого создания (`QuickCreateEquipmentModal`). Ни отдела-владельца, ни даты покупки, ни
 * гарантии, ни модели-ссылки здесь нет вовсе: заявитель их не знает, и, спросив их, форма получила
 * бы выдуманные ответы. Их проставляет проверяющий в форме подтверждения — полной форме карточки
 * парка (Р13).
 *
 * МОДЕЛЬ — ТЕКСТОМ. Справочник моделей такая же запись, как карточка техники, и открыв его
 * заявителю, портал вернул бы отобранный `officeEquipment.write` боковой дверью: перечень моделей
 * пополняли бы те, кому карточки вести не положено. Ссылку на модель проставляет проверяющий.
 *
 * ОКНО НИЧЕГО НЕ ОТПРАВЛЯЕТ САМО (Р2). Оно кладёт черновик в форму заявки и закрывается; уходит всё
 * одним нажатием «Сохранить» в самой заявке, потому что кандидат и заявка рождаются одной
 * транзакцией одного запроса. Отсюда и подпись кнопки — «Отправить с заявкой», а не «Сохранить»:
 * человек должен видеть, что произойдёт, а произойдёт заполнение формы под окном.
 */
export function ReportEquipmentModal({
  open,
  draft,
  onClose,
  onFilled,
}: {
  open: boolean;
  /** Уже заявленное — окно открывают и повторно, чтобы поправить сообщение до отправки. */
  draft: EquipmentCandidateDraft | null;
  onClose: () => void;
  /** Черновик уходит в форму заявки: она и отправит его вместе с описанием и вложениями. */
  onFilled: (draft: EquipmentCandidateDraft) => void;
}) {
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const { user } = useAuth();
  const objectScope = useObjectScope();

  // Справочники спрашиваются только при открытом окне: большинство заводящих заявку сюда не
  // заходит вовсе, и два запроса на каждое открытие формы были бы платой ни за что.
  const { data: typeOptions = [], isFetching: typesLoading } = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    enabled: open,
  });
  const { data: objectOptions = [] } = useQuery({ ...objectOptionsQuery(), enabled: open });

  /*
   * ПЛОЩАДКА — ПО ОСИ РОЛИ, тем же правилом, каким её проверяет сервер (Р7): объектная роль
   * называет свои объекты, отдельская — площадки своих отделов, роль без оси выбирает из
   * справочника. Чужой объект сервер отвечает 422, и предлагать в поле отвергаемое нельзя —
   * человек узнал бы об отказе после того, как заполнил шесть полей.
   *
   * Отдельская ось спрашивается по `departmentObjectIds` учётки, а не по её отделам: связь
   * «отдел ↔ площадка» портал знает готовым списком (ADR 0062), и второй способ её вычислить
   * разошёлся бы с серверным на первой же правке привязок.
   */
  const departmentAxis = isDepartmentScopedRole(user?.role);
  const ownDepartmentObjects = user?.departmentObjectIds ?? [];
  const objects = objectScope.isObjectRole
    ? objectScope.limitObjectOptions(objectOptions)
    : departmentAxis
      ? objectOptions.filter((o) => ownDepartmentObjects.includes(o.value))
      : objectOptions;

  useEffect(() => {
    if (!open) return;
    // Открытое повторно окно показывает уже сообщённое: правят сообщение до отправки, а не
    // заводят второе. Пустая форма на месте заявленного читалась бы как потерянный ввод.
    form.resetFields();
    if (draft) form.setFieldsValue(draft.input);
  }, [open, draft, form]);

  const finish = (values: Values) => {
    /*
     * «Хотя бы один номер» (Р7) — проверкой в `onFinish`, а не правилом поля: правило живёт у
     * одного поля, а условие говорит про пару, и повешенное на оба оно ругалось бы дважды на одну
     * причину. Слова те же, что скажет схема сервера, — иначе один и тот же отказ читался бы в
     * форме и в ответе по-разному.
     */
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
          objectLabel: objects.find((o) => o.value === objectId)?.label ?? '',
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
        {/* Подсказка про фото — ПРОСЬБА, А НЕ ПРАВИЛО (Р7, В4). Снимок шильдика снимает половину
            работы проверяющего: номера видно глазами, и опечатка «O» вместо «0» ловится до
            заведения карточки. Обязательным его не делаем — аппарат стоит в коридоре, телефон
            бывает без камеры, а запертая на вложении заявка означает несделанную заявку. Механики
            новой не нужно: снимок приезжает обычным вложением самой заявки. */}
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

        {/* Модель словами — то, что человек прочёл с шильдика, вместе с «кажется, Kyocera». */}
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
          <Input.TextArea rows={2} maxLength={2000} placeholder="стоит у бухгалтерии, наклейки нет" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
