import { Typography } from 'antd';
import type { MechRequestDto } from '@technic/contracts';
import { mechModelLabel, mechRequesterLabel, mechTermLabel } from '../model/labels';

/**
 * Шапка окна действия: какую заявку сейчас двигают.
 *
 * Одна на все окна модуля, а не по строке в каждом. Окна открываются из меню строки и из карточки,
 * и по одному заголовку «Взять в работу» человек не отличит соседние заявки на одну и ту же
 * виброплиту: их различают номер, модель, площадка и срок — ровно эти четыре и стоят здесь.
 *
 * Заявитель назван рядом с площадкой, а не вместо неё: у заявки отдела это разные вещи (Р17), и
 * договорённость с арендодателем заключают под площадку, а деньги относят на заявителя.
 */
export function MechRequestContext({ request }: { request: MechRequestDto }) {
  return (
    <div style={{ lineHeight: 1.4, marginBottom: 12 }}>
      <Typography.Text strong>
        {request.displayNumber} · {mechModelLabel(request)}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
        {request.objectName} · заявитель: {mechRequesterLabel(request)}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
        План: {mechTermLabel(request)}
      </Typography.Text>
    </div>
  );
}
