import { useEffect, useState } from 'react';
import { Alert, App, DatePicker, Divider, Input, InputNumber, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  consumableFactIssue,
  consumableFactPayload,
  consumableFactRows,
  consumableFailureText,
  ServiceConsumableFactRows,
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
  type ConsumableFactRow,
} from '@entities/service-request';
import { officeEquipmentConsumableKeys, officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { factIssue, factRowsFrom, factToPayload, factTotal, type FactRow } from '../model/fact';
import { CompleteRows } from './CompleteRows';

const DATE = 'YYYY-MM-DD';

function money(value: number): string {
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Закрытие работ исполнителем (§9.3). Окон два в одном, потому что дуга одна: у ремонта
 * предъявляют смету и факт по её строкам, у расходников — сколько чего выдали (§6.2).
 *
 * У ремонта итог — **вычисляемая строка, а не поле ввода** (Р12): он пересчитывается на глазах при
 * каждой снятой отметке и разойтись с суммой строк не может. Нужно больше согласованного — окно не
 * пускает и говорит куда идти: удорожание проходит переоткрытием сметы.
 *
 * У расходников сметы нет вовсе, поэтому нет ни итога, ни скидки, ни планки закрывающего документа
 * (предикат контрактов требует `kind = 'repair'`). Вместо них — отметка факта по строкам, и её
 * умолчание «сколько просили» подставляет ФОРМА (Р3): сервер по молчанию клиента со склада не
 * списывает и отвечает 422 «нет отметки о выдаче». Списание идёт той же транзакцией, что и переход
 * в «Решена» (Р5), поэтому нехватка остатка отменяет закрытие целиком — и приходит текстом, в
 * котором названы позиция, остаток и оба законных выхода (Р7).
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
  const [lines, setLines] = useState<ConsumableFactRow[]>([]);
  const [completedOn, setCompletedOn] = useState<Dayjs>(dayjs());
  const [adjustment, setAdjustment] = useState<number | null>(null);
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [comment, setComment] = useState('');
  /**
   * Отказ сервера — строкой в самом окне, а не только тостом: нехватка остатка называет позицию и
   * число, по которым человек правит факт прямо здесь, а тост к этому моменту уже погас.
   */
  const [failure, setFailure] = useState<string | null>(null);
  const consumable = request?.kind === 'consumable';

  useEffect(() => {
    if (!request) return;
    setRows(factRowsFrom(request.items));
    setLines(consumableFactRows(request.consumables));
    setCompletedOn(dayjs());
    setAdjustment(null);
    setAdjustmentReason('');
    setComment('');
    setFailure(null);
  }, [request]);

  const total = factTotal(rows, adjustment);
  const issue = consumable
    ? consumableFactIssue(lines)
    : factIssue(rows, adjustment, adjustmentReason, request?.estimatedTotalAmount ?? null);

  const changeRow = (id: string, patch: Partial<FactRow>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const changeLine = (id: string, patch: Partial<ConsumableFactRow>) =>
    setLines((prev) => prev.map((line) => (line.id === id ? { ...line, ...patch } : line)));

  const mutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.complete(request!.id, {
        completedOn: completedOn.format(DATE),
        // Строки сметы и строки номенклатуры — предмет одного или другого вида заявки, но не
        // обоих сразу: сервер отбивает и смету у расходников, и номенклатуру у ремонта.
        items: consumable ? [] : factToPayload(rows),
        consumables: consumable ? consumableFactPayload(lines) : undefined,
        adjustmentAmount: consumable ? null : adjustment,
        adjustmentReason: consumable ? '' : adjustmentReason.trim(),
        comment: comment.trim(),
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Работы закрыты — заявка ждёт приёмки');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // Закрытие расходников двигает склад той же транзакцией (Р5): остаток в справочнике и лента
      // журнала устарели ровно сейчас.
      if (consumable) void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      onClose();
    },
    onError: (e) => {
      const text = consumable ? consumableFailureText(e) : errorMessage(e);
      setFailure(text);
      message.error(text);
    },
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
          <ServiceRequestContext request={request} />
          {consumable ? (
            <Alert
              type="info"
              showIcon
              title="Отметьте, сколько выдали"
              description="Умолчание — сколько просили. Расхождение объясняется причиной: выдали больше, меньше или не выдали вовсе. Закрывающий документ у расходников не требуется."
            />
          ) : (
            <Alert
              type="info"
              showIcon
              title={`Согласована ревизия ${request.approval?.revision ?? request.estimateRevision} на ${money(request.estimatedTotalAmount ?? 0)}`}
              description="Снимите отметку с того, что не понадобилось: гарантия проставляется только выполненным строкам."
            />
          )}

          <DatePicker
            style={{ width: 220 }}
            format="DD.MM.YYYY"
            allowClear={false}
            value={completedOn}
            // Дата выполнения — от неё сервер считает гарантии по строкам без своей даты.
            onChange={(d) => d && setCompletedOn(d)}
          />

          {consumable ? (
            <ServiceConsumableFactRows rows={lines} onChange={changeLine} />
          ) : (
            <>
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
            </>
          )}

          <Input.TextArea
            rows={2}
            maxLength={1000}
            value={comment}
            placeholder="Комментарий: что сделали и чего не понадобилось"
            onChange={(e) => setComment(e.target.value)}
          />
          {/* Отказ сервера показывается как есть (Р7): в нём названы позиция, остаток и выход. */}
          {failure && <Alert type="error" showIcon title={failure} />}
          {issue && <Typography.Text type="warning">{issue}</Typography.Text>}
        </div>
      )}
    </FormModal>
  );
}
