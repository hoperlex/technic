import { Button, Tag, Tooltip } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import type { WasteTicketBadgeDto } from '@technic/contracts';
import { ticketBadgeLines, ticketBadgeTotal } from './ticketBadgeLegend';

/**
 * Значок разбора талонов в строке списка заявок (ADR 0114, Р24; ADR 0195).
 *
 * До ADR 0195 колонка показывала до пяти чисел со значками разом. Числа были верны, но отвечали
 * не на тот вопрос: из строки списка с ними ничего нельзя сделать, а разбирать всё равно идут в
 * карточку — причём кликом мимо значка, потому что теги клик отдавали строке. Теперь у заявки с
 * поводом для разбора стоит **крестик**, и он ведёт ровно туда, ради чего колонку читают;
 * разбивка переехала в подсказку, где на неё есть место и где каждому значку хватает расшифровки.
 *
 * ЦВЕТОМ РАЗЛИЧАЕТСЯ РОВНО ОДНО (Р2): красный крестик — есть ⛔, то есть цифры не сошлись и разбор
 * нужен сейчас; обычный — всё остальное, что смотрят, когда дойдут руки. Пятицветной палитре в
 * узкой колонке делать нечего: она называет состояния, но не меняет порядок работы.
 *
 * Надписи на кнопке нет — как и у соседней кнопки подтверждения (требование заказчика: колонка
 * узкая). Числа человек читает в подсказке, читалка экрана — в `aria-label`.
 */
export function TicketBadge({
  badge,
  onReview,
}: {
  badge: WasteTicketBadgeDto | null;
  /** Ход на разбор: карточка заявки, прокрученная к талонам. */
  onReview: () => void;
}) {
  if (!badge) return null;
  const lines = ticketBadgeLines(badge);
  // Разобранная заявка кнопки не получает: разбирать нечего, и крестик звал бы в пустую панель.
  // «Все нули» — не то же самое, что заявка без бумаги: у первой всё разобрано, у второй значка
  // нет вовсе.
  if (lines.length === 0) {
    return (
      <Tooltip title="Талоны разобраны, расхождений нет">
        <Tag color="success" style={{ marginInlineEnd: 0 }}>
          ✓
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Tooltip
      title={
        <div>
          {lines.map(({ state, count }) => (
            <div key={state.key}>{`${state.icon} ${count} — ${state.label}`}</div>
          ))}
          <div style={{ marginTop: 4 }}>Открыть разбор</div>
        </div>
      }
    >
      <Button
        size="small"
        icon={<CloseOutlined />}
        // Красный — только у несошедшихся цифр: «иди сейчас» против «посмотри, когда дойдут руки».
        danger={badge.errors > 0}
        aria-label={`Открыть разбор талонов: поводов ${ticketBadgeTotal(badge)}`}
        onClick={onReview}
      />
    </Tooltip>
  );
}
