import type { ReactNode } from 'react';
import { Space, Tooltip, Typography } from 'antd';

/**
 * Подпись показателя и строка раскрытия карточки — одни на весь слайс «Аудит талонов».
 *
 * Все четыре вида строк (сводка, точность, когорты, лента) показывают одно и то же устройство:
 * таблица на десктопе, карточки на телефоне, и в раскрытии карточки — подпись слева, значение
 * справа. Разъедься эта пара по четырём файлам (как было), правка отступа или тултипа доезжала бы
 * до одного вида из четырёх.
 */

/**
 * Заголовок столбца с определением показателя: число без определения читается как знание.
 *
 * Без подсказки подпись печатается приглушённой: в ленте событий «Модель» и «Автор» — не показатели,
 * а названия полей записи, и определять там нечего. Пунктир тултипа над ними обещал бы объяснение,
 * которого нет.
 */
export function ColumnTitle({ title, hint }: { title: string; hint?: string }) {
  if (hint === undefined) return <Typography.Text type="secondary">{title}</Typography.Text>;
  return (
    <Tooltip title={hint}>
      <span>{title}</span>
    </Tooltip>
  );
}

/** Строка раскрытия: подпись показателя слева, значение справа — как ячейка таблицы, в столбик. */
export function CardLine({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
      <ColumnTitle title={title} hint={hint} />
      {children}
    </Space>
  );
}
