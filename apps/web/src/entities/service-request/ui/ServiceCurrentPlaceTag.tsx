import { Tag, Tooltip } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ServiceRequestDto } from '@technic/contracts';
import { serviceRequestCurrentPlaceLine } from '../model/subject';

/**
 * "Stands now" after a move (ADR 0215) — the place executors travel to, shown next to the request's
 * own snapshot instead of replacing it.
 *
 * The snapshot stays because it is the request's scope and its testimony (what was declared, where
 * it was filed); the tag exists because executors read the header, not the history tab, and kept
 * going to the declared site after IT had recorded the real one.
 *
 * The tooltip names the move day and the source: the place comes from the directory as of today,
 * so a reader who sees the request and the tag disagree knows which one is current and why.
 */
export function ServiceCurrentPlaceTag({
  request,
}: {
  request: Pick<ServiceRequestDto, 'currentPlace'>;
}) {
  const line = serviceRequestCurrentPlaceLine(request);
  const place = request.currentPlace ?? null;
  if (!line || !place) return null;
  return (
    <Tooltip
      title={`Аппарат перемещён ${dayjs(place.movedOn).format('DD.MM.YYYY')}, уже после заведения заявки. Место — по справочнику на сегодня; в самой заявке осталось то, что указали при заведении.`}
    >
      <Tag
        color="blue"
        icon={<SwapOutlined />}
        // Long site names must wrap inside the tag instead of pushing the column wider.
        style={{ marginInlineEnd: 0, whiteSpace: 'normal' }}
      >
        Сейчас: {line}
      </Tag>
    </Tooltip>
  );
}
