import { useEffect } from 'react';
import { Alert, App, Form, Input, Space } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '@shared/lib';

/**
 * Срочность заявки: поставить или снять (план модернизации, Р56).
 *
 * Окно, а не переключатель в строке списка, ровно из-за пары «флаг + причина»: срочность без
 * объяснения запрещена и схемой, и CHECK в базе, а переключатель мог бы поставить только флаг.
 * Снятие тоже проходит через окно — там видно, что именно снимают, и это удерживает от «уберу
 * красное, чтобы список не мозолил глаза».
 *
 * Заявку при этом не двигают: возраст в текущем статусе срочность не сбрасывает — очередь «дольше
 * всех ждут» не должна обнуляться от того, что заявку пометили.
 */
export function ServiceUrgencyModal({
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
  const blockers = useFormBlockers(form);
  /** Причина живёт формой: на ней же показывается отказ «не объяснили» (ADR 0094). */
  const reason = () => (form.getFieldValue('reason') as string | undefined) ?? '';
  // Снимаем срочность у той заявки, что уже помечена; ставим — у остальных. Режим считается из
  // самой заявки, а не приходит снаружи: два источника правды разошлись бы на первой же гонке.
  const clearing = !!request?.isUrgent;

  useEffect(() => {
    form.setFieldsValue({ reason: request?.urgencyReason ?? '' });
  }, [request]);

  const mutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.setUrgency(request!.id, {
        isUrgent: !clearing,
        // Снятая срочность уносит и причину: порознь их не принимает ни схема, ни база.
        urgencyReason: clearing ? '' : reason().trim(),
        version: request!.version,
      }),
    onSuccess: () => {
      message.success(clearing ? 'Срочность снята' : 'Заявка отмечена срочной');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = () => {
    if (
      blockers.raise({
        reason: !clearing && !reason().trim() && 'Объясните, почему заявка срочная',
      })
    )
      return;
    mutation.mutate();
  };

  return (
    <FormModal
      title={
        clearing
          ? `Снять срочность с ${request?.displayNumber ?? ''}`
          : `Отметить срочной ${request?.displayNumber ?? ''}`
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={clearing ? 'Снять срочность' : 'Отметить срочной'}
      okDanger={clearing}
      width={520}
    >
      {request && (
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <ServiceRequestContext request={request} />
          {clearing ? (
            <Alert
              type="warning"
              showIcon
              title="Заявка перестанет стоять первой в очередях и в письмах"
              description={
                request.urgencyReason
                  ? `Указанная причина: ${request.urgencyReason}`
                  : 'Причина не была указана.'
              }
            />
          ) : (
            <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
              <Form.Item
                name="reason"
                label="Почему срочно"
                extra="Причина видна оператору и исполнителю и уходит в историю заявки."
                style={{ marginBottom: 0 }}
              >
                <Input.TextArea
                  rows={3}
                  maxLength={500}
                  autoFocus
                  placeholder="Например: единственный принтер на площадке, встала выдача пропусков"
                />
              </Form.Item>
            </Form>
          )}
        </Space>
      )}
    </FormModal>
  );
}
