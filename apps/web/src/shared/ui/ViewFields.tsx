import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { Descriptions, type DescriptionsProps } from 'antd';
import { useIsMobile } from '@shared/lib';

type DescriptionsItem = NonNullable<DescriptionsProps['items']>[number];

/**
 * Поле карточки: подпись и значение. Ширину поле не выбирает — только говорит, годится ли ему
 * доля строки. Числа колонок поле не знает: одна и та же разметка идёт и на телефон, где колонка
 * одна, и на десктоп.
 */
export interface ViewField {
  key: string;
  label: ReactNode;
  /** `full` — значению доля строки мала: адрес, вложенный список, строка с тегами и кнопкой. */
  full?: boolean;
  children: ReactNode;
}

/**
 * Колонок на десктопе. Две, а не три: в окне 1000 px подписи забирают около 260 px, и на значение
 * в трёх колонках остаётся 190 px — в них не помещается ни период работы («05.08.2026 –
 * 07.08.2026»), ни ФИО с телефоном, и строка карточки становится трёхэтажной. В двух колонках на
 * значение приходится по 340 px: то же число полей укладывается в ту же высоту, но без переносов.
 */
const DESKTOP_COLUMNS = 2;

/**
 * Раскладывает поля по строкам так, чтобы ширины складывались ровно в строку.
 *
 * antd кладёт поля в строку подряд, а поле, которое в остаток строки не влезает, молча ужимает
 * до этого остатка (и ругается в консоль). Из-за этого «Согласование» с длинным тегом занимало
 * треть строки вместо всей, а следующие поля съезжали. Здесь такая строка закрывается заранее:
 * `span: 'filled'` у предыдущего поля растягивает его на остаток, а широкое поле встаёт с начала
 * следующей строки — целиком, как и объявлено.
 */
function packRows(fields: ViewField[], columns: number): DescriptionsItem[] {
  const items: DescriptionsItem[] = [];
  let rest = columns;

  for (const { full, ...field } of fields) {
    const span = full ? columns : 1;
    if (span > rest) {
      const previous = items[items.length - 1];
      if (previous) previous.span = 'filled';
      rest = columns;
    }
    items.push({ ...field, span });
    rest -= span;
    if (rest === 0) rest = columns;
  }

  return items;
}

/**
 * Карточка записи в окне просмотра: поля «подпись — значение» в рамке, на телефоне — в одну
 * колонку подписью над значением (ADR 0030).
 *
 * Ширины колонок задаёт сетка, а не содержимое. Таблица antd раскладывается по запросам
 * содержимого, и все строки в этом соревнуются: длинный тег в одной отбирал ширину у значений
 * всех остальных. Столбец значений сжимался до 84 px — дата ломалась посреди числа
 * («05.08.2 026 – 07.08.2 026»), фамилия автора шла по букве в строке, а справа при этом
 * оставалось пустое место. Сетка надевается поверх разметки antd (стили `.view-fields--grid`):
 * подписи занимают свою ширину, значения делят остаток поровну, и раскладка строки больше не
 * зависит от того, что попало в соседнюю.
 */
export function ViewFields({ items }: { items: ViewField[] }) {
  const isMobile = useIsMobile();
  const columns = isMobile ? 1 : DESKTOP_COLUMNS;
  const packed = useMemo(() => packRows(items, columns), [items, columns]);

  return (
    <Descriptions
      // Сетка — только для десктопной раскладки: на телефоне подпись стоит над значением,
      // колонок нет, и делить между ними нечего.
      className={isMobile ? 'view-fields' : 'view-fields view-fields--grid'}
      style={{ '--view-fields-columns': columns } as CSSProperties}
      size="small"
      bordered
      column={columns}
      layout={isMobile ? 'vertical' : 'horizontal'}
      items={packed}
    />
  );
}
