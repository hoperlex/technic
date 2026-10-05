import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, App, Button, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type LinearDaySubject,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDayDto,
  type VehicleRequestDaysDto,
  weeklyWeekLabel,
  weekStartKey,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { useAuth } from '@entities/session';
import { vehicleRequestErrorMessage as errorMessage } from '@entities/vehicle-request';
import { garageKeys } from '@entities/garage';
import { formatDateOnly } from '@shared/lib';
import { useRouteModal } from '@features/route-modal';
import { dayColumns } from './dayColumns';
import { VehicleDayBatchModal } from './VehicleDayBatchModal';
import { VehicleDayRouteModal } from '@widgets/vehicle-route-windows';

/**
 * Work days are maintained at the on-site equipment order (ADR 0100 decision 8).
 *
 * An order day is one outing: it joins the vehicle's route for that date and appears on its 4-P.
 * Days were introduced for linear equipment that returns to base and can visit several sites in
 * one day. Linearity no longer gates this entry (ADR 0207): equipment staying on one site for a
 * week can also need a daily 4-P.
 *
 * Both planning entries live here. A single day already knows its order and term; a route card
 * would have to search all running orders by site. Routes therefore show and remove days but do
 * not add them (`LINEAR_DAY_DOOR_MESSAGE`). Batch planning covers the whole term after extensions,
 * missed days or annulled waybills. Different vehicles or drivers on individual dates no longer
 * prohibit a batch: it takes the assigned vehicle and skips conflicting days with a reason rather
 * than moving them.
 *
 * A file of its own, not a block of the request card: the card sits right at its length limit,
 * while this table — with its week window, three queries and two mutations — is a self-contained
 * planning workflow.
 */

interface Props {
  /** Any on-site equipment order can expose days; the server's blocker explains ineligibility. */
  request: SpecialEquipmentRequestDto;
  /**
   * Read-only entry over another screen: route composition, waybill journal or garage (route and
   * request windows plan, §3.5). The full table remains, but the action column and the planning
   * dialog are absent.
   *
   * This needs a flag rather than an omitted action prop because planning owns its mutations
   * here. Its permission pair, vehicleRequests.status && waybills.read, also opens the route, so
   * rights alone would give a dispatcher an active planner when they only asked to inspect an
   * order from that route.
   *
   * Hiding the whole tab would remove the very answer this entry exists for: which route carries
   * each day. Reading it must remain as complete as reading the same card from the order list.
   */
  readOnly?: boolean;
}

export function VehicleRequestDays({ request, readOnly }: Props) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { openRoute } = useRouteModal();
  /**
   * The underlying route already has its card open (`?route=X&request=Y`). A day in X must not
   * link to that same card underneath this window (plan §3.1, invariant 3). The address is the
   * window state; the provider deliberately keeps no competing React copy of it.
   */
  const [params] = useSearchParams();
  const openedRouteId = readOnly ? params.get('route') : null;
  /** A null target closes the single-day planner. */
  const [planning, setPlanning] = useState<string | null>(null);
  /** Batch planning has a separate window from a single day (ADR 0207). */
  const [batching, setBatching] = useState(false);
  /** A manual week selection overrides the server's current-week default. */
  const [picked, setPicked] = useState<string | null>(null);

  const { data, isPending } = useQuery({
    queryKey: vehicleRequestKeys.days(request.id),
    queryFn: () => vehicleRequestsApi.days(request.id),
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  /** Existing route days let the shared rule determine whether a selected day is free. */
  const plannedDays = useMemo(() => items.filter((d) => d.route).map((d) => d.date), [items]);

  /**
   * Planning uses the same workflow grant as taking an order into work, plus route access: its
   * choices expose other vehicles and drivers' names. Both grants match the endpoint so a button
   * never promises an action the server will refuse.
   */
  const canPlan = can('vehicleRequests.status') && can('waybills.read');

  /**
   * Build the subject for the shared day rules from the card. Each row's blocker must come from
   * the same planDayBlocker used by the server, down to the wording of the refusal.
   */
  const subject: LinearDaySubject = {
    requestType: request.requestType,
    isLinear: request.isLinear,
    status: request.status,
    deletedAt: request.deletedAt,
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    ownership: request.assignment?.ownership ?? null,
  };

  /**
   * A write returns the entire day table, which replaces the cache. Days have no separate version
   * and the portal cannot reproduce the server's renumbering of free task rows in other routes.
   */
  const applyDays = (days: VehicleRequestDaysDto) => {
    qc.setQueryData(vehicleRequestKeys.days(request.id), days);
    // Order rows embed the day's route and vehicle, both of which planning can change.
    void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    // A day either joins an existing route or creates one; both change the route list's composition.
    void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
    // The garage is a server-derived daily view (ADR 0076), whose work visibility depends on route
    // composition (ADR 0131). Removing the final day removes an empty route without a waybill and
    // frees its vehicle and driver; adding a day occupies them. Without invalidation the dispatcher
    // would keep seeing availability that no longer exists.
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  };

  const unplan = useMutation({
    mutationFn: (date: string) => vehicleRequestsApi.unplanDay(request.id, date),
    onSuccess: (days, date) => {
      message.success(`День ${formatDateOnly(date)} снят с рейса`);
      applyDays(days);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * A quarter-long order has about ninety days, too many to read in one run (plan U13). Group them
   * by the same Monday–Sunday weekStartKey used by ESM-2 and weekly requests; the portal must not
   * invent another definition of a week.
   */
  const weeks = useMemo(() => {
    const byWeek = new Map<string, VehicleRequestDayDto[]>();
    for (const day of items) {
      const start = weekStartKey(day.date);
      const week = byWeek.get(start);
      if (week) week.push(day);
      else byWeek.set(start, [day]);
    }
    return [...byWeek.entries()]
      .map(([start, days]) => ({ start, days }))
      .sort((a, b) => a.start.localeCompare(b.start));
  }, [items]);

  /**
   * Default to the server's current week so a long-running order does not require scrolling from
   * its first week on every visit. onDate comes from the server because the browser clock can be
   * wrong. Before or after the order's term, fall back to the first week.
   */
  const defaultWeek = data
    ? (weeks.find((w) => w.start === weekStartKey(data.onDate))?.start ?? weeks[0]?.start ?? null)
    : null;
  const shown = weeks.find((w) => w.start === picked)?.start ?? defaultWeek;
  const index = weeks.findIndex((w) => w.start === shown);
  const week = index >= 0 ? weeks[index]! : null;

  /**
   * The action column exists only with planning rights and in the working entry, never in the
   * read-only card. Disabled buttons would misstate why a dispatcher with sufficient rights cannot
   * plan here. A customer reading the plan (ADR 0122) never has those rights, so two dead buttons
   * per row would be permanent noise. Both cases omit the column entirely.
   */
  const columns = dayColumns({
    can,
    openRoute,
    openedRouteId,
    actions:
      readOnly || !canPlan
        ? null
        : {
            subject,
            plannedDays,
            busy: unplan.isPending,
            onUnplan: (date) => unplan.mutate(date),
            onPlan: setPlanning,
          },
  });

  if (isPending) return <Spin size="small" />;

  // Explain ineligibility with the server's words instead of an empty table: for a rental order,
  // the lessor maintains routes and the portal has no day rows to supply (plan U14).
  if (data?.blocker) return <Alert type="info" showIcon title={data.blocker} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Ninety consecutive days are not readable at once. Arrows browse adjacent weeks; the
        selector also allows a direct jump to the end of a long term. */}
      <Space size={[12, 8]} wrap>
        <Space.Compact>
          <Button
            icon={<LeftOutlined />}
            title="Предыдущая неделя"
            aria-label="Предыдущая неделя"
            disabled={index <= 0}
            onClick={() => setPicked(weeks[index - 1]!.start)}
          />
          <Select
            value={shown ?? undefined}
            style={{ minWidth: 260 }}
            onChange={setPicked}
            options={weeks.map((w) => ({
              value: w.start,
              label: `${weeklyWeekLabel(w.start)} · ${w.days.filter((d) => d.route).length} из ${w.days.length}`,
            }))}
          />
          <Button
            icon={<RightOutlined />}
            title="Следующая неделя"
            aria-label="Следующая неделя"
            disabled={index < 0 || index >= weeks.length - 1}
            onClick={() => setPicked(weeks[index + 1]!.start)}
          />
        </Space.Compact>
        {/* The remaining-day question concerns the whole order, so its total must not change
          when the reader switches the visible week. */}
        <Tag color={plannedDays.length === items.length ? 'green' : 'orange'}>
          распланировано {plannedDays.length} из {items.length} дней
        </Tag>
        {/* Batch planning (ADR 0207) uses the assigned vehicle and reports conflicting days.
          Unplanned days are the reason to open it, hence its place beside their total. It uses
          exactly the same availability condition as the single-day entry. */}
        {!readOnly && canPlan && (
          <Button onClick={() => setBatching(true)}>Распланировать период</Button>
        )}
      </Space>

      <Table
        rowKey="date"
        size="small"
        dataSource={week?.days ?? []}
        columns={columns}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        День ставят в рейс по одному, когда на него выходит своя машина или свой водитель; весь срок
        разом проходит «Распланировать период» — машиной назначения и одним человеком. Часы дня
        подтверждают на вкладке «На объекте», а печатается день строкой задания в листе рейса.
      </Typography.Text>

      {/* The day and site are known; the planner asks for vehicle and driver. It is absent, not
        merely hidden, in read-only and customer views. Its only entry is the action column, also
        absent there, so planning stays null and no latent planner exists in those modes. */}
      {!readOnly && canPlan && (
        <VehicleDayRouteModal
          // The server's onDate uses the same timezone as backdateGuard. It tells the dialog
          // whether a past-day reason is required (ADR 0101 item 4); a wrong browser clock must
          // not make the form and endpoint disagree.
          target={planning ? { request, date: planning, onDate: data?.onDate ?? planning } : null}
          onClose={() => setPlanning(null)}
          onDone={(days) => {
            setPlanning(null);
            applyDays(days);
          }}
        />
      )}

      {/* The batch shares the single-day condition and server date; a second availability rule
        would drift. Its own report survives closing the window because it is read after the
        command has finished. */}
      {!readOnly && canPlan && (
        <VehicleDayBatchModal
          target={batching && data ? { request, onDate: data.onDate } : null}
          onClose={() => setBatching(false)}
          onDone={applyDays}
        />
      )}
    </div>
  );
}
