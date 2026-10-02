import { DatePicker, Radio, Table, Tooltip, Typography, type TableColumnType } from 'antd';
import dayjs from 'dayjs';
import {
  dateKeySpan,
  shiftDateKey,
  type WeeklySuggestionDto,
  type WeeklySuggestionOrderDto,
} from '@technic/contracts';
import { formatDateOnly, useIsMobile } from '@shared/lib';
import { WeeklyItemWarnings, weeklyPreviousText } from '@entities/weekly-request';
import type { WeeklyOrderDecision, WeeklyOrderRow } from '../model/compositionState';

/** Each on-site order has an explicit stay/leave decision; unchecked is not equivalent to leave. */

const DATE = 'YYYY-MM-DD';

/** Show only a positive extension span because an extension cannot shorten an order. */
function gainLabel(from: string, to: string): string | null {
  const days = dateKeySpan(shiftDateKey(from, 1), to);
  return days > 0 ? `+${days} дн.` : null;
}

interface RowProps {
  row: WeeklyOrderRow;
  decision: WeeklyOrderDecision;
  editable: boolean;
  weekStart: string;
  weekEnd: string;
  skipReason: string | undefined;
  onChange: (patch: Partial<WeeklyOrderDecision>) => void;
}

/**
 * Use the server-owned `extendBlockedReason` instead of recreating eligibility in the form. An
 * order already running through Sunday can only be kept by the next week's document.
 */
function DecisionControl({ row, decision, editable, onChange }: RowProps) {
  const blocked = row.extendBlockedReason;
  return (
    <Radio.Group
      size="small"
      optionType="button"
      disabled={!editable}
      value={decision.kind ?? undefined}
      onChange={(e) => onChange({ kind: e.target.value as 'extend' | 'leave' })}
      options={[
        {
          label: blocked ? (
            // The tooltip names the supported next-week path instead of only stating the blocker.
            <Tooltip
              title={`${blocked}. Чтобы оставить дальше — соберите заявку на следующую неделю`}
            >
              Остаётся
            </Tooltip>
          ) : (
            'Остаётся'
          ),
          value: 'extend',
          disabled: !!blocked,
        },
        { label: 'Уезжает', value: 'leave' },
      ]}
      aria-label={`Решение по заказу ${row.displayNumber}`}
    />
  );
}

/** Extension may end on any target-week day strictly after the current end. */
function ExtendDateControl({ row, decision, editable, weekStart, weekEnd, onChange }: RowProps) {
  // Do not offer a date when every target-week value would be rejected.
  if (row.extendBlockedReason) return <Typography.Text type="secondary">—</Typography.Text>;
  if (decision.kind !== 'extend') return <Typography.Text type="secondary">—</Typography.Text>;
  const min = row.effectiveDateTo > weekStart ? shiftDateKey(row.effectiveDateTo, 1) : weekStart;
  const gain = gainLabel(row.effectiveDateTo, decision.dateTo);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <DatePicker
        size="small"
        style={{ width: '100%' }}
        format="DD.MM.YYYY"
        allowClear={false}
        disabled={!editable}
        // Shortening belongs to the separately approved early-end flow (ADR 0044).
        disabledDate={(d) => {
          const key = d.format(DATE);
          return key < min || key > weekEnd;
        }}
        value={decision.dateTo ? dayjs(decision.dateTo) : null}
        onChange={(d) => d && onChange({ dateTo: d.format(DATE) })}
      />
      {gain && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {gain}
        </Typography.Text>
      )}
    </div>
  );
}

/** Keep warnings, stale-source context and application failures attached to their row. */
function RowNotes({ row, skipReason }: RowProps) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <WeeklyItemWarnings warnings={row.warnings} />
      {/* Repeat the blocker as text because touch users cannot rely on a hover tooltip. */}
      {row.extendBlockedReason && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {row.extendBlockedReason}. Чтобы оставить дальше — соберите заявку на следующую неделю
        </Typography.Text>
      )}
      {row.staleReason && <Typography.Text type="danger">{row.staleReason}</Typography.Text>}
      {skipReason && <Typography.Text type="danger">Не применена: {skipReason}</Typography.Text>}
    </div>
  );
}

interface Props {
  rows: WeeklyOrderRow[];
  decisions: Record<string, WeeklyOrderDecision>;
  setDecision: (requestId: string, patch: Partial<WeeklyOrderDecision>) => void;
  /** Row-level application failures keyed by saved composition item id. */
  skipReasons: Map<string, string>;
  weekStart: string;
  weekEnd: string;
  editable: boolean;
  suggestion: WeeklySuggestionDto | undefined;
}

/**
 * Put previous-week continuity before decisions and name every dropped order with its reason, so
 * a missing familiar vehicle cannot silently turn into a duplicate additional request.
 */
function PreviousWeekNote({ suggestion }: { suggestion: WeeklySuggestionDto | undefined }) {
  const previous = suggestion?.previous;
  if (!previous) return null;
  return (
    <div style={{ marginBottom: 8, lineHeight: 1.4 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {weeklyPreviousText(previous)}
      </Typography.Text>
    </div>
  );
}

/** Explain orders outside this week's decision scope without mixing them into editable rows. */
function SuggestionNotes({ suggestion }: { suggestion: WeeklySuggestionDto | undefined }) {
  const beyond: WeeklySuggestionOrderDto[] = suggestion?.beyond ?? [];
  const blocked = suggestion?.blocked ?? [];
  if (beyond.length === 0 && blocked.length === 0) return null;
  return (
    <div style={{ marginTop: 8, lineHeight: 1.4 }}>
      {beyond.length > 0 && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Ещё {beyond.length} ед. заказаны дольше недели — решать по ним на этой неделе нечего:{' '}
            {beyond.map((o) => o.displayNumber).join(', ')}
          </Typography.Text>
        </div>
      )}
      {blocked.length > 0 && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Не годятся в состав: {blocked.map((b) => `${b.displayNumber} — ${b.reason}`).join('; ')}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}

export function WeeklyRequestComposition(props: Props) {
  const isMobile = useIsMobile();
  const rowProps = (row: WeeklyOrderRow): RowProps => ({
    row,
    decision: props.decisions[row.requestId] ?? { kind: null, dateTo: '' },
    editable: props.editable,
    weekStart: props.weekStart,
    weekEnd: props.weekEnd,
    skipReason: row.itemId ? props.skipReasons.get(row.itemId) : undefined,
    onChange: (patch) => props.setDecision(row.requestId, patch),
  });

  if (props.rows.length === 0) {
    return (
      <div>
        {/* Continuity matters most when a non-empty previous week yields no current rows. */}
        <PreviousWeekNote suggestion={props.suggestion} />
        <Typography.Text type="secondary">
          На площадке нет техники, срок которой кончается на этой неделе, — состав собирается из
          одной дополнительной техники.
        </Typography.Text>
        <SuggestionNotes suggestion={props.suggestion} />
      </div>
    );
  }

  const columns: TableColumnType<WeeklyOrderRow>[] = [
    { key: 'num', title: 'Заказ', dataIndex: 'displayNumber', width: 110 },
    { key: 'title', title: 'Техника', dataIndex: 'title' },
    {
      key: 'current',
      title: 'Сейчас до',
      width: 110,
      render: (_v, r) => (r.effectiveDateTo ? formatDateOnly(r.effectiveDateTo) : '—'),
    },
    {
      key: 'decision',
      title: 'Решение',
      width: 180,
      render: (_v, r) => <DecisionControl {...rowProps(r)} />,
    },
    {
      key: 'dateTo',
      title: 'Продлить до',
      width: 170,
      render: (_v, r) => <ExtendDateControl {...rowProps(r)} />,
    },
    {
      key: 'notes',
      title: 'Последствия',
      width: 320,
      render: (_v, r) => <RowNotes {...rowProps(r)} />,
    },
  ];

  if (isMobile) {
    // Six decision columns cannot remain legible at the mobile width (ADR 0030).
    return (
      <div className="list-cards">
        <PreviousWeekNote suggestion={props.suggestion} />
        {props.rows.map((row) => {
          const p = rowProps(row);
          return (
            <div key={row.requestId} className="list-card">
              <div className="list-card__head">
                <Typography.Text strong>{row.displayNumber}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  сейчас до {row.effectiveDateTo ? formatDateOnly(row.effectiveDateTo) : '—'}
                </Typography.Text>
              </div>
              <div className="list-card__primary">{row.title}</div>
              <div className="list-card__line">
                <DecisionControl {...p} />
              </div>
              {p.decision.kind === 'extend' && (
                <div className="list-card__line">
                  <ExtendDateControl {...p} />
                </div>
              )}
              <div className="list-card__line">
                <RowNotes {...p} />
              </div>
            </div>
          );
        })}
        <SuggestionNotes suggestion={props.suggestion} />
      </div>
    );
  }

  return (
    <div>
      <PreviousWeekNote suggestion={props.suggestion} />
      <Table<WeeklyOrderRow>
        rowKey="requestId"
        size="small"
        columns={columns}
        dataSource={props.rows}
        pagination={false}
      />
      <SuggestionNotes suggestion={props.suggestion} />
    </div>
  );
}

/**
 * Leaving rows are both document decisions and dispatch reminders. Pickup stays in the ordinary
 * order card because site roles cannot issue relocation documents; a guaranteed 403 button here
 * would be misleading.
 */
export function WeeklyRequestLeaving({
  rows,
  decisions,
}: {
  rows: WeeklyOrderRow[];
  decisions: Record<string, WeeklyOrderDecision>;
}) {
  const leaving = rows.filter((r) => decisions[r.requestId]?.kind === 'leave');
  if (leaving.length === 0) {
    return <Typography.Text type="secondary">Ничего не уезжает.</Typography.Text>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {leaving.map((row) => (
        <div key={row.requestId} style={{ lineHeight: 1.4 }}>
          <Typography.Text strong>{row.displayNumber}</Typography.Text> · {row.title} · срок до{' '}
          {row.effectiveDateTo ? formatDateOnly(row.effectiveDateTo) : '—'}
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Вывоз оформляет диспетчер перегоном по заказу — недельная заявка бланков не выписывает
            </Typography.Text>
          </div>
        </div>
      ))}
    </div>
  );
}
