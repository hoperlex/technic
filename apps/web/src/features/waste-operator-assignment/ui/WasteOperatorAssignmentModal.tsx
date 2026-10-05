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

/** Keep the owner-mismatch decision beside the operator that causes it. */
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
  const { data: groups } = useQuery({
    queryKey: wasteRequestKeys.presentGroups(request?.objectId),
    queryFn: () => wasteRequestsApi.presentGroups(request!.objectId),
    enabled: !!request,
  });

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
      width={640}
    >
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item
          name="operatorCounterpartyId"
          label="Оператор вывоза"
          rules={[{ required: true, message: 'Выберите оператора' }]}
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
