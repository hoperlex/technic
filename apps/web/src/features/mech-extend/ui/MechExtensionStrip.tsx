import { Alert, Button, Space, Typography } from 'antd';
import {
  isMechRentalRunning,
  type MechExtensionAccess,
  type MechRequestDto,
} from '@technic/contracts';
import { mechDayLabel } from '@entities/mech-request';
import { formatDateTime } from '@shared/lib';

/**
 * The extension strip of the rental card (ADR 0171, stage 3): «Продление до … ждёт визы, причина
 * …» with the buttons of whoever may act on it — the visa holder approves or refuses, the dispatch
 * office withdraws. Which buttons exist is decided by `mechExtensionAccess` of the contracts, the
 * same blockers the server answers with; this markup only draws them.
 *
 * Shown for a pending request and for a refusal while the rental still runs: the refusal comes back
 * to the dispatcher with its reason, and he decides what to tell the lessor. An approval needs no
 * strip — the moved term is in the card and the history says who signed it.
 */
export function MechExtensionStrip({
  request,
  access,
  onApprove,
  onReject,
  onWithdraw,
}: {
  request: MechRequestDto;
  access: MechExtensionAccess;
  onApprove: (request: MechRequestDto) => void;
  onReject: (request: MechRequestDto) => void;
  onWithdraw: (request: MechRequestDto) => void;
}) {
  const extension = request.extension;
  if (!extension) return null;

  if (extension.status === 'rejected') {
    if (!isMechRentalRunning(request)) return null;
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        title={`Продление до ${mechDayLabel(extension.newPlannedTo)} отклонено`}
        description={
          <>
            <div>Причина отказа: {extension.decisionComment}</div>
            <Typography.Text type="secondary">
              {extension.decidedByName ?? '—'}
              {extension.decidedAt ? ` · ${formatDateTime(extension.decidedAt)}` : ''}
            </Typography.Text>
          </>
        }
      />
    );
  }
  if (extension.status !== 'pending') return null;

  const buttons = [
    access.approve && (
      <Button key="approve" type="primary" size="small" onClick={() => onApprove(request)}>
        Согласовать
      </Button>
    ),
    access.reject && (
      <Button key="reject" danger size="small" onClick={() => onReject(request)}>
        Отклонить
      </Button>
    ),
    access.withdraw && (
      <Button key="withdraw" size="small" onClick={() => onWithdraw(request)}>
        Отозвать запрос
      </Button>
    ),
  ].filter(Boolean);

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title={`Продление до ${mechDayLabel(extension.newPlannedTo)} ждёт визы площадки`}
      description={
        <>
          <div>
            Сейчас возврат {mechDayLabel(request.plannedTo)}. Причина: {extension.reason}
          </div>
          <Typography.Text type="secondary">
            Запросил {extension.requestedByName} · {formatDateTime(extension.requestedAt)}
          </Typography.Text>
          {/* Why the visa holder cannot sign although he may decide: the term changed under the
              request. He still may refuse; the dispatcher files a new request. */}
          {access.approveBlocker && (
            <Typography.Text type="danger" style={{ display: 'block' }}>
              {access.approveBlocker}
            </Typography.Text>
          )}
          {buttons.length > 0 && (
            <Space size={8} wrap style={{ marginTop: 8 }}>
              {buttons}
            </Space>
          )}
        </>
      }
    />
  );
}
