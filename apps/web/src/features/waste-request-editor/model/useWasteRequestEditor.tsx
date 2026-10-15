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
import {
  counterpartyActiveOperatorOptionsQuery,
  operatorOptionsForObject,
} from '@entities/counterparty';
import { containerTypeOptionsQuery } from '@entities/container-type';
import { objectRecordsQuery } from '@entities/object';
import { useAuth } from '@entities/session';
import { wasteTypeOptionsQuery } from '@entities/waste-type';
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
import {
  LocalCreateAttemptError,
  objectDraftPayload,
  storeFormDateFields,
  useDeferredOptions,
  useLocalFormDraft,
} from '@shared/lib';
import { useFormBlockers, type FilterOption } from '@shared/ui';
import { DeferredWasteRequestEditor as WasteRequestEditorModal } from '../ui/DeferredWasteRequestEditor';
import type {
  WasteRequestEditorController,
  WasteRequestEditorFile,
  WasteRequestFormValues,
} from './types';

interface EditorScope {
  objectFieldDisabled: boolean;
  limitObjectOptions: (options: FilterOption[]) => FilterOption[];
  soleObjectId?: string;
}

/** Own create/edit state and commands; field presentation stays in the feature's UI module. */
export function useWasteRequestEditor(scope: EditorScope): WasteRequestEditorController {
  const { message } = App.useApp();
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const canAssignOperator = can('wasteRequests.assignOperator');
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteRequestDto | null>(null);
  const [files, setFiles] = useState<WasteRequestEditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [form] = Form.useForm<WasteRequestFormValues>();
  const draft = useLocalFormDraft({
    userId: user?.id ?? null,
    form: 'waste-request',
    read: () => storeFormDateFields(form.getFieldsValue(true), ['deliveryDate']),
    parse: objectDraftPayload,
  });
  // The mounted controller survives closing the lazy editor. Its own PICK observers switch off
  // with the dialog and recheck an old cached choice on the next opening.
  const objects = useDeferredOptions(objectRecordsQuery(true), open, (data) => data.items, 'pick');
  const types = useDeferredOptions(
    containerTypeOptionsQuery({ activeOnly: true }),
    open,
    (data) => data.items,
    'pick',
  );
  const wasteTypes = useDeferredOptions(
    wasteTypeOptionsQuery({ pricedOnly: true }),
    open,
    (data) => data.items,
    'pick',
  );
  const operators = useDeferredOptions(
    counterpartyActiveOperatorOptionsQuery(),
    open && canAssignOperator,
    (data) => data.items,
    'pick',
  );
  const operatorOptionsFor = (
    objectId: string | undefined,
    assigned?: { id: string | null; name: string | null },
  ) => operatorOptionsForObject(operators.options ?? [], objectId, assigned);
  const sources = {
    containerTypes: {
      cont: (types.options ?? [])
        .filter((type) => type.type === 'cont')
        .map((type) => ({ value: type.id, label: type.name })),
      loading: types.loading,
      current: types.current,
    },
    objectFieldDisabled: scope.objectFieldDisabled,
    objectOptions: scope.limitObjectOptions(
      (objects.options ?? []).map((object) => ({
        value: object.id,
        label: `${object.code} — ${object.name}`,
      })),
    ),
    objectsLoading: objects.loading,
    objectsCurrent: objects.current,
    operatorOptionsFor,
    operatorsLoading: operators.loading,
    operatorsReady: operators.current,
    soleObjectId: scope.soleObjectId,
    wasteTypes: {
      options: (wasteTypes.options ?? []).map((type) => ({ value: type.id, label: type.name })),
      loading: wasteTypes.loading,
      current: wasteTypes.current,
    },
  };
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
    // Delivery defaults to today, the earliest date the contract rule allows. The count defaults
    // to one container because that is what is usually removed.
    form.setFieldsValue({ deliveryDate: minRequestDate(), containersCount: 1 });
    // The site is prefilled only when the role has exactly one: with several, prefilling the first
    // one would create a request for the wrong site (ADR 0039).
    if (sources.soleObjectId) form.setFieldValue('objectId', sources.soleObjectId);
    draft.begin('create');
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
      // Replacement and removal choose the container as a group; installation has no group field.
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
      // No time set leaves the field empty; deliveryAt then holds Moscow midnight.
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
      // Date and time are composed in Moscow time, the zone in which the server checks the working
      // window. No time means Moscow midnight plus the unspecified flag: a request "for the day".
      const time = normalizeTimeInput(values.deliveryTime ?? '');
      const deliveryAt = dayjs.tz(
        `${values.deliveryDate.format('YYYY-MM-DD')} ${time ?? '00:00'}`,
        MOSCOW_TZ,
      );
      // Replacement and removal pick the container as a "type + owner" group (ADR 0054);
      // installation picks a directory type and has no group.
      const group = values.containerGroupKey
        ? parseContainerGroupKey(values.containerGroupKey)
        : null;
      const withGroup = usesContainerGroup(values.requestType);
      const base = {
        objectId: values.objectId,
        requestType: values.requestType,
        // Only container operations carry a directory type: removal has no such field, and the
        // server would null a submitted value anyway (ADR 0022).
        containerTypeId: withGroup ? group?.containerTypeId : values.containerTypeId,
        containerOwnerCounterpartyId: withGroup
          ? (group?.ownerCounterpartyId ?? undefined)
          : undefined,
        containersCount: withGroup ? (values.containersCount ?? 1) : 1,
        // The reason is sent only with a mismatch: matching parties have no reason field.
        ownerMismatchReason: withGroup ? values.ownerMismatchReason : undefined,
        // Waste type and volume belong only to removal (ADR 0019); the server nulls them for
        // container operations anyway.
        wasteTypeId: isPricedRequestType(values.requestType) ? values.wasteTypeId : undefined,
        volumeM3: isPricedRequestType(values.requestType) ? values.volumeM3 : undefined,
        // Only a dispatcher assigns the executor, and only on an existing request: the create form
        // has no such field, and other roles lack it on edit too (ADR 0010).
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
          // An empty field from a dispatcher means "remove the executor": that is null, not
          // "leave unchanged".
          operatorCounterpartyId: canAssignOperator
            ? (values.operatorCounterpartyId ?? null)
            : undefined,
          // On update an omitted field means "unchanged", so a group without an owner and a change
          // of request type send an explicit null: otherwise the owner would outlive a type that
          // never has one.
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
      const attempt = draft.prepareCreate(payload);
      return wasteRequestsApi.create(attempt.body, attempt.key);
    },
    onSuccess: () => {
      if (!record) draft.clear();
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
      setOpen(false);
    },
    onError: (error) => {
      if (!record && !(error instanceof LocalCreateAttemptError) && draft.active?.createAttempt)
        message.warning('Исход создания нужно проверить перед исправлением заявки.');
      // A validation error is shown on its field: a generic toast does not say what to fix.
      // deliveryAt is split into date and time in the form, so it maps to the date field.
      if (!blockers.fromApi(error, { deliveryAt: 'deliveryDate' })) {
        message.error(errorMessage(error));
      }
    },
  });

  const reconcile = useMutation({
    mutationFn: async () => {
      const attempt = draft.active?.createAttempt;
      if (!attempt) throw new LocalCreateAttemptError('Нет попытки создания для проверки');
      if (attempt.protocol !== 'receipt-v1')
        throw new LocalCreateAttemptError('Проверьте исход старой отправки в списке заявок вручную');
      const result = await wasteRequestsApi.reconcileCreate(
        attempt.body as WasteRequestPayload,
        attempt.key,
      );
      return { key: attempt.key, result };
    },
    onSuccess: ({ key, result }) => {
      if (result.state === 'created') {
        draft.clear();
        void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
        message.success('Заявка создана');
        setOpen(false);
        return;
      }
      if (draft.releaseCreateAttempt(key, result.nextOperationId))
        message.info('Создание не произошло. Исправьте форму и отправьте её заново.');
      else message.error('Не удалось сохранить результат проверки на этом устройстве');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return {
    actions: { create, edit },
    node: (
      <WasteRequestEditorModal
        draft={draft}
        blockers={blockers}
        canAssignOperator={canAssignOperator}
        files={files}
        form={form}
        onCancel={() => {
          if (!record && draft.active) draft.persist();
          setOpen(false);
        }}
        onFinish={(values) => {
          if (!record) draft.persist();
          save.mutate(values);
        }}
        onRemoveFile={(file) => void removeFile(file)}
        onReconcile={() => reconcile.mutate()}
        onLegacyReset={() => {
          if (draft.resetLegacyCreateAttempt())
            message.info('Старая попытка сброшена. Перед отправкой проверьте данные заявки.');
          else message.error('Не удалось сохранить сброс попытки на этом устройстве');
        }}
        onUpload={(file) => void upload(file)}
        open={open}
        record={record}
        reconciling={reconcile.isPending || save.isPending}
        saving={save.isPending}
        sources={sources}
        uploading={uploading}
      />
    ),
  };
}
