import { useEffect, useState } from 'react';
import { Alert, App, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  consumableFactChanges,
  consumableFactIssue,
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

/**
 * Правка факта выдачи (Р6): склад двигает **изменение факта**, а не смена статуса.
 *
 * Отсюда и главное, что окно обязано сказать словами: каждая правка порождает событие журнала на
 * **разницу**, а не на всё количество. Было выдано 2, стало 3 — со склада уйдёт одна штука; было
 * 2, стало 0 — вернутся две. Не скажи этого окно, «исправляю 2 на 3» читалось бы как «спишите ещё
 * три», и склад разошёлся бы с полкой на первой же правке.
 *
 * Пока заявка не закрыта. После «Закрыта» строки заявки замирают, и всё, что случилось со складом
 * дальше, — ручная правка остатка с причиной и своим правом (Р8); поэтому и пункт меню в «Закрыта»
 * не показывается, и сервер отвечает на такую правку 422.
 *
 * Уходят только тронутые строки: `PATCH` состава заявки не касается вовсе, а строка с неизменным
 * фактом события не порождает — второй раз с неё ничего не спишется.
 */
export function ServiceConsumablesIssueModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается в «В работе» и «Решена». */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [rows, setRows] = useState<ConsumableFactRow[]>([]);
  /** Отказ сервера строкой в окне: по нехватке остатка факт правят здесь же, не закрывая окно. */
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setRows(consumableFactRows(request.consumables));
    setFailure(null);
  }, [request]);

  const changeRow = (id: string, patch: Partial<ConsumableFactRow>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const issue = consumableFactIssue(rows);
  const changes = consumableFactChanges(rows);

  const mutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.setConsumablesIssued(request!.id, {
        items: changes,
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Выданное количество отмечено');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // Событие журнала уже записано: остаток позиции и её лента в справочнике устарели.
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      onClose();
    },
    onError: (e) => {
      // Нехватка остатка приходит 422 с готовым предложением (Р7) — показываем его как есть.
      const text = consumableFailureText(e);
      setFailure(text);
      message.error(text);
    },
  });

  /**
   * Кнопка запирается самим состоянием строк, а не отвечает тостом (ADR 0094): причина отказа
   * стоит под таблицей, у той строки, из-за которой он случился. «Ничего не изменилось» — тот же
   * случай: правка без разницы не породила бы ни одного события журнала, и отправлять её незачем.
   */
  const blocked = !!issue || changes.length === 0;

  return (
    <FormModal
      title={request ? `Выдача по заявке ${request.displayNumber}` : 'Выдача'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => mutation.mutate()}
      confirmLoading={mutation.isPending}
      okDisabled={blocked}
      okText="Записать выдачу"
      width={720}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ServiceRequestContext request={request} />
          <Alert
            type="info"
            showIcon
            message="Со склада уйдёт разница, а не всё количество"
            description="Было выдано 2, стало 3 — спишется одна штука; было 2, стало 0 — вернутся две. Расхождение с запрошенным объясняется причиной."
          />
          <ServiceConsumableFactRows rows={rows} onChange={changeRow} showDelta />
          {failure && <Alert type="error" showIcon message={failure} />}
          {issue ? (
            <Typography.Text type="warning">{issue}</Typography.Text>
          ) : (
            changes.length === 0 && (
              <Typography.Text type="secondary">
                Пока ничего не изменилось: правьте выданное количество — со склада уйдёт разница.
              </Typography.Text>
            )
          )}
        </div>
      )}
    </FormModal>
  );
}
