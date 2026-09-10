import { assignmentDimensionLabels, type CancelledAssignmentGroupDto } from '@technic/contracts';
import { formatDateOnly } from './shared';

/**
 * Гасимые сокращением срока решения о технике — человеческой строкой (Д2 плана
 * `docs/assignment-periods-plan.md`).
 *
 * Отдельным модулем, потому что перечень показывают две двери: правка срока (`VehiclePeriodModal`)
 * и закрытие заказа фактической датой (`CompletionConsequences`, ADR 0178). Гашение у них одно и
 * то же — общий планировщик сокращения, — и текст обязан быть одним: разойдись эти две строки хоть
 * словом, один и тот же перечень объяснялся бы человеку по-разному в зависимости от того, каким
 * окном он до него дошёл.
 */

/**
 * Одна гасимая группа: с какого числа и что именно уходит.
 *
 * Гашение групповое (Д2) — вместе с машиной уходит и назначенный на неё машинист, — поэтому состав
 * перечисляется целиком. Имени машиниста в перечне нет и взяться ему неоткуда: строка шкалы
 * `driver` носит состояние, а не человека, — поэтому строка называет состояние, а не выдумывает
 * фамилию.
 */
export function cancelGroupLine(group: CancelledAssignmentGroupDto): string {
  const parts = group.rows.map((row) => {
    if (row.dimension === 'vehicle') {
      return `${assignmentDimensionLabels.vehicle}: ${row.vehicle?.name ?? 'не названа'}`;
    }
    const state = row.driver?.state;
    const text =
      state === 'set'
        ? 'назначенный этим же решением'
        : state === 'cleared'
          ? 'снят — участок вёл арендодатель'
          : 'не восстановлен по бумаге';
    return `${assignmentDimensionLabels.driver}: ${text}`;
  });
  const since = group.rows[0]?.effectiveDate;
  return `с ${since ? formatDateOnly(since) : '—'} — ${parts.join('; ')}`;
}
