import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DownOutlined, UpOutlined } from '@ant-design/icons';

/**
 * Ячейка таблицы, которая не растит строку. Свёрнутой она занимает столько же строк, сколько
 * соседние колонки (номер и автор, техника и ставка), а всё, что не поместилось, открывается
 * нажатием — по строке.
 *
 * Так показывают длинное содержимое, которое читают не всегда: комментарий к заявке и контакты на
 * концах маршрута. Обрезать их многоточием нельзя — там, где начинается отличие одной заявки от
 * другой, текст как раз и кончается; но и пустить их в высоту значит раздуть каждую строку списка
 * под самую многословную заявку.
 *
 * Переключатель стоит поверх правого края и высоты не добавляет: подпись «ещё» отдельной строкой
 * сама сделала бы строки таблицы толще ровно на неё — то есть ровно то, от чего ячейка и заведена.
 */
export function ExpandableCell({
  lines = 2,
  children,
}: {
  /** Сколько строк видно свёрнутой; по умолчанию две — обычная высота строки этих списков. */
  lines?: number;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    // Развёрнутая ячейка себя не мерит: в ней видно всё, и замер сказал бы, что прятать нечего, —
    // переключатель исчез бы вместе с возможностью вернуть строке прежнюю высоту. Пока ячейка
    // развёрнута, `clipped` держит последний замер свёрнутого состояния.
    if (!el || expanded) return;
    const measure = () => setClipped(el.scrollHeight - el.clientHeight > 1);
    measure();
    // Ширина колонки меняется вместе с окном: то, что помещалось в две строки, перестаёт.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, expanded, lines]);

  return (
    <div className="expandable-cell">
      <div
        ref={bodyRef}
        className={`expandable-cell__body${expanded ? '' : ' expandable-cell__body--clamped'}`}
        style={expanded ? undefined : { WebkitLineClamp: lines }}
      >
        {children}
      </div>
      {clipped && (
        <button
          type="button"
          className="expandable-cell__toggle"
          aria-label={expanded ? 'Свернуть' : 'Показать полностью'}
          title={expanded ? 'Свернуть' : 'Показать полностью'}
          // Нажатие остаётся в ячейке: строка списка по клику открывает карточку записи, а
          // разворачивают текст, чтобы его прочитать здесь, — не вместо этого.
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </button>
      )}
    </div>
  );
}
