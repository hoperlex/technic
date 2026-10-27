import { Form, Space } from 'antd';
import {
  normalizeTimeInput,
  readingTimeIssues,
  TIME_FORMAT_MESSAGE,
  type ReadingPointInput,
  type ReadingTimeIssue,
  type ReportItemDto,
} from '@technic/contracts';
import { TimeInput } from '@entities/request';

/**
 * Shift and stop times in the staff entry of a reading (ADR 0234; plan
 * `docs/readings-shifts-merge-plan.md` §7.5, owner decision D5): the same fields the driver has,
 * all optional — staff entering or closing a day on a driver's behalf often do not know the times,
 * and the rule that asks the driver for them (`driverReadingTimeIssues`) is the driver's only.
 *
 * Shape and order are checked for staff as for anyone (`readingTimeIssues`), before the request,
 * so that a refusal stands under its field instead of coming back as one sentence.
 *
 * A route's stops are the reading's SAVED stops: their times are corrected by position, as the
 * server addresses them after a route rebuild. A route reading without saved stops shows no stop
 * fields — the first capture of a stop set needs the live stops of the route with their ids, which
 * the report card does not carry; the driver captures them from the cabinet.
 */

/** A refusal under a time field, in the shape `setFields` takes. */
interface FieldError {
  name: 'startedAt' | ['stops', number, 'departedAt'];
  errors: string[];
}

export interface TimeValues {
  startedAt?: string;
  endedAt?: string;
  /** Times of the saved stops, in their order. */
  stops?: { arrivedAt?: string; departedAt?: string }[];
}

/** An optional time: empty is fine, a typed one must read as `HH:mm` (any hour — shifts run at night). */
const timeRule = {
  validator: (_rule: unknown, raw: string | undefined) =>
    !raw?.trim() || normalizeTimeInput(raw)
      ? Promise.resolve()
      : Promise.reject(new Error(TIME_FORMAT_MESSAGE)),
};

/** The saved times as the form's initial values. */
export function timeInitialValues(item: ReportItemDto): TimeValues {
  const reading = item.reading;
  return {
    startedAt: item.sourceKind === 'esm2' ? (reading?.startedAt ?? '') : '',
    endedAt: item.sourceKind === 'esm2' ? (reading?.endedAt ?? '') : '',
    stops: (reading?.points ?? []).map((point) => ({
      arrivedAt: point.arrivedAt ?? '',
      departedAt: point.departedAt ?? '',
    })),
  };
}

export function IntakeTimeFields({ item }: { item: ReportItemDto }) {
  if (item.sourceKind === 'esm2') {
    return (
      <Space size={12} style={{ display: 'flex' }}>
        <Form.Item name="startedAt" label="Время начала смены" rules={[timeRule]}>
          <TimeInput />
        </Form.Item>
        <Form.Item name="endedAt" label="Время окончания смены" rules={[timeRule]}>
          <TimeInput />
        </Form.Item>
      </Space>
    );
  }
  return (item.reading?.points ?? []).map((point, index) => (
    <Space key={point.position} size={12} style={{ display: 'flex' }}>
      {index === 0 && (
        <Form.Item
          name={['stops', index, 'arrivedAt']}
          label={`${point.position}. ${point.location} — прибытие`}
          rules={[timeRule]}
        >
          <TimeInput />
        </Form.Item>
      )}
      <Form.Item
        name={['stops', index, 'departedAt']}
        label={index === 0 ? 'убытие' : `${point.position}. ${point.location} — убытие`}
        rules={[timeRule]}
      >
        <TimeInput />
      </Form.Item>
    </Space>
  ));
}

const time = (raw: string | undefined): string | null =>
  raw?.trim() ? (normalizeTimeInput(raw) ?? null) : null;

/**
 * The time keys of a staff `values` reading, or the refusals of the contract's shape and order rule
 * under their fields. Keys are explicit, empty as `null`: the form shows the saved times, so an
 * emptied field is the decision to clear it (the ADR 0163 Р13 wire contract).
 */
export function timeKeys(
  item: ReportItemDto,
  values: TimeValues,
):
  | { keys: { startedAt?: string | null; endedAt?: string | null; points?: ReadingPointInput[] } }
  | { fields: FieldError[] } {
  if (item.sourceKind === 'esm2') {
    const startedAt = time(values.startedAt);
    const endedAt = time(values.endedAt);
    const issues = readingTimeIssues('esm2', { startedAt, endedAt, points: [] });
    if (issues.length > 0) {
      return {
        fields: issues.map((issue) => ({ name: 'startedAt', errors: [issue.message] })),
      };
    }
    return { keys: { startedAt, endedAt } };
  }
  const saved = item.reading?.points ?? [];
  if (saved.length === 0) return { keys: {} };
  const points = saved.map((point, index) => ({
    position: point.position,
    routePointId: point.routePointId,
    arrivedAt: index === 0 ? time(values.stops?.[index]?.arrivedAt) : null,
    departedAt: time(values.stops?.[index]?.departedAt),
  }));
  const issues = readingTimeIssues('route', { startedAt: null, endedAt: null, points });
  if (issues.length > 0) {
    const index = (issue: ReadingTimeIssue) =>
      issue.position === null
        ? saved.length - 1
        : saved.findIndex((p) => p.position === issue.position);
    return {
      fields: issues.map((issue) => ({
        name: ['stops', Math.max(0, index(issue)), 'departedAt'],
        errors: [issue.message],
      })),
    };
  }
  return { keys: { points } };
}
