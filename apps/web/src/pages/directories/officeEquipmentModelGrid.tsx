import { Button, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import type { OfficeEquipmentModelDto } from '@technic/contracts';
import {
  actionsColumn,
  boolBadgeColumn,
  RowActionButton,
  textColumn,
  type CardConfig,
} from '@shared/ui';

/**
 * Как перечень моделей аппаратов выглядит списком: колонки таблицы и карточка строки на телефоне
 * (план `docs/office-equipment-consumables-plan.md`, Р8; приём `wasteTariffGrid`).
 *
 * Отдельным модулем от самого окна: в окне остаётся работа с данными — запросы, отбор, форма,
 * мутации и подтверждения, — а описание представления читается целиком, не пролистывая их. Обе
 * фабрики принимают действия, а не берут их из контекста: строка одинакова и в таблице, и в
 * карточке, и различать их должно одно место.
 */

/** Отказ сервера в удалении — им же объясняется и выключенная кнопка (Р11). */
const USED_HINT = 'На модель ссылается техника, снимите «Активна» вместо удаления';

/**
 * Что означает столбец «В парке» (Р12). Подпись обязательная, а не пояснительная: число считается
 * в области смотрящего, и роль одной площадки увидит здесь свои аппараты, а не весь парк, — без
 * этой строки два человека за одним столом решили бы, что портал им врёт.
 */
/**
 * Что означает отбор «без расходника» (Р15). Подпись обязательная: срез отвечает на вопрос «чем
 * эти аппараты заправлять — неизвестно», по нему ИТ-служба и дозаполняет номенклатуру, а его
 * пустота означает «покрыли всё». Погашенный расходник при этом считается заведённым: «больше не
 * покупаем» модель непокрытой не делает — это другой разговор и другой срез, в окне картриджей.
 */
export const UNCOVERED_HINT =
  'Модели, к которым не привязан ни один картридж или тонер: по этому срезу дозаполняют номенклатуру, и пустой он означает, что заправлять есть чем всё.';

export const MODEL_COUNT_HINT =
  'Столбец «В парке» — активные карточки этой модели в вашей области видимости: архив и выведенная из эксплуатации техника в счёт не идут.';

export interface OfficeEquipmentModelGridActions {
  /** Ведение справочника: без него в строке остаётся только чтение (ADR 0033 §6). */
  canWrite: boolean;
  onEdit: (model: OfficeEquipmentModelDto) => void;
  onDelete: (model: OfficeEquipmentModelDto) => void;
}

export function officeEquipmentModelColumns({
  canWrite,
  onEdit,
  onDelete,
}: OfficeEquipmentModelGridActions): TableColumnType<OfficeEquipmentModelDto>[] {
  return [
    textColumn<OfficeEquipmentModelDto>({
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
    textColumn<OfficeEquipmentModelDto>({
      key: 'type',
      title: 'Тип',
      dataIndex: 'type',
      searchable: false,
      width: 160,
      render: (_v, r) => (
        <Space size={6}>
          {r.type.name}
          {/* Модель жива, а тип снят с оборота: строка обязана объяснить, почему такой техники
              больше не заводят. */}
          {!r.type.isActive && <Tag>Не используется</Tag>}
        </Space>
      ),
    }),
    textColumn<OfficeEquipmentModelDto>({
      key: 'manufacturer',
      title: 'Производитель',
      dataIndex: 'manufacturer',
      searchable: false,
      width: 180,
      render: (_v, r) => r.manufacturer || <Typography.Text type="secondary">—</Typography.Text>,
    }),
    textColumn<OfficeEquipmentModelDto>({
      key: 'equipmentCount',
      title: 'В парке',
      dataIndex: 'equipmentCount',
      // Сортировки по счётчику нет намеренно, и сервер её не принимает (Р11): число считается в
      // области смотрящего, и порядок строк зависел бы от того, кто открыл окно.
      sortable: false,
      searchable: false,
      width: 110,
      render: (_v, r) => <Tooltip title={MODEL_COUNT_HINT}>{r.equipmentCount}</Tooltip>,
    }),
    boolBadgeColumn<OfficeEquipmentModelDto>({
      key: 'isActive',
      title: 'Активность',
      dataIndex: 'isActive',
      trueText: 'Активна',
      falseText: 'Погашена',
      // Выпадашки отбора в заголовке нет: активность спрашивается полосой над таблицей, и два
      // места для одного вопроса разошлись бы — в заголовке отбор виден, а в полосе он был бы уже
      // другим.
      width: 140,
    }),
    // Строка действий есть только у ведущего справочник: читателю в окне остаётся перечень
    // (ADR 0033 §6). Само окно сегодня открывается только из-под права записи, но опираться на
    // это нельзя — следующим его откроет карточка расходника (Р15).
    ...(canWrite
      ? [
          actionsColumn<OfficeEquipmentModelDto>(
            (r) => (
              <Space>
                <RowActionButton
                  title="Редактировать"
                  icon={<EditOutlined />}
                  onClick={() => onEdit(r)}
                />
                {/*
                 * Удаление доступно по `isUsed`, а не по счётчику: `equipmentCount` считается в
                 * области смотрящего, и ноль в нём означает «у вас таких нет», а не «модель
                 * свободна» (Р11, Р12). Удалить не даёт и чужая карточка — в том числе архивная.
                 *
                 * Кнопка обёрнута руками: antd гасит события указателя на выключенной кнопке, и
                 * своя подсказка `RowActionButton` на ней не открылась бы — запрет остался бы без
                 * объяснения.
                 */}
                <Tooltip title={r.isUsed ? USED_HINT : 'Удалить'}>
                  <span>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="Удалить"
                      disabled={r.isUsed}
                      onClick={() => onDelete(r)}
                    />
                  </span>
                </Tooltip>
              </Space>
            ),
            100,
          ),
        ]
      : []),
  ];
}

/** Строка списка на телефоне (ADR 0030): та же запись, другой способ показать. */
export function officeEquipmentModelCard({
  canWrite,
  onEdit,
  onDelete,
}: OfficeEquipmentModelGridActions): CardConfig<OfficeEquipmentModelDto> {
  return {
    title: (r) => r.name,
    badge: (r) => (
      <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Активна' : 'Погашена'}</Tag>
    ),
    primary: (r) => r.type.name,
    lines: [
      (r) => r.manufacturer || null,
      (r) => `В парке: ${r.equipmentCount} (в вашей области, активных)`,
    ],
    // Касание по карточке ведёт туда, где человек и так работает, — в правку; читателю открывать
    // нечего, и карточка остаётся просто строкой.
    onOpen: canWrite ? onEdit : undefined,
    actions: canWrite
      ? (r) => [
          { key: 'edit', label: 'Редактировать', onClick: () => onEdit(r) },
          {
            key: 'delete',
            label: 'Удалить',
            danger: true,
            // Тот же признак, что и у кнопки в таблице: ссылки считаются по всему парку (Р11).
            disabled: r.isUsed,
            onClick: () => onDelete(r),
          },
        ]
      : undefined,
  };
}
