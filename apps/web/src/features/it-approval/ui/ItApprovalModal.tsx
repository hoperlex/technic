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
      form.setFields([{ name: 'reason', errors: ['Укажите, почему аппарат дешевле заменить'] }]);
      return;
    }
    mutation.mutate(false);
  };

  return (
    <ViewModal
      title={request ? `Решение ИТ по смете ${request.displayNumber}` : 'Решение ИТ по смете'}
      open={!!request}
      onClose={onClose}
      width={640}
      destroyOnHidden
      footer={[
        <Button key="reject" danger loading={mutation.isPending} onClick={reject}>
          Менять аппарат
        </Button>,
        <Button
          key="approve"
          type="primary"
          loading={mutation.isPending}
          onClick={() => mutation.mutate(true)}
        >
          Чинить за эти деньги
        </Button>,
      ]}
    >
      {request && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <ServiceRequestContext request={request} />

          {/*
            * Виза уехала со входа на смету (ADR 0133): вопрос теперь не «звать ли сервис», а
            * «стоит ли этот ремонт своих денег». Врезка объясняет оба исхода, потому что второй
            * закрывает заявку — а кнопка «Менять аппарат» без объяснения читалась бы как отказ
            * визировать, а не как решение по технике.
            */}
          <Alert
            type="info"
            showIcon
            message="Решение: чинить за эту сумму или менять аппарат"
            description="«Чинить» оставляет заявку на согласовании — сумму подписывает тот, кто ведёт модуль. «Менять аппарат» закрывает её с причиной и с пометкой «рекомендована замена»: по таким заявкам собирают список того, что пора обновить."
          />

          {/* Смета — предмет решения, и без неё оно не принимается: сумма показывается здесь же. */}
          {request.estimatedTotalAmount !== null && (
            <div>
              <Typography.Text strong>Смета</Typography.Text>
              <div>
                {request.estimatedTotalAmount.toLocaleString('ru-RU', {
                  style: 'currency',
                  currency: 'RUB',
                  maximumFractionDigits: 2,
                })}
                {request.estimateRevision > 1 && (
                  <Typography.Text type="secondary"> · ревизия {request.estimateRevision}</Typography.Text>
                )}
              </div>
            </div>
          )}

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
              label="Причина замены"
              extra="Нужна только для «Менять аппарат»: согласие на ремонт объясняет себя суммой."
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea
                rows={2}
                maxLength={1000}
                placeholder="Например: ремонт дороже половины нового аппарата, менять"
              />
            </Form.Item>
          </Form>
        </Space>
      )}
    </ViewModal>
  );
}
