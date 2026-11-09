import type { CSSProperties } from 'react';
import { Tag, Typography } from 'antd';
import type { MechRequestDto } from '@technic/contracts';
import { isDepartmentRequester, mechRequesterLabel } from '../model/labels';

/**
 * The name wraps to two lines instead of being cut to one: a site is recognised by the end of its
 * name — «…корпус 3» and «…корпус 7» differ in the last word. What does not fit is in the hover
 * hint.
 */
const nameBox: CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  overflowWrap: 'anywhere',
};

/** The address stays on one line: it is the list's second question, not worth the row's height. */
const line: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/**
 * The address takes no part in sizing the column: with `width: 0` it adds nothing to max-content,
 * and `minWidth: '100%'` gives the line the whole cell back when it is drawn.
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
 * The site is **where the machine works**, and every request has one (R17). The address on the
 * second line: «where do we pick it up» is asked of it most often, and it is not worth a column.
 *
 * A cell of its own, not one with the requester: «who pays» and «where it stands» are two
 * questions, and a department's request answers them differently.
 *
 * The row is narrowed to the site's fields so that the lessor's list (lessor receipt plan, P12)
 * draws its site the same way: his DTO carries no site code, and the hint then names the site alone.
 */
export function MechPlaceCell({
  row,
}: {
  row: Pick<MechRequestDto, 'objectName' | 'objectAddress'> & { objectCode?: string | null };
}) {
  const address = row.objectAddress.trim();
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div
        style={nameBox}
        title={row.objectCode ? `${row.objectCode} — ${row.objectName}` : row.objectName}
      >
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
