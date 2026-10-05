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
  const [record, setRecord] = useState<WasteRequestDto | null>(null);
  const [focus, setFocus] = useState<'tickets' | null>(null);
  const opened = useOpenedRecord<WasteRequestDto>({
    active,
    queryKey: (id) => wasteRequestKeys.detail(id),
    fetch: (id) => wasteRequestsApi.get(id),
  });
  const viewed = record ?? opened.record;
  const comment = useWasteRequestComment(setRecord);
  const tickets = useWasteTicketAttach(setRecord);
  const canComment = can('wasteRequests.operatorComment');
  const canChangeStatus = can('wasteRequests.status');

  const close = () => {
    setRecord(null);
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
