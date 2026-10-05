import { useState } from 'react';
import { Alert, Button, Space, Tag, Tooltip, Typography } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  EditOutlined,
  MergeCellsOutlined,
  SplitCellsOutlined,
} from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import {
  type RoutePointAction,
  routeContactsLabel,
  type VehicleRoutePointDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import {
  actionLabel,
  actionPairLabel,
  blockerMessage,
  mergeHintMessage,
  type PointMergeHint,
  type RouteAssembly,
  vehicleRoutesApi,
} from '@entities/vehicle-route';
import { RoutePointEditModal } from './RoutePointEditModal';
import { RoutePointSplitModal } from './RoutePointSplitModal';

/**
 * Stop order: how the vehicle moves through the day (section 4.3 of `docs/route-trips-plan.md`).
 *
 * Before this block the card showed the **composition** — a list of requests — and the arrows
 * reordered requests. That answered "what are we carrying" but not the dispatcher's question of
 * the day: "where will the vehicle stop and in what order". The difference stopped being cosmetic
 * once requests gained trips: two trips `A→B` and `A→C` are loaded in one visit, yet in the request
 * list they are two lines that cannot be combined at a glance. With printing by task rows (R11),
 * the composition also stopped defining the paper order — points define it.
 *
 * Hence this block reorders **points** (`PUT /:id/points/order`), not requests. The server bridge
 * that derived point order from composition order (R14a) is no longer needed by the portal from
 * here on: it covered the window between printing by points and this card.
 *
 * An issued waybill freezes the whole list (R15): the paper is with the driver, and a record that
 * diverges from it is worse than no record. The hints go dark too — offering an action that cannot
 * be performed promises a door that does not exist.
 */

interface Props {
  route: VehicleRouteDto;
  /** Task rows, blockers and hints — computed once for the whole card. */
  assembly: RouteAssembly;
  frozen: boolean;
  /** The route after an edit: the card puts it into the cache and invalidates the lists. */
  onChanged: (route: VehicleRouteDto) => void;
  /** A refusal in words, plus a route re-read on a version conflict; shared by the whole card. */
  onFail: (e: unknown) => void;
}

export function RoutePointsBlock({ route, assembly, frozen, onChanged, onFail }: Props) {
  /** The point opened for address and time editing; `null` — the window is closed. */
  const [editing, setEditing] = useState<VehicleRoutePointDto | null>(null);
  /** The point being split in two. */
  const [splitting, setSplitting] = useState<VehicleRoutePointDto | null>(null);

  // Empty fallback for the same reason as in `assembleRoute`: the cache key is shared by the card
  // and the list, and not every server endpoint returns points.
  const points = [...(route.points ?? [])].sort((a, b) => a.position - b.position);

  const reorder = useMutation({
    mutationFn: (pointIds: string[]) =>
      vehicleRoutesApi.points.order(route.id, { pointIds, version: route.version }),
    onSuccess: onChanged,
    onError: onFail,
  });

  const merge = useMutation({
    mutationFn: (pointIds: string[]) =>
      vehicleRoutesApi.points.merge(route.id, { pointIds, version: route.version }),
    onSuccess: onChanged,
    onError: onFail,
  });

  const busy = reorder.isPending || merge.isPending;

  /** Moves a stop: the full order goes to the server, which rewrites positions in one pass. */
  const move = (index: number, delta: number) => {
    const ids = points.map((point) => point.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };

  /** The merge group the point belongs to; `null` — there is nothing to merge it with. */
  const mergeHintOf = (pointId: string): PointMergeHint | null =>
    assembly.merges.find((hint) => hint.pointIds.includes(pointId)) ?? null;

  /**
   * Refusals above the list — all except the overflowing row: that one sits at its point (R11b)
   * because it is fixed by editing **the point's address**, not the composition. The driver is not
   * named here either — the issue-readiness line above the button covers it, and a second message
   * about the same thing would read as a second gap.
   */
  const listBlockers = assembly.blockers.filter(
    (blocker) => blocker.code !== 'required_fields_overflow' && blocker.code !== 'no_driver',
  );

  return (
    <div>
      <Typography.Title level={5}>Порядок объезда ({points.length})</Typography.Title>

      {points.length === 0 && (
        <Typography.Paragraph type="secondary">
          Остановок нет: положите в рейс заявку — её ездки разложатся точками сами, а линейный день
          встанет своей точкой из карточки заявки.
        </Typography.Paragraph>
      )}

      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        {!frozen &&
          listBlockers.map((blocker) => (
            <Alert
              key={blocker.code}
              type={blocker.code === 'capacity_exceeded' ? 'error' : 'warning'}
              showIcon
              title={blockerMessage(blocker, assembly)}
            />
          ))}
        {/* Merge hint (R9a): points with the same address. Nothing is merged automatically — the
          decision "this is one visit" is the person's: they know whether everything fits in the
          truck body and whether the vehicle will be let in on a single pass. */}
        {!frozen &&
          assembly.merges.map((hint) => (
            <Alert
              key={hint.pointIds.join(':')}
              type="info"
              showIcon
              title={mergeHintMessage(hint)}
              action={
                <Button
                  size="small"
                  loading={merge.isPending}
                  disabled={busy}
                  onClick={() => merge.mutate(hint.pointIds)}
                >
                  Совместить
                </Button>
              }
            />
          ))}

        {points.map((point, index) => (
          <RoutePointRow
            key={point.id}
            point={point}
            index={index}
            total={points.length}
            frozen={frozen}
            busy={busy}
            assembly={assembly}
            mergeHint={mergeHintOf(point.id)}
            onMove={move}
            onEdit={() => setEditing(point)}
            onSplit={() => setSplitting(point)}
            onMerge={(ids) => merge.mutate(ids)}
          />
        ))}
      </Space>

      <RoutePointEditModal
        route={route}
        point={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setEditing(null);
          onChanged(updated);
        }}
      />
      <RoutePointSplitModal
        route={route}
        point={splitting}
        onClose={() => setSplitting(null)}
        onSaved={(updated) => {
          setSplitting(null);
          onChanged(updated);
        }}
      />
    </div>
  );
}

/**
 * A stop as a list item: number, address, time, contacts — and below them the roles, i.e. what is
 * done here with the task rows.
 *
 * Contacts sit **above** the roles rather than in each role: on arrival the driver calls a person,
 * not a trip, and two people meeting the vehicle at one point (R9a) is a property of the stop.
 * Their order is set by a rule (`pointContacts`), the same one that prints them in the
 * «заказчик, телефон» (customer, phone) column (R11a) — the card does not re-sort them.
 */
function RoutePointRow({
  point,
  index,
  total,
  frozen,
  busy,
  assembly,
  mergeHint,
  onMove,
  onEdit,
  onSplit,
  onMerge,
}: {
  point: VehicleRoutePointDto;
  index: number;
  total: number;
  frozen: boolean;
  busy: boolean;
  assembly: RouteAssembly;
  mergeHint: PointMergeHint | null;
  onMove: (index: number, delta: number) => void;
  onEdit: () => void;
  onSplit: () => void;
  onMerge: (pointIds: string[]) => void;
}) {
  const blockers = assembly.pointBlockers.get(point.id) ?? [];

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        border: '1px solid var(--ant-color-border)',
        borderRadius: 8,
        padding: 8,
      }}
    >
      <Tag style={{ marginTop: 2 }}>{point.position}</Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} wrap>
          <strong>{point.location}</strong>
          {point.arrivalTime && <Tag color="blue">{point.arrivalTime}</Tag>}
        </Space>
        {/* Contacts: name and number in the same format the form prints them
          (`routeContactsLabel`) — people read and dial them, and two spellings of one number
          confuse. */}
        {point.contacts.map((contact) => (
          <div key={`${contact.name}:${contact.phone}`}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ☎ {routeContactsLabel([contact])}
            </Typography.Text>
          </div>
        ))}
        {/* Two contacts are not an error but a result of merging (R9a), and the form prints both.
          It must be said here: whoever merged the points would otherwise learn it from paper. */}
        {point.contacts.length > 1 && (
          <Tag color="warning">{point.contacts.length} ответственных — в лист пойдут все</Tag>
        )}
        {point.actions.map((action) => (
          <PointActionLine key={`${action.displayNumber}:${action.role}`} action={action} />
        ))}
        {point.comment && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {point.comment}
            </Typography.Text>
          </div>
        )}
        {/* An unprintable row is visible during assembly, not at issue time (R11a), and leads to
          where it is fixed: the address edit of **this** point — the point's address is what gets
          printed, not the trip's field (R11b). */}
        {!frozen &&
          blockers.map((blocker) => (
            <Alert
              key={`${blocker.code}:${point.id}`}
              style={{ marginTop: 6 }}
              type="error"
              showIcon
              title={blockerMessage(blocker, assembly)}
              action={
                <Button size="small" onClick={onEdit}>
                  Править точку
                </Button>
              }
            />
          ))}
      </div>
      {!frozen && (
        <Space>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            title="Выше"
            aria-label={`Поднять точку ${point.position}`}
            disabled={index === 0 || busy}
            onClick={() => onMove(index, -1)}
          />
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            title="Ниже"
            aria-label={`Опустить точку ${point.position}`}
            disabled={index === total - 1 || busy}
            onClick={() => onMove(index, 1)}
          />
          <Button
            size="small"
            icon={<EditOutlined />}
            title="Править адрес, время и записку"
            aria-label={`Править точку ${point.position}`}
            disabled={busy}
            onClick={onEdit}
          />
          {/* «Совместить» (merge) sits at the point, not only in the hint: the hint gets read and
            dismissed, while people want to combine two stops while looking at one of them. The
            action is the same — the whole same-address group at once.

            The `<span>` wrapper is not decoration: a disabled button emits no mouse events, so its
            tooltip would never show, and the disabled button would stay silent about why. */}
          <span
            title={
              mergeHint
                ? `Свести с точками ${mergeHint.positions.filter((p) => p !== point.position).join(', ')}`
                : 'Совмещать не с чем: другой точки с этим адресом в маршруте нет'
            }
          >
            <Button
              size="small"
              icon={<MergeCellsOutlined />}
              aria-label={`Совместить точку ${point.position}`}
              disabled={busy || !mergeHint}
              onClick={() => mergeHint && onMerge(mergeHint.pointIds)}
            />
          </span>
          <span
            title={
              point.actions.length > 1
                ? 'Разнести: часть работы уйдёт в новую остановку'
                : 'Разносить нечего: на точке одна строка задания'
            }
          >
            <Button
              size="small"
              icon={<SplitCellsOutlined />}
              aria-label={`Разнести точку ${point.position}`}
              disabled={busy || point.actions.length < 2}
              onClick={onSplit}
            />
          </span>
        </Space>
      )}
    </div>
  );
}

/** A role on a point: what is done with the task row and where it goes next. */
function PointActionLine({ action }: { action: RoutePointAction }) {
  const pair = actionPairLabel(action);
  return (
    <div>
      <Space size={6} wrap>
        <Typography.Text style={{ fontSize: 13 }}>{actionLabel(action)}</Typography.Text>
        {pair && (
          <Typography.Text
            // A trip whose other end is not laid out is not a "formatting warning": such a row
            // cannot be printed, and the issue will answer `rows_unplaced`.
            type={action.kind === 'freight' && action.pairPosition === 0 ? 'danger' : 'secondary'}
            style={{ fontSize: 12 }}
          >
            {pair}
          </Typography.Text>
        )}
        {/* Address mismatch (R10): the point keeps its own snapshot, and the request's address has
          been edited since. The **point's** address is printed (R11b), and the issue confirms this
          with the `address_mismatch` warning — here it is surfaced early, while a fix is cheap. */}
        {action.addressMismatch && (
          <Tooltip title="В заявке адрес этой строки задания другой. В бланк пойдёт адрес точки — поправьте его, если ехать надо по заявке.">
            <Tag color="warning">адрес ездки изменился</Tag>
          </Tooltip>
        )}
      </Space>
    </div>
  );
}
