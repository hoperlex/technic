import { Alert, Button, Space, Typography } from 'antd';
import type { MechLessorReceiptAccess, MechRequestDto } from '@technic/contracts';
import { formatDateTime } from '@shared/lib';
import { officeReceiptLine } from '../model/lines';
import {
  MechLessorReceiptVersionLine,
  MechLessorReceiptVersions,
} from './MechLessorReceiptVersions';

/** The windows a receipt button opens; who owns them is the caller's business (ADR 0140). */
export interface MechLessorReceiptHandlers {
  attach: (request: MechRequestDto) => void;
  /** The visa window over the pending version. */
  review: (request: MechRequestDto) => void;
  /** The «без чека» reason dialog, without a preview: there is nothing to look at. */
  waive: (request: MechRequestDto) => void;
  revokeApproval: (request: MechRequestDto) => void;
  revokeWaiver: (request: MechRequestDto) => void;
}

/**
 * The buttons of the block in the order of the question they answer. Which exist is
 * `mechLessorReceiptAccess` of the contracts — the same blockers the server answers with (ADR 0223):
 * this markup only draws them.
 *
 * «Без чека» is a button of its own only when there is no file to look at (none, or the last one
 * rejected, P6); over a pending file it lives inside the visa window, where the holder sees what he
 * waives.
 */
function receiptButtons(
  request: MechRequestDto,
  access: MechLessorReceiptAccess,
  on: MechLessorReceiptHandlers,
) {
  return [
    access.review && (
      <Button key="review" type="primary" size="small" onClick={() => on.review(request)}>
        Проверить чек
      </Button>
    ),
    access.attach && (
      <Button key="attach" size="small" onClick={() => on.attach(request)}>
        {access.replace ? 'Заменить чек' : 'Прикрепить чек'}
      </Button>
    ),
    access.waive && !access.review && (
      <Button key="waive" size="small" onClick={() => on.waive(request)}>
        Без чека
      </Button>
    ),
    access.revokeApproval && (
      <Button key="revoke-approval" size="small" onClick={() => on.revokeApproval(request)}>
        Отозвать утверждение
      </Button>
    ),
    access.revokeWaiver && (
      <Button key="revoke-waiver" size="small" onClick={() => on.revokeWaiver(request)}>
        Отменить «без чека»
      </Button>
    ),
  ].filter(Boolean);
}

/**
 * «Чек арендодателя» in the rental card (lessor receipt plan, P15): the current version — its file
 * opens in the same preview as in the visa window, its status, who and when, the decision and its
 * words — then «Версии чека (n)» collapsed, and the buttons of whoever may act.
 *
 * Without `access` the block is read-only: the archive and the journal show the evidence, and the
 * requester sees it too and acts on nothing (his access is all `false`). A rental that neither needs
 * a receipt nor ever had one shows no block at all — a heading over nothing would read as a missing
 * receipt.
 */
export function MechLessorReceiptBlock({
  request,
  access,
  on,
}: {
  request: MechRequestDto;
  access?: MechLessorReceiptAccess;
  on?: MechLessorReceiptHandlers;
}) {
  const current = request.lessorReceipt;
  const buttons = access && on ? receiptButtons(request, access, on) : [];
  const retiredCount = request.lessorReceiptVersionCount - (current ? 1 : 0);
  if (
    !request.lessorReceiptRequired &&
    request.lessorReceiptVersionCount === 0 &&
    !buttons.length
  ) {
    return null;
  }

  return (
    <section aria-label="Чек арендодателя" style={{ marginTop: 16 }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Чек арендодателя
      </Typography.Title>
      {current ? (
        <MechLessorReceiptVersionLine line={officeReceiptLine(current)} />
      ) : (
        <Typography.Text type="secondary">
          {request.lessorReceiptRequired
            ? 'Чек не прикреплён: аренду завершают после утверждённого чека или визы «без чека»'
            : 'Чек не прикреплён. Аренда взята в работу до появления чека — завершают её и без него'}
        </Typography.Text>
      )}
      {buttons.length > 0 && (
        <Space size={8} wrap style={{ display: 'flex', marginTop: 8 }}>
          {buttons}
        </Space>
      )}
      <MechLessorReceiptVersions
        lines={request.lessorReceiptRetired?.map(officeReceiptLine) ?? null}
        count={Math.max(0, retiredCount)}
      />
    </section>
  );
}

/**
 * The strip above the card's fields while the current version waits for the visa: the visa holder
 * opens the card and sees at once what waits for him, the dispatcher sees that the rental cannot be
 * completed yet. The block below carries the detail; the strip only the call to act.
 */
export function MechLessorReceiptStrip({
  request,
  access,
  on,
}: {
  request: MechRequestDto;
  access: MechLessorReceiptAccess;
  on: Pick<MechLessorReceiptHandlers, 'review'>;
}) {
  const current = request.lessorReceipt;
  if (request.deletedAt || current?.status !== 'pending') return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title="Чек арендодателя ждёт визы"
      description={
        <>
          <Typography.Text type="secondary">
            Версия {current.versionNo} · прикрепил {current.createdByName} ·{' '}
            {formatDateTime(current.createdAt)}
          </Typography.Text>
          {access.review && (
            <div style={{ marginTop: 8 }}>
              <Button type="primary" size="small" onClick={() => on.review(request)}>
                Проверить чек
              </Button>
            </div>
          )}
        </>
      }
    />
  );
}
