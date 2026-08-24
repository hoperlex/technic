import { Button, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, EditOutlined, NumberOutlined } from '@ant-design/icons';
import type { OfficeEquipmentConsumableDto } from '@technic/contracts';
import { actionsColumn, RowActionButton, textColumn, type CardConfig } from '@shared/ui';

/**
 * Как перечень картриджей и тонеров выглядит списком: колонки таблицы и карточка строки на
 * телефоне (план `docs/office-equipment-consumables-plan.md`, Р8, Р11; приём
 * `officeEquipmentModelGrid`).
 *
 * Отдельным модулем от самого окна: в окне остаётся работа с данными — запросы, отбор, форма,
 * мутации и подтверждения, — а описание представления читается целиком, не пролистывая их. Обе
 * фабрики принимают действия, а не берут их из контекста: строка одинакова и в таблице, и в
 * карточке, и различать их должно одно место.
 */

/** Отказ сервера в удалении — им же объясняется и выключенная кнопка (Р11). */
const HAS_HISTORY_HINT =
  'По расходнику есть движение остатка: журнал не подчищают, снимите «Активен» вместо удаления';

/**
 * Что означает столбец «В парке» (Р12, Р15). Подпись обязательная, а не пояснительная: число
 * считается в области смотрящего тем же предикатом, что и список техники, и роль одной площадки
 * увидит здесь свои аппараты, а не весь парк. Без этой строки два человека за одним столом решили
 * бы, что портал им врёт.
 *
 * И второе, что она обязана проговаривать: ноль здесь — «у вас таких аппаратов нет», а не
 * «позиция ничему не подходит». На второй вопрос отвечает столбец «Модели», и подменять один
 * ответ другим нельзя — заказ отменяют по первому, а номенклатуру правят по второму.
 */
export const PARK_COUNT_HINT =
  'Столбец «В парке» — сколько аппаратов, которым подходит позиция, стоит в вашей области видимости (живых и активных); ноль означает «у вас таких нет», а не «позиция ничему не подходит».';

/** Почему у остатка нет колонки-правки: он меняется событием, а не ячейкой таблицы (Р7). */
export const STOCK_HINT =
  'Остаток правится своим окном — кнопкой «Изменить остаток» в строке или в карточке: у каждого изменения спрашивают причину, и оно попадает в журнал.';

export interface OfficeEquipmentConsumableGridActions {
  /**
   * Ведение номенклатуры (Р10): заведение, правка, гашение и удаление позиции. Своё право, а не
   * общее `officeEquipment.write`: иначе человеку, ведущему один справочник картриджей, пришлось
   * бы выдать правку всего парка.
   */
  canManage: boolean;
  /**
   * Ручная правка остатка — второе, независимое право (Р10): пересчитать коробки на полке и
   * завести позицию номенклатуры это разные работы, и делают их разные люди. Поэтому кнопка стоит
   * и в строке: у кладовщика без `manage` карточка не откроется на правку вовсе, а остаток
   * править ему можно.
   */
  canStock: boolean;
  /** Открыть карточку: правку у ведущего номенклатуру, чтение — у всех прочих. */
  onOpen: (consumable: OfficeEquipmentConsumableDto) => void;
  onStock: (consumable: OfficeEquipmentConsumableDto) => void;
  onDelete: (consumable: OfficeEquipmentConsumableDto) => void;
}

/** Остаток числом: ноль — это ответ «заказывать», и читаться он должен с одного взгляда (§6). */
function quantityText(consumable: OfficeEquipmentConsumableDto) {
  return consumable.quantity === 0 ? (
    <Typography.Text type="danger" strong>
      0
    </Typography.Text>
  ) : (
    <Typography.Text strong>{consumable.quantity}</Typography.Text>
  );
}

export function officeEquipmentConsumableColumns({
  canManage,
  canStock,
  onOpen,
  onStock,
  onDelete,
}: OfficeEquipmentConsumableGridActions): TableColumnType<OfficeEquipmentConsumableDto>[] {
  return [
    textColumn<OfficeEquipmentConsumableDto>({
      key: 'code',
      title: 'Код',
      dataIndex: 'code',
      searchable: false,
      width: 150,
    }),
    textColumn<OfficeEquipmentConsumableDto>({
      key: 'name',
      title: 'Наименование',
      dataIndex: 'name',
      searchable: false,
      render: (_v, r) => (
        <>
          {r.name}
          {r.comment && (
            <>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.comment}
              </Typography.Text>
            </>
          )}
        </>
      ),
    }),
    {
      key: 'color',
      title: 'Цвет',
      dataIndex: 'color',
      width: 120,
      /*
       * Сортировки нет: среди полей контракта цвета нет, и сортируемый заголовок обещал бы
       * порядок, на который маршрут ответит 400.
       *
       * Пусто — это ответ «у чёрно-белой позиции цвета не бывает», а не «не заполнили» (Р5),
       * поэтому прочерк, а не пустая ячейка: пустую читают как недоделку справочника.
       */
      render: (value: unknown) =>
        (value as string | null) || <Typography.Text type="secondary">—</Typography.Text>,
    },
    textColumn<OfficeEquipmentConsumableDto>({
      key: 'quantity',
      title: 'Наличие',
      dataIndex: 'quantity',
      searchable: false,
      width: 110,
      // Сортировка по остатку — то, ради чего в справочник заходят перед заказом: срез «что
      // заказывать» читается снизу, с нулей (Р9). Своей подсказки у ячейки нет: почему число не
      // правится прямо здесь, сказано один раз строкой под отборами.
      render: (_v, r) => quantityText(r),
    }),
    {
      key: 'models',
      title: 'Модели',
      width: 110,
      /*
       * Сортировки по числу моделей сервер не принимает (поля контракта — наименование, код,
       * остаток, дата): сортируемый заголовок обещал бы порядок, на который маршрут ответит 400.
       *
       * Само число — длина набора из ответа, а не отдельный счётчик: второе число, посчитанное
       * своим запросом, разошлось бы с перечнем в карточке.
       */
      render: (_value: unknown, r: OfficeEquipmentConsumableDto) =>
        r.models.length === 0 ? (
          // Ноль — не украшение строки, а дыра справочника: к чему подходит код, ИТ-служба ещё не
          // сказала, и такой расходник не найдётся отбором по модели (Р6).
          <Tooltip title="Модели не указаны: расходник не найдётся отбором «что подходит к аппарату»">
            <Tag>—</Tag>
          </Tooltip>
        ) : (
          <Tooltip title={r.models.map((m) => m.name).join(', ')}>{r.models.length}</Tooltip>
        ),
    },
    {
      key: 'equipmentCount',
      title: 'В парке',
      dataIndex: 'equipmentCount',
      width: 110,
      /*
       * Сортировки нет, и это не забывчивость: число считается в области смотрящего (Р12), и
       * порядок строк, зависящий от того, кто открыл окно, читается как ошибка портала. Сервер
       * такого поля сортировки и не принимает.
       */
      render: (value: unknown) => <Tooltip title={PARK_COUNT_HINT}>{value as number}</Tooltip>,
    },
    {
      key: 'isActive',
      title: 'Активность',
      dataIndex: 'isActive',
      width: 130,
      // Тем же поводом, что и у «Моделей»: активности среди полей сортировки контракта нет.
      render: (value: unknown) => (
        <Tag color={value ? 'green' : 'default'}>{value ? 'Активен' : 'Погашен'}</Tag>
      ),
    },
    // Строка действий есть у всех: карточку с журналом читают по `officeEquipment.read` (Р10) —
    // подобрать картридж должен каждый, кому видна оргтехника. Различается набор действий в ней.
    actionsColumn<OfficeEquipmentConsumableDto>(
      (r) => (
        <Space>
          <RowActionButton
            // Подпись честная: без права ведения номенклатуры карточка открывается на чтение,
            // и обещать «Редактировать» там, где сохранить нельзя, значит звать на отказ.
            title={canManage ? 'Редактировать' : 'Открыть карточку'}
            icon={<EditOutlined />}
            onClick={() => onOpen(r)}
          />
          {/* Остаток — своим действием прямо из строки: у права `stock` карточка на правку не
                открывается, а пересчитать полку ему разрешено (Р10). */}
          {canStock && (
            <RowActionButton
              title="Изменить остаток"
              icon={<NumberOutlined />}
              onClick={() => onStock(r)}
            />
          )}
          {/*
           * Удаление доступно, пока по расходнику нет ни одного движения остатка: так
           * убирают опечатку первого дня. Дальше историю не подчищают — её держит
           * `ON DELETE RESTRICT` журнала, а не доброта маршрута (Р11).
           *
           * Кнопка обёрнута руками: antd гасит события указателя на выключенной кнопке, и
           * своя подсказка `RowActionButton` на ней не открылась бы — запрет остался бы без
           * объяснения.
           */}
          {canManage && (
            <Tooltip title={r.hasStockHistory ? HAS_HISTORY_HINT : 'Удалить'}>
              <span>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label="Удалить"
                  disabled={r.hasStockHistory}
                  onClick={() => onDelete(r)}
                />
              </span>
            </Tooltip>
          )}
        </Space>
      ),
      130,
    ),
  ];
}

/** Строка списка на телефоне (ADR 0030): та же запись, другой способ показать. */
export function officeEquipmentConsumableCard({
  canManage,
  canStock,
  onOpen,
  onStock,
  onDelete,
}: OfficeEquipmentConsumableGridActions): CardConfig<OfficeEquipmentConsumableDto> {
  return {
    title: (r) => r.name,
    badge: (r) => (
      <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Активен' : 'Погашен'}</Tag>
    ),
    primary: (r) => (r.color ? `${r.code} · ${r.color}` : r.code),
    lines: [
      (r) => `В наличии: ${r.quantity}`,
      (r) => (r.models.length === 0 ? 'Модели не указаны' : `Подходит к: ${r.models.length}`),
      // Подпись целиком, а не одно число: в карточке телефона подсказке по наведению взяться
      // неоткуда, а число без области читается как масштаб всего парка (Р12).
      (r) => `В парке: ${r.equipmentCount} (в вашей области, активных)`,
    ],
    // Касание по карточке ведёт туда, где человек и так работает, — в саму карточку: у ведущего
    // номенклатуру на правку, у прочих на чтение вместе с журналом.
    onOpen,
    actions: (r) => [
      {
        key: 'open',
        label: canManage ? 'Редактировать' : 'Открыть карточку',
        onClick: () => onOpen(r),
      },
      ...(canStock ? [{ key: 'stock', label: 'Изменить остаток', onClick: () => onStock(r) }] : []),
      ...(canManage
        ? [
            {
              key: 'delete',
              label: 'Удалить',
              danger: true,
              // Тот же признак, что и у кнопки в таблице: движение остатка запирает удаление (Р11).
              disabled: r.hasStockHistory,
              onClick: () => onDelete(r),
            },
          ]
        : []),
    ],
  };
}
