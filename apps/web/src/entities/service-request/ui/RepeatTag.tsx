import { Tag, Tooltip } from 'antd';
import { RetweetOutlined } from '@ant-design/icons';
import type { ServiceRequestRepeatDto } from '@technic/contracts';
import { serviceRepeatHint } from '../model/repeat';

/**
 * Повторное обращение по аппарату — «Повтор ×3» у номера заявки (план
 * `docs/office-equipment-repeat-request-plan.md`, Р10).
 *
 * СОСТОЯНИЙ ТРИ, А НЕ ДВА, И РАЗЛИЧАЕТ ИХ САМО ОТСУТСТВИЕ ПОЛЯ. Признака нет вовсе (`undefined`) —
 * окно выключено настройкой, заявка на расходники либо заявка без аппарата: считать было нечего.
 * `count: 0` — считали и не нашли. Тега нет ни там, ни там, но состояния это разные: во втором
 * признак работает, и отбор «Только повторные» человеку показывать можно (§6 плана). Судить о том,
 * включён ли признак, по нулю нельзя — тем и важно, что поле необязательное.
 *
 * ТЕГ И ПОДСКАЗКА НЕРАЗДЕЛИМЫ, как у срочности рядом: «Повтор ×3» без периода — утверждение, к
 * которому нечего предъявить, а человек по нему решает, звать ли подрядчика на разговор. Подсказка
 * остаётся и на телефоне: второго места, где назвать окно, у бейджа карточки нет.
 *
 * НИЧЕГО НЕ ЗАПУСКАЕТ (Р9): ни срочности, ни письма, ни эскалации — только показ. Решение принимает
 * человек, посмотрев по ссылке из карточки те самые предыдущие заявки.
 */
export function RepeatTag({ repeat }: { repeat: ServiceRequestRepeatDto | undefined }) {
  if (!repeat || repeat.count <= 0) return null;
  return (
    <Tooltip title={serviceRepeatHint(repeat)}>
      <Tag color="orange" icon={<RetweetOutlined />} style={{ marginInlineEnd: 0 }}>
        Повтор ×{repeat.count}
      </Tag>
    </Tooltip>
  );
}
