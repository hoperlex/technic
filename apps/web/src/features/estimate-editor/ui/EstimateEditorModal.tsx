import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Space, Tooltip, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceItemKind, ServiceRequestDto } from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { ViewModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import {
  estimateIssue,
  newEstimateRow,
  rowsChanged,
  rowsFromItems,
  rowsToPayload,
  rowsTotal,
  type EstimateRow,
} from '../model/rows';
import { EstimateRowsGroup } from './EstimateRows';

/**
 * Редактор сметы исполнителя (§9.3): две группы, количество, цена, срок гарантии, итог на лету.
 *
 * Смета уходит на сервер целиком (`PUT`), поэтому строки живут состоянием окна, а не формой с
 * `Form.List`: считать итог на каждое нажатие клавиши и показывать его тут же — главное, что
 * окно делает; смета — это разговор о деньгах, и сумма не должна появляться только после
 * отправки.
 *
 * Версия заявки держится своим состоянием: сохранение состава её поднимает, и предъявление
 * сметы сразу после сохранения ушло бы со старой версией — то есть получило бы 409 на ровном
 * месте (Р30).
 */
export function EstimateEditorModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается только в «Диагностике»: дальше смета правке не подлежит. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [rows, setRows] = useState<EstimateRow[]>([]);
  const [comment, setComment] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!request) return;
    setRows(rowsFromItems(request.items));
    setVersion(request.version);
    setComment('');
  }, [request]);

  const total = rowsTotal(rows);
  const issue = estimateIssue(rows);
  const warrantyMode = !!request?.warrantyClaim;

  const addRow = (kind: ServiceItemKind) => setRows((prev) => [...prev, newEstimateRow(kind)]);
  const changeRow = (key: string, patch: Partial<EstimateRow>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const removeRow = (key: string) => setRows((prev) => prev.filter((row) => row.key !== key));

  const refresh = () => void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });

  /**
   * Сохранение и предъявление — одна цепочка, а не две кнопки с одинаковым телом: предъявить
   * можно только то, что лежит на сервере, и «сохранить, потом отправить» руками означало бы
   * ревизию, разошедшуюся с экраном исполнителя.
   */
  const saveMutation = useMutation({
    mutationFn: async (submit: boolean) => {
      let current = version;
      if (rowsChanged(rows, request!.items)) {
        const saved = await serviceRequestsApi.saveEstimate(request!.id, {
          items: rowsToPayload(rows),
          version: current,
        });
        current = saved.version;
      }
      if (!submit) return { version: current, submitted: false };
      const sent = await serviceRequestsApi.submitEstimate(request!.id, {
        warrantyRepair: false,
        comment: comment.trim(),
        version: current,
      });
      return { version: sent.version, submitted: true };
    },
    onSuccess: (result) => {
      setVersion(result.version);
      refresh();
      if (result.submitted) {
        message.success('Смета предъявлена на согласование');
        onClose();
      } else {
        message.success('Смета сохранена');
      }
    },
    // 409 здесь — обычный ответ: заявку подвинули, пока смету набирали.
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Гарантийный ремонт (Р27): смета из служебной нулевой строки, её собирает сервер. */
  const warrantyMutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.submitEstimate(request!.id, {
        warrantyRepair: true,
        comment: comment.trim(),
        version,
      }),
    onSuccess: () => {
      message.success('Гарантийный ремонт предъявлен без оплаты');
      refresh();
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const pending = saveMutation.isPending || warrantyMutation.isPending;
  const submit = (asDraft: boolean) => {
    if (!asDraft && issue) {
      message.warning(issue);
      return;
    }
    saveMutation.mutate(!asDraft);
  };

  return (
    <ViewModal
      title={request ? `Смета заявки ${request.displayNumber}` : 'Смета'}
      open={!!request}
      onClose={onClose}
      width={860}
      destroyOnHidden
      footer={[
        ...(warrantyMode
          ? [
              <Tooltip
                key="warranty"
                title={
                  rows.length > 0
                    ? 'Уберите строки: гарантийный ремонт предъявляется без оплаты'
                    : 'Работы по гарантии: заявка уйдёт на согласование с нулевой суммой'
                }
              >
                <span>
                  <Button
                    disabled={rows.length > 0 || pending}
                    loading={warrantyMutation.isPending}
                    onClick={() => warrantyMutation.mutate()}
                  >
                    Гарантийный ремонт без оплаты
                  </Button>
                </span>
              </Tooltip>,
            ]
          : []),
        <Button key="draft" disabled={pending} onClick={() => submit(true)}>
          Сохранить черновик
        </Button>,
        <Button
          key="submit"
          type="primary"
          loading={saveMutation.isPending}
          disabled={warrantyMutation.isPending}
          onClick={() => submit(false)}
        >
          Отправить на согласование
        </Button>,
      ]}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Alert
            type="info"
            showIcon
            message={
              request.estimateRevision > 0
                ? `Ревизия ${request.estimateRevision} отклонена или переоткрыта — отправите ревизию ${request.estimateRevision + 1}`
                : 'Черновик можно сохранять сколько угодно: на согласование уйдёт то, что отправите'
            }
            description={
              warrantyMode
                ? 'Заявка заведена как гарантийная — работы можно предъявить без оплаты.'
                : undefined
            }
          />

          <EstimateRowsGroup
            kind="part"
            rows={rows.filter((row) => row.kind === 'part')}
            onAdd={addRow}
            onChange={changeRow}
            onRemove={removeRow}
          />
          <EstimateRowsGroup
            kind="service"
            rows={rows.filter((row) => row.kind === 'service')}
            onAdd={addRow}
            onChange={changeRow}
            onRemove={removeRow}
          />

          {/* Итог — строка, а не поле: его считает сумма строк, и разойтись с ней он не может. */}
          <Space size={8} style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Typography.Text type="secondary">Итого по смете:</Typography.Text>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {total.toLocaleString('ru-RU', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              ₽
            </Typography.Text>
          </Space>

          <Input.TextArea
            rows={2}
            maxLength={1000}
            value={comment}
            placeholder="Комментарий к смете: что нашли при диагностике"
            onChange={(e) => setComment(e.target.value)}
          />
          {issue && <Typography.Text type="warning">{issue}</Typography.Text>}
        </div>
      )}
    </ViewModal>
  );
}
