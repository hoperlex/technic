import { Button, Space, Tag, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { officeEquipmentTitle, type OfficeEquipmentDto } from '@technic/contracts';
import { actionsColumn, boolBadgeColumn, textColumn, type CardConfig } from '@shared/ui';
import { WarrantyTag } from '@entities/office-equipment';

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
  onEdit: (record: OfficeEquipmentDto) => void;
  onDelete: (record: OfficeEquipmentDto) => void;
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
    ...(canWrite
      ? [
          actionsColumn<OfficeEquipmentDto>((r) => (
            <Space>
              <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(r)} />
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(r)} />
            </Space>
          )),
        ]
      : []),
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
}: OfficeEquipmentGridActions): CardConfig<OfficeEquipmentDto> {
  return {
    title: (r) => officeEquipmentTitle(r),
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => r.type.name,
    lines: [
      (r) => `${r.object.code} — ${r.object.name}`,
      (r) => (r.department ? `Отдел: ${r.department.name}` : 'Отдел: не закреплена'),
      (r) => r.location || null,
      (r) =>
        r.warrantyUntil ? (
          <Space size={4}>
            Гарантия: <WarrantyTag until={r.warrantyUntil} />
          </Space>
        ) : null,
    ],
    onOpen: canWrite ? onEdit : undefined,
    actions: canWrite
      ? (r) => [
          { key: 'edit', label: 'Редактировать', onClick: () => onEdit(r) },
          { key: 'delete', label: 'Удалить', danger: true, onClick: () => onDelete(r) },
        ]
      : undefined,
  };
}
