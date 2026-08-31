import { Segmented, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  officeEquipmentPurchaseStatusLabels,
  OFFICE_EQUIPMENT_PURCHASE_OPEN_STATUSES,
  type OfficeEquipmentPurchaseDto,
  type OfficeEquipmentPurchaseStatus,
} from '@technic/contracts';
import { DataTable, textColumn, type CardConfig } from '@shared/ui';
import { useListParams } from '@shared/lib';
import {
  officeEquipmentPurchaseKeys,
  officeEquipmentPurchasesApi,
} from '@entities/office-equipment';
import { formatDateTime } from '../../utils/format';

/**
 * Список плановых закупок (план `docs/office-equipment-consumables-and-purchase-plan.md`, Р9, Р10).
 *
 * ПОИСКА НЕТ, И ЭТО НЕ ЭКОНОМИЯ. Искать у закупки нечего: ни ФИО, ни телефона, ни названия у неё не
 * бывает (Р16), а номер спрашивают отбором «открытые» и глазами по одной странице. Поиск по
 * комментарию обещал бы находить закупку «по картриджам Pantum», чего он не умеет — позиции лежат
 * строками, а не в тексте шапки. Сервер такого параметра и не принимает.
 *
 * ОТБОР — ТРИ СРЕЗА, А НЕ ПЕРЕЧЕНЬ СОСТОЯНИЙ. Рабочий вопрос снабжения один: «что сейчас в работе»,
 * то есть «Новая» и «В работе» вместе; одним значением его не выразить, поэтому отбор уезжает
 * набором через запятую — тем же приёмом, что отбор действий в журнале аудита.
 */

const STATUS_COLORS: Record<OfficeEquipmentPurchaseStatus, string> = {
  new: 'default',
  in_work: 'processing',
  closed: 'success',
  cancelled: 'error',
};

/** Открытые — «Новая» и «В работе» вместе: именно этим списком живёт снабжение (Р15). */
const OPEN = OFFICE_EQUIPMENT_PURCHASE_OPEN_STATUSES.join(',');

const SLICES = [
  { value: OPEN, label: 'Открытые' },
  { value: 'closed', label: 'Закрытые' },
  { value: 'cancelled', label: 'Отменённые' },
  // Пустая строка означает «отбор не слать вовсе»: у сервера отсутствие параметра и есть «все
  // состояния», а пустого набора схема не принимает.
  { value: '', label: 'Все' },
];

interface Props {
  /** Открыть карточку закупки: окно держит вкладка — оно одно на список и на кнопку заведения. */
  onOpen: (id: string) => void;
}

/** Что список спрашивает сверх базовых параметров: срез по состоянию и порядок по умолчанию. */
interface PurchaseFilters {
  status?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

const card: CardConfig<OfficeEquipmentPurchaseDto> = {
  title: (r) => r.displayNumber,
  badge: (r) => (
    <Tag color={STATUS_COLORS[r.status]}>{officeEquipmentPurchaseStatusLabels[r.status]}</Tag>
  ),
  primary: (r) => `${r.itemCount} позиций · ${r.totalQuantity} шт`,
  lines: [(r) => `Завёл: ${r.createdByName}, ${formatDateTime(r.createdAt)}`],
};

export function OfficeEquipmentPurchasesList({ onOpen }: Props) {
  const { params, setParams, onTableChange } = useListParams<PurchaseFilters>(
    // Свежие сверху: закупку ищут по номеру редко, а «что сейчас у снабжения» спрашивают каждый
    // раз. Срез по умолчанию — открытые: закрытые и отменённые смотрят, когда за ними приходят.
    { status: OPEN, sortBy: 'num', sortOrder: 'desc' },
    { searchKeys: [] },
  );

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentPurchaseKeys.list(params),
    queryFn: () => officeEquipmentPurchasesApi.list(params),
  });

  const columns = [
    textColumn<OfficeEquipmentPurchaseDto>({
      key: 'num',
      title: 'Номер',
      dataIndex: 'displayNumber',
      searchable: false,
      width: 120,
    }),
    {
      key: 'status',
      title: 'Состояние',
      dataIndex: 'status',
      width: 140,
      // Сортировки нет: среди полей контракта состояния нет, и сортируемый заголовок обещал бы
      // порядок, на который маршрут ответит 400. Срез по состоянию делает переключатель выше.
      render: (_v: unknown, r: OfficeEquipmentPurchaseDto) => (
        <Tag color={STATUS_COLORS[r.status]}>{officeEquipmentPurchaseStatusLabels[r.status]}</Tag>
      ),
    },
    {
      key: 'itemCount',
      // Пара «позиций / штук» стоит в списке намеренно: по ней читают закупку, не открывая
      // карточку, — «двенадцать позиций на сорок штук» это уже ответ.
      title: 'Состав',
      width: 180,
      render: (_v: unknown, r: OfficeEquipmentPurchaseDto) => (
        <Typography.Text>
          {r.itemCount} позиций · {r.totalQuantity} шт
        </Typography.Text>
      ),
    },
    {
      key: 'createdAt',
      title: 'Заведена',
      dataIndex: 'createdAt',
      sorter: true,
      width: 220,
      render: (_v: unknown, r: OfficeEquipmentPurchaseDto) => (
        <>
          <div>{formatDateTime(r.createdAt)}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.createdByName}
          </Typography.Text>
        </>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Segmented
        value={params.status ?? ''}
        options={SLICES}
        onChange={(v) => setParams((p) => ({ ...p, status: (v as string) || undefined, page: 1 }))}
      />
      <DataTable<OfficeEquipmentPurchaseDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onRowClick={(r) => onOpen(r.id)}
        onChange={onTableChange}
      />
    </Space>
  );
}
