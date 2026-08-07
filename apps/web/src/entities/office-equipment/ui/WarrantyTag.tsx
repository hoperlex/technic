import { Tag, Typography } from 'antd';
import {
  warrantyLabel,
  warrantyState,
  warrantyStateColors,
  warrantyToday,
} from '@technic/contracts';

/**
 * Состояние гарантии одним тегом (Р25, §9.6): зелёный «до 12.03.2027», жёлтый «истекает
 * 20.08.2026», серый «истекла 05.05.2026».
 *
 * Компонент один на все экраны — справочник, карточку единицы, форму и карточку заявки, реестр
 * гарантий. Не ради экономии строк: у «истекает скоро» есть порог, и стоит подсветке разъехаться
 * между списками, как одна и та же гарантия окажется жёлтой в справочнике и зелёной в заявке.
 * Считать состояние здесь нечем — это делает `warrantyState` в контрактах, тег только рисует.
 *
 * `none` (срок не заведён) — прочерк, а не тег «нет гарантии»: портал не знает, была ли она
 * вообще, и выдумывать за него отрицательный ответ нельзя.
 */
export function WarrantyTag({ until }: { until: string | null | undefined }) {
  // «Сегодня» спрашивается один раз на оба вызова: между ними может пройти полночь, и тег
  // показал бы состояние одного дня с подписью другого.
  const today = warrantyToday();
  const state = warrantyState(until, today);
  if (state === 'none') return <Typography.Text type="secondary">—</Typography.Text>;
  return <Tag color={warrantyStateColors[state]}>{warrantyLabel(until, today)}</Tag>;
}
