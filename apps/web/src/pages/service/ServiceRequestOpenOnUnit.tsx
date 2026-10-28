import { Fragment } from 'react';
import { Alert } from 'antd';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { isServiceRequestClosed, type ServiceRequestKind } from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { useAuth } from '@entities/session';

/**
 * Requests of the same kind already open on the chosen unit (ADR 0236): a hint, never a refusal.
 * A unit may carry several open requests, so the form only tells the requester about them; whether
 * the new one is the same fault is theirs to decide, and the dispatcher's later.
 *
 * The list is the ordinary registry list, so the reader's scope narrows it exactly as in the
 * registry: no hint means "none visible to you", and the text never claims "there are none".
 *
 * Same kind only: a cartridge request beside an open repair was always normal (ADR 0133), and
 * mentioning the repair there would be noise.
 *
 * Rows are checked as not closed on this side too. A server older than `openOnly` drops the unknown
 * parameter and answers with the unit's whole history; without the check the hint would name
 * accepted requests during the deploy window.
 */
export function ServiceRequestOpenOnUnit({
  open,
  equipmentId,
  kind,
}: {
  open: boolean;
  /** Only a new request asks: an edited one cannot change its unit. */
  equipmentId: string | undefined;
  kind: ServiceRequestKind;
}) {
  const { can } = useAuth();
  const query = {
    equipmentId,
    openOnly: 'true',
    sortBy: 'createdAt',
    sortOrder: 'asc',
  };
  const { data } = useQuery({
    queryKey: serviceRequestKeys.list(query),
    queryFn: () => serviceRequestsApi.list(query),
    enabled: open && !!equipmentId && can('serviceRequests.read'),
  });
  const rows = (data?.items ?? []).filter(
    (row) => row.kind === kind && !isServiceRequestClosed(row.status),
  );
  if (!equipmentId || rows.length === 0) return null;

  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 12 }}
      title={
        <>
          {rows.length === 1
            ? 'По этому аппарату уже открыта заявка '
            : 'По этому аппарату уже открыты заявки '}
          {rows.map((row, i) => (
            <Fragment key={row.id}>
              {i > 0 && ', '}
              {/* A new tab keeps the half-written form: the card is a look, not a switch. */}
              <Link
                to={`/office-equipment?tab=requests&open=${row.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {row.displayNumber}
              </Link>
            </Fragment>
          ))}
        </>
      }
      description="Если вы о том же, напишите в обсуждении открытой заявки. Если о другом — отправляйте эту."
    />
  );
}
