import { useEffect } from 'react';
import { Alert, App, DatePicker, Form, Input, Select } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OFFICE_EQUIPMENT_STATES,
  officeEquipmentStateLabels,
  officeEquipmentStateNeedsNote,
  officeEquipmentTitle,
  type OfficeEquipmentDto,
  type OfficeEquipmentState,
} from '@technic/contracts';
import {
  officeEquipmentApi,
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
} from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { serviceRequestKeys } from '@entities/service-request';
import { errorMessage } from '@shared/lib';
import { FormModal } from '@shared/ui';

const DATE = 'YYYY-MM-DD';

interface Values {
  objectId: string;
  departmentId?: string | null;
  location: string;
  state: OfficeEquipmentState;
  stateNote: string;
  movedOn: Dayjs;
  reason: string;
  comment?: string;
}

/**
 * Перемещение единицы (план модернизации, Р59–Р61).
 *
 * Своё окно, а не поле карточки: у переезда есть дата (технику увозят в пятницу, а в портал
 * заносят в понедельник), причина и обе стороны — из этого и складывается журнал, по которому
 * потом отвечают на вопрос «где этот аппарат стоял в мае».
 *
 * Целевой объект — любой активный (Р60). Отдающий ничего не получает на чужой площадке: он теряет
 * технику из своего списка, и предупреждение об этом стоит прямо в окне — иначе «куда делся
 * принтер» выясняется через неделю.
 */
export function EquipmentMoveModal({
  equipment,
  /** Заявка, из-за которой единицу везут: подставляет причину и связывает запись с ремонтом. */
  serviceRequestId,
  onClose,
}: {
  /** `null` — окно закрыто. */
  equipment: OfficeEquipmentDto | null;
  serviceRequestId?: string | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const state = Form.useWatch('state', form);
  const objectId = Form.useWatch('objectId', form);

  const { data: objectOptions = [] } = useQuery({
    ...objectOptionsQuery({ activeOnly: true }),
    enabled: !!equipment,
  });
  const { data: departmentOptions = [] } = useQuery({
    ...departmentOptionsQuery(),
    enabled: !!equipment,
  });

  useEffect(() => {
    if (!equipment) return;
    form.setFieldsValue({
      objectId: equipment.object.id,
      departmentId: equipment.department?.id ?? null,
      location: equipment.location,
      state: equipment.state,
      stateNote: equipment.stateNote,
      movedOn: dayjs(),
      reason: '',
      comment: '',
    });
  }, [equipment, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      officeEquipmentApi.move(equipment!.id, {
        objectId: values.objectId,
        departmentId: values.departmentId ?? null,
        location: values.location?.trim() ?? '',
        state: values.state,
        stateNote: values.stateNote?.trim() ?? '',
        movedOn: values.movedOn.format(DATE),
        reason: values.reason.trim(),
        comment: values.comment?.trim() ?? '',
        serviceRequestId: serviceRequestId ?? null,
      }),
    onSuccess: () => {
      message.success('Перемещение записано');
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // Переезд меняет и область, и состояние карточки, а счётчик «В парке» считается по ним
      // обоим (матрица Р14). Считают его два окна — моделей и расходников, — и устаревают оба.
      void qc.invalidateQueries({ queryKey: officeEquipmentModelKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      // Заявки показывают реквизиты снимком, но карточка единицы в них тянется отдельно — и
      // состояние техники там же.
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const leavesScope = !!equipment && objectId !== undefined && objectId !== equipment.object.id;

  return (
    <FormModal
      title={equipment ? `Переместить ${officeEquipmentTitle(equipment)}` : 'Перемещение'}
      open={!!equipment}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Записать перемещение"
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
        {leavesScope && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="Техника уйдёт с вашей площадки"
            description="После записи она пропадёт из вашего справочника и появится у принимающей стороны. Вернуть её сможет тот, к кому она приехала."
          />
        )}

        <Form.Item
          name="objectId"
          label="Объект"
          rules={[{ required: true, message: 'Выберите объект' }]}
        >
          <Select showSearch optionFilterProp="label" options={objectOptions} />
        </Form.Item>

        <Form.Item name="location" label="Место внутри объекта">
          <Input maxLength={255} placeholder="кабинет 214, прорабская" />
        </Form.Item>

        <Form.Item name="departmentId" label="Отдел-владелец">
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Не закреплена"
            options={departmentOptions}
          />
        </Form.Item>

        <Form.Item name="state" label="Где находится">
          <Select
            options={OFFICE_EQUIPMENT_STATES.map((value) => ({
              value,
              label: officeEquipmentStateLabels[value],
            }))}
          />
        </Form.Item>

        {/* «На складе» и «у сотрудника» без уточнения — потерянная техника: искать её негде. */}
        {state && officeEquipmentStateNeedsNote(state) && (
          <Form.Item
            name="stateNote"
            label="Где именно"
            rules={[{ required: true, message: 'Уточните, где именно находится техника' }]}
          >
            <Input maxLength={255} placeholder="Склад АХО, стеллаж 3 · Иванов И. И." />
          </Form.Item>
        )}

        <Form.Item
          name="movedOn"
          label="Дата перемещения"
          rules={[{ required: true, message: 'Укажите дату' }]}
        >
          {/* Дата переезда, а не записи: технику увозят в пятницу, а заносят в понедельник. */}
          <DatePicker
            format="DD.MM.YYYY"
            style={{ width: 200 }}
            disabledDate={(d) => d.isAfter(dayjs().endOf('day'))}
          />
        </Form.Item>

        <Form.Item
          name="reason"
          label="Причина"
          rules={[{ required: true, message: 'Укажите причину перемещения' }]}
        >
          <Input maxLength={1000} placeholder="Перевод бухгалтерии, увезли в сервис, вернули" />
        </Form.Item>

        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} maxLength={1000} placeholder="Необязательно" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
