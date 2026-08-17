import { Checkbox, Form, Input, InputNumber, Switch, Typography, type FormInstance } from 'antd';
import {
  FREIGHT_VEHICLE_KIND_CODE,
  LINEAR_VEHICLE_TYPE_HINT,
  LINEAR_VEHICLE_TYPE_LABEL,
  MAINTENANCE_BASIS_HINT,
  MAINTENANCE_BASIS_LABEL,
  type VehicleTypeDto,
} from '@technic/contracts';
import { AutoSelect } from '@shared/ui';

/**
 * Поля формы типа ТС — те же у заведения и у правки, и живут отдельно от списка (ADR 0005).
 *
 * Отдельным файлом, потому что вопросов у типа стало больше, чем колонок у списка: бланк листа,
 * линейность, разметка ТО — каждый со своим объяснением, и каждый следующий рос бы внутри вкладки,
 * которая про таблицу, а не про форму. Форма умеет ровно одно — спросить и объяснить; что делать с
 * ответами, решает вкладка (у линейности, например, свой протокол переключения).
 */

export interface VtFormValues {
  kindId?: string;
  code?: string;
  name?: string;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
  /** Легковой ли транспорт: им выбирается бланк листа — форма № 3 вместо 4-П (ADR 0065). */
  isPassenger?: boolean;
  /** Линейная техника: заказ такого типа на объект ведётся днями, а не неделями стояния. */
  isLinear?: boolean;
  /**
   * Ведётся ли ТО по пробегу (Р13). В форме — галочка, в модели — основание расчёта: перевод
   * делают `maintenanceBasisOf`/`isOdometerMaintenance`, чтобы третье основание (моточасы) стало
   * правкой перевода, а не правкой формы.
   */
  maintenanceByOdometer?: boolean;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

interface Props {
  form: FormInstance<VtFormValues>;
  /** Правка — тип, который правят; заведение — `null`: у него вид и код ещё спрашивают. */
  record: VehicleTypeDto | null;
  kinds: { id: string; code: string; name: string }[];
  kindsLoading: boolean;
}

export function VehicleTypeFormFields({ form, record, kinds, kindsLoading }: Props) {
  const isEdit = !!record;
  const kindOptions = kinds.map((k) => ({ value: k.id, label: k.name }));

  /**
   * Вид ТС формы: у правки он свой (вид неизменяем), у заведения — тот, что выбрали. Им решается,
   * спрашивать ли про легковой транспорт: бланк есть только там, где машина едет рейсом.
   */
  const watchKindId = Form.useWatch('kindId', form);
  const formKindCode = isEdit ? record.kindCode : kinds.find((k) => k.id === watchKindId)?.code;
  // За признаком следим, потому что им меняется правда о путевых листах типа: у линейного ЭСМ-2
  // сам не выписывается, и подпись рядом обязана говорить то же, что будет делать портал.
  const watchIsLinear = Form.useWatch('isLinear', form);

  const codeRules = isEdit
    ? []
    : [
        { required: true, message: 'Укажите код' },
        {
          pattern: CODE_PATTERN,
          message: 'Только строчные латинские, цифры и _, первый символ — буква',
        },
      ];

  return (
    <>
      {isEdit ? (
        <Form.Item label="Вид">
          <Input value={record.kindName} disabled />
        </Form.Item>
      ) : (
        <Form.Item name="kindId" label="Вид" rules={[{ required: true, message: 'Выберите вид' }]}>
          <AutoSelect options={kindOptions} loading={kindsLoading} placeholder="Выберите вид" />
        </Form.Item>
      )}

      <Form.Item name="code" label="Код" rules={codeRules}>
        {/* Код — стабильный системный идентификатор, неизменяем после создания. */}
        <Input disabled={isEdit} placeholder="например truck_cranes" />
      </Form.Item>

      <Form.Item
        name="name"
        label="Наименование типа"
        rules={[{ required: true, message: 'Укажите наименование' }]}
      >
        <Input />
      </Form.Item>

      <Form.Item name="description" label="Описание">
        <Input.TextArea rows={2} />
      </Form.Item>

      <Form.Item name="sortOrder" label="Порядок сортировки">
        <InputNumber style={{ width: '100%' }} min={0} />
      </Form.Item>

      <Form.Item name="isActive" label="Активен" valuePropName="checked">
        <Switch />
      </Form.Item>

      {/* Бланк листа — вопросом «легковой ли это транспорт», а не выбором формы: так его
          задаёт тот, кто ведёт справочник, и так он звучит на языке парка. Умолчание — 4-П:
          у собственной техники лист есть всегда (ADR 0065).

          У спецтехники поля нет вовсе: её недельный ЭСМ-2 бланком типа не задаётся (он идёт от
          заявки), а всё, что печатается на рейс, — перегон на объект и день линейной техники —
          идёт по 4-П независимо от типа. Отвечать тут не на что. */}
      {formKindCode === FREIGHT_VEHICLE_KIND_CODE && (
        <Form.Item
          name="isPassenger"
          valuePropName="checked"
          extra="Путевой лист выписывается по форме № 3 (легковой автомобиль) вместо 4-П"
        >
          <Checkbox>Легковой транспорт</Checkbox>
        </Form.Item>
      )}
      {!!formKindCode && formKindCode !== FREIGHT_VEHICLE_KIND_CODE && (
        <Form.Item label="Путевой лист">
          {/* Первая половина подписи зависит от признака: у линейного типа портал ЭСМ-2 сам
              не выписывает и перегона не заводит вовсе — техника ночует в гараже, — поэтому
              прежняя фраза стала бы обещанием, которого портал не сдержит. Вторая половина
              верна в обоих случаях: бланк такому типу не закрепляют. */}
          <Typography.Text type="secondary">
            {watchIsLinear
              ? 'ЭСМ-2 по заявке на технику выписывается по требованию, а день работ на объекте печатается по 4-П.'
              : 'ЭСМ-2 портал выписывает сам по заявке на технику, а перегон на объект — по 4-П.'}{' '}
            Бланк такому типу не задаётся.
          </Typography.Text>
        </Form.Item>
      )}

      {/* Линейная техника — про то, как ведётся заказ, а не про бланк, поэтому вопрос стоит
          у типов любого вида: на объект заказывают и самосвал под вывоз грунта, и работает
          он там сменами наравне с экскаватором. Соседний «Легковой транспорт» остаётся у
          грузового вида: он про форму листа, и у спецтехники отвечать на него нечем.

          Подпись и пояснение — из контрактов: ту же формулировку сервер печатает заголовком
          колонки в выгрузке справочника, и разойтись им нельзя. */}
      <Form.Item name="isLinear" valuePropName="checked" extra={LINEAR_VEHICLE_TYPE_HINT}>
        <Checkbox>{LINEAR_VEHICLE_TYPE_LABEL}</Checkbox>
      </Form.Item>

      {/* Разметка ТО (Р13). Вопрос стоит у типов любого вида и рядом с линейностью, потому что
          отвечает на него тот же человек и в тот же заход: заводя тип, он знает, есть ли у этой
          техники одометр и ведут ли по нему обслуживание.

          Пояснение обязано называть последствие снятой галочки, а не только смысл поставленной:
          умолчание справочника — «не ведётся», и без этой фразы пустая колонка ТО в гараже
          читается как поломка портала, а не как неразмеченный тип. */}
      <Form.Item
        name="maintenanceByOdometer"
        valuePropName="checked"
        extra={MAINTENANCE_BASIS_HINT}
      >
        <Checkbox>{MAINTENANCE_BASIS_LABEL}</Checkbox>
      </Form.Item>
    </>
  );
}
