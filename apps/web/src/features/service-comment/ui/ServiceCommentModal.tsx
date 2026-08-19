import { useEffect } from 'react';
import { App, Form, Input, Space } from 'antd';
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
 * Примечание исполнителя (приём ADR 0053): строка сервисной компании в чужой заявке.
 *
 * Своё окно, а не поле правки заявки, ровно потому, что заявку исполнитель не редактирует: правка
 * открыта заказчику и только в «Новой» и «Согласована ИТ», а «запчасть будет 3-го» пишут посреди
 * цикла — чаще всего когда заявка уже стоит отложенной (Р110). Общее с правкой поле пришлось бы
 * либо открыть исполнителю целиком, либо закрыть примечание вместе с ней.
 *
 * Пустое значение — обычный ход, а не отказ формы: примечание устаревает раньше заявки («ждём
 * поставку» после того, как деталь приехала), и стереть его надо тем же окном, каким писали.
 * Другого способа снять строку из карточки нет.
 */
export function ServiceCommentModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ serviceComment?: string }>();
  const blockers = useFormBlockers(form);

  // Правят прежнюю запись, а не пишут поверх пустого: без предзаполнения «дополнить» означало бы
  // «набрать заново», и вместо дополнения человек молча затирал бы то, что уже было в карточке.
  useEffect(() => {
    form.setFieldsValue({ serviceComment: request?.serviceComment ?? '' });
  }, [request]);

  const mutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.saveServiceComment(request!.id, {
        serviceComment: ((form.getFieldValue('serviceComment') as string | undefined) ?? '').trim(),
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Примечание сохранено');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    // Длину примечания сервер называет полем — показываем её на самом поле, а не тостом в углу
    // (ADR 0094). Тост остаётся тому, у чего поля нет: разошедшейся версии и закрытой заявке.
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={`Примечание исполнителя ${request?.displayNumber ?? ''}`}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      width={520}
    >
      {request && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <ServiceRequestContext request={request} />
          <Form
            form={form}
            layout="vertical"
            onFinish={() => mutation.mutate()}
            {...blockers.formProps}
          >
            <Form.Item
              name="serviceComment"
              label="Примечание исполнителя"
              extra="Видно в карточке заявки обеим сторонам. Пустое поле стирает прежнюю запись."
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea
                rows={4}
                // Тот же предел, что и у схемы: обрезать длинное молча лучше здесь, чем ответом 422
                // после нажатия «Сохранить».
                maxLength={2000}
                showCount
                autoFocus
                placeholder="Например: ждём запчасть от поставщика, обещают к 3-му"
              />
            </Form.Item>
          </Form>
        </Space>
      )}
    </FormModal>
  );
}
