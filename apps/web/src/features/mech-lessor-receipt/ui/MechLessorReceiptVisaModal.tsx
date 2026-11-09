import { useState, type ReactNode } from 'react';
import { App, Button, Descriptions, Form, Grid, Input, theme } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  mechLessorReceiptAccess,
  mechLessorReceiptAuthorLabels,
  type AttachedFileDto,
  type MechLessorReceiptDecision,
  type MechLessorReceiptVersionDto,
  type MechRequestDto,
} from '@technic/contracts';
import { FilePreviewFrame, filesApi } from '@entities/file';
import {
  isMechStaleError,
  mechDayLabel,
  mechFailureText,
  mechModelLabel,
  mechRateLabel,
  mechRequestKeys,
  mechRequestsApi,
  mechTermLabel,
} from '@entities/mech-request';
import { useAuth } from '@entities/session';
import { errorMessage, formatDateTime, useIsMobile } from '@shared/lib';
import { useFormBlockers, ViewModal } from '@shared/ui';
import { useDecideMechLessorReceipt, useWaiveMechLessorReceipt } from '../model/mutations';

/** What the window is doing: looking, or typing the reason of one decision. */
type Step = 'look' | 'reject' | 'waive' | 'revoke';

const STEP_TEXTS: Record<Exclude<Step, 'look'>, { label: string; ok: string; required: string }> = {
  reject: { label: 'Причина отказа', ok: 'Отклонить', required: 'Укажите причину отказа' },
  waive: {
    label: 'Почему аренду завершают без чека',
    ok: 'Разрешить без чека',
    required: 'Укажите, почему аренду завершают без чека',
  },
  revoke: {
    label: 'Причина отзыва',
    ok: 'Отозвать утверждение',
    required: 'Укажите причину отзыва',
  },
};

const SUCCESS: Record<Exclude<Step, 'look'> | 'approve', string> = {
  approve: 'Чек утверждён',
  reject: 'Чек отклонён',
  waive: 'Завершение без чека разрешено',
  revoke: 'Утверждение чека отозвано',
};

interface Values {
  comment?: string;
}

/**
 * «Проверить чек» (lessor receipt plan, O5, P15): the receipt itself next to the facts it is signed
 * against, and the decision in the same window.
 *
 * - Desktop (≥ 992 px): the receipt on the left, about two thirds, the facts on the right.
 * - Phone: the full-screen sheet, the receipt on top, the facts below, the actions in the sheet's
 *   pinned footer — the thumb reaches them without scrolling past the receipt.
 *
 * THE WINDOW SIGNS WHAT IT SHOWS. It keeps the version it opened with and sends that `receiptId`
 * and the request version of that moment; the server binds the write to both (P5). A version
 * replaced while the window was open is a 409, and the window closes with the SERVER's words —
 * «Чек заменили, пока окно было открыто» says more than the module's generic «reread» — and the card
 * reads itself again.
 *
 * Which actions exist is `mechLessorReceiptAccess` over the server's permission list (ADR 0223), so a
 * shown button does not end in a 422. A rejection, a waiver and a revocation each need a reason; the
 * reason field appears in place of the facts' tail, and the footer turns into «Назад» and the one
 * decision.
 */
export function MechLessorReceiptVisaModal({
  target,
  onClose,
}: {
  /** `null` — closed. `receipt` is the current file version at the moment the window opened. */
  target: { request: MechRequestDto; receipt: MechLessorReceiptVersionDto } | null;
  onClose: () => void;
}) {
  // Keyed by the version: another version is another window, with the step and the reason empty.
  if (!target?.receipt.file) return null;
  return (
    <VisaWindow
      key={target.receipt.id}
      request={target.request}
      receipt={target.receipt}
      file={target.receipt.file}
      onClose={onClose}
    />
  );
}

function VisaWindow({
  request,
  receipt,
  file,
  onClose,
}: {
  request: MechRequestDto;
  receipt: MechLessorReceiptVersionDto;
  file: AttachedFileDto;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { user, can } = useAuth();
  const isMobile = useIsMobile();
  const wide = !!Grid.useBreakpoint().lg && !isMobile;
  const { token } = theme.useToken();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const decide = useDecideMechLessorReceipt();
  const waive = useWaiveMechLessorReceipt();
  const [step, setStep] = useState<Step>('look');

  /*
   * The card's own query, for the one fact a list row does not carry: why the previous version was
   * rejected. The decision itself goes out with the request as the window opened it.
   */
  const { data: fresh } = useQuery({
    queryKey: mechRequestKeys.detail(request.id),
    queryFn: () => mechRequestsApi.get(request.id),
  });

  const access = mechLessorReceiptAccess(user, { ...request, lessorVersionCount: 0 }, can);
  const previous = (fresh?.id === request.id ? fresh : request).lessorReceiptRetired?.[0];
  const pending = decide.isPending || waive.isPending;

  const finish = (done: keyof typeof SUCCESS) => ({
    onSuccess: () => {
      message.success(SUCCESS[done]);
      onClose();
    },
    onError: (e: unknown) => {
      if (isMechStaleError(e)) {
        // The server's words, not the module's generic «reread»; the cache is already dropped.
        message.error(errorMessage(e));
        onClose();
        return;
      }
      if (!blockers.fromApi(e, { comment: 'comment' })) message.error(mechFailureText(e));
    },
  });

  const send = (decision: MechLessorReceiptDecision, comment: string, done: keyof typeof SUCCESS) =>
    decide.mutate({ rental: request, receiptId: receipt.id, decision, comment }, finish(done));

  const submit = ({ comment }: Values) => {
    const reason = comment?.trim() ?? '';
    if (step === 'reject') send('reject', reason, 'reject');
    else if (step === 'revoke') send('revoke', reason, 'revoke');
    else if (step === 'waive') waive.mutate({ rental: request, comment: reason }, finish('waive'));
  };

  const download = async () => {
    try {
      await filesApi.download(file.id);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const size = isMobile ? 'large' : 'middle';
  const downloadButton = (
    <Button key="download" size={size} icon={<DownloadOutlined />} onClick={() => void download()}>
      Скачать
    </Button>
  );
  const buttons: ReactNode[] =
    step === 'look'
      ? [
          downloadButton,
          access.waive && (
            <Button key="waive" size={size} onClick={() => setStep('waive')}>
              Без чека
            </Button>
          ),
          access.revokeApproval && (
            <Button key="revoke" size={size} danger onClick={() => setStep('revoke')}>
              Отозвать утверждение
            </Button>
          ),
          access.review && (
            <Button key="reject" size={size} danger onClick={() => setStep('reject')}>
              Отклонить
            </Button>
          ),
          access.review && (
            <Button
              key="approve"
              size={size}
              type="primary"
              loading={pending}
              onClick={() => send('approve', '', 'approve')}
            >
              Утвердить
            </Button>
          ),
        ].filter(Boolean)
      : [
          downloadButton,
          <Button key="back" size={size} disabled={pending} onClick={() => setStep('look')}>
            Назад
          </Button>,
          <Button
            key="submit"
            size={size}
            type="primary"
            danger={step !== 'waive'}
            loading={pending}
            onClick={() => form.submit()}
          >
            {STEP_TEXTS[step].ok}
          </Button>,
        ];

  const facts = (
    <Descriptions
      size="small"
      column={1}
      bordered
      layout={wide ? 'horizontal' : 'vertical'}
      items={[
        { key: 'num', label: '№', children: request.displayNumber },
        {
          key: 'object',
          label: 'Площадка',
          children: `${request.objectCode} — ${request.objectName}`,
        },
        { key: 'model', label: 'Модель', children: mechModelLabel(request) },
        { key: 'lessor', label: 'Арендодатель', children: request.lessorName ?? '—' },
        { key: 'rate', label: 'Ставка', children: mechRateLabel(request.rate, request.rateUnit) },
        { key: 'term', label: 'Плановый срок', children: mechTermLabel(request) },
        {
          key: 'issued',
          label: 'Выдана',
          children: request.actualFrom ? mechDayLabel(request.actualFrom) : 'ещё не выдана',
        },
        {
          key: 'version',
          label: 'Версия',
          children: `Версия ${receipt.versionNo} из ${request.lessorReceiptVersionCount}`,
        },
        {
          key: 'author',
          label: 'Прикрепил',
          children: `${receipt.createdByName} (${mechLessorReceiptAuthorLabels[receipt.createdAs]}) · ${formatDateTime(receipt.createdAt)}`,
        },
        ...(previous?.status === 'rejected'
          ? [
              {
                key: 'previous',
                label: 'Прошлая версия',
                children: `отклонена: ${previous.decisionComment || '—'}`,
              },
            ]
          : []),
      ]}
    />
  );

  const reason =
    step === 'look' ? null : (
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 16 }}
        disabled={pending}
        onFinish={submit}
        {...blockers.formProps}
      >
        <Form.Item
          name="comment"
          label={STEP_TEXTS[step].label}
          rules={[
            { required: true, message: STEP_TEXTS[step].required },
            { whitespace: true, message: STEP_TEXTS[step].required },
            { max: 500, message: 'Слишком длинная причина' },
          ]}
        >
          <Input.TextArea rows={3} maxLength={500} showCount autoFocus />
        </Form.Item>
      </Form>
    );

  const preview = (
    <div
      style={{
        height: wide ? '100%' : '60dvh',
        minHeight: 0,
        background: token.colorFillQuaternary,
        borderRadius: token.borderRadius,
        overflow: 'hidden',
      }}
    >
      <FilePreviewFrame file={file} pdf="pages" />
    </div>
  );

  return (
    <ViewModal
      title={`Чек арендодателя · ${request.displayNumber}`}
      open
      onClose={onClose}
      width={1200}
      destroyOnHidden
      // On the phone the sheet lays the buttons out evenly by itself; a grid of two keeps five of
      // them readable instead of five slivers in one row.
      footer={
        isMobile ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{buttons}</div>
        ) : (
          buttons
        )
      }
      bodyStyle={
        wide
          ? {
              height: '78vh',
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)',
              gap: 16,
              overflow: 'hidden',
            }
          : undefined
      }
    >
      {preview}
      <div style={wide ? { minHeight: 0, overflowY: 'auto' } : { marginTop: 16 }}>
        {facts}
        {reason}
      </div>
    </ViewModal>
  );
}
