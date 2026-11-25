import { useRef, useState } from 'react';
import { App, Form } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  actsForCounterparty,
  usesContainerGroup,
  wasteOperatorServesSite,
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
  useSnowSupport,
  wasteRequestErrorMessage as errorMessage,
  wasteRequestKeys,
  wasteRequestsApi,
  type WasteRequestPayload,
} from '@entities/waste-request';
import { MOSCOW_TZ } from '@shared/config';
import {
  LocalCreateAttemptError,
  isFileInPendingCreate,
  objectDraftPayload,
  PENDING_CREATE_FILE_MESSAGE,
  storeFormDateFields,
  useDeferredOptions,
  useLocalFormDraft,
} from '@shared/lib';
import { useFormBlockers, type FilterOption } from '@shared/ui';
import { DeferredWasteRequestEditor as WasteRequestEditorModal } from '../ui/DeferredWasteRequestEditor';
import { createPayload, updatePayload, withoutHiddenFields } from './payload';
import type {
  WasteRequestEditorController,
  WasteRequestEditorFile,
  WasteRequestFormValues,
} from './types';

/** Refusal shown instead of freezing a new snow attempt the serving API may not understand. */
export const SNOW_UNSUPPORTED_MESSAGE =
  'Вывоз снега пока недоступен: сервер не подтвердил поддержку. Повторите через несколько минут.';

interface SaveCommand {
  values: WasteRequestFormValues;
  /** The opening the save was sent from; its answer may act only on that opening. */
  opening: number;
  record: WasteRequestDto | null;
}

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
  // A counterparty-scoped creator files only for their own organisation (snow-removal plan, §3.2):
  // the server refuses any other operator and an omitted one, so the form sends their own.
  const ownOperatorId =
    actsForCounterparty(user, 'operator') && user?.counterpartyId ? user.counterpartyId : null;
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteRequestDto | null>(null);
  const [files, setFiles] = useState<WasteRequestEditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  /**
   * The current opening of the form. Every open and close moves it on, and an upload or save
   * answer compares the opening it started in with the current one: the answer of a closed or
   * replaced form must not add its file to, or close, the form opened after it — the same request
   * reopened included (snow-removal plan, §3.3).
   */
  const opening = useRef(0);
  const [form] = Form.useForm<WasteRequestFormValues>();
  const draft = useLocalFormDraft({
    userId: user?.id ?? null,
    form: 'waste-request',
    // The draft keeps what the person could see: a waste type left over from a garbage choice
    // never rides along with a snow draft (ADR 0230 shape, snow-removal plan §3.3).
    read: () =>
      storeFormDateFields(withoutHiddenFields(form.getFieldsValue(true)), ['deliveryDate']),
    parse: objectDraftPayload,
  });
  const snow = useSnowSupport(open);
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
  ) => {
    const options = operatorOptionsForObject(operators.options ?? [], objectId, assigned);
    return ownOperatorId ? options.filter((option) => option.value === ownOperatorId) : options;
  };
  /**
   * Whether the creator's own organisation may serve the chosen site: the same binding rule and
   * the same input as the server, every link of the site whatever the operator's state (§3.2).
   * `undefined` — not a counterparty-scoped creator, or the site is not chosen or not loaded yet.
   */
  const ownOperatorServes = (objectId: string | undefined): boolean | undefined => {
    if (!ownOperatorId || !objectId) return undefined;
    const site = objects.options?.find((object) => object.id === objectId);
    if (!site) return undefined;
    return wasteOperatorServesSite(
      site.operators.map((operator) => operator.id),
      ownOperatorId,
    );
  };
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
    ownOperator: ownOperatorId ? { serves: ownOperatorServes } : null,
    snowSupported: snow.supported,
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
    opening.current += 1;
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
    opening.current += 1;
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

  const close = () => {
    opening.current += 1;
    setOpen(false);
  };

  const upload = async (file: File) => {
    const startedIn = opening.current;
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      // The form this upload was chosen in is closed or replaced: the file belongs to no form and
      // no save references it, so it is removed instead of joining the newer form's files.
      if (startedIn !== opening.current) {
        void filesApi.remove(uploaded.id).catch(() => {});
        return;
      }
      setFiles((previous) => [...previous, { ...uploaded, isNew: true }]);
    } catch (error) {
      if (startedIn === opening.current) message.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (file: WasteRequestEditorFile) => {
    if (!record && isFileInPendingCreate(draft.active?.createAttempt, file.id)) {
      message.warning(PENDING_CREATE_FILE_MESSAGE);
      return;
    }
    if (file.isNew) await filesApi.remove(file.id).catch(() => {});
    else setRemovedIds((previous) => [...previous, file.id]);
    setFiles((previous) => previous.filter((item) => item.id !== file.id));
  };

  const save = useMutation({
    mutationFn: async ({ values, record: target }: SaveCommand) => {
      const snowBlocked = values.requestType === 'snow_removal' && !snow.supported;
      if (target) {
        if (snowBlocked) throw new LocalCreateAttemptError(SNOW_UNSUPPORTED_MESSAGE);
        const payload = updatePayload(values, target, {
          addFileIds: files.filter((file) => file.isNew).map((file) => file.id),
          removeFileIds: removedIds,
          // Only a dispatcher assigns the executor in the form (ADR 0010).
          operator: canAssignOperator ? 'send' : 'omit',
        });
        return { saved: await wasteRequestsApi.update(target.id, payload), attemptKey: null };
      }
      // A NEW snow attempt is refused before it is frozen: a frozen body is resent on every retry
      // and would keep asking a server that does not know snow. An attempt frozen earlier, when
      // support was confirmed, is still resent with its key — its outcome must be learned, not
      // abandoned (snow-removal plan, §3.5).
      if (snowBlocked && !draft.active?.createAttempt) {
        throw new LocalCreateAttemptError(SNOW_UNSUPPORTED_MESSAGE);
      }
      const payload: WasteRequestPayload = createPayload(values, {
        fileIds: files.filter((file) => file.isNew).map((file) => file.id),
        ownOperatorId: ownOperatorId ?? undefined,
      });
      const attempt = draft.prepareCreate(payload);
      return {
        saved: await wasteRequestsApi.create(attempt.body, attempt.key),
        attemptKey: attempt.key,
      };
    },
    onSuccess: ({ attemptKey }, command) => {
      // The draft is cleared only while it still holds this attempt. After the form was reopened
      // the stored copy waits as a pending draft, and its own check settles it.
      if (attemptKey && draft.active?.createAttempt?.key === attemptKey) draft.clear();
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
      if (command.opening === opening.current) close();
    },
    onError: (error, command) => {
      if (command.opening !== opening.current) {
        // The form is gone or shows another opening: its fields are not this answer's to mark.
        message.error(errorMessage(error));
        return;
      }
      if (
        !command.record &&
        !(error instanceof LocalCreateAttemptError) &&
        draft.active?.createAttempt
      )
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
        throw new LocalCreateAttemptError(
          'Проверьте исход старой отправки в списке заявок вручную',
        );
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
        close();
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
          close();
        }}
        onFinish={(values) => {
          if (!record) draft.persist();
          save.mutate({ values, opening: opening.current, record });
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
