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

/**
 * "Stays" and "Leaves" blocks (section 5 steps 2 and 4): a decision for each vehicle standing on
 * site. An unchecked box is not a missing row but a decision to leave (R10), so the choice here is
 * between two explicit options rather than a checkbox: an empty composition caused by unchecked
 * rows must not read as "no decision was made".
 */

const DATE = 'YYYY-MM-DD';

/**
 * Extension span in words: "+7 дн.". Zero is not shown: an extension always lengthens the term
 * (R4).
 */
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
 * Decision for a vehicle: stays or leaves. An empty value means "not decided".
 *
 * "Stays" is disabled by the server's reason (extendBlockedReason), not by a form condition of our
 * own: the predicate is one for the portal and the API (R4), and a second description here would
 * drift, showing the site an option that always refuses. There is exactly one live case: a term
 * running to the week's Sunday, with nothing to extend inside the week; "keep it further" is
 * decided by next week.
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
            // The tooltip explains not only the prohibition but the way out: next week's request
            // picks this order up as usual, which is a core function of the weekly document, not a
            // workaround.
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

/** "Extend to": any day of the week, but strictly after the current term end (R4). */
function ExtendDateControl({ row, decision, editable, weekStart, weekEnd, onChange }: RowProps) {
  // Nothing to extend, so nothing to choose a date from: the only day that would fit here would be
  // rejected by the server at once.
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
        // An extension cannot shorten the term: that is early end, with its own approval (ADR
        // 0044). The form's lower bound is the same day as the server predicate's.
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

/** What a row tells the person: warnings, a vanished order, the apply refusal reason. */
function RowNotes({ row, skipReason }: RowProps) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <WeeklyItemWarnings warnings={row.warnings} />
      {/* The extension ban is explained here, not only in the button tooltip: there is no hover on
          a phone, and the vehicle decision still has to be made. */}
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
  /** Per-row apply refusal reasons (section 9), keyed by the composition item id. */
  skipReasons: Map<string, string>;
  weekStart: string;
  weekEnd: string;
  editable: boolean;
  suggestion: WeeklySuggestionDto | undefined;
}

/**
 * The previous-week report as a line ABOVE the composition (section 3 item 4 of the "composition
 * selection" plan).
 *
 * On top rather than at the end because it is read before decisions: every next request tries to
 * extend all positions of the previous one, and the site office's first question is "did everything
 * agreed a week ago make it here". Dropped orders are named with a reason: otherwise the loss of a
 * familiar vehicle goes unnoticed and the site adds a second row for it.
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

/**
 * Vehicles ordered for longer than a week and orders unfit for the composition, in one note
 * (section 7).
 */
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
        {/* The previous-week report is shown here too: an empty composition after a non-empty
            previous week is exactly when the explanation is needed most. */}
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
    // On a phone rows become cards (ADR 0030): none of them fits a six-column table at 360 px.
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
 * The "Leaves" block (section 5 step 4): departure decisions as a separate list, part of the weekly
 * document and at the same time a task for the dispatcher to arrange the pickup.
 *
 * There is deliberately no "Arrange pickup" button: issuing a relocation is closed to site roles by
 * rights, and a button that always refuses is worse than none (R10). Pickup is arranged in the
 * order's own card, where delivery is created too.
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
