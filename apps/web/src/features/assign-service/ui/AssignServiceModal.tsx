import { useEffect } from 'react';
import { Alert, App, Form, Input } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  serviceCompanyOptionsQuery,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { AutoSelect, FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';

interface Values {
  serviceCounterpartyId: string;
  reason?: string;
  comment?: string;
}

/**
 * Назначение и переназначение исполнителя (§5.3) — одно окно, а не два.
 *
 * Действие одно и то же: заявке называют сервисную компанию. Разница только в цене решения — при
 * переназначении у прежнего исполнителя отбирают работу, поэтому появляется обязательная причина
 * и предупреждение о том, что вместе с ним уходит его смета и снимок согласования. Двумя окнами
 * это разъехалось бы: подпись поля «Сервис» и список компаний оказались бы в двух местах.
 */
export function AssignServiceModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const reassign = !!request?.service;

  const { data: options = [], isFetching } = useQuery({
    ...serviceCompanyOptionsQuery(),
    enabled: !!request,
  });

  // Окно переоткрывают на соседней заявке: причина и выбранный сервис прошлой к ней отношения
  // не имеют. Прежний исполнитель подставляется намеренно — его видно в поле, и «переназначить
  // на того же» человек не сделает случайно.
  useEffect(() => {
    if (!request) return;
    form.resetFields();
    form.setFieldsValue({ serviceCounterpartyId: request.service?.id });
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      serviceRequestsApi.assignService(request!.id, {
        serviceCounterpartyId: values.serviceCounterpartyId,
        reason: values.reason?.trim() || undefined,
        comment: values.comment?.trim() ?? '',
        version: request!.version,
      }),
    onSuccess: () => {
      message.success(reassign ? 'Исполнитель заменён' : 'Сервис назначен');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      onClose();
    },
    // Отказ сервера здесь содержателен: контрагент приостановлен, заявку уже подвинули (409).
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={reassign ? 'Переназначить сервис' : 'Назначить сервис'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={reassign ? 'Переназначить' : 'Назначить'}
      width={520}
    >
      {reassign && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="У прежнего исполнителя заявку заберут"
          description="Его смета и согласование будут стёрты, а отсчёт ожидания начнётся заново: новый сервис не наследует чужое время."
        />
      )}
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
        <Form.Item
          name="serviceCounterpartyId"
          label="Сервисная компания"
          rules={[{ required: true, message: 'Выберите исполнителя' }]}
        >
          <AutoSelect
            showSearch
            optionFilterProp="label"
            loading={isFetching}
            options={options}
            placeholder="Кому передать заявку"
            notFoundContent="Сервисных компаний нет — заведите контрагента в справочнике"
          />
        </Form.Item>
        {reassign && (
          <Form.Item
            name="reason"
            label="Причина замены"
            extra="Уйдёт в историю заявки: по ней и разбирают, почему исполнителя сменили"
            rules={[
              { required: true, message: 'Укажите причину' },
              { whitespace: true, message: 'Укажите причину' },
            ]}
          >
            <Input.TextArea rows={2} maxLength={1000} showCount />
          </Form.Item>
        )}
        <Form.Item name="comment" label="Комментарий исполнителю">
          <Input.TextArea rows={2} maxLength={1000} placeholder="Необязательно" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
