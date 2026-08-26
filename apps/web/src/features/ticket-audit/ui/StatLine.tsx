import type { ReactNode } from 'react';
import { Space, Tooltip, Typography } from 'antd';

/**
 * Строка показателя: подпись слева, значение справа.
 *
 * Своим файлом с тех пор, как таких строк стало три вида на трёх экранах — каскад (§5.2),
 * подсистема (§5.4) и точность (§5.5). Три копии одной вёрстки разошлись бы отступом или тем,
 * висит ли объяснение на подписи, — и один и тот же показатель на соседних экранах читался бы
 * по-разному.
 *
 * Объяснение висит на подписи, а не стоит сноской под блоком: на телефоне сноска уезжает под сгиб,
 * а спрашивают «что это за число» именно глядя в строку. Оно обязательно: число без определения
 * читается как знание (§1 плана).
 */
export function StatLine({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
      <Tooltip title={hint}>
        <Typography.Text type="secondary">{label}</Typography.Text>
      </Tooltip>
      {children}
    </Space>
  );
}
