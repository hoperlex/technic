import { Tag, Typography } from 'antd';
import {
  type WeeklyItemCounts,
  type WeeklyItemWarning,
  type WeeklyRequestStatus,
  weeklyRequestStatusColors,
  weeklyRequestStatusLabels,
} from '@technic/contracts';

function plural(count: number, one: string, few: string, many: string): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * Composition total in words, "8 единиц: 5 продлений, 2 новых, 1 уезжает"
 * (docs/weekly-vehicle-request-plan.md, §5 step 3), shared by the feed card and the weekly request
 * page. Empty item kinds are not listed: "0 новых" answers a question nobody asked and lengthens a
 * line that is read at a glance.
 */
export function weeklyCountsText(counts: WeeklyItemCounts): string {
  const total = counts.extend + counts.new + counts.leave;
  if (total === 0) return 'Состав пуст';
  const parts: string[] = [];
  if (counts.extend > 0) {
    parts.push(`${counts.extend} ${plural(counts.extend, 'продление', 'продления', 'продлений')}`);
  }
  if (counts.new > 0) {
    parts.push(`${counts.new} ${plural(counts.new, 'новая', 'новых', 'новых')}`);
  }
  if (counts.leave > 0) {
    parts.push(`${counts.leave} ${plural(counts.leave, 'уезжает', 'уезжают', 'уезжают')}`);
  }
  return `${total} ${plural(total, 'единица', 'единицы', 'единиц')}: ${parts.join(', ')}`;
}

/** The canonical weekly-request status badge used by page and feed views. */
export function WeeklyStatusTag({ status }: { status: WeeklyRequestStatus }) {
  return (
    <Tag color={weeklyRequestStatusColors[status]} style={{ marginInlineEnd: 0 }}>
      {weeklyRequestStatusLabels[status]}
    </Tag>
  );
}

/**
 * Row warnings as ready text from the contracts (`itemWarnings`): the same text appears in the
 * form, in the approval queue and in the API answer, so it is never rephrased here. Rental is
 * neutral grey and everything else orange: "the lessor keeps ESM-2" is the normal order of things,
 * not a gap (R19).
 */
export function WeeklyItemWarnings({ warnings }: { warnings: WeeklyItemWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div style={{ lineHeight: 1.35 }}>
      {warnings.map((warning) => (
        <div key={warning.kind}>
          <Typography.Text
            type={warning.kind === 'rental' ? 'secondary' : 'warning'}
            style={{ fontSize: 12 }}
          >
            {warning.text}
          </Typography.Text>
        </div>
      ))}
    </div>
  );
}
