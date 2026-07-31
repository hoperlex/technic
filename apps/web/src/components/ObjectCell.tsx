import type { CSSProperties } from 'react';
import { Typography } from 'antd';

/** Строка обрезается по ширине колонки — каждая своим многоточием. */
const line: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/**
 * Заказчик заявки в строке таблицы: наименование объекта (или отдела), а под ним — адрес. Адрес
 * отвечает на «куда ехать» — второй вопрос к списку после самой заявки, — но своей колонки не
 * стоит: у заявок отдела адреса нет (ADR 0040), и колонка стояла бы пустой через строку.
 *
 * Обрезаются строки по отдельности, а не `ellipsis` самой колонки: тот рассчитан на однострочную
 * ячейку и второй строке места не оставляет. Полный текст — в подсказке наведения.
 */
export function ObjectCell({ name, address }: { name: string; address?: string | null }) {
  // Адрес в справочнике необязателен: пустой не занимает вторую строку — иначе высота строк
  // таблицы плясала бы от того, заполнили ли объекту адрес.
  const trimmed = address?.trim();
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div style={line} title={name}>
        {name}
      </div>
      {trimmed && (
        <Typography.Text
          type="secondary"
          style={{ ...line, display: 'block', fontSize: 12 }}
          title={trimmed}
        >
          {trimmed}
        </Typography.Text>
      )}
    </div>
  );
}
