import { useEffect } from 'react';
import { Alert, App, Checkbox, Form, Input, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  ServiceEstimateTable,
  ServiceRequestContext,
  serviceRequestEquipmentName,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { FileLinkList } from '../../../components/FileLinks';

/** Итог: сервер зафиксировал его при предъявлении — пересчитывать по строкам нельзя. */
function totalLabel(request: ServiceRequestDto): string {
  const total = request.estimatedTotalAmount;
  if (total == null) return '—';
  return `${total.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/** Поля отказа. Согласия у окна нет вовсе — у него нет содержания, кроме уже видной суммы. */
interface Values {
  reason?: string;
  resolution?: string;
  replacementRecommended?: boolean;
}

/**
 * Отказ по объёму работ (Р8, Р11, Р12) — «не согласовано» и только оно.
 *
 * **Окно одноисходное, и это исправление, а не сужение.** Согласие содержания не имеет: есть
 * ревизия и сумма, которые человек только что видел, — и оно идёт подтверждением прямо из набора
 * действий (`serviceRequestActions`), как и просил заказчик кнопкой в разделе. Оставь мы обе
 * кнопки здесь, пункт «Не согласовано» открывал бы окно, где заново спрашивают, согласовать или
 * нет; а «Согласовать» существовало бы двумя дорогами с разными телами запроса.
 *
 * У отказа содержание есть, и его два: причина («почему») и решение («что делаем вместо», Р12).
 * Расходятся они и путём — причина уходит комментарием перехода в историю, решение остаётся полем
 * заявки, — и с решения через месяц начинается разбор отклонённой. Спрашиваются оба здесь, потому
 * что заявка после отказа закрыта (В1, «Отменена») и дописать пропущенное будет уже негде.
 *
 * Галочка замены — рукой, а не ручкой сервера: прежде отказ ИТ означал «не чинить, значит менять»,
 * теперь «не согласовано» означает много чего ещё, и флаг, проставленный за человека, был бы
 * решением, которого он не принимал (Р8, Р10 — виза упразднена).
 *
 * Номер ревизии показан крупно и не случайно: отказывают именно той версии, которую видели. Строки
 * и документы предъявления — здесь же: объём работ часто приходит файлом от сервиса, и решение
 * принимают по нему, а не по таблице.
 */
export function EstimateApprovalModal({
  request,
  onClose,
}: {
  /**
   * `null` — окно закрыто. Открывается в «В работе» при непогашенном предъявлении: доступность
   * решает `canApproveServiceEstimate` у зовущего — и у кнопки «Не согласовано» под таблицей
   * объёма работ, и у пункта меню «Действия» (Р11).
   */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);

  useEffect(() => {
    if (request) form.resetFields();
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      serviceRequestsApi.decideEstimate(request!.id, {
        // Исход у окна один. `approved: false` — не значение поля, а само назначение окна, и
        // читать его из формы значило бы завести в ней состояние, которого у человека нет.
        approved: false,
        reason: values.reason?.trim(),
        resolution: values.resolution?.trim(),
        // Поле обязательно и в схеме (`approveServiceEstimateSchema`): у него есть умолчание, но в
        // выводимом типе оно required, и «не слать, раз галочка не стоит» тело сломало бы.
        replacementRecommended: !!values.replacementRecommended,
        version: request!.version,
      }),
    onSuccess: () => {
      // Что стало с заявкой — в самом тосте: отказ её закрывает, и человек, искавший «объём в
      // правке», должен узнать про «Отменена» здесь, а не по пропавшей заявке в списке.
      message.success('Объём работ не согласован — заявка отменена');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => {
      // Оба текста проверяет и сервер (`superRefine` схемы). Ответ ложится на поле, а не тостом:
      // отказ формы называет поле (ADR 0094).
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={request ? `Отказ по объёму работ ${request.displayNumber}` : 'Отказ по объёму работ'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Не согласовано"
      okDanger
      width={900}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => mutation.mutate(values)}
        {...blockers.formProps}
      >
        {request && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
            {/* Деньги согласуют, видя предмет: что за аппарат и где он стоит (Р57). */}
            <ServiceRequestContext request={request} />
            <Alert
              type="warning"
              showIcon
              title={`Ревизия ${request.estimateRevision} · ${totalLabel(request)}`}
              description={
                <Space orientation="vertical" size={0}>
                  <span>
                    {request.service?.name ?? 'Исполнитель не назначен'} ·{' '}
                    {serviceRequestEquipmentName(request)}
                  </span>
                  <Typography.Text type="secondary">
                    Отказ закрывает заявку — она уходит в «Отменена», и вернуть её оттуда может
                    только «Ведение». Если объём нужно лишь переделать, вернитесь и выберите
                    «Вернуть в правку»: заявка останется в работе.
                  </Typography.Text>
                </Space>
              }
            />

            <ServiceEstimateTable items={request.items} />

            <EstimateFiles request={request} />
          </div>
        )}

        <Form.Item
          name="reason"
          label="Причина"
          extra="Уйдёт комментарием в историю заявки: по ней и разбирают отказ"
          rules={[
            { required: true, message: 'Укажите, почему объём работ не согласован' },
            { min: 3, message: 'Напишите подробнее' },
          ]}
        >
          <Input.TextArea
            rows={2}
            maxLength={1000}
            placeholder="Например: ремонт вдвое дороже нового аппарата"
          />
        </Form.Item>
        <Form.Item
          name="resolution"
          label="Решение"
          extra="Что делаем вместо ремонта. Остаётся полем заявки: с него начинают разбор отклонённой заявки через месяц"
          rules={[{ required: true, message: 'Опишите решение: что делаем вместо ремонта' }]}
        >
          <Input.TextArea
            rows={2}
            maxLength={500}
            showCount
            placeholder="Например: меняем аппарат, заявка на закупку заведена"
          />
        </Form.Item>
        <Form.Item
          name="replacementRecommended"
          valuePropName="checked"
          extra="По этой пометке собирают список того, что пора обновить. Ставится рукой: «не согласовано» само по себе не значит «менять»"
          style={{ marginBottom: 0 }}
        >
          <Checkbox>Рекомендована замена аппарата</Checkbox>
        </Form.Item>
      </Form>
    </FormModal>
  );
}

/** Документы, на которые смотрят при решении: предъявленный объём файлом и вложения сторон. */
function EstimateFiles({ request }: { request: ServiceRequestDto }) {
  const files = request.files.filter(
    (file) => file.kind === 'estimate' || file.kind === 'attachment',
  );
  if (files.length === 0) return null;
  return (
    <div>
      <Typography.Text strong>Документы</Typography.Text>
      <FileLinkList files={files} maxNameWidth={420} />
    </div>
  );
}
