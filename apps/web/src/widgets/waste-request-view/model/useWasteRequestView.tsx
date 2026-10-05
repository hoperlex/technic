import { useState, type ReactNode } from 'react';
import {
  wasteOperatorCommentEditable,
  wasteTicketsAttachable,
  type WasteRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { wasteRequestKeys, wasteRequestsApi } from '@entities/waste-request';
import { useWasteRequestComment } from '@features/waste-request-comment';
import { useWasteTicketAttach } from '@features/waste-ticket-attach';
import { useOpenedRecord } from '@shared/lib';
import { WasteRequestView } from '../ui/WasteRequestView';

interface Input {
  active: boolean;
  canModify: (request: WasteRequestDto) => boolean;
  onEdit: (request: WasteRequestDto) => void;
}

export interface WasteRequestViewController {
  actions: {
    open: (request: WasteRequestDto) => void;
    openTicketReview: (request: WasteRequestDto) => void;
  };
  node: ReactNode;
}

/** Own list-card state, deep links and mutations whose result must refresh the open record. */
export function useWasteRequestView({
  active,
  canModify,
  onEdit,
}: Input): WasteRequestViewController {
  const { can } = useAuth();
  // The card is a separate read-only window: the table has no room for the author, price per m3
  // or vehicles, and a specific request cannot be examined without them (ADR 0012).
  const [record, setRecord] = useState<WasteRequestDto | null>(null);
  // How the card was opened: tickets means the ticket column cross (ADR 0195), scroll to review.
  const [focus, setFocus] = useState<'tickets' | null>(null);
  // The request named in the URL, e.g. a link from the on-site list. It is fetched by id: the same
  // request may sit on another page or under another filter, and searching the loaded list would
  // open the card only some of the time.
  const opened = useOpenedRecord<WasteRequestDto>({
    active,
    queryKey: (id) => wasteRequestKeys.detail(id),
    fetch: (id) => wasteRequestsApi.get(id),
  });
  const viewed = record ?? opened.record;
  const comment = useWasteRequestComment(setRecord);
  const tickets = useWasteTicketAttach(setRecord);
  // Executor note (ADR 0053): written by its operator and by those who run the request.
  const canComment = can('wasteRequests.operatorComment');
  // Status management also unlocks adding tickets to a completed request (ADR 0189): whoever
  // closes the request brings the paper, and there is no separate permission for it.
  const canChangeStatus = can('wasteRequests.status');

  const close = () => {
    setRecord(null);
    // Otherwise the next ordinary row click, for another purpose, would scroll to tickets again.
    setFocus(null);
    opened.clear();
  };
  const edit = (request: WasteRequestDto) => {
    close();
    onEdit(request);
  };

  return {
    actions: {
      open: setRecord,
      openTicketReview: (request) => {
        setRecord(request);
        setFocus('tickets');
      },
    },
    // Editing from the card uses the same editor as the list, and only when this role may modify
    // the request; the executor note is edited in the card itself, since an operator has no editor.
    node: (
      <WasteRequestView
        request={viewed}
        focus={focus}
        onClose={close}
        onEdit={viewed && canModify(viewed) ? edit : undefined}
        onSaveOperatorComment={
          canComment && viewed && !viewed.deletedAt && wasteOperatorCommentEditable(viewed.status)
            ? comment.save
            : undefined
        }
        savingOperatorComment={comment.pending}
        // Late tickets (ADR 0189): the permission is the completion one, and the acceptance window
        // is the contract predicate the server answers with (wasteTicketsAttachable).
        onAddTickets={
          canChangeStatus && viewed && !viewed.deletedAt && wasteTicketsAttachable(viewed.status)
            ? tickets.attach
            : undefined
        }
        addingTickets={tickets.pending}
      />
    ),
  };
}
