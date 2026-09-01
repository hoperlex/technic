import { Typography } from 'antd';
import type { MechRentalState } from '@technic/contracts';
import { mechDayLabel, mechDaysLeftLabel } from '../model/labels';

/** Что ячейке нужно от заявки: плановый возврат и три поля состояния (Р2). */
export type MechTermRow = MechRentalState & { plannedTo: string };

/**
 * Плановый возврат и остаток срока — правая половина столбца «Срок».
 *
 * Столбцов у срока два, а не один (`MECH_REQUEST_SORT_FIELDS`): «с» и «по» отвечают на разные
 * вопросы — «когда начали» и «когда возвращать», — и сортировка по ним нужна разная. Дата подачи
 * рисуется соседней колонкой обычным днём, а вся смысловая нагрузка живёт здесь: список читают
 * вопросом «что пора возвращать».
 *
 * Остаток показывается **только у действующей аренды** и считается предикатом контрактов: у
 * заявки, которую ещё не подали, срок не начался, а у возвращённой он кончился — «осталось 3 дня»
 * в обоих случаях было бы неправдой. Просрочка красная: это единственная строка списка, ради
 * которой берут телефон и звонят арендодателю.
 *
 * «Сегодня» приходит сверху одним значением на весь список (Р12): спроси его каждая ячейка сама —
 * и список, открытый в 00:00, посчитал бы часть строк по вчерашнему дню.
 */
export function MechTermCell({ row, today }: { row: MechTermRow; today: string }) {
  const left = mechDaysLeftLabel(row, today);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{mechDayLabel(row.plannedTo)}</div>
      {left && (
        <Typography.Text
          type={left.overdue ? 'danger' : 'secondary'}
          style={{ fontSize: 12, display: 'block' }}
        >
          {left.text}
        </Typography.Text>
      )}
    </div>
  );
}
