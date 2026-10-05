import type { RefObject } from 'react';
import { Typography } from 'antd';
import type { WasteRequestDto } from '@technic/contracts';
import { FileLinkList } from '@entities/file';
import { AddTicketsBlock } from '@features/waste-ticket-attach';
import { TicketRecognitionBanner, WasteTicketsPanel } from '@features/waste-ticket-review';

interface Props {
  adding?: boolean;
  canReview: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  onAdd?: (request: WasteRequestDto, ticketFileIds: string[]) => void;
  request: WasteRequestDto;
}

/** Keep ticket evidence separate from ordinary request attachments and permission-gate review. */
export function WasteRequestTickets({ adding, canReview, containerRef, onAdd, request }: Props) {
  const visible =
    request.tickets.length > 0 ||
    !!onAdd ||
    (canReview && (request.status === 'done' || !!request.ticketBadge));
  if (!visible) return null;

  return (
    <div ref={containerRef}>
      <Typography.Text strong>Талоны</Typography.Text>
      {canReview ? (
        <div style={{ marginTop: 12 }}>
          <TicketRecognitionBanner enabled />
          <WasteTicketsPanel requestId={request.id} />
        </div>
      ) : (
        <FileLinkList files={request.tickets} maxNameWidth={420} emptyText="Талонов нет" />
      )}
      {onAdd && <AddTicketsBlock request={request} onAdd={onAdd} adding={adding} />}
    </div>
  );
}
