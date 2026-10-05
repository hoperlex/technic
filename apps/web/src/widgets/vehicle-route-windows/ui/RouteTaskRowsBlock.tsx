import { Button, Collapse, Space, Tag, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import {
  type PointRoleInput,
  type TaskRef,
  taskRefKey,
  taskRowLayoutKind,
  type WaybillFormCode,
  type WaybillTaskRow,
  type VehicleRouteDto,
} from '@technic/contracts';
import {
  blockerMessage,
  reorderedPointRoles,
  type RouteAssembly,
  vehicleRoutesApi,
} from '@entities/vehicle-route';
import { EntityLink } from '@shared/ui';
import { useAuth } from '@entities/session';
import { vehicleRequestViewLink } from '@entities/vehicle-request';
import { useRouteModal } from '@features/route-modal';

/**
 * «Задание листа» (waybill task) — the same day, but as the paper sees it (section 4.3, R11 of
 * `docs/route-trips-plan.md`).
 *
 * The stop list answers "how will the vehicle drive", this block answers "what will be printed on
 * the form", and their order differs only in appearance: task rows follow the order of **points**,
 * but a row is a trip or a linear day, not a stop (in 4-П the "from" and "to" columns form a pair —
 * there is nowhere to print a point). Because of that one stop can yield two rows and two stops can
 * yield one, and the stop list cannot show this.
 *
 * Collapsed because it answers a rare question: the day is assembled by stop order, and people
 * look here twice — when counting whether one more request fits, and when arguing whose coupon the
 * customer will sign. The header counter answers both without expanding.
 *
 * **Not every row has arrows, and that is a rule, not an unfinished feature.** Task row order is
 * the order of tear-off coupons (R12, R20), and almost always the stop order sets it: a row stands
 * where its points stand. It fails to set it in exactly one case — when two rows sit on **the very
 * same** pair of points: auto-assembly reused a stop (R8), and the stop order cannot tell them
 * apart. Only those rows get arrows, and they reorder the work on the shared point: "load this trip
 * at the quarry first". Other rows deliberately have no arrows — they are reordered by moving
 * points in the stop list, and offering two ways to do one thing only confuses.
 *
 * The row number is a link opening the request as a window (ADR 0120,
 * `docs/vehicle-routes-modal-plan.md` section 1): people look here when arguing whose coupon the
 * customer will sign, and the answer to "what work is this" lives in the request, not the form.
 * A task row **structurally** has no request status — `TaskRef` carries only a `requestId`
 * (`packages/contracts/src/route-points.ts`) — and pulling it from the route composition just to
 * pick a tab would fix the wrong thing: the link leads to a window, not a tab, and needs no status
 * at all. Exactly for this case contracts gained the status-independent `vehicleRequestViewPath`,
 * wrapped here by `vehicleRequestViewLink` (plan section 3.5).
 */

interface Props {
  route: VehicleRouteDto;
  formCode: WaybillFormCode | null;
  assembly: RouteAssembly;
  /** An issued waybill freezes the route (R15): the paper is with the driver, too late to move. */
  frozen: boolean;
  /** The route after reordering: the card puts it into the cache and invalidates the lists. */
  onChanged: (route: VehicleRouteDto) => void;
  onFail: (e: unknown) => void;
}

/**
 * How a row is printed: customer coupon, additional task, or not at all.
 *
 * Computed by the same `taskRowLayoutKind` the issue uses to choose a row layout: four rows of the
 * 4-П table carry a tear-off coupon (R12), rows 5–7 are printed in a single cell of the
 * «Дополнительное задание» (additional task) block (ADR 0068), and `null` means "this row will not
 * reach the paper": either the form does not print the task at all (form No. 3, ADR 0071), or the
 * row is beyond capacity.
 */
function slotTag(formCode: WaybillFormCode | null, slot: number) {
  const kind = taskRowLayoutKind(formCode, slot);
  if (kind === 'columns') return <Tag color="green">талон {slot}</Tag>;
  if (kind === 'single-cell') return <Tag>доп. задание, без талона</Tag>;
  return <Tag color="red">не печатается</Tag>;
}

/** A task row as one line: from, to, cargo. A linear day has an empty "from" (R11). */
function rowLine(row: WaybillTaskRow): string {
  const cargo = row.kind === 'freight' ? row.cargoLabel : row.workNote;
  return [row.kind === 'freight' ? `${row.from} → ${row.to}` : row.to, cargo]
    .filter((part) => part.trim() !== '')
    .join(' · ');
}

export function RouteTaskRowsBlock({
  route,
  formCode,
  assembly,
  frozen,
  onChanged,
  onFail,
}: Props) {
  const { can } = useAuth();
  const { openRequest } = useRouteModal();
  const { rows, composition, capacity } = assembly;
  /** Composition rows not yet laid out on points: nothing to print them from (`rows_unplaced`). */
  const unplaced = composition.length - rows.length;
  const overflow = new Map(
    assembly.blockers
      .filter((blocker) => blocker.code === 'required_fields_overflow')
      .map((blocker) => [taskRefKey(blocker.ref), blocker] as const),
  );

  const reorder = useMutation({
    mutationFn: ({ pointId, roles }: { pointId: string; roles: PointRoleInput[] }) =>
      vehicleRoutesApi.points.rolesOrder(route.id, pointId, { roles, version: route.version }),
    onSuccess: onChanged,
    onError: onFail,
  });

  /*
   * Empty fallback for the same reason as in `assembleRoute`: the cache key is shared by the card
   * and the list, and not every server endpoint returns points.
   */
  const points = route.points ?? [];

  /** Roles of the shared point in a new order: the row swaps places with its group neighbour. */
  const rolesFor = (pointId: string, a: TaskRef, b: TaskRef): PointRoleInput[] => {
    const point = points.find((item) => item.id === pointId);
    return point ? reorderedPointRoles(point, a, b) : [];
  };

  /**
   * Moves a row among those the stop order cannot tell apart.
   *
   * It swaps with its neighbour **in the group**, not in the list: group neighbours are printed
   * consecutively (they share the first two sort keys), so a swap within the group is exactly a
   * swap of adjacent rows on paper.
   */
  const move = (ref: TaskRef, delta: number) => {
    const group = assembly.orderGroups.get(taskRefKey(ref));
    if (!group) return;
    const index = group.refs.findIndex((item) => taskRefKey(item) === taskRefKey(ref));
    const target = index + delta;
    if (index < 0 || target < 0 || target >= group.refs.length) return;
    const roles = rolesFor(group.pointId, ref, group.refs[target]!);
    if (roles.length === 0) return;
    reorder.mutate({ pointId: group.pointId, roles });
  };

  return (
    <Collapse
      size="small"
      items={[
        {
          key: 'task',
          label: (
            <Space size={8} wrap>
              <span>Задание листа</span>
              <Typography.Text type={composition.length > capacity ? 'danger' : 'secondary'}>
                {composition.length} из {capacity} строк
              </Typography.Text>
              {unplaced > 0 && <Tag color="orange">не разложено: {unplaced}</Tag>}
            </Space>
          ),
          children: (
            <Space orientation="vertical" size={6} style={{ width: '100%' }}>
              {/* Form No. 3 does not print the task (ADR 0071): a passenger car's execution order
                is not guaranteed, so the form comes out with its details and a blank back side.
                This must be said where people look at the task — otherwise the mismatch between
                paper and route is discovered only after printing. */}
              {formCode !== '4p' && (
                <Typography.Text type="secondary">
                  Задание в этом бланке не печатается: строки остаются планом рейса, а в лист не
                  идут.
                </Typography.Text>
              )}
              {rows.length === 0 && (
                <Typography.Text type="secondary">
                  Строк задания нет: рейс пуст либо его работа ещё не разложена по точкам.
                </Typography.Text>
              )}
              {rows.map((row) => {
                const blocker = overflow.get(taskRefKey(row.ref));
                const group = assembly.orderGroups.get(taskRefKey(row.ref));
                const index = group
                  ? group.refs.findIndex((item) => taskRefKey(item) === taskRefKey(row.ref))
                  : -1;
                return (
                  <div key={taskRefKey(row.ref)} style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Space size={8} wrap>
                        <Tag>{row.slot}</Tag>
                        {/* The row number is the request number with its trip («ТС-40/2»), and it
                          stays bold for the same reason as in the composition: there are up to
                          ten rows (seven on 4-P), and eyes navigate them by number. Without the right to view
                          requests it stays plain text as before. */}
                        <EntityLink
                          to={vehicleRequestViewLink(can, row.ref.requestId)}
                          title="Открыть заявку"
                          onActivate={() => openRequest(row.ref.requestId)}
                        >
                          <strong>{row.displayNumber}</strong>
                        </EntityLink>
                        {slotTag(formCode, row.slot)}
                      </Space>
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {rowLine(row)}
                        </Typography.Text>
                      </div>
                      {/* A row that will not fit on paper is named here too: in the stop list it is
                        shown at its point, and here in its place among the rows, where it becomes
                        clear that it is longer than its neighbours. */}
                      {blocker && (
                        <div>
                          <Typography.Text type="danger" style={{ fontSize: 12 }}>
                            {blockerMessage(blocker, assembly)}
                          </Typography.Text>
                        </div>
                      )}
                    </div>
                    {/* Arrows only for rows the stop order cannot tell apart: for the rest the
                      order is set by points, and a second way to the same order would confuse. */}
                    {!frozen && group && (
                      <Space>
                        <Button
                          size="small"
                          icon={<ArrowUpOutlined />}
                          title="Раньше в задании: на общей точке эта строка идёт первой"
                          aria-label={`Поднять строку задания ${row.displayNumber}`}
                          disabled={index <= 0 || reorder.isPending}
                          onClick={() => move(row.ref, -1)}
                        />
                        <Button
                          size="small"
                          icon={<ArrowDownOutlined />}
                          title="Позже в задании: на общей точке эта строка идёт следующей"
                          aria-label={`Опустить строку задания ${row.displayNumber}`}
                          disabled={
                            index < 0 || index >= group.refs.length - 1 || reorder.isPending
                          }
                          onClick={() => move(row.ref, 1)}
                        />
                      </Space>
                    )}
                  </div>
                );
              })}
              {/* Why not every row has arrows is explained where their absence is noticed:
                otherwise a person reordering coupons would think the button failed to render. */}
              {!frozen && assembly.orderGroups.size > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Стрелки — у строк, стоящих на одних и тех же точках: объезд их не различает, и
                  порядок талонов задаёте вы. Остальные строки переставляются точками в порядке
                  объезда.
                </Typography.Text>
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}
