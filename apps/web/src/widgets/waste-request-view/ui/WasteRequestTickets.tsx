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

/**
 * Tickets are a separate block from request documents: they are not accompanying paper but proof of
 * removal (ADR 0013). Since ADR 0024 the list is shared by every request type and not split by
 * vehicle.
 */
export function WasteRequestTickets({ adding, canReview, containerRef, onAdd, request }: Props) {
  // The block stays open even without a single scan in three cases. A completed request: the
  // volume check computes "0 m3 in tickets vs 40 at completion" without files, and a hidden block
  // would mean a computed remark that nobody sees. A request still waiting for paper (ADR 0189):
  // the upload button needs a place. Any request whose badge promises review (ADR 0195): numbers
  // are also computed from a ticket entered by hand, which has no file at all.
  const visible =
    request.tickets.length > 0 ||
    !!onAdd ||
    (canReview && (request.status === 'done' || !!request.ticketBadge));
  if (!visible) return null;

  return (
    <div ref={containerRef}>
      <Typography.Text strong>Талоны</Typography.Text>
      {/* Review is shown only with the ticketReview permission (ADR 0114, R25): recognized values
          are a check result just like remarks, and the checked party has no need to see them.
          Without the permission the card keeps the plain file list and viewer. */}
      {canReview ? (
        <div style={{ marginTop: 12 }}>
          <TicketRecognitionBanner enabled />
          {/* No separate file list here: the panel shows the same scans beside the ticket numbers
              found in them. Two lists of the same files, only one of which knows about review,
              invite reading the wrong one. */}
          <WasteTicketsPanel requestId={request.id} />
        </div>
      ) : (
        <FileLinkList files={request.tickets} maxNameWidth={420} emptyText="Талонов нет" />
      )}
      {onAdd && <AddTicketsBlock request={request} onAdd={onAdd} adding={adding} />}
    </div>
  );
}
