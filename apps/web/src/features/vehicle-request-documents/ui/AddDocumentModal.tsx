import { useEffect, useMemo, useState } from 'react';
import { App, AutoComplete, Button, DatePicker, Form, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  VEHICLE_REQUEST_DOCUMENT_TYPE_MAX,
  VEHICLE_REQUEST_DOCUMENT_TYPE_SUGGESTIONS,
  type VehicleRequestDocumentDto,
} from '@technic/contracts';
import { filesApi } from '@entities/file';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { FILE_MAX_SIZE } from '@shared/config';
import { errorMessage } from '@shared/lib';
import { FormModal, useFormBlockers } from '@shared/ui';

interface Values {
  file?: File;
  docType?: string;
  docDate?: Dayjs;
}

/**
 * Adding one document: the file, its type and its date, both typed by hand (D5; the date may be any
 * date — owner correction to P4). The file goes to storage first and is linked second, the order of
 * every attachment in the portal: the server links an id of an object already uploaded.
 *
 * The type is free text with suggestions (P11) — the usual papers and the types this request already
 * has, so the second УПД is spelled like the first one. Nothing outside the list is refused.
 */
export function AddDocumentModal({
  requestId,
  open,
  usedTypes,
  onClose,
}: {
  requestId: string;
  open: boolean;
  /** Types the request's documents already carry — offered first. */
  usedTypes: string[];
  onClose: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setFile(null);
  }, [open, form]);

  const options = useMemo(
    () =>
      [...new Set([...usedTypes, ...VEHICLE_REQUEST_DOCUMENT_TYPE_SUGGESTIONS])].map((value) => ({
        value,
      })),
    [usedTypes],
  );

  const add = useMutation({
    mutationFn: async (v: { file: File; docType: string; docDate: string }) => {
      const uploaded = await filesApi.upload(v.file);
      return vehicleRequestsApi.addDocument(requestId, {
        fileId: uploaded.id,
        docType: v.docType,
        docDate: v.docDate,
      });
    },
    onSuccess: (res: { items: VehicleRequestDocumentDto[] }) => {
      // The answer is the table whole: put it in place, so the card shows the new row at once.
      qc.setQueryData(vehicleRequestKeys.documents(requestId), res);
      // The request history gained an event. Not the request root: it is the prefix of the table
      // just put in place, and would fetch it again.
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.events(requestId) });
      message.success('Документ добавлен');
      onClose();
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  const submit = (v: Values) => {
    const docType = (v.docType ?? '').trim();
    const blocked = blockers.raise({
      file: !file && 'Выберите файл',
      docType: !docType && 'Укажите тип документа',
      docDate: !v.docDate && 'Укажите дату документа',
    });
    if (blocked || !file || !v.docDate) return;
    add.mutate({ file, docType, docDate: v.docDate.format('YYYY-MM-DD') });
  };

  return (
    <FormModal
      title="Добавить документ"
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={add.isPending}
      okText="Добавить"
    >
      <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
        <Form.Item name="file" label="Файл">
          <Upload
            maxCount={1}
            showUploadList={false}
            beforeUpload={(picked) => {
              if (picked.size > FILE_MAX_SIZE) {
                blockers.raise({ file: 'Файл больше 50 МБ' });
                return Upload.LIST_IGNORE;
              }
              setFile(picked);
              form.setFieldsValue({ file: picked });
              return false;
            }}
          >
            <Button icon={<UploadOutlined />}>{file ? 'Выбрать другой' : 'Выбрать файл'}</Button>
          </Upload>
        </Form.Item>
        {file && (
          <Typography.Paragraph type="secondary" style={{ marginTop: -12 }}>
            {file.name}
          </Typography.Paragraph>
        )}
        <Form.Item name="docType" label="Тип документа">
          <AutoComplete
            options={options}
            maxLength={VEHICLE_REQUEST_DOCUMENT_TYPE_MAX}
            placeholder="Например, УПД"
            filterOption={(input, option) =>
              String(option?.value ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>
        <Form.Item name="docDate" label="Дата документа">
          <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
