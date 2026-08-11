import { useEffect } from 'react';
import { Alert, App, Button, Form, Input, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  ServiceEstimateTable,
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { useFormBlockers, ViewModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { FileLinkList } from '../../../components/FileLinks';

/** Итог сметы: сервер зафиксировал его при предъявлении — пересчитывать по строкам нельзя. */
function totalLabel(request: ServiceRequestDto): string {
  const total = request.estimatedTotalAmount;
  if (total == null) return '—';
  return `${total.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Согласование сметы (§9.3) — решение оператора о деньгах.
 *
 * Одно окно на «да» и «нет»: и то и другое — ответ на одну и ту же предъявленную ревизию, и
 * принимают его, глядя на одни и те же строки. Разведи их по двум окнам — отказ пришлось бы
 * давать вслепую, по одной сумме из списка.
 *
 * Номер ревизии показан крупно и не случайно: согласована именно та версия, которую видели, и
 * к работам сервер пустит только по совпадению ревизий (Р14). Документы предъявления — здесь же:
 * смета часто приходит файлом от сервиса, и решение принимают по нему, а не по строкам.
 */
export function EstimateApprovalModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается в статусе «Смета на согласовании». */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ reason?: string }>();
  const blockers = useFormBlockers(form);
  /** Причина живёт формой, а не окном: на ней же показывается отказ (ADR 0094). */
  const reason = () => (form.getFieldValue('reason') as string | undefined) ?? '';

  useEffect(() => {
    if (request) form.resetFields();
  }, [request]);

  const mutation = useMutation({
    mutationFn: (approved: boolean) =>
      serviceRequestsApi.decideEstimate(request!.id, {
        approved,
        reason: reason().trim() || undefined,
        version: request!.version,
      }),
    onSuccess: (_dto, approved) => {
      message.success(approved ? 'Смета согласована — заявка в работе' : 'Смета отклонена');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const reject = () => {
    // Причина отказа обязательна и на сервере: без неё исполнитель не узнает, что переделывать.
    if (blockers.raise({ reason: !reason().trim() && 'Укажите причину отклонения' })) return;
    mutation.mutate(false);
  };

  // Документы, на которые смотрят при решении: предъявленная смета файлом и вложения сторон.
  const files = (request?.files ?? []).filter(
    (file) => file.kind === 'estimate' || file.kind === 'attachment',
  );

  return (
    <ViewModal
      title={request ? `Согласование сметы ${request.displayNumber}` : 'Согласование сметы'}
      open={!!request}
      onClose={onClose}
      width={900}
      destroyOnHidden
      footer={[
        <Button key="reject" danger loading={mutation.isPending} onClick={reject}>
          Отклонить
        </Button>,
        <Button
          key="approve"
          type="primary"
          loading={mutation.isPending}
          onClick={() => mutation.mutate(true)}
        >
          Согласовать
        </Button>,
      ]}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Деньги согласуют, видя предмет: что за аппарат и где он стоит (Р57). */}
          <ServiceRequestContext request={request} />
          <Alert
            type="info"
            showIcon
            message={`Ревизия ${request.estimateRevision} · ${totalLabel(request)}`}
            description={
              <Space direction="vertical" size={0}>
                <span>
                  {request.service?.name ?? 'Исполнитель не назначен'} · {request.equipment.name}
                </span>
                <Typography.Text type="secondary">
                  Согласование пускает к работам именно эту ревизию: изменить смету после можно
                  только переоткрытием.
                </Typography.Text>
              </Space>
            }
          />

          <ServiceEstimateTable items={request.items} />

          {files.length > 0 && (
            <div>
              <Typography.Text strong>Документы</Typography.Text>
              <FileLinkList files={files} maxNameWidth={420} />
            </div>
          )}

          <Form form={form} layout="vertical" {...blockers.formProps}>
            <Form.Item name="reason" label="Причина отклонения" style={{ marginBottom: 0 }}>
              <Input.TextArea
                rows={2}
                maxLength={1000}
                placeholder="Обязательна при отказе: что именно не так со сметой"
              />
            </Form.Item>
          </Form>
        </div>
      )}
    </ViewModal>
  );
}
