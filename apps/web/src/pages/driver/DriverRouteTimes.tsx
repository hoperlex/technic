import { Typography } from 'antd';
import { formatDuration } from '@entities/vehicle-reading';
import type { DraftStopTimes } from './api';
import { TimeField } from './DriverTimeField';
import { hintStyle } from './readingFieldStyles';
import { routeSummary, type ShownStop } from './readingStops';
import { timeFields } from './readingsTimes';

/**
 * «Маршрут — время по факту»: the stops of a route item with their actual times, above the counters
 * (ADR 0234; plan `docs/readings-shifts-merge-plan.md` §7.4, owner decisions D6 and D9, variant A).
 *
 * Stops in route order, each with what is done there and the planned time — the driver fills the
 * day against the task he was given. Stop 1 takes the arrival (the start of the shift) and the
 * departure; every other stop takes the departure only: the segment from the previous departure to
 * this one is this stop's work (D6). The departure from the last stop ends the shift.
 *
 * Below the stops, «Время по заявкам» counts live by the contract's split, so the driver sees what
 * each request gets before sending — and a shared stop says out loud that it is split equally.
 */

const stopStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 10,
  border: '1px solid rgba(0, 0, 0, 0.08)',
  borderRadius: 8,
} as const;

const summaryStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: 10,
  borderRadius: 8,
  background: 'rgba(0, 0, 0, 0.03)',
} as const;

const lineStyle = { display: 'flex', justifyContent: 'space-between', gap: 12 } as const;

/** One stop: where, what is done there, the plan, and the fields of this stop. */
function StopCard({
  stop,
  first,
  last,
  times,
  errors,
  disabled,
  onChange,
}: {
  stop: ShownStop;
  first: boolean;
  last: boolean;
  times: DraftStopTimes;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (patch: Partial<DraftStopTimes>) => void;
}) {
  const edges = [
    first ? 'Прибытие на первую точку — начало смены' : null,
    last ? 'Убытие с последней точки — конец смены' : null,
  ].filter((text): text is string => text !== null);
  return (
    <div style={stopStyle} data-stop={stop.position}>
      <div>
        <Typography.Text strong>{`${stop.position}. ${stop.location}`}</Typography.Text>
        {stop.actions.map((action, index) => (
          <div key={`${action.displayNumber}-${index}`}>
            <Typography.Text style={hintStyle}>
              {[`${action.roleLabel} ${action.displayNumber}`, action.cargoLabel]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          </div>
        ))}
        {stop.plannedTime && (
          <div>
            <Typography.Text type="secondary" style={hintStyle}>
              {`план ${stop.plannedTime}`}
            </Typography.Text>
          </div>
        )}
      </div>
      {first && (
        <TimeField
          label="Прибытие"
          value={times.arrivedAt}
          error={errors[timeFields.arrival(stop.position)]}
          disabled={disabled}
          onChange={(next) => onChange({ arrivedAt: next })}
        />
      )}
      <TimeField
        label="Убытие"
        value={times.departedAt}
        error={errors[timeFields.departure(stop.position)]}
        disabled={disabled}
        onChange={(next) => onChange({ departedAt: next })}
      />
      {edges.map((text) => (
        <Typography.Text key={text} type="secondary" style={hintStyle}>
          {text}
        </Typography.Text>
      ))}
    </div>
  );
}

/** Why the split is not shown yet: in words, so that an empty box does not read as "zero". */
const SUMMARY_WAITS: Record<'incomplete' | 'order' | 'unassigned', string> = {
  incomplete: 'Посчитается, когда будут отмечены прибытие на первую точку и убытие со всех точек',
  order: 'Время идёт не по порядку точек — проверьте убытия',
  unassigned: 'У части точек нет заявки — время между заявками распределит диспетчер',
};

function Summary({
  stops,
  times,
}: {
  stops: readonly ShownStop[];
  times: Record<string, DraftStopTimes>;
}) {
  const summary = routeSummary(stops, times);
  return (
    <div style={summaryStyle} data-testid="route-summary">
      <Typography.Text strong>Время по заявкам</Typography.Text>
      {summary.kind !== 'ok' ? (
        <Typography.Text type="secondary" style={hintStyle}>
          {SUMMARY_WAITS[summary.kind]}
        </Typography.Text>
      ) : (
        <>
          {summary.requests.map((request) => (
            <div key={request.label} style={lineStyle}>
              <span>{request.label}</span>
              <span>{formatDuration(request.minutes)}</span>
            </div>
          ))}
          <div style={lineStyle}>
            <Typography.Text
              strong
            >{`Смена ${summary.shift.from}–${summary.shift.to}`}</Typography.Text>
            <Typography.Text strong>{formatDuration(summary.shift.minutes)}</Typography.Text>
          </div>
          {summary.shared.map((stop) => (
            <Typography.Text key={stop.position} type="secondary" style={hintStyle}>
              {`Общая точка ${stop.position} делится поровну: по ${formatDuration(stop.shareMinutes)} каждой заявке`}
            </Typography.Text>
          ))}
        </>
      )}
    </div>
  );
}

export function RouteTimes({
  stops,
  value,
  errors,
  disabled,
  onChange,
}: {
  stops: readonly ShownStop[];
  value: Record<string, DraftStopTimes>;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (key: string, patch: Partial<DraftStopTimes>) => void;
}) {
  const empty: DraftStopTimes = { arrivedAt: '', departedAt: '' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Typography.Text strong style={{ display: 'block' }}>
        Маршрут — время по факту
      </Typography.Text>
      {stops.map((stop, index) => (
        <StopCard
          key={stop.key}
          stop={stop}
          first={index === 0}
          last={index === stops.length - 1}
          times={value[stop.key] ?? empty}
          errors={errors}
          disabled={disabled}
          onChange={(patch) => onChange(stop.key, patch)}
        />
      ))}
      {errors[timeFields.route] && (
        <Typography.Text type="danger" style={hintStyle}>
          {errors[timeFields.route]}
        </Typography.Text>
      )}
      <Summary stops={stops} times={value} />
    </div>
  );
}
