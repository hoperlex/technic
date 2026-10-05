import { Button, Space, Switch, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { EditOutlined, InfoCircleOutlined, PlusOutlined } from '@ant-design/icons';
import {
  containerKindColors,
  type CounterpartyDto,
  type WasteTariffDto,
  type WasteTypeDto,
} from '@technic/contracts';
import {
  type WasteTariffGridRow,
  wasteTariffColumnOperators,
  wasteTariffKindLabels,
} from '@entities/waste-tariff';
import { formatMoney } from '@shared/lib';

interface Options {
  operators: CounterpartyDto[];
  tariffs: WasteTariffDto[];
  wasteTypeById: Map<string, WasteTypeDto>;
  isMobile: boolean;
  togglePending: boolean;
  onCreateFor: (row: WasteTariffGridRow, operatorCounterpartyId: string) => void;
  onEdit: (tariff: WasteTariffDto) => void;
  onEditWasteType: (wasteType: WasteTypeDto) => void;
  onToggle: (tariff: WasteTariffDto, next: boolean) => void;
}

/** The cell tooltip explains both source pricing and lifecycle without widening every column. */
function cellHint(tariff: WasteTariffDto): string {
  const parts = [
    tariff.isPerContainer && tariff.pricePerContainer != null
      ? `В прайсе — ${formatMoney(tariff.pricePerContainer)} за контейнер${
          tariff.containerVolumeM3 != null ? ` ${tariff.containerVolumeM3} м³` : ''
        }`
      : null,
    tariff.note || null,
    tariff.isActive ? null : 'Цена отключена',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Build the responsive tariff matrix while keeping all write actions behind explicit ports. */
export function buildWasteTariffColumns({
  operators,
  tariffs,
  wasteTypeById,
  isMobile,
  togglePending,
  onCreateFor,
  onEdit,
  onEditWasteType,
  onToggle,
}: Options): TableColumnType<WasteTariffGridRow>[] {
  const operatorColumns: TableColumnType<WasteTariffGridRow>[] = wasteTariffColumnOperators(
    operators,
    tariffs,
  ).map((operator) => ({
    key: `operator:${operator.id}`,
    title: (
      <Space orientation="vertical" size={0}>
        <span>{operator.name}</span>
        <span style={{ fontWeight: 400, fontSize: 12, opacity: 0.65 }}>
          {operator.isActive ? '₽/м³' : '₽/м³ · неактивен'}
        </span>
      </Space>
    ),
    width: isMobile ? 150 : 200,
    render: (_value, row) => {
      const tariff = row.byOperator[operator.id];
      // An empty cell is the create affordance because the row and column already identify every
      // field except the price.
      if (!tariff) {
        return (
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            title={`Задать цену — ${operator.name}`}
            onClick={() => onCreateFor(row, operator.id)}
          />
        );
      }
      const hint = cellHint(tariff);
      // A phone cell retains only the price-as-edit-action and lifecycle tag. Tooltips do not open
      // reliably on touch, and a switch would consume the remaining width of the 150 px column.
      if (isMobile) {
        return (
          <Space size={4} wrap>
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: 'auto', opacity: tariff.isActive ? 1 : 0.45 }}
              onClick={() => onEdit(tariff)}
            >
              {formatMoney(tariff.pricePerM3)}
            </Button>
            {!tariff.isActive && <Tag>отключена</Tag>}
          </Space>
        );
      }
      return (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 'auto', opacity: tariff.isActive ? 1 : 0.45 }}
            onClick={() => onEdit(tariff)}
          >
            {formatMoney(tariff.pricePerM3)}
          </Button>
          {!tariff.isActive && <Tag>отключена</Tag>}
          {hint && (
            <Tooltip title={hint}>
              <InfoCircleOutlined style={{ opacity: 0.45 }} />
            </Tooltip>
          )}
          <Switch
            size="small"
            checked={tariff.isActive}
            loading={togglePending}
            title="Действует"
            onChange={(next) => onToggle(tariff, next)}
          />
        </Space>
      );
    },
  }));

  /**
   * Waste and vehicle are one sticky anchor on phones (ADR 0030). Separate 260 px and 220 px
   * columns cannot fit a 360 px screen, while scrolling to a later operator without an anchor
   * makes the price pair unknowable.
   */
  const subjectColumn: TableColumnType<WasteTariffGridRow> = {
    key: 'subject',
    title: 'Мусор · техника',
    width: 170,
    render: (_value, row) => {
      const type = wasteTypeById.get(row.wasteTypeId);
      return (
        <div style={{ lineHeight: 1.3 }}>
          <Space size={4}>
            <span>{row.wasteTypeName}</span>
            {type && !type.isActive && <Tag>неактивен</Tag>}
            {type && (
              <Button
                type="text"
                size="small"
                className="touch-icon"
                aria-label="Переименовать тип мусора"
                icon={<EditOutlined />}
                onClick={() => onEditWasteType(type)}
              />
            )}
          </Space>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.containerTypeName ??
                (row.containerKind ? wasteTariffKindLabels[row.containerKind] : '—')}
            </Typography.Text>
          </div>
        </div>
      );
    },
  };

  if (isMobile) return [subjectColumn, ...operatorColumns];
  return [
    {
      key: 'wasteTypeName',
      title: 'Тип мусора',
      dataIndex: 'wasteTypeName',
      width: 260,
      // The pencil edits the type itself, not this operator's tariff position.
      render: (value: string, row) => {
        const type = wasteTypeById.get(row.wasteTypeId);
        return (
          <Space size={4}>
            <span>{value}</span>
            {type && !type.isActive && <Tag>неактивен</Tag>}
            {type && (
              <Button
                type="text"
                size="small"
                title="Переименовать тип мусора"
                icon={<EditOutlined />}
                onClick={() => onEditWasteType(type)}
              />
            )}
          </Space>
        );
      },
    },
    {
      key: 'container',
      title: 'Техника',
      width: 220,
      render: (_value, row) =>
        row.containerTypeName ??
        (row.containerKind ? (
          <Tag color={containerKindColors[row.containerKind]}>
            {wasteTariffKindLabels[row.containerKind]}
          </Tag>
        ) : (
          '—'
        )),
    },
    ...operatorColumns,
  ];
}
