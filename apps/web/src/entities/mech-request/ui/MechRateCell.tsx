import { Typography } from 'antd';
import { mechRateUnitRateLabels, type MechRateUnit } from '@technic/contracts';
import { mechMoney } from '../model/labels';

/**
 * Ставка аренды в строке списка: сумма и единица, за которую она назначена.
 *
 * Единица под суммой, а не в одной строке с ней: «1 200,00 ₽ за час» и «1 200,00 ₽ за смену»
 * различаются последним словом, и в узком столбце оно уезжает в многоточие — то есть пропадает
 * ровно то, без чего цена ничего не значит.
 *
 * Пустая ставка — не ноль и не пропуск данных: договорённости ещё нет (заявка «Новая» либо
 * отменённая), и прочерк здесь читается верно. Выдуманный ноль означал бы «бесплатно».
 */
export function MechRateCell({
  rate,
  rateUnit,
}: {
  rate: number | null;
  rateUnit: MechRateUnit | null;
}) {
  if (rate == null || !rateUnit) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{mechMoney(rate)}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {mechRateUnitRateLabels[rateUnit]}
      </Typography.Text>
    </div>
  );
}
