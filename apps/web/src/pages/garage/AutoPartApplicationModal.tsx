import { useEffect } from 'react';
import { App, DatePicker, Form, Input, InputNumber, Select, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { moscowDateKeyOf, type AutoPartWarehouseLotDto } from '@technic/contracts';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { errorMessage, formatMoney } from '@shared/lib';
import { FormGrid, FormModal, useFormBlockers } from '@shared/ui';
import { useReceiptVehicleOptions } from './receiptVehicleOptions';

interface Values {
  vehicleId: string;
  appliedOn: Dayjs;
  quantity: number;
  documentNumber: string;
  note?: string;
}

/** Reporting document that consumes a receipt-backed warehouse lot. */
export function AutoPartApplicationModal({
  lot,
  onClose,
}: {
  lot: AutoPartWarehouseLotDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const vehicles = useReceiptVehicleOptions();
  const today = moscowDateKeyOf(new Date());

  useEffect(() => {
    if (!lot) return;
    form.resetFields();
    form.setFieldsValue({ appliedOn: dayjs(today), quantity: lot.remainingQuantity });
  }, [form, lot, today]);

  const save = useMutation({
    mutationFn: (values: Values) =>
      autoPartReceiptApi.applyFromWarehouse(lot!.lineId, {
        vehicleId: values.vehicleId,
        appliedOn: values.appliedOn.format('YYYY-MM-DD'),
        quantity: values.quantity,
        documentNumber: values.documentNumber.trim(),
        note: values.note?.trim() ?? '',
      }),
    onSuccess: (application) => {
      message.success('Применение запчасти оформлено');
      void qc.invalidateQueries({ queryKey: autoPartReceiptKeys.warehouseLists() });
      void qc.invalidateQueries({ queryKey: autoPartReceiptKeys.snapshots() });
      void qc.invalidateQueries({
        queryKey: autoPartReceiptKeys.vehicleSpends(application.vehicleId),
      });
      onClose();
    },
    onError: (error) => {
      if (!blockers.fromApi(error)) message.error(errorMessage(error));
      void qc.invalidateQueries({ queryKey: autoPartReceiptKeys.warehouseLists() });
    },
  });

  return (
    <FormModal
      title={lot ? `Применить: ${lot.name}` : 'Применить запчасть'}
      open={lot !== null}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      width={680}
    >
      {lot && (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => save.mutate(values)}
          {...blockers.formProps}
        >
          <Typography.Paragraph type="secondary">
            Остаток партии: {lot.remainingQuantity} {lot.unit} на {formatMoney(lot.remainingAmount)}
            . Источник — чек № {lot.receiptDocumentNumber} от{' '}
            {dayjs(lot.purchasedOn).format('DD.MM.YYYY')}.
          </Typography.Paragraph>
          <FormGrid>
            <Form.Item
              name="vehicleId"
              label="Техника"
              rules={[{ required: true, message: 'Выберите технику' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                loading={vehicles.loading}
                options={vehicles.options}
                placeholder="Собственная техника"
              />
            </Form.Item>
            <Form.Item
              name="appliedOn"
              label="Дата применения"
              rules={[{ required: true, message: 'Укажите дату применения' }]}
            >
              <DatePicker
                format="DD.MM.YYYY"
                allowClear={false}
                style={{ width: '100%' }}
                disabledDate={(date) => date.format('YYYY-MM-DD') > today}
              />
            </Form.Item>
            <Form.Item
              name="quantity"
              label={`Количество, ${lot.unit}`}
              rules={[{ required: true, message: 'Укажите количество' }]}
            >
              <InputNumber
                min={1}
                max={lot.remainingQuantity}
                precision={0}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item
              name="documentNumber"
              label="Номер документа"
              rules={[{ required: true, message: 'Укажите номер документа' }]}
            >
              <Input maxLength={100} placeholder="Акт / требование / ведомость" />
            </Form.Item>
            <FormGrid.Full>
              <Form.Item name="note" label="Примечание">
                <Input.TextArea rows={3} maxLength={1000} showCount />
              </Form.Item>
            </FormGrid.Full>
          </FormGrid>
        </Form>
      )}
    </FormModal>
  );
}
