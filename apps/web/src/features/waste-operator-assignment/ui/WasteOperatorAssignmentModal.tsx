import { useEffect } from 'react';
import { Form, Input, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  checkContainerOwner,
  FOREIGN_CONTAINER_SPLIT_MESSAGE,
  type WasteRequestDto,
} from '@technic/contracts';
import { presentGroupsHint, wasteRequestKeys, wasteRequestsApi } from '@entities/waste-request';
import { AutoSelect, FormModal, type FilterOption } from '@shared/ui';

export interface WasteOperatorAssignmentValue {
  operatorCounterpartyId: string;
  ownerMismatchReason?: string;
}

interface Props {
  confirmLoading: boolean;
  loading: boolean;
  onCancel: () => void;
  onSubmit: (value: WasteOperatorAssignmentValue) => void;
  options: FilterOption[];
  request: WasteRequestDto | null;
}

/**
 * Operator assignment while moving a request into work. The executor is mandatory: the request
 * reaches its operator's list through exactly this field (ADR 0010). The owner-mismatch decision
 * stays beside the operator that causes it (ADR 0054).
 */
export function WasteOperatorAssignmentModal({
  confirmLoading,
  loading,
  onCancel,
  onSubmit,
  options,
  request,
}: Props) {
  const [form] = Form.useForm<WasteOperatorAssignmentValue>();
  const operatorId = Form.useWatch('operatorCounterpartyId', form);
  // What stands on the affected site: the "whom to call" hint and the basis for the foreign
  // container warning (ADR 0054). Same query key as the editor form, so the cache is shared.
  const { data: groups } = useQuery({
    queryKey: wasteRequestKeys.presentGroups(request?.objectId),
    queryFn: () => wasteRequestsApi.presentGroups(request!.objectId),
    enabled: !!request,
  });

  // An executor may already be chosen in the request itself; the modal then only confirms it.
  useEffect(() => {
    form.resetFields();
    if (request?.operatorCounterpartyId) {
      form.setFieldValue('operatorCounterpartyId', request.operatorCounterpartyId);
    }
  }, [form, request]);

  const verdict = request
    ? checkContainerOwner({ ...request, operatorCounterpartyId: operatorId ?? null }, false)
    : 'ok';

  return (
    <FormModal
      title="Назначение оператора вывоза мусора"
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="В работу"
      // One field needs no columns; the wider modal only stops the operator label and its hint
      // from wrapping syllable by syllable, as they did at 480 px.
      width={640}
    >
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item
          name="operatorCounterpartyId"
          label="Оператор вывоза"
          rules={[{ required: true, message: 'Выберите оператора' }]}
          // Site containers are shown here because assignment is when the crew is decided, and
          // "whoever installed it removes it" is part of that decision (ADR 0054).
          extra={
            options.length === 0
              ? 'Нет активных контрагентов типа «Оператор» — заведите его в справочнике'
              : presentGroupsHint(groups ?? [])
          }
        >
          <AutoSelect options={options} loading={loading} showSearch optionFilterProp="label" />
        </Form.Item>
        {verdict !== 'ok' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="warning">
                {`Контейнер установил «${request?.containerOwnerName ?? '—'}». `}
                {verdict === 'splitRequired'
                  ? FOREIGN_CONTAINER_SPLIT_MESSAGE
                  : 'Назначьте его либо объясните, почему вывозит другой оператор'}
              </Typography.Text>
            </div>
            {verdict !== 'splitRequired' && (
              <Form.Item
                name="ownerMismatchReason"
                label="Причина вывоза чужого контейнера"
                rules={[{ required: true, message: 'Укажите причину' }]}
              >
                <Input.TextArea
                  rows={2}
                  maxLength={500}
                  placeholder="Например: контейнеры переданы по акту"
                />
              </Form.Item>
            )}
          </>
        )}
      </Form>
    </FormModal>
  );
}
