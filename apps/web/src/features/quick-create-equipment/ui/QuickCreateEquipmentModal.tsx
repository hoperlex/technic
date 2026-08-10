import { useEffect } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListResult, OfficeEquipmentDto } from '@technic/contracts';
import {
  OfficeEquipmentFields,
  type OfficeEquipmentFormValues,
  officeEquipmentApi,
  officeEquipmentPayload,
  officeEquipmentKeys,
  officeEquipmentTypeOptionsQuery,
} from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { applyApiFieldErrors } from '../../../utils/formErrors';

/**
 * Быстрое заведение карточки оргтехники прямо из формы заявки (этап 7, Р40).
 *
 * Тому, кто ведёт справочник (`officeEquipment.write` — надстройка «Оператор (оргтехника)» и
 * держатели справочников), тупик «техники нет в справочнике» разбирается за один заход: заявку не
 * бросают, карточку заводят здесь же, и заведённая единица сразу встаёт выбранной в поле «Техника».
 * Отправить его в справочник значило бы потерять набранное описание неисправности и вложения —
 * форма заявки при уходе со страницы не сохраняется.
 *
 * Окно поверх окна: заявка остаётся открытой под ним. Поэтому подпись действия — «Завести и
 * выбрать», а не «Сохранить»: человек нажимает её, продолжая заводить заявку, и должен видеть, что
 * произойдёт с полем.
 */
export function QuickCreateEquipmentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Заведённая единица — ею заполняют поле «Техника» формы заявки. */
  onCreated: (equipment: OfficeEquipmentDto) => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<OfficeEquipmentFormValues>();

  // Справочники спрашиваются только при открытом окне: большинство заводящих заявку сюда не
  // заходит вовсе, и три запроса на каждое открытие формы были бы платой ни за что.
  const { data: typeOptions = [], isFetching: typesLoading } = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    enabled: open,
  });
  // Только действующие площадки, в отличие от вкладки справочника: там закрытые оставлены ради
  // правки уже заведённых карточек, а новую единицу на закрытый объект не ставят.
  const { data: objectOptions = [] } = useQuery({ ...objectOptionsQuery(), enabled: open });
  const { data: departmentOptions = [] } = useQuery({ ...departmentOptionsQuery(), enabled: open });

  useEffect(() => {
    if (!open) return;
    // Окно открывают и повторно — на соседней заявке: набранное в прошлый раз к ней отношения не
    // имеет. «Активна» стоит сразу: заводят то, что стоит в кабинете и ждёт ремонта.
    form.resetFields();
    form.setFieldsValue({ isActive: true } as OfficeEquipmentFormValues);
  }, [open, form]);

  const mutation = useMutation({
    mutationFn: (values: OfficeEquipmentFormValues) =>
      officeEquipmentApi.create(officeEquipmentPayload(values)),
    onSuccess: (created) => {
      message.success('Карточка заведена');
      /*
       * Новая единица встаёт в список вариантов сразу, не дожидаясь перезапроса: поле заявки
       * заполняется тем же нажатием, и до ответа сервера человек видел бы в нём идентификатор
       * вместо подписи «модель · инв. номер». Перезапрос идёт следом — он же приносит единицу
       * всем прочим спискам справочника.
       */
      qc.setQueryData<ListResult<OfficeEquipmentDto>>(officeEquipmentKeys.options(), (prev) =>
        prev ? { ...prev, items: [created, ...prev.items], total: prev.total + 1 } : prev,
      );
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onCreated(created);
      onClose();
    },
    onError: (e) => {
      // «Серийный номер уже заведён карточкой …» — обычный ответ сервера, и показать его нужно на
      // самом поле: иначе человек заведёт дубль, не поняв, какой из номеров занят.
      if (!applyApiFieldErrors(form, e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title="Новая единица оргтехники"
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Завести и выбрать"
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
        <OfficeEquipmentFields
          typeOptions={typeOptions}
          typesLoading={typesLoading}
          objectOptions={objectOptions}
          departmentOptions={departmentOptions}
        />
      </Form>
    </FormModal>
  );
}
