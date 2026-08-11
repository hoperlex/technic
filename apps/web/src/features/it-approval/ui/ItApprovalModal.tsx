import { useEffect } from 'react';
import { Alert, App, Button, Form, Input, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
  UrgentTag,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { errorMessage } from '@shared/lib';
import { ViewModal } from '@shared/ui';

/**
 * Виза отдела ИТ (план модернизации, Р51): нужен ли внешний ремонт вообще.
 *
 * Окно одно на «да» и «нет» — решение одно, различается ответ. Отказ закрывает заявку, поэтому у
 * него обязательна причина: «ИТ отказал» без объяснения заказчик прочитает как молчание, а
 * оспорить молчание нечем.
 *
 * Решают, глядя на предмет: что за аппарат, где стоит и что с ним просят сделать. Поэтому шапка
 * заявки и текст неисправности — здесь же, а не «в карточке, откройте отдельно»: согласующий от
 * ИТ видит заявки всей компании, и вспомнить каждую по номеру он не может.
 */
export function ItApprovalModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ reason?: string }>();

  useEffect(() => {
    form.resetFields();
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (approved: boolean) =>
      serviceRequestsApi.itApproval(request!.id, {
        approved,
        reason: (form.getFieldValue('reason') as string | undefined)?.trim() || undefined,
        version: request!.version,
      }),
    onSuccess: (_result, approved) => {
      message.success(approved ? 'Заявка согласована' : 'Заявка отклонена');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const reject = () => {
    const reason = (form.getFieldValue('reason') as string | undefined)?.trim();
    if (!reason) {
      form.setFields([{ name: 'reason', errors: ['Укажите причину отказа'] }]);
      return;
    }
    mutation.mutate(false);
  };

  return (
    <ViewModal
      title={request ? `Согласование ИТ ${request.displayNumber}` : 'Согласование ИТ'}
      open={!!request}
      onClose={onClose}
      width={640}
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <ServiceRequestContext request={request} />

          <Alert
            type="info"
            showIcon
            message="Решение: звать ли внешний сервис"
            description="Согласованную заявку оператор передаёт сервисной компании. Отказ закрывает её с причиной — заказчик увидит объяснение в истории."
          />

          {request.isUrgent && (
            <Space size={8} wrap>
              <UrgentTag reason="" />
              <span>{request.urgencyReason}</span>
            </Space>
          )}

          <div>
            <Typography.Text strong>Неисправность</Typography.Text>
            <div style={{ whiteSpace: 'pre-wrap' }}>{request.description}</div>
          </div>

          {request.comment && (
            <div>
              <Typography.Text type="secondary">Комментарий заказчика</Typography.Text>
              <div style={{ whiteSpace: 'pre-wrap' }}>{request.comment}</div>
            </div>
          )}

          <Form form={form} layout="vertical">
            <Form.Item
              name="reason"
              label="Причина отказа"
              extra="Нужна только при отказе: согласие объясняет себя само."
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea
                rows={2}
                maxLength={1000}
                placeholder="Например: чиним своими силами, картридж на складе"
              />
            </Form.Item>
          </Form>
        </Space>
      )}
    </ViewModal>
  );
}
