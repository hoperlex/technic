import { useState } from 'react';
import { App, Form } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isPricedRequestType,
  normalizeTimeInput,
  usesContainerGroup,
  type WasteRequestDto,
} from '@technic/contracts';
import { filesApi } from '@entities/file';
import { useAuth } from '@entities/session';
import {
  containerGroupKey,
  minRequestDate,
  parseContainerGroupKey,
  wasteRequestErrorMessage as errorMessage,
  wasteRequestKeys,
  wasteRequestsApi,
  type WasteRequestPayload,
  type WasteRequestUpdatePayload,
} from '@entities/waste-request';
import { MOSCOW_TZ } from '@shared/config';
import { useFormBlockers } from '@shared/ui';
import { WasteRequestEditorModal } from '../ui/WasteRequestEditorModal';
import type {
  WasteRequestEditorController,
  WasteRequestEditorFile,
  WasteRequestEditorSources,
  WasteRequestFormValues,
} from './types';

/** Own create/edit state and commands; field presentation stays in the feature's UI module. */
export function useWasteRequestEditor(
  sources: WasteRequestEditorSources,
): WasteRequestEditorController {
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const canAssignOperator = can('wasteRequests.assignOperator');
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteRequestDto | null>(null);
  const [files, setFiles] = useState<WasteRequestEditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [form] = Form.useForm<WasteRequestFormValues>();
  const blockers = useFormBlockers(form, {
    // A different site may make the selected operator invalid, so clear it before submission.
    onValuesChange: (changed: Partial<WasteRequestFormValues>) => {
      if (!changed.objectId) return;
      const selected = form.getFieldValue('operatorCounterpartyId') as string | undefined;
      const allowed = sources.operatorOptionsFor(changed.objectId);
      if (selected && !allowed.some((option) => option.value === selected)) {
        form.setFieldValue('operatorCounterpartyId', undefined);
      }
    },
  });

  const create = () => {
    setRecord(null);
    setFiles([]);
    setRemovedIds([]);
    form.resetFields();
    form.setFieldsValue({ deliveryDate: minRequestDate(), containersCount: 1 });
    if (sources.soleObjectId) form.setFieldValue('objectId', sources.soleObjectId);
    setOpen(true);
  };

  const edit = (request: WasteRequestDto) => {
    setRecord(request);
    setFiles(request.files.map((file) => ({ ...file, isNew: false })));
    setRemovedIds([]);
    form.resetFields();
    form.setFieldsValue({
      objectId: request.objectId,
      requestType: request.requestType,
      containerTypeId: request.containerTypeId ?? undefined,
      containerGroupKey:
        usesContainerGroup(request.requestType) && request.containerTypeId
          ? containerGroupKey({
              containerTypeId: request.containerTypeId,
              ownerCounterpartyId: request.containerOwnerCounterpartyId,
            })
          : undefined,
      containersCount: request.containersCount,
      wasteTypeId: request.wasteTypeId ?? undefined,
      volumeM3: request.volumeM3 ?? undefined,
      operatorCounterpartyId: request.operatorCounterpartyId ?? undefined,
      deliveryDate: dayjs(request.deliveryAt).tz(MOSCOW_TZ),
      deliveryTime: request.deliveryTimeUnspecified
        ? undefined
        : dayjs(request.deliveryAt).tz(MOSCOW_TZ).format('HH:mm'),
      responsibleName: request.responsibleName,
      responsiblePhone: request.responsiblePhone,
      comment: request.comment,
    });
    setOpen(true);
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      setFiles((previous) => [...previous, { ...uploaded, isNew: true }]);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (file: WasteRequestEditorFile) => {
    if (file.isNew) await filesApi.remove(file.id).catch(() => {});
    else setRemovedIds((previous) => [...previous, file.id]);
    setFiles((previous) => previous.filter((item) => item.id !== file.id));
  };

  const save = useMutation({
    mutationFn: (values: WasteRequestFormValues) => {
      // The API validates the working window in Moscow time; an omitted time means the whole day.
      const time = normalizeTimeInput(values.deliveryTime ?? '');
      const deliveryAt = dayjs.tz(
        `${values.deliveryDate.format('YYYY-MM-DD')} ${time ?? '00:00'}`,
        MOSCOW_TZ,
      );
      const group = values.containerGroupKey
        ? parseContainerGroupKey(values.containerGroupKey)
        : null;
      const withGroup = usesContainerGroup(values.requestType);
      const base = {
        objectId: values.objectId,
        requestType: values.requestType,
        containerTypeId: withGroup ? group?.containerTypeId : values.containerTypeId,
        containerOwnerCounterpartyId: withGroup
          ? (group?.ownerCounterpartyId ?? undefined)
          : undefined,
        containersCount: withGroup ? (values.containersCount ?? 1) : 1,
        ownerMismatchReason: withGroup ? values.ownerMismatchReason : undefined,
        wasteTypeId: isPricedRequestType(values.requestType) ? values.wasteTypeId : undefined,
        volumeM3: isPricedRequestType(values.requestType) ? values.volumeM3 : undefined,
        operatorCounterpartyId:
          canAssignOperator && record ? values.operatorCounterpartyId : undefined,
        deliveryAt: deliveryAt.toISOString(),
        deliveryTimeUnspecified: time === undefined,
        responsibleName: values.responsibleName!,
        responsiblePhone: values.responsiblePhone!,
        comment: values.comment ?? '',
      };
      if (record) {
        const payload: WasteRequestUpdatePayload = {
          ...base,
          operatorCounterpartyId: canAssignOperator
            ? (values.operatorCounterpartyId ?? null)
            : undefined,
          containerOwnerCounterpartyId: withGroup ? (group?.ownerCounterpartyId ?? null) : null,
          addFileIds: files.filter((file) => file.isNew).map((file) => file.id),
          removeFileIds: removedIds,
          version: record.version,
        };
        return wasteRequestsApi.update(record.id, payload);
      }
      const payload: WasteRequestPayload = {
        ...base,
        fileIds: files.filter((file) => file.isNew).map((file) => file.id),
      };
      return wasteRequestsApi.create(payload);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
      setOpen(false);
    },
    onError: (error) => {
      if (!blockers.fromApi(error, { deliveryAt: 'deliveryDate' })) {
        message.error(errorMessage(error));
      }
    },
  });

  return {
    actions: { create, edit },
    node: (
      <WasteRequestEditorModal
        blockers={blockers}
        canAssignOperator={canAssignOperator}
        files={files}
        form={form}
        onCancel={() => setOpen(false)}
        onFinish={(values) => save.mutate(values)}
        onRemoveFile={(file) => void removeFile(file)}
        onUpload={(file) => void upload(file)}
        open={open}
        record={record}
        saving={save.isPending}
        sources={sources}
        uploading={uploading}
      />
    ),
  };
}
