import { Button, Space, Switch, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { EditOutlined, SettingOutlined } from '@ant-design/icons';
import {
  isOdometerMaintenance,
  type VehicleClassificationDto,
  type VehicleTypeDto,
} from '@technic/contracts';
import { actionsColumn, textColumn, type CardConfig } from '@shared/ui';

interface PresentationOptions {
  typeById: Map<string, VehicleTypeDto>;
  togglePending: boolean;
  onToggle: (row: VehicleClassificationDto, next: boolean) => void;
  onEdit: (type: VehicleTypeDto) => void;
  onOpenCard: (type: VehicleTypeDto) => void;
}

/**
 * Desktop columns of the flat classifier (ADR 0028). There is no separate category counter: the
 * categories are the rows of the list.
 */
export function classificationColumns({
  typeById,
  togglePending,
  onToggle,
  onEdit,
  onOpenCard,
}: PresentationOptions): TableColumnType<VehicleClassificationDto>[] {
  return [
    textColumn<VehicleClassificationDto>({
      key: 'kindName',
      title: 'Вид',
      dataIndex: 'kindName',
      searchable: false,
      width: 200,
    }),
    {
      key: 'label',
      title: 'Тип/категория',
      dataIndex: 'label',
      sorter: true,
      ellipsis: true,
      // A category name already starts with its type («Автокраны, г/п 25 т»), so the type is not
      // repeated next to it. The tag tells a category from a type that is ordered as a whole.
      render: (value: string, row) => (
        <Space size={6}>
          <span>{value}</span>
          {row.vehicleCategoryId ? null : <Tag>тип целиком</Tag>}
        </Space>
      ),
    },
    {
      key: 'specCount',
      title: 'ТТХ',
      dataIndex: 'specCount',
      width: 90,
      sorter: false,
      render: (value: number) => (value > 0 ? <Tag color="blue">{value}</Tag> : <Tag>0</Tag>),
    },
    {
      key: 'isLinear',
      title: 'Линейная',
      width: 160,
      sorter: false,
      // The flag lives on the type, while a list row can also be a category (ADR 0028): it is read
      // from the type and shown on all its rows — a category is ordered in the same mode as its
      // type. A marker, not a switch: it is edited in the form, where the explanation sits and
      // where the portal names the requests that stay on the previous mode (ADR 0107).
      render: (_value, row) => {
        const type = typeById.get(row.vehicleTypeId);
        return (
          <Space orientation="vertical" size={2}>
            {type?.isLinear ? <Tag color="blue">по дням</Tag> : <span>—</span>}
            {/* Requests caught by a switch keep working in the mode they were created with, and
                the column answers «why do two requests of one type behave differently». Zero is
                not shown — that is the case for the vast majority of types. */}
            {type && type.frozenRequests > 0 ? (
              <Tooltip title="Эти заявки застало переключение признака: до закрытия они идут прежним режимом">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {type.frozenRequests} на прежнем режиме
                </Typography.Text>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      key: 'maintenanceBasis',
      title: 'ТО',
      width: 120,
      sorter: false,
      // Maintenance marking (R13) uses the same approach as linear mode: the flag lives on the
      // type, is shown on all its rows and is edited in the form, not by a list switch. The column
      // makes «which types are marked» readable as a list: otherwise the answer takes opening cards
      // one by one, and an unmarked type silently shows maintenance nowhere.
      render: (_value, row) =>
        isOdometerMaintenance(typeById.get(row.vehicleTypeId)?.maintenanceBasis ?? 'none') ? (
          <Tag color="blue">по пробегу</Tag>
        ) : (
          <Tooltip title="У этого типа ТО не ведётся: срок обслуживания портал не считает и не подсвечивает">
            <span>—</span>
          </Tooltip>
        ),
    },
    {
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      width: 110,
      sorter: true,
      render: (value: boolean, row) => {
        // A category shows its availability as a whole: an inactive type has no available
        // categories, and enabling them one by one is pointless — the type must be enabled first.
        const blocked = !!row.vehicleCategoryId && !row.typeIsActive;
        const control = (
          <Switch
            size="small"
            checked={value}
            disabled={blocked}
            loading={togglePending}
            onChange={(next) => onToggle(row, next)}
          />
        );
        return blocked ? (
          <Tooltip title={`Тип «${row.typeName}» неактивен — активируйте сначала его`}>
            {control}
          </Tooltip>
        ) : (
          control
        );
      },
    },
    actionsColumn<VehicleClassificationDto>((row) => {
      const type = typeById.get(row.vehicleTypeId);
      return (
        <Space size={4}>
          <Button
            size="small"
            icon={<SettingOutlined />}
            title="ТТХ и категории типа"
            disabled={!type}
            onClick={() => type && onOpenCard(type)}
          />
          {/* Edit always targets the type: a category name is built from the type's specs and
              values (ADR 0016) and is edited there, in the card. */}
          <Button
            size="small"
            icon={<EditOutlined />}
            title={`Редактировать тип «${row.typeName}»`}
            disabled={!type}
            onClick={() => type && onEdit(type)}
          />
        </Space>
      );
    }),
  ];
}

/**
 * Classifier card on a phone (ADR 0042). The title is the position itself: a category already
 * starts with its type («Автокраны, г/п 25 т»), so the type is not repeated, and the tag marks a
 * category-less type ordered as a whole.
 */
export function classificationCard({
  typeById,
  onToggle,
  onEdit,
  onOpenCard,
}: PresentationOptions): CardConfig<VehicleClassificationDto> {
  return {
    title: (row) => row.label,
    badge: (row) => (
      <Tag color={row.isActive ? 'green' : 'default'}>{row.isActive ? 'Да' : 'Нет'}</Tag>
    ),
    primary: (row) => (
      <Space size={6} wrap>
        <span>{row.kindName}</span>
        {row.vehicleCategoryId ? null : <Tag>тип целиком</Tag>}
        {/* The same flag as the desktop column, worded «линейная»: there is no column header on
            the card, and a bare «по дням» would be about nothing (ADR 0042). */}
        {typeById.get(row.vehicleTypeId)?.isLinear ? <Tag color="blue">линейная</Tag> : null}
        {/* Maintenance marking uses the same tag and also only when present: «not tracked» stays
            silent on the phone card, like the empty column on desktop. */}
        {isOdometerMaintenance(typeById.get(row.vehicleTypeId)?.maintenanceBasis ?? 'none') ? (
          <Tag color="blue">ТО по пробегу</Tag>
        ) : null}
      </Space>
    ),
    lines: [
      (row) => (row.specCount > 0 ? `ТТХ: ${row.specCount}` : 'ТТХ не заведены'),
      // Requests caught by a flag switch: a line rather than a tag — on a phone card it is an
      // explanation, not a marker. Zero takes no line.
      (row) => {
        const frozen = typeById.get(row.vehicleTypeId)?.frozenRequests ?? 0;
        return frozen > 0 ? `${frozen} на прежнем режиме` : '';
      },
    ],
    // A tap opens the type card: specs, categories and category name editing live there.
    onOpen: (row) => {
      const type = typeById.get(row.vehicleTypeId);
      if (type) onOpenCard(type);
    },
    actions: (row) => {
      const type = typeById.get(row.vehicleTypeId);
      return [
        {
          key: 'card',
          label: 'ТТХ и категории типа',
          disabled: !type,
          onClick: () => type && onOpenCard(type),
        },
        {
          key: 'edit',
          label: `Редактировать тип «${row.typeName}»`,
          disabled: !type,
          onClick: () => type && onEdit(type),
        },
        {
          key: 'toggle',
          label: row.isActive ? 'Деактивировать' : 'Активировать',
          danger: row.isActive,
          // A category of an inactive type has nothing to enable: the type is enabled first.
          disabled: !!row.vehicleCategoryId && !row.typeIsActive,
          onClick: () => onToggle(row, !row.isActive),
        },
      ];
    },
  };
}
