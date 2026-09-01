import type { CSSProperties } from 'react';
import { Tag, Typography } from 'antd';
import type { MechRequestDto } from '@technic/contracts';
import { isDepartmentRequester, mechRequesterLabel } from '../model/labels';

/**
 * Наименование переносится на две строки, а не обрезается в одну: площадку узнают по концу
 * названия — «…корпус 3» и «…корпус 7» различаются последним словом. Что не поместилось — в
 * подсказке наведения.
 */
const nameBox: CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  overflowWrap: 'anywhere',
};

/** Адрес остаётся однострочным: он второй вопрос к списку, и высоту строки за него не отдают. */
const line: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/**
 * Адрес не участвует в подборе ширины колонки: при `width: 0` его вклад в max-content нулевой, а
 * при отрисовке `minWidth: '100%'` возвращает строке всю ширину ячейки.
 */
const addressBox: CSSProperties = { width: 0, minWidth: '100%' };

/**
 * Заявитель заявки: отдел, если он заполнен, иначе сама площадка (Р20).
 *
 * Тег «отдел» рядом с названием — не украшение: на одной площадке живут и заявка самой площадки, и
 * заявка отдела, и без пометки два соседних имени в столбце читались бы как одно и то же. Именно
 * этим различием и заведены два независимых фильтра — «Площадка» и «Заявитель» (Р20).
 */
export function MechRequesterCell({ row }: { row: MechRequestDto }) {
  const label = mechRequesterLabel(row);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div style={nameBox} title={label}>
        {label}
      </div>
      {isDepartmentRequester(row) && (
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>
          отдел
        </Tag>
      )}
    </div>
  );
}

/**
 * Площадка — **место эксплуатации**, и она есть у каждой заявки (Р17). Адрес второй строкой:
 * «куда ехать забирать» спрашивают у неё чаще всего, а своего столбца адрес не стоит.
 *
 * Отдельной ячейкой от заявителя, а не одной с ним: это два разных вопроса — «на кого расходы» и
 * «где стоит», — и у заявки отдела ответы на них разные.
 */
export function MechPlaceCell({ row }: { row: MechRequestDto }) {
  const address = row.objectAddress.trim();
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div style={nameBox} title={`${row.objectCode} — ${row.objectName}`}>
        {row.objectName}
      </div>
      {address && (
        <div style={addressBox}>
          <Typography.Text
            type="secondary"
            style={{ ...line, display: 'block', fontSize: 12 }}
            title={address}
          >
            {address}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}
