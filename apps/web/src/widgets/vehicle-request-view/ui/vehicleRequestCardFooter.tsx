import { Button } from 'antd';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { VehicleRequestDto } from '@technic/contracts';

/** Build footer actions without adding a wrapper that would break equal-width mobile buttons. */
export function vehicleRequestCardFooter({
  request,
  onClose,
  onEdit,
  onCopy,
  requestListHref,
  isMobile,
}: {
  request: VehicleRequestDto | null;
  onClose: () => void;
  onEdit?: (request: VehicleRequestDto) => void;
  onCopy?: (request: VehicleRequestDto) => void;
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
    ...(request && onCopy
      ? [
          <Button key="copy" onClick={() => onCopy(request)}>
            Завести такую же
          </Button>,
        ]
      : []),
    ...(requestListHref
      ? [
          <Link key="list" to={requestListHref}>
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
