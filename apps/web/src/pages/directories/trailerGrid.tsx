import { Button, Space, Tag, Tooltip, type TableColumnsType } from 'antd';
import {
  DeleteFilled,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  LinkOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  TRAILER_KINDS,
  VEHICLE_STATUSES,
  type VehicleTrailerDto,
  type VehicleTrailerVehicleRefDto,
  trailerKindLabels,
  trailerTitle,
  vehicleStatusColors,
  vehicleStatusLabels,
} from '@technic/contracts';
import {
  actionsColumn,
  badgeColumn,
  type CardConfig,
  RowActionButton,
  textColumn,
} from '@shared/ui';

/**
 * Как прицеп выглядит списком: колонки таблицы и карточка строки на телефоне (приём
 * `officeEquipmentModelGrid`, `wasteTariffGrid`).
 *
 * Отдельным модулем от самой вкладки: во вкладке остаётся работа с данными — запрос, отборы,
 * мутации и подтверждения, — а описание представления читается целиком, не пролистывая их. Обе
 * фабрики принимают один и тот же набор действий: строка одинакова и в таблице, и в карточке, и
 * различать их должно одно место — иначе на телефоне однажды окажется на кнопку меньше.
 */

export const kindOptions = TRAILER_KINDS.map((k) => ({ value: k, label: trailerKindLabels[k] }));
export const statusOptions = VEHICLE_STATUSES.map((s) => ({
  value: s,
  label: vehicleStatusLabels[s],
}));

/**
 * Чем машина названа в строке прицепа — госномером и маркой, той же парой примет, какой её
 * выбирают в списках (`vehicleOptionLabel`). Оба реквизита приезжают допускающими `null`, потому
 * что такими они лежат в `vehicles`; строка сокращается до того, что есть.
 */
export function hitchedVehicleLabel(v: VehicleTrailerVehicleRefDto): string {
  const shown = [v.registrationNumber, v.modelName].filter(
    (p): p is string => !!p && p.trim() !== '',
  );
  return shown.length > 0 ? shown.join(' — ') : '—';
}

/**
 * Почему прицеп нельзя поставить за машину, или `null` — если можно. Списанный за тягачом не
 * стоит: это физический запрет базы (CHECK `vehicle_trailers_hitch_status_check`), и упереться в
 * него отказом сервера после нажатия хуже, чем увидеть причину на выключенной кнопке.
 */
export function hitchBlockReason(t: VehicleTrailerDto): string | null {
  return t.status === 'retired' ? 'Списанный прицеп за машиной не стоит' : null;
}

export interface TrailerRowActions {
  /** Возврат записи из архива — право администратора (ADR 0021): кнопка следует за ним. */
  canRestore: boolean;
  /** Удаление насовсем (ADR 0060) — как его отдаёт `usePurgeAction`. */
  purge: { allowed: boolean; pending: boolean; confirm: (id: string, name: string) => void };
  onEdit: (trailer: VehicleTrailerDto) => void;
  onHitch: (trailer: VehicleTrailerDto) => void;
  onUnhitch: (trailer: VehicleTrailerDto) => void;
  onDelete: (trailer: VehicleTrailerDto) => void;
  onRestore: (trailer: VehicleTrailerDto) => void;
}

export function trailerColumns({
  canRestore,
  purge,
  onEdit,
  onHitch,
  onUnhitch,
  onDelete,
  onRestore,
}: TrailerRowActions): TableColumnsType<VehicleTrailerDto> {
  return [
    badgeColumn<VehicleTrailerDto>({
      key: 'kind',
      title: 'Тип',
      dataIndex: 'kind',
      labels: trailerKindLabels,
      width: 140,
    }),
    textColumn<VehicleTrailerDto>({
      key: 'registrationNumber',
      title: 'Госномер',
      dataIndex: 'registrationNumber',
      searchable: false,
      width: 140,
    }),
    textColumn<VehicleTrailerDto>({
      key: 'model',
      title: 'Марка',
      dataIndex: 'model',
      searchable: false,
      ellipsis: true,
      width: 200,
    }),
    {
      key: 'manufacturedYear',
      title: 'Год',
      dataIndex: 'manufacturedYear',
      width: 90,
      sorter: true,
      render: (_v: unknown, r: VehicleTrailerDto) => r.manufacturedYear ?? '—',
    },
    {
      key: 'passportNumber',
      title: 'ПТС',
      dataIndex: 'passportNumber',
      width: 170,
      ellipsis: true,
      sorter: true,
      render: (_v: unknown, r: VehicleTrailerDto) => r.passportNumber || '—',
    },
    {
      key: 'hitchedVehicle',
      title: 'За машиной',
      width: 260,
      sorter: true,
      // Машина и слот — одна графа в две строки, а не два столбца: порознь они не читаются.
      // Слот здесь не порядок в списке, а место в шапке бланка: «Прицеп 2» печатается своей
      // парой граф, и без номера строка не говорит, какую именно наполнит эта привязка.
      render: (_v: unknown, r: VehicleTrailerDto) =>
        r.hitchedVehicle ? (
          <>
            {hitchedVehicleLabel(r.hitchedVehicle)}
            <br />
            <Tag>Прицеп {r.hitchPosition}</Tag>
          </>
        ) : (
          '—'
        ),
    },
    badgeColumn<VehicleTrailerDto>({
      key: 'status',
      title: 'Состояние',
      dataIndex: 'status',
      labels: vehicleStatusLabels,
      colors: vehicleStatusColors,
      width: 150,
    }),
    actionsColumn<VehicleTrailerDto>((r) => {
      if (r.deletedAt) {
        return (
          <Space>
            <Tag>в архиве</Tag>
            {canRestore ? (
              <RowActionButton
                title="Восстановить"
                icon={<ReloadOutlined />}
                onClick={() => onRestore(r)}
              />
            ) : null}
            {purge.allowed ? (
              <Button
                size="small"
                danger
                icon={<DeleteFilled />}
                title="Удалить окончательно"
                aria-label="Удалить окончательно"
                loading={purge.pending}
                onClick={() => purge.confirm(r.id, trailerTitle(r))}
              />
            ) : null}
          </Space>
        );
      }
      const blocked = hitchBlockReason(r);
      const hitchTitle = r.hitchedVehicle ? 'Переставить' : 'Прицепить';
      return (
        <Space>
          <RowActionButton
            title="Редактировать"
            icon={<EditOutlined />}
            onClick={() => onEdit(r)}
          />
          {/* Выключенная кнопка событий указателя не отдаёт, и своя подсказка на ней не
              открылась бы — причина висит на обёртке. */}
          <Tooltip title={blocked ?? hitchTitle}>
            <span>
              <Button
                size="small"
                icon={<LinkOutlined />}
                aria-label={hitchTitle}
                disabled={!!blocked}
                onClick={() => onHitch(r)}
              />
            </span>
          </Tooltip>
          {r.hitchedVehicle ? (
            <RowActionButton
              title="Отцепить"
              icon={<DisconnectOutlined />}
              onClick={() => onUnhitch(r)}
            />
          ) : null}
          <RowActionButton
            title="В архив"
            icon={<DeleteOutlined />}
            danger
            onClick={() => onDelete(r)}
          />
        </Space>
      );
    }, 200),
  ];
}

/**
 * Карточка прицепа на телефоне (ADR 0042). Заголовок — госномер: им прицеп и зовут, а марка
 * стоит рядом с типом, потому что вместе они и есть подпись из бланка.
 */
export function trailerCard({
  canRestore,
  purge,
  onEdit,
  onHitch,
  onUnhitch,
  onDelete,
  onRestore,
}: TrailerRowActions): CardConfig<VehicleTrailerDto> {
  return {
    title: (r) => r.registrationNumber,
    badge: (r) => <Tag color={vehicleStatusColors[r.status]}>{vehicleStatusLabels[r.status]}</Tag>,
    primary: (r) => `${trailerKindLabels[r.kind]} · ${r.model}`,
    lines: [
      (r) =>
        r.hitchedVehicle
          ? `За машиной ${hitchedVehicleLabel(r.hitchedVehicle)} · прицеп ${r.hitchPosition}`
          : null,
      (r) =>
        [r.manufacturedYear ? `${r.manufacturedYear} г.` : null, r.passportNumber || null]
          .filter(Boolean)
          .join(' · ') || null,
      (r) => (r.deletedAt ? 'В архиве' : null),
    ],
    onOpen: (r) => (r.deletedAt ? undefined : onEdit(r)),
    actions: (r) =>
      r.deletedAt
        ? [
            ...(canRestore
              ? [{ key: 'restore', label: 'Восстановить', onClick: () => onRestore(r) }]
              : []),
            ...(purge.allowed
              ? [
                  {
                    key: 'purge',
                    label: 'Удалить окончательно',
                    danger: true,
                    onClick: () => purge.confirm(r.id, trailerTitle(r)),
                  },
                ]
              : []),
          ]
        : [
            { key: 'edit', label: 'Редактировать', onClick: () => onEdit(r) },
            {
              key: 'hitch',
              label: r.hitchedVehicle ? 'Переставить за другую машину' : 'Прицепить к машине',
              disabled: !!hitchBlockReason(r),
              disabledReason: hitchBlockReason(r) ?? undefined,
              onClick: () => onHitch(r),
            },
            ...(r.hitchedVehicle
              ? [{ key: 'unhitch', label: 'Отцепить', onClick: () => onUnhitch(r) }]
              : []),
            { key: 'delete', label: 'В архив', danger: true, onClick: () => onDelete(r) },
          ],
  };
}
