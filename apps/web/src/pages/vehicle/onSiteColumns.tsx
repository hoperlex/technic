import { Space, Typography, type TableColumnType } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  ScheduleOutlined,
} from '@ant-design/icons';
import { type SpecialEquipmentRequestDto, vehicleClassificationLabel } from '@technic/contracts';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { UserAvatar } from '../../components/UserAvatar';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../../components/ObjectCell';
import {
  dash,
  decidable,
  earlyEndAllowed,
  type OnSiteRowArgs,
  presenceCell,
  shiftsCell,
  termCell,
  vehicleCell,
} from './onSiteCells';

/**
 * Колонки среза «На объекте» — фабрикой: они замыкаются на день среза, права и окна вкладки и
 * получают их аргументами.
 *
 * Отдельным файлом тем же приёмом, каким разложены соседи (`busyColumns.tsx`): колонка живёт
 * рядом со своей ячейкой, а вкладке остаются список, запросы и разметка.
 */
export function onSiteColumns({
  onDate,
  canRequest,
  canDecide,
  earlyEnd,
  onView,
  onShifts,
}: OnSiteRowArgs): TableColumnType<SpecialEquipmentRequestDto>[] {
  // Ключ колонки — он же поле сортировки на сервере (VEHICLE_ON_SITE_SORT_FIELDS).
  return [
    {
      ...textColumn<SpecialEquipmentRequestDto>({
        key: 'objectName',
        title: 'Объект',
        dataIndex: 'objectName',
        width: OBJECT_COLUMN_WIDTH,
        render: (_v, r) => <ObjectCell name={r.objectName ?? '—'} address={r.objectAddress} />,
      }),
      defaultSortOrder: 'ascend',
    },
    {
      key: 'vehicleTypeName',
      title: 'Заказано',
      dataIndex: 'vehicleTypeName',
      width: 200,
      sorter: true,
      // Заказанная позиция классификатора (ADR 0028): категория, а без неё — сам тип.
      render: (_v, r) =>
        vehicleClassificationLabel({
          typeName: r.vehicleTypeName,
          categoryName: r.vehicleCategoryName,
        }),
    },
    {
      // Что именно стоит на площадке, а не что заказано: у обычного заказа это машина назначения
      // (ADR 0027), у линейного — машина рейса дня (ADR 0100 §12). Марка второй строкой рядом с
      // арендодателем: госномер не говорит, самосвал это или автовышка, а держат машину в голове
      // по марке. Правило целиком — в `onSiteVehicleLines`, здесь только ширина графы: 240 против
      // прежних 220, потому что вторая строка длиннее одного имени арендодателя.
      key: 'assignment',
      title: 'Техника',
      width: 240,
      render: (_v, r) => vehicleCell(r),
    },
    {
      key: 'presence',
      title: 'Сегодня',
      width: 150,
      render: (_v, r) => (onDate ? presenceCell(r, onDate) : dash),
    },
    {
      key: 'term',
      title: 'Срок',
      width: 175,
      sorter: true,
      render: (_v, r) => termCell(r),
    },
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 170,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Space size={6}>
            <UserAvatar name={r.createdByName} size={18} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.createdByName}
            </Typography.Text>
          </Space>
        </div>
      ),
    },
    {
      // Приёмка работы по дням: сколько смен объект уже подтвердил и сколько наступивших дней
      // ещё ждёт подписи. Долг решает, примут ли работу подписью или её закроют со слов
      // закрывающего, — поэтому цифра стоит рядом со сроком, а не прячется в карточке.
      key: 'shifts',
      title: 'Согласование смен',
      width: 190,
      render: (_v, r) => shiftsCell(r),
    },
    textColumn<SpecialEquipmentRequestDto>({
      // Планируемые работы: по ним на объекте и понимают, чем машина занята сегодня.
      key: 'comment',
      title: 'Работы',
      dataIndex: 'comment',
      sortable: false,
      searchable: false,
      width: 260,
      ellipsis: true,
    }),
    actionsColumn<SpecialEquipmentRequestDto>(
      // Срез читают, а не ведут: статусы, виза и правка остаются в списке заявок. Своё действие
      // у него ровно одно — досрочное завершение (ADR 0044): решение об отъезде техники
      // принимают, глядя именно на этот список. Карточка — единственное место, где видны файлы,
      // ставки и вся хронология заявки (ADR 0015).
      (r) => (
        <Space size={4}>
          <RowActionButton
            title="Открыть карточку"
            icon={<EyeOutlined />}
            onClick={() => onView(r)}
          />
          <RowActionButton title="Смены" icon={<ScheduleOutlined />} onClick={() => onShifts(r)} />
          {decidable(r, canDecide) ? (
            <>
              <RowActionButton
                title="Согласовать досрочное завершение"
                icon={<CheckOutlined />}
                onClick={() => earlyEnd.approve(r)}
              />
              <RowActionButton
                title="Отклонить досрочное завершение"
                icon={<CloseOutlined />}
                danger
                onClick={() => earlyEnd.reject(r)}
              />
            </>
          ) : (
            earlyEndAllowed(r, onDate, canRequest) && (
              <RowActionButton
                title="Завершить досрочно"
                icon={<FieldTimeOutlined />}
                onClick={() => earlyEnd.open(r)}
              />
            )
          )}
        </Space>
      ),
      110,
    ),
  ];
}
