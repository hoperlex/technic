import { Button } from 'antd';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { VehicleRequestDto } from '@technic/contracts';

/**
 * Footer actions of the request card: edit, copy, open in the list, close. Kept in one place so
 * "what can the user do after reading the card" has one answer.
 *
 * Returns an array because ViewModal accepts footer nodes and lays them out itself; a wrapper
 * component would add a DOM node and break the equal-width mobile footer.
 */
export function vehicleRequestCardFooter({
  request,
  onClose,
  onEdit,
  onCopy,
  requestListHref,
  isMobile,
}: {
  /** null means the window is closed; only "Close" remains. */
  request: VehicleRequestDto | null;
  onClose: () => void;
  onEdit?: (request: VehicleRequestDto) => void;
  onCopy?: (request: VehicleRequestDto) => void;
  /**
   * Section tab with this request's card open; null means no door (the overlay was opened without
   * archive.read, and the link would end in a refusal).
   */
  requestListHref: string | null;
  isMobile: boolean;
}): ReactNode[] {
  return [
    ...(request && onEdit
      ? [
          <Button key="edit" type="primary" onClick={() => onEdit(request)}>
            Редактировать
          </Button>,
        ]
      : []),
    /*
     * Order copy (ADR 0173): a regular button, not primary; the card has one primary action and
     * repeating the order is not it. It sits next to edit because both lead to the same form: "fix
     * this one" versus "create one like it".
     *
     * The label is the second question, not "Create copy" (ADR 0206): copies are now taken from a
     * request of any status, and for a completed one "copy" would promise inheriting its state
     * (vehicle, route, fact) that the new request will not have. A new order is created from a
     * template.
     */
    ...(request && onCopy
      ? [
          <Button key="copy" onClick={() => onCopy(request)}>
            Завести такую же
          </Button>,
        ]
      : []),
    /*
     * The overlay offers no actions; instead it has a door to where they are: the request list with
     * this request's card open (ADR 0120 item 7). The href is computed from the loaded DTO because
     * the status is not enough: a deleted request lives in the archive, chosen by deletedAt, and
     * the archive is closed by archive.read. Without it vehicleRequestLink returns null and there
     * is no button: a link ending in a refusal is worse than none.
     *
     * A real link, not navigate on click: the request list is opened in a neighbouring browser tab
     * while the route stays on screen, the same technique as EntityLink. Following it drops request
     * and route from the URL, and the windows close by themselves because their state lives only in
     * the URL.
     */
    ...(requestListHref
      ? [
          <Link key="list" to={requestListHref}>
            {/* On a phone footer buttons share the width equally (.sheet-footer), and the link is
                what shares it, not the button inside: without block the button would stay as wide
                as its text while the neighbouring "Close" takes its whole share. */}
            <Button type="primary" block={isMobile}>
              Открыть в списке заявок
            </Button>
          </Link>,
        ]
      : []),
    <Button key="close" onClick={onClose}>
      Закрыть
    </Button>,
  ];
}
