import { Button, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, EditOutlined, HistoryOutlined, SwapOutlined } from '@ant-design/icons';
import { officeEquipmentTitle, type OfficeEquipmentDto } from '@technic/contracts';
import { actionsColumn, boolBadgeColumn, textColumn, type CardConfig } from '@shared/ui';
import { EquipmentStateTag, WarrantyTag } from '@entities/office-equipment';

/**
 * Как справочник оргтехники выглядит списком: колонки таблицы и карточка строки на телефоне
 * (ADR 0042). Отдельным модулем от самой вкладки — по образцу `wasteTariffGrid`: во вкладке
 * остаётся работа с данными (запросы, форма, мутации), а описание представления читается целиком,
 * не пролистывая мутации.
 *
 * Обе фабрики принимают действия, а не берут их из контекста: строка одинакова и на десктопе, и в
 * карточке, и различать их должно одно место — вкладка.
 */

export interface OfficeEquipmentGridActions {
  /** Ведение справочника: без него в строке остаётся только чтение (ADR 0033 §6). */
  canWrite: boolean;
  /**
   * Правка и удаление карточки — работа справочника, и во вкладке модуля их нет вовсе (Р72):
   * там технику эксплуатируют, а не ведут. Поэтому необязательные: отсутствие обработчика значит
   * «этого действия здесь не бывает», а не «оно недоступно этой роли».
   */
  onEdit?: (record: OfficeEquipmentDto) => void;
  onDelete?: (record: OfficeEquipmentDto) => void;
  /** Перемещение (Р59): объект правкой карточки больше не меняется — у переезда своя ручка. */
  onMove: (record: OfficeEquipmentDto) => void;
  /** История единицы (Р62): перемещения и ремонты одной лентой. */
  onHistory: (record: OfficeEquipmentDto) => void;
}

/** Номера второй строкой: ими единицу и опознают, а называют её моделью. */
export function numbersLine(r: OfficeEquipmentDto): string {
  return [
    r.inventoryNumber && `инв. ${r.inventoryNumber}`,
    r.serialNumber && `SN ${r.serialNumber}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function officeEquipmentColumns({
  canWrite,
  onEdit,
  onDelete,
  onMove,
  onHistory,
}: OfficeEquipmentGridActions): TableColumnType<OfficeEquipmentDto>[] {
  return [
    textColumn<OfficeEquipmentDto>({
      key: 'type',
      title: 'Тип',
      dataIndex: 'type',
      searchable: false,
      width: 160,
      render: (_v, r) => (
        <>
          {r.type.name}
          {/* Единица активна, а тип снят с оборота: строка обязана объяснить, почему такой
              техники больше не заводят. */}
          {!r.type.isActive && (
            <>
              {' '}
              <Tag>Не используется</Tag>
            </>
          )}
        </>
      ),
    }),
    textColumn<OfficeEquipmentDto>({
      key: 'name',
      title: 'Модель',
      dataIndex: 'name',
      render: (_v, r) => (
        <>
          {r.name}
          {numbersLine(r) && (
            <>
              <br />
              <Typography.Text type="secondary">{numbersLine(r)}</Typography.Text>
            </>
          )}
        </>
      ),
    }),
    textColumn<OfficeEquipmentDto>({
      key: 'object',
      title: 'Объект',
      dataIndex: 'object',
      searchable: false,
      width: 200,
      // Код объекта первой строкой: им площадку и называют между собой, наименование — под ним.
      render: (_v, r) => (
        <>
          {r.object.code}
          <br />
          <Typography.Text type="secondary">{r.object.name}</Typography.Text>
        </>
      ),
    }),
    textColumn<OfficeEquipmentDto>({
      key: 'department',
      title: 'Отдел',
      dataIndex: 'department',
      sortable: false,
      searchable: false,
      width: 180,
      render: (_v, r) =>
        r.department ? (
          <>
            {r.department.code}
            <br />
            <Typography.Text type="secondary">{r.department.name}</Typography.Text>
          </>
        ) : (
          // Не пустая ячейка: единицу без владельца справочник и заведён размечать, и «ничего не
          // указано» здесь — задача, а не отсутствие данных.
          <Typography.Text type="secondary">не закреплена</Typography.Text>
        ),
    }),
    textColumn<OfficeEquipmentDto>({
      key: 'location',
      title: 'Место',
      dataIndex: 'location',
      sortable: false,
      searchable: false,
      ellipsis: true,
      // Под местом — состояние (Р61): «кабинет 214» и «в ремонте» отвечают на один и тот же
      // вопрос «где искать аппарат», и разносить их по разным колонкам незачем.
      render: (_v, r) => (
        <>
          {r.location || <Typography.Text type="secondary">—</Typography.Text>}
          {r.state !== 'on_site' && (
            <>
              <br />
              <EquipmentStateTag state={r.state} note={r.stateNote} />
            </>
          )}
        </>
      ),
    }),
    textColumn<OfficeEquipmentDto>({
      key: 'warrantyUntil',
      title: 'Гарантия',
      dataIndex: 'warrantyUntil',
      searchable: false,
      width: 190,
      render: (_v, r) => <WarrantyTag until={r.warrantyUntil} />,
    }),
    boolBadgeColumn<OfficeEquipmentDto>({
      key: 'isActive',
      title: 'Активна',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      filters: true,
      width: 120,
    }),
    actionsColumn<OfficeEquipmentDto>((r) => (
      <Space>
        {/* История видна всем, кому открыт справочник: «что с этим аппаратом делали» — вопрос
            читателя, а не только того, кто его ведёт. */}
        <Tooltip title="История">
          <Button size="small" icon={<HistoryOutlined />} onClick={() => onHistory(r)} />
        </Tooltip>
        {canWrite && (
          <>
            <Tooltip title="Переместить">
              <Button size="small" icon={<SwapOutlined />} onClick={() => onMove(r)} />
            </Tooltip>
            {/* Правки и удаления во вкладке модуля нет вовсе: карточку ведут в справочнике. */}
            {onEdit && <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(r)} />}
            {onDelete && (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(r)} />
            )}
          </>
        )}
      </Space>
    )),
  ];
}

/**
 * Карточка строки на телефоне (ADR 0042). Заголовок — то, чем единицу зовут в разговоре: модель и
 * номер (`officeEquipmentTitle`, он же в письмах). Гарантия отдельной строкой и только когда срок
 * заведён: прочерк в списке карточек занимал бы строку, ничего не сообщая.
 */
export function officeEquipmentCard({
  canWrite,
  onEdit,
  onDelete,
  onMove,
  onHistory,
}: OfficeEquipmentGridActions): CardConfig<OfficeEquipmentDto> {
  return {
    title: (r) => officeEquipmentTitle(r),
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => r.type.name,
    lines: [
      (r) => `${r.object.code} — ${r.object.name}`,
      (r) => (r.department ? `Отдел: ${r.department.name}` : 'Отдел: не закреплена'),
      (r) =>
        r.state === 'on_site' ? (
          r.location || null
        ) : (
          <Space size={4}>
            {r.location || 'Место:'} <EquipmentStateTag state={r.state} note={r.stateNote} />
          </Space>
        ),
      (r) =>
        r.warrantyUntil ? (
          <Space size={4}>
            Гарантия: <WarrantyTag until={r.warrantyUntil} />
          </Space>
        ) : null,
    ],
    // Нажатие по карточке ведёт туда, где человек и так работает: в справочнике это правка, во
    // вкладке модуля правки нет — открывается история.
    onOpen: canWrite && onEdit ? onEdit : onHistory,
    actions: (r) => [
      { key: 'history', label: 'История', onClick: () => onHistory(r) },
      ...(canWrite
        ? [
            { key: 'move', label: 'Переместить', onClick: () => onMove(r) },
            ...(onEdit ? [{ key: 'edit', label: 'Редактировать', onClick: () => onEdit(r) }] : []),
            ...(onDelete
              ? [{ key: 'delete', label: 'Удалить', danger: true, onClick: () => onDelete(r) }]
              : []),
          ]
        : []),
    ],
  };
}
