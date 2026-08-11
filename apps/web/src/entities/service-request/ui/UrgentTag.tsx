import { Tag, Tooltip } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';

/**
 * Пометка срочной заявки (план модернизации, Р56).
 *
 * Тег и подсказка неразделимы: срочность в портале не бывает без причины (её требуют и схема, и
 * CHECK в базе), и показывать красную метку, не давая прочитать объяснение, значило бы вернуть
 * ровно тот «чекбокс без смысла», ради которого пара и заведена. На телефоне подсказки нет —
 * там причина выносится отдельной строкой карточки.
 */
export function UrgentTag({ reason }: { reason: string }) {
  const tag = (
    <Tag color="red" icon={<ThunderboltOutlined />} style={{ marginInlineEnd: 0 }}>
      Срочная
    </Tag>
  );
  return reason ? <Tooltip title={reason}>{tag}</Tooltip> : tag;
}
