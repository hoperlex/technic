import { useEffect } from 'react';
import { Alert, App, Form, Input, Space } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  serviceRequestStatusLabels,
  serviceResumeTarget,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '@shared/lib';

/** Что делают с движением заявки: останавливают или отпускают. */
export type HoldMode = 'hold' | 'resume';

/**
 * Заморозка и возврат (Р103) — два конца одной остановки, и потому одно окно с двумя режимами, как
 * у приёмки с возвратом на доработку. Различаются они содержанием, а не поведением: у заморозки
 * причина обязательна (Р107) — даты «отложена до» у неё нет, и на вопрос «когда ждать» отвечает
 * только она; у возврата слово вдогонку необязательно — решение выражено самим переходом.
 *
 * Куда вернётся заявка, здесь показывают, а не выбирают (Р104): дуга назад одна — в статус, из
 * которого её отложили. Дай мы выбор, «Отложена» стала бы вторым входом в цикл, в обход визы ИТ,
 * сметы и назначения.
 */
export function ServiceHoldModal({
  request,
  mode,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  mode: HoldMode;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ text?: string }>();
  const blockers = useFormBlockers(form);
  const resuming = mode === 'resume';

  useEffect(() => {
    if (request) form.resetFields();
  }, [request, mode]);

  /** Значение поля берётся у формы: окно об этом ничего не помнит и хранить не должно. */
  const text = () => (form.getFieldValue('text') as string | undefined) ?? '';

  const mutation = useMutation({
    mutationFn: () =>
      resuming
        ? serviceRequestsApi.resume(request!.id, {
            comment: text().trim(),
            version: request!.version,
          })
        : serviceRequestsApi.hold(request!.id, {
            reason: text().trim(),
            version: request!.version,
          }),
    onSuccess: () => {
      message.success(resuming ? 'Заявка возвращена в работу' : 'Заявка отложена');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = () => {
    // Причина заморозки — обязательное поле, а не тост поверх окна: правят её здесь же (ADR 0094).
    if (
      blockers.raise({
        text: !resuming && !text().trim() && 'Объясните, почему заявку откладывают',
      })
    )
      return;
    mutation.mutate();
  };

  /**
   * Куда вернётся заявка. У возврата это `held_from_status`, у заморозки — тот статус, в котором
   * заявка стоит сейчас: отложат её именно из него, и человеку полезно видеть это до нажатия —
   * другого пути назад не будет.
   */
  const target = request ? (serviceResumeTarget(request) ?? request.status) : null;

  return (
    <FormModal
      title={
        resuming
          ? `Вернуть в работу ${request?.displayNumber ?? ''}`
          : `Отложить ${request?.displayNumber ?? ''}`
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={resuming ? 'Возобновить' : 'Отложить'}
      width={520}
    >
      {request && (
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <ServiceRequestContext request={request} />
          <Alert
            type="info"
            showIcon
            title={
              resuming
                ? `Заявка вернётся в «${serviceRequestStatusLabels[target!]}»`
                : 'Заявка остановится: ход по ней станет невозможен'
            }
            description={
              resuming
                ? // Причина заморозки видна ровно здесь: после возврата заявка её не помнит —
                  // поля заморозки чистит сам переход (Р118).
                  `${request.holdReason ? `Отложена: ${request.holdReason}. ` : ''}Возраст в статусе обнулится: исполнитель не наследует время остановки.`
                : `Вернуть её можно будет только в «${serviceRequestStatusLabels[target!]}» — другого пути назад нет. Срочность и правку отложенной заявке не меняют, а файлы, примечание исполнителя и перемещение техники остаются доступными.`
            }
          />

          <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
            <Form.Item
              name="text"
              label={resuming ? 'Комментарий' : 'Почему откладываем'}
              extra={
                resuming
                  ? undefined
                  : 'Причина видна в списке и в карточке: она заменяет дату «отложена до».'
              }
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea
                rows={3}
                maxLength={1000}
                autoFocus
                placeholder={
                  resuming
                    ? 'Необязательно: что изменилось'
                    : 'Например: ждём запчасть от поставщика, обещают к 3-му'
                }
              />
            </Form.Item>
          </Form>
        </Space>
      )}
    </FormModal>
  );
}
