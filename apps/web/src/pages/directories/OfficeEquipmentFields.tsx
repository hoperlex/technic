import { DatePicker, Form, Input, Switch } from 'antd';
import { AutoSelect } from '@shared/ui';

interface Option {
  value: string;
  label: string;
}

interface Props {
  typeOptions: Option[];
  typesLoading: boolean;
  objectOptions: Option[];
  departmentOptions: Option[];
}

/**
 * Поля карточки оргтехники. Отдельным компонентом от вкладки: полей одиннадцать, и вместе с
 * запросами, мутациями и подтверждениями удаления они превращали экран в файл, который читают
 * прокруткой. Компонент ничего не знает ни про запросы, ни про сохранение — только про поля и их
 * правила, а данные для выпадающих списков получает готовыми.
 *
 * Формой владеет вкладка (`Form form={form}` там же): здесь только `Form.Item`, поэтому
 * компонент одинаково работает и при заведении, и при правке.
 */
export function OfficeEquipmentFields({
  typeOptions,
  typesLoading,
  objectOptions,
  departmentOptions,
}: Props) {
  return (
    <>
      <Form.Item
        name="equipmentTypeId"
        label="Тип"
        rules={[{ required: true, message: 'Выберите тип' }]}
      >
        <AutoSelect
          options={typeOptions}
          loading={typesLoading}
          showSearch
          optionFilterProp="label"
        />
      </Form.Item>
      <Form.Item name="name" label="Модель" rules={[{ required: true, message: 'Укажите модель' }]}>
        <Input maxLength={255} placeholder="Kyocera ECOSYS M3145" />
      </Form.Item>
      <Form.Item name="serialNumber" label="Серийный номер">
        <Input maxLength={100} />
      </Form.Item>
      <Form.Item
        name="inventoryNumber"
        label="Инвентарный номер"
        // Проверка стоит на инвентарном номере, как и в контрактах: путь ошибки у сервера тот
        // же, и отказ API ляжет на то же поле, что и проверка формы.
        dependencies={['serialNumber']}
        extra="Нужен хотя бы один номер: по нему единицу опознают при приёмке из ремонта"
        rules={[
          ({ getFieldValue }) => ({
            validator: (_r, value: string | undefined) =>
              value?.trim() || (getFieldValue('serialNumber') as string | undefined)?.trim()
                ? Promise.resolve()
                : Promise.reject(new Error('Укажите серийный или инвентарный номер')),
          }),
        ]}
      >
        <Input maxLength={100} />
      </Form.Item>
      <Form.Item
        name="objectId"
        label="Объект"
        rules={[{ required: true, message: 'Выберите объект' }]}
      >
        <AutoSelect options={objectOptions} showSearch optionFilterProp="label" />
      </Form.Item>
      <Form.Item
        name="departmentId"
        label="Отдел-владелец"
        extra="Пусто — единица не закреплена ни за кем; такие видно фильтром «Без владельца»"
      >
        {/* Необязательное поле: пустое значение здесь — осмысленный ответ, поэтому
          единственный вариант само не подставляется. */}
        <AutoSelect
          options={departmentOptions}
          autoSelectSole={false}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Не закреплена"
        />
      </Form.Item>
      <Form.Item name="location" label="Место">
        <Input maxLength={255} placeholder="Кабинет 204, приёмная" />
      </Form.Item>
      <Form.Item name="purchasedOn" label="Дата покупки">
        <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
      </Form.Item>
      <Form.Item
        name="warrantyUntil"
        label="Гарантия до"
        extra="Последний день гарантии поставщика — он в неё входит"
      >
        <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
      </Form.Item>
      <Form.Item name="comment" label="Комментарий">
        <Input.TextArea rows={2} maxLength={2000} />
      </Form.Item>
      <Form.Item name="isActive" label="Активна" valuePropName="checked">
        <Switch />
      </Form.Item>
    </>
  );
}
