import { useState } from 'react';
import { Button, DatePicker, Form, Input, Space, Switch } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { OfficeEquipmentModelRefDto } from '@technic/contracts';
import { AutoSelect } from '@shared/ui';
import { withSavedOption } from '@shared/lib';
import { officeEquipmentModelOptionsQuery } from '../api/queries';
import { OfficeEquipmentModelFormModal } from './OfficeEquipmentModelFormModal';

interface Option {
  value: string;
  label: string;
}

interface Props {
  typeOptions: Option[];
  typesLoading: boolean;
  objectOptions: Option[];
  departmentOptions: Option[];
  /**
   * Модель уже заведённой карточки — только для правки. Список выбора собирается из действующих
   * моделей (Р11), а у карточки может стоять погашенная: без сохранённого варианта правка кабинета
   * начиналась бы с пустого обязательного поля, то есть требовала бы заодно сменить модель.
   */
  savedModel?: OfficeEquipmentModelRefDto | null;
}

/**
 * Поля карточки оргтехники. Отдельным компонентом от вкладки: полей одиннадцать, и вместе с
 * запросами, мутациями и подтверждениями удаления они превращали экран в файл, который читают
 * прокруткой. Компонент ничего не знает ни про сохранение карточки, ни про её удаление — только
 * про поля и их правила.
 *
 * Формой владеет вкладка (`Form form={form}` там же): здесь только `Form.Item`, поэтому компонент
 * одинаково работает и при заведении, и при правке.
 *
 * Единственный собственный запрос — перечень моделей выбранного типа (Р1): он зависит от поля,
 * которое компонент же и рисует, и вынести его наружу значило бы попросить обоих вызывающих
 * следить за типом за него.
 */
export function OfficeEquipmentFields({
  typeOptions,
  typesLoading,
  objectOptions,
  departmentOptions,
  savedModel,
}: Props) {
  const form = Form.useFormInstance();
  const equipmentTypeId = Form.useWatch<string | undefined>('equipmentTypeId', form);
  const [modelFormOpen, setModelFormOpen] = useState(false);
  /**
   * Модель, заведённая только что из этой же формы. Держится состоянием, потому что список
   * вариантов придёт перезапросом не сразу, а поле заполняется тем же нажатием: без неё человек
   * секунду видел бы в поле идентификатор вместо названия.
   */
  const [createdModel, setCreatedModel] = useState<OfficeEquipmentModelRefDto | null>(null);

  const { data: modelOptions = [], isFetching: modelsLoading } = useQuery(
    officeEquipmentModelOptionsQuery(equipmentTypeId),
  );
  /**
   * Сохранённая и только что заведённая модели добавляются к списку, если из него выпали.
   * Обычными вариантами, а не выключенными: сервер обе принимает — правку, не меняющую ссылку, он
   * не перепроверяет вовсе (Р11), а свежезаведённая модель активна по определению.
   */
  const models = withSavedOption(
    withSavedOption(modelOptions, { id: savedModel?.id, name: savedModel?.name }),
    { id: createdModel?.id, name: createdModel?.name },
  );

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
          /*
           * Смена типа сбрасывает модель — обязательно, а не для порядка: у модели тип неизменяем
           * (Р1), и модель прежнего типа маршрут отобьёт 422 на паре «модель — тип». Из формы
           * такая пара не должна складываться вовсе.
           *
           * Сброс живёт здесь, а не в `onValuesChange` вызывающего, потому что оба поля рисует
           * этот компонент: разложенное по двум формам-хозяевам правило разошлось бы при первой
           * правке одной из них. Свой `onChange` у поля формы законен — `@rc-component/form`
           * зовёт его следом за собственным обработчиком, а не вместо.
           */
          onChange={() => {
            form.setFieldValue('modelId', undefined);
            setCreatedModel(null);
          }}
        />
      </Form.Item>
      {/*
       * Свободного ввода здесь больше нет (Р1): картридж подходит модели, а не отдельной карточке,
       * и «Ricon MP C2503», набранный по памяти, означал бы аппарат, к которому нечем подобрать
       * расходник. Перечень — из справочника, а чего в нём нет, заводят кнопкой рядом: без неё
       * оператор упрётся на первой же машине, которой в перечне не значится.
       *
       * Поле и кнопка стоят в одной строке, поэтому само поле — вложенный `noStyle`: `Form.Item`
       * подставляет значение единственному ребёнку, и связкой владел бы `Space.Compact`. Ошибку
       * вложенное поле отдаёт внешнему — прокрутка и вспышка находят его наравне с прочими
       * (ADR 0094).
       */}
      <Form.Item
        label="Модель"
        required
        // Подпись обязана указывать на само поле: `for` внешний `Form.Item` без `name` не
        // проставляет, и без этого «Модель» осталась бы подписью, по которой не встать в поле —
        // ни мышью, ни с клавиатуры, ни в тесте.
        htmlFor="modelId"
        extra={
          equipmentTypeId
            ? undefined
            : 'Модели показываются по типу: одноимённые принтер и МФУ — разные модели'
        }
      >
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item
            name="modelId"
            noStyle
            rules={[{ required: true, message: 'Выберите модель аппарата' }]}
          >
            <AutoSelect
              style={{ width: '100%' }}
              /*
               * Единственная модель сама в поле не встаёт — в отличие от типа и объекта, и это не
               * непоследовательность. Перечень моделей меняется вслед за типом, и между сбросом
               * поля и приходом нового перечня есть промежуток, в котором поле уже пусто, а список
               * ещё прежнего типа: подстановка «единственного» вернула бы туда модель чужого типа —
               * ровно ту пару, которую сервер отбивает 422 (Р1). Проверено тестом «сбрасывает выбор
               * при смене типа»: с подстановкой он краснеет.
               */
              autoSelectSole={false}
              options={models}
              loading={modelsLoading}
              disabled={!equipmentTypeId}
              showSearch
              optionFilterProp="label"
              placeholder={equipmentTypeId ? 'Ricoh Aficio MP 201SPF' : 'Сначала выберите тип'}
            />
          </Form.Item>
          <Button
            icon={<PlusOutlined />}
            disabled={!equipmentTypeId}
            title="Завести модель"
            aria-label="Завести модель"
            onClick={() => setModelFormOpen(true)}
          />
        </Space.Compact>
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

      {/* Окно заведения модели стоит внутри формы карточки намеренно: antd поднимает z-index
          вложенного окна над родительским по контексту, а соседнее на телефоне оказалось бы под
          шторкой карточки. Заведённая модель тут же встаёт в поле — за этим кнопку и нажимали. */}
      <OfficeEquipmentModelFormModal
        open={modelFormOpen}
        onCancel={() => setModelFormOpen(false)}
        typeOptions={typeOptions}
        typesLoading={typesLoading}
        lockedTypeId={equipmentTypeId}
        onSaved={(model) => {
          setCreatedModel({ id: model.id, name: model.name });
          form.setFieldValue('modelId', model.id);
        }}
      />
    </>
  );
}
