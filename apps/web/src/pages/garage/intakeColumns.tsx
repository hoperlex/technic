import { Badge, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import dayjs from 'dayjs';
import { intakeLevel, type IntakeIssue, type ReadingIntakeRow } from '@technic/contracts';
import { decimal } from './readingNumbers';

/**
 * Строка реестра приёма: что за смена, чья она, какие числа пришли и что с ними не так
 * (план «Показания техники», Р5—Р7).
 *
 * **Портал здесь ничего не считает и ничего не сочиняет.** Пометку строит сервер — с кодом, уровнем
 * и готовым текстом, в котором уже стоят числа и даты («прирост 3 400 км за 1 день при пороге
 * 1 500 км»); уровень строки собирает единственная функция контрактов `intakeLevel`. Своя формула
 * уровня на портале означала бы ровно то, чего Р5 избегает: кнопка пакетного приёма предлагала бы
 * принять день, который экран красит жёлтым.
 *
 * Зелёная строка молчит. Пометок у неё нет вовсе (Р6) — не «всё в порядке» в каждой из полусотни
 * строк, а пустая графа: реестр открывают ради тех строк, где что-то не так, и хор подтверждений
 * прячет их ровно так же, как прятал бы шум любого другого рода.
 */

const SHOWN_DATE = 'DD.MM.YYYY';
const SHOWN_TIME = 'DD.MM HH:mm';

const secondary = { fontSize: 12 } as const;

/**
 * Цвет уровня. Слово рядом с цветом — не пересказ пометки, а имя самого цвета: без него строка
 * различается только оттенком точки, а это не различается ни в подсказке, ни глазами того, кто
 * цвета путает. Причина же всегда стоит текстом в графе «Пометки» — её сочинил сервер.
 */
const LEVEL_HINT: Record<'green' | 'yellow' | 'red', string> = {
  green: 'В порядке: показание сдано, вопросов к нему нет',
  yellow: 'Требует внимания',
  red: 'Требует разбора сейчас',
};

const LEVEL_STATUS = { green: 'success', yellow: 'warning', red: 'error' } as const;

/** Точка уровня строки: максимум уровней её пометок, посчитанный контрактами (Р5). */
export function IntakeLevelDot({ issues }: { issues: readonly IntakeIssue[] }) {
  const level = intakeLevel(issues);
  return (
    <Tooltip title={LEVEL_HINT[level]}>
      <Badge status={LEVEL_STATUS[level]} />
    </Tooltip>
  );
}

/**
 * Пометки строки текстом сервера (Р7). Красная и жёлтая различаются цветом, а не порядком: их
 * порядок задал сервер, и переставлять его значило бы решать за него, что важнее.
 */
export function IntakeIssues({ issues }: { issues: readonly IntakeIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <Space orientation="vertical" size={2} style={{ display: 'flex' }}>
      {issues.map((issue, index) => (
        <Tag
          key={`${issue.code}-${index}`}
          color={issue.level === 'red' ? 'red' : 'gold'}
          style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}
        >
          {issue.message}
        </Tag>
      ))}
    </Space>
  );
}

/** Когда показание передали. Нет показания — нет и времени: строка ждёт, а не молчит по ошибке. */
function PersonCell({ row }: { row: ReadingIntakeRow }) {
  return (
    <Space orientation="vertical" size={0}>
      <span>{row.personName || '—'}</span>
      <Typography.Text type="secondary" style={secondary}>
        {row.reading
          ? `${row.reading.source === 'staff' ? 'внесено персоналом' : 'передано'} ${dayjs(
              row.reading.recordedAt,
            ).format(SHOWN_TIME)}`
          : 'показание не передано'}
      </Typography.Text>
    </Space>
  );
}

/** Число показания. Прочерк — не ноль: у `no_data` и у несданной смены чисел нет по существу. */
function number(value: number | null | undefined, digits = 1) {
  const text = decimal(value ?? null, digits);
  return text === '—' ? <Typography.Text type="secondary">—</Typography.Text> : text;
}

export const intakeColumns: TableColumnType<ReadingIntakeRow>[] = [
  {
    key: 'level',
    title: '',
    width: 44,
    align: 'center',
    render: (_v, r) => <IntakeLevelDot issues={r.issues} />,
  },
  {
    key: 'day',
    title: 'День и смена',
    width: 200,
    render: (_v, r) => (
      <Space orientation="vertical" size={0}>
        <span>{dayjs(r.reportDate).format(SHOWN_DATE)}</span>
        <Space size={6} wrap>
          <Typography.Text type="secondary" style={secondary}>
            {r.sourceLabel || '—'}
          </Typography.Text>
          {r.sourceKind === 'esm2' && <Tag style={{ marginInlineEnd: 0 }}>ЭСМ-2</Tag>}
        </Space>
      </Space>
    ),
  },
  { key: 'vehicle', title: 'Техника', dataIndex: 'vehicleLabel', width: 240 },
  { key: 'person', title: 'Кто передал', width: 220, render: (_v, r) => <PersonCell row={r} /> },
  {
    key: 'odometer',
    title: 'Одометр, км',
    width: 130,
    align: 'right',
    render: (_v, r) => number(r.reading?.odometerKm, 0),
  },
  {
    key: 'engineHours',
    title: 'Моточасы',
    width: 120,
    align: 'right',
    render: (_v, r) => number(r.reading?.engineHours),
  },
  {
    // Заправлено за смену, а не остаток и не расход (Р28): портал называет ровно то, что считает.
    key: 'fuel',
    title: 'Заправлено, л',
    width: 130,
    align: 'right',
    render: (_v, r) => number(r.reading?.fuelFilledLiters),
  },
  { key: 'issues', title: 'Пометки', render: (_v, r) => <IntakeIssues issues={r.issues} /> },
];
