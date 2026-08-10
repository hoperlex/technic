import { DatePicker, Radio, Table, Tooltip, Typography, type TableColumnType } from 'antd';
import dayjs from 'dayjs';
import {
  dateKeySpan,
  shiftDateKey,
  type WeeklySuggestionDto,
  type WeeklySuggestionOrderDto,
} from '@technic/contracts';
import { useIsMobile } from '@shared/lib';
import { formatDateOnly } from '../../utils/date';
import type { WeeklyOrderDecision, WeeklyOrderRow } from './weeklyComposition';
import { ItemWarnings, weeklyPreviousText } from './weeklyShared';

/**
 * Блоки «Остаётся» и «Уезжает» (§5 шаги 2 и 4): решение по каждой единице, которая стоит на
 * площадке. Снятая галка — не отсутствие строки, а решение об отъезде (Р10), поэтому выбор здесь
 * из двух явных вариантов, а не чекбокс: пустой состав из-за неотмеченных строк не должен
 * читаться как «решения не было».
 */

const DATE = 'YYYY-MM-DD';

/** Прибавка к сроку словами: «+7 дн.». Ноль не показывается — продление всегда удлиняет срок (Р4). */
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
 * Выбор решения по единице: остаётся или уезжает. Незаполненное значение — «решение не принято».
 *
 * «Остаётся» гасится причиной с сервера (`extendBlockedReason`), а не собственным условием формы:
 * предикат один на портал и API (Р4), и второе его описание здесь разошлось бы с первым — площадка
 * увидела бы вариант, который всегда отказывает. Живой случай ровно один — срок, идущий до
 * воскресенья недели: продлевать внутри неё нечего, и «оставить дальше» решает следующая неделя.
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
            // Подсказка объясняет не только запрет, но и выход: заявка на следующую неделю
            // подтянет этот заказ штатно, и это одна из основных функций недельного документа, а
            // не обход ограничения.
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

/** «Продлить до»: любой день недели, но строго позже нынешнего конца срока (Р4). */
function ExtendDateControl({ row, decision, editable, weekStart, weekEnd, onChange }: RowProps) {
  // Продлевать нечем — и выбирать дату не из чего: единственный день, который сюда влез бы, сервер
  // тут же и отверг бы.
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
        // Сокращение срока продлением невозможно: сокращают досрочным завершением, и у него своя
        // виза (ADR 0044). Форма ограничена снизу тем же днём, что и предикат сервера.
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

/** Что строка говорит человеку: предупреждения, пропавший заказ, причина отказа применения. */
function RowNotes({ row, skipReason }: RowProps) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <ItemWarnings warnings={row.warnings} />
      {/* Запрет продления объясняется здесь же, а не только подсказкой на кнопке: на телефоне
          подсказку не наведёшь, а решение по единице принимать всё равно надо. */}
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
  /** Построчные причины отказа применения (§9), ключ — идентификатор строки состава. */
  skipReasons: Map<string, string>;
  weekStart: string;
  weekEnd: string;
  editable: boolean;
  suggestion: WeeklySuggestionDto | undefined;
}

/**
 * Отчёт по прошлой неделе — строкой **над** составом (§3 п. 4 плана «Отбор состава»).
 *
 * Сверху, а не в конце, потому что читается он до решений: каждая следующая заявка пытается
 * продлить все позиции прошлой, и первый вопрос штаба — «всё ли, о чём договорились неделю назад,
 * доехало сюда». Выбывшие названы поимённо с причиной: без этого пропажу знакомой машины из
 * состава заметить нечем, и на площадке заведут вторую строку.
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

/** Единицы, заказанные дольше недели, и заказы, не годные в состав, — одной припиской (§7). */
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
        {/* Отчёт по прошлой неделе показывается и здесь: пустой состав при непустой прошлой
            неделе — это как раз тот случай, когда объяснение нужнее всего. */}
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
    // На телефоне строки становятся карточками (ADR 0030): в таблицу с шестью колонками на 360 px
    // не помещается ни одна из них целиком.
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
 * Блок «Уезжает» (§5 шаг 4): решения об отъезде отдельным списком — это часть недельного
 * документа и одновременно задача диспетчеру оформить вывоз.
 *
 * Кнопки «Оформить вывоз» здесь нет намеренно: маршрут выписки перегона закрыт объектным ролям по
 * правам, а кнопка, которая всегда отказывает, хуже её отсутствия (Р10). Вывоз оформляют в
 * карточке самого заказа — там же, где заводят доставку.
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
