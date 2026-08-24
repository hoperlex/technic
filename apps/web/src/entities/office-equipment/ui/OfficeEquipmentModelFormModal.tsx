import { useEffect } from 'react';
import { App, Form, Input, Switch } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateOfficeEquipmentModelInput, OfficeEquipmentModelDto } from '@technic/contracts';
import { AutoSelect, FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { officeEquipmentModelsApi } from '../api/officeEquipmentApi';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
} from '../api/keys';

/**
 * Заведение и правка модели аппарата (план `docs/office-equipment-consumables-plan.md`, Р1).
 *
 * Форма живёт в слое сущности, а не у окна моделей, потому что заводят модель из двух мест: из
 * самого окна и из формы карточки техники, когда нужной модели в перечне нет. Второе — не
 * удобство: без него оператор упирается на первой же машине, которой в справочнике не значится, и
 * либо бросает заведение карточки, либо (в выпуске A это ещё возможно) уводит её мимо справочника.
 * Две копии одной формы разошлись бы при первой правке — а различать заведённое отсюда и оттуда в
 * базе нечем, модель одна и та же.
 *
 * Инвалидация — по матрице Р14: гасится и корень моделей, и корень техники. Второе обязательно:
 * имя карточки с выпуска A — зеркало имени модели, которое ведёт база, и переименование модели
 * меняет строки справочника техники, ни одной карточки не тронув.
 */

interface Option {
  value: string;
  label: string;
}

interface Props {
  open: boolean;
  onCancel: () => void;
  /** Правка заведённой модели; `null` — заведение новой. */
  record?: OfficeEquipmentModelDto | null;
  typeOptions: Option[];
  typesLoading?: boolean;
  /**
   * Тип задан снаружи и не выбирается. Причин две, и обе — правила, а не удобство: у заведённой
   * модели тип неизменяем (Р1), а модель, заводимая из карточки техники, обязана быть того же
   * типа, что и карточка, — иначе маршрут ответит 422 на пару «модель — тип».
   */
  lockedTypeId?: string;
  /** Заведённая или поправленная модель: ею форма карточки техники заполняет своё поле. */
  onSaved?: (model: OfficeEquipmentModelDto) => void;
}

export function OfficeEquipmentModelFormModal({
  open,
  onCancel,
  record,
  typeOptions,
  typesLoading,
  lockedTypeId,
  onSaved,
}: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<CreateOfficeEquipmentModelInput>();
  const blockers = useFormBlockers(form);

  useEffect(() => {
    if (!open) return;
    // Окно открывают и повторно — на соседней строке: набранное в прошлый раз к ней отношения не
    // имеет. «Активна» стоит сразу: заводят то, что уже стоит в кабинетах.
    form.resetFields();
    form.setFieldsValue({
      equipmentTypeId: record?.type.id ?? lockedTypeId,
      name: record?.name ?? '',
      manufacturer: record?.manufacturer ?? '',
      comment: record?.comment ?? '',
      isActive: record?.isActive ?? true,
    });
  }, [open, record, lockedTypeId, form]);

  const saveMut = useMutation({
    mutationFn: (values: CreateOfficeEquipmentModelInput) =>
      record
        ? // Тип в тело правки не кладём вовсе: менять его нельзя, и присланный чужой маршрут
          // отобьёт 422. Свой же он и так знает — читает из строки, а не из запроса.
          officeEquipmentModelsApi.update(record.id, {
            /*
             * Имя уходит, только если его правда меняли, и это не экономия байтов. Присланное имя
             * маршрут считает переименованием: он запирает всю таблицу техники
             * (`SHARE ROW EXCLUSIVE`) и прогоняет триггер зеркала по всем карточкам модели — на
             * шестидесяти восьми аппаратах ради снятой галочки «Активна» это плата без покупки, да
             * ещё и с остановкой записи в парк на это время.
             */
            ...(values.name.trim() === record.name ? {} : { name: values.name }),
            manufacturer: values.manufacturer,
            comment: values.comment,
            isActive: values.isActive,
          })
        : officeEquipmentModelsApi.create(values),
    onSuccess: (saved) => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: officeEquipmentModelKeys.root });
      // Матрица Р14: имя модели стоит в строке справочника техники зеркалом — без этого
      // переименование доехало бы до списка только со следующим заходом на вкладку.
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // Та же матрица, третий сосед: модель названа именем и в карточке расходника («Подходит к»),
      // и в отборе окна картриджей — переименованная, она осталась бы там под прежним именем.
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      onSaved?.(saved);
      onCancel();
    },
    /*
     * Отказы, названные полем, ложатся на поле (ADR 0094), и занятое наименование — из них:
     * `err.conflict` принимает `fields`, маршрут шлёт `{ name: … }` и на проверке до вставки, и
     * на разборе `23505` из гонки. Тост остаётся тому, у чего поля нет, — вроде отказа в самой
     * записи по правам. Разбирает 409 наравне с 400 общий `errorFields`: он смотрит на `fields`,
     * а не на код ответа.
     */
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={record ? 'Редактирование модели' : 'Новая модель аппарата'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={saveMut.isPending}
      okText={onSaved && !record ? 'Завести и выбрать' : undefined}
      width={440}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => saveMut.mutate(v)}
        {...blockers.formProps}
      >
        <Form.Item
          name="equipmentTypeId"
          label="Тип"
          rules={[{ required: true, message: 'Выберите тип' }]}
          extra={
            lockedTypeId
              ? record
                ? 'Тип модели неизменяем: не тот тип — заведите модель заново'
                : 'Тип берётся из карточки техники: картридж подбирают по модели её типа'
              : undefined
          }
        >
          <AutoSelect
            options={typeOptions}
            loading={typesLoading}
            disabled={!!lockedTypeId}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item
          name="name"
          label="Наименование"
          rules={[{ required: true, message: 'Укажите наименование модели' }]}
          // Написание — канон справочника: по нему модель узнают и в перечне, и в строке техники,
          // куда оно уезжает зеркалом. Регистр база не трогает («ECOSYS», «i-Sensys» — фирменные
          // написания), а лишние пробелы сворачивает сама.
          extra="Как на корпусе: Ricoh Aficio MP 201SPF, Kyocera ECOSYS M3145"
        >
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item
          name="manufacturer"
          label="Производитель"
          // Отдельным полем, хотя оно и повторяет первое слово названия: так спрашивают «все
          // Ricoh» — и поиск в окне идёт по обоим полям сразу.
          extra="Ricoh, Kyocera, Pantum"
        >
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
        <Form.Item
          name="isActive"
          label="Активна"
          valuePropName="checked"
          extra="Погашенную модель не предлагают при заведении техники; у заведённых карточек она остаётся"
        >
          <Switch />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
