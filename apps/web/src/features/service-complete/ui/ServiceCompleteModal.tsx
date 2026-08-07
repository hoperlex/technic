import { useEffect, useState } from 'react';
import { Alert, App, DatePicker, Divider, Input, InputNumber, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { factIssue, factRowsFrom, factToPayload, factTotal, type FactRow } from '../model/fact';
import { CompleteRows } from './CompleteRows';

const DATE = 'YYYY-MM-DD';

function money(value: number): string {
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Закрытие работ исполнителем (§9.3): по каждой строке — «выполнено» и фактическое количество,
 * ниже скидка по акту с причиной.
 *
 * Итог — **вычисляемая строка, а не поле ввода** (Р12): он пересчитывается на глазах при каждой
 * снятой отметке, и разойтись с суммой строк не может. Тем же порядком его считает сервер, и
 * прислать его отсюда нельзя вовсе — схема закрытия итога не принимает.
 *
 * Нужно больше согласованного — окно не пускает и говорит куда идти: удорожание проходит
 * переоткрытием сметы, потому что это новое решение о деньгах, а не отчёт о работе.
 */
export function ServiceCompleteModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается в статусе «В работе». */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [rows, setRows] = useState<FactRow[]>([]);
  const [completedOn, setCompletedOn] = useState<Dayjs>(dayjs());
  const [adjustment, setAdjustment] = useState<number | null>(null);
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (!request) return;
    setRows(factRowsFrom(request.items));
    setCompletedOn(dayjs());
    setAdjustment(null);
    setAdjustmentReason('');
    setComment('');
  }, [request]);

  const total = factTotal(rows, adjustment);
  const issue = factIssue(
    rows,
    adjustment,
    adjustmentReason,
    request?.estimatedTotalAmount ?? null,
  );

  const changeRow = (id: string, patch: Partial<FactRow>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const mutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.complete(request!.id, {
        completedOn: completedOn.format(DATE),
        items: factToPayload(rows),
        adjustmentAmount: adjustment,
        adjustmentReason: adjustmentReason.trim(),
        comment: comment.trim(),
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Работы закрыты — заявка ждёт приёмки');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = () => {
    if (issue) {
      message.warning(issue);
      return;
    }
    mutation.mutate();
  };

  return (
    <FormModal
      title={request ? `Закрытие работ ${request.displayNumber}` : 'Закрытие работ'}
      open={!!request}
      onCancel={onClose}
      onSubmit={submit}
      confirmLoading={mutation.isPending}
      okText="Закрыть работы"
      width={720}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Alert
            type="info"
            showIcon
            message={`Согласована ревизия ${request.approval?.revision ?? request.estimateRevision} на ${money(request.estimatedTotalAmount ?? 0)}`}
            description="Снимите отметку с того, что не понадобилось: гарантия проставляется только выполненным строкам."
          />

          <DatePicker
            style={{ width: 220 }}
            format="DD.MM.YYYY"
            allowClear={false}
            value={completedOn}
            // Дата выполнения — от неё сервер считает гарантии по строкам без своей даты.
            onChange={(d) => d && setCompletedOn(d)}
          />

          <CompleteRows rows={rows} onChange={changeRow} />

          <Divider style={{ margin: '8px 0' }} />

          <Space wrap align="start">
            <InputNumber
              style={{ width: 200 }}
              max={-0.01}
              value={adjustment}
              placeholder="Скидка по акту, ₽"
              aria-label="Скидка по акту"
              onChange={setAdjustment}
            />
            <Input
              style={{ width: 320 }}
              maxLength={500}
              value={adjustmentReason}
              disabled={adjustment == null}
              placeholder="Причина скидки"
              aria-label="Причина скидки"
              onChange={(e) => setAdjustmentReason(e.target.value)}
            />
          </Space>

          {/* Итог считается, а не вводится: строка меняется при каждой отметке (Р12). */}
          <Space size={8} style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Typography.Text type="secondary">Итого по акту:</Typography.Text>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {money(total)}
            </Typography.Text>
          </Space>

          <Input.TextArea
            rows={2}
            maxLength={1000}
            value={comment}
            placeholder="Комментарий: что сделали и чего не понадобилось"
            onChange={(e) => setComment(e.target.value)}
          />
          {issue && <Typography.Text type="warning">{issue}</Typography.Text>}
        </div>
      )}
    </FormModal>
  );
}
