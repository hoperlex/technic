import { useEffect, useRef } from 'react';
import { Alert, App, DatePicker, Form, Input } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { mechEditScope, type MechRequestDto } from '@technic/contracts';
import { mechModelOptionsQuery } from '@entities/mech-model';
import { mechFailureText, mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import { useAuth } from '@entities/session';
import {
  AutoSelect,
  FormModal,
  LocalFormDraftNotice,
  RequestCreateAttemptNotice,
  useFormBlockers,
} from '@shared/ui';
import {
  FormDraftAutosave,
  LocalCreateAttemptError,
  objectDraftPayload,
  restoreFormDateFields,
  storeFormDateFields,
  useDeferredOptions,
  useLocalFormDraft,
  withSavedOption,
} from '@shared/lib';
import { MechRequestAttachments, useMechAttachments } from './MechRequestAttachments';
import { useMechRequesterFields } from './MechRequesterFields';
import { PhoneInput } from '@entities/user-account';
import { ResponsibleFields } from '@entities/request';

const DATE = 'YYYY-MM-DD';

interface Values {
  customer: string;
  placeObjectId?: string;
  mechModelId: string;
  plannedFrom: Dayjs;
  plannedTo: Dayjs;
  responsibleName: string;
  responsiblePhone: string;
  comment?: string;
}

/**
 * The state gate controls editable fields for every role. Once a rental leaves New, its subject
 * belongs to the supplier agreement; only extension may change the term. The action menu enforces
 * the separate role gate before opening this form (ADR 0152).
 */
export function MechRequestForm({
  open,
  request,
  onClose,
}: {
  open: boolean;
  /** A null request opens the create form. */
  request: MechRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const restored = useRef(false);
  const draft = useLocalFormDraft({
    userId: user?.id ?? null,
    form: 'mech-request',
    read: () => storeFormDateFields(form.getFieldsValue(true), ['plannedFrom', 'plannedTo']),
    parse: objectDraftPayload,
  });
  const blockers = useFormBlockers(form);
  const attachments = useMechAttachments(request, open);
  const customerKey = Form.useWatch('customer', form);

  // Keep a deactivated model's saved label selectable during edits (ADR 0156).
  const {
    options: modelOptions,
    loading: modelsLoading,
    current: modelsCurrent,
  } = useDeferredOptions(mechModelOptionsQuery(), open, (options) => options, 'pick');
  const models = withSavedOption(modelOptions ?? [], {
    id: request?.mechModelId,
    name: request?.mechModelName,
  });

  // A new request has no state gate; edits use the contract predicate (ADR 0152).
  const scope = request ? mechEditScope(request) : 'all';
  const lockedSubject = scope !== 'all';
  const lockedContact = scope === 'comment';

  const requester = useMechRequesterFields({
    request,
    customerKey,
    disabled: lockedSubject,
    open,
  });
  const { savedKey, soleKey } = requester;

  useEffect(() => {
    if (!open) return;
    if (restored.current && !request) return;
    form.resetFields();
    if (request) {
      form.setFieldsValue({
        // The saved requester key remains selectable after its directory entry changes.
        customer: savedKey ?? undefined,
        // Only department requests render the site field; the body builder filters it otherwise.
        placeObjectId: request.objectId,
        // Legacy requests without a model link must choose one before saving.
        mechModelId: request.mechModelId ?? undefined,
        plannedFrom: dayjs(request.plannedFrom),
        plannedTo: dayjs(request.plannedTo),
        responsibleName: request.responsibleName,
        responsiblePhone: request.responsiblePhone,
        comment: request.comment,
      });
      return;
    }
  }, [open, request, form, savedKey]);

  useEffect(() => {
    if (!open) restored.current = false;
  }, [open]);
  const { begin } = draft;
  useEffect(() => {
    if (open && !request) begin('create');
  }, [open, request, begin]);

  useEffect(() => {
    // PICK may finish after the new form opens. Filling its only customer must not reset contact,
    // dates or model that the person entered while the directory was loading.
    if (
      open &&
      !request &&
      soleKey &&
      !form.isFieldTouched('customer') &&
      !form.getFieldValue('customer')
    ) {
      form.setFieldValue('customer', soleKey);
    }
  }, [open, request, soleKey, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const pair = requester.bodyOf(values.customer, values.placeObjectId);
      const contact = {
        responsibleName: values.responsibleName.trim(),
        responsiblePhone: values.responsiblePhone.trim(),
      };
      const comment = values.comment?.trim() ?? '';
      if (request) {
        // Sending locked fields would reject an otherwise valid contact or comment edit.
        return mechRequestsApi.update(request.id, {
          ...(scope === 'all' && pair
            ? {
                objectId: pair.objectId,
                departmentId: pair.departmentId ?? null,
                mechModelId: values.mechModelId,
                plannedFrom: values.plannedFrom.format(DATE),
                plannedTo: values.plannedTo.format(DATE),
              }
            : {}),
          ...(lockedContact ? {} : contact),
          comment,
          ...attachments.patch,
          version: request.version,
        });
      }
      const payload = {
        objectId: pair!.objectId,
        ...(pair!.departmentId ? { departmentId: pair!.departmentId } : {}),
        mechModelId: values.mechModelId,
        plannedFrom: values.plannedFrom.format(DATE),
        plannedTo: values.plannedTo.format(DATE),
        ...contact,
        comment,
        fileIds: attachments.ids,
      };
      const attempt = draft.prepareCreate(payload);
      return mechRequestsApi.create(attempt.body, attempt.key);
    },
    onSuccess: () => {
      if (!request) draft.clear();
      message.success(request ? 'Заявка сохранена' : 'Заявка заведена');
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!request && !(e instanceof LocalCreateAttemptError) && draft.active?.createAttempt)
        message.warning('Исход создания нужно проверить перед исправлением заявки.');
      if (!blockers.fromApi(e)) message.error(mechFailureText(e));
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
      const result = await mechRequestsApi.reconcileCreate(
        attempt.body as Parameters<typeof mechRequestsApi.create>[0],
        attempt.key,
      );
      return { key: attempt.key, result };
    },
    onSuccess: ({ key, result }) => {
      if (result.state === 'created') {
        draft.clear();
        void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
        message.success('Заявка создана');
        onClose();
        return;
      }
      if (draft.releaseCreateAttempt(key, result.nextOperationId))
        message.info('Создание не произошло. Исправьте форму и отправьте её заново.');
      else message.error('Не удалось сохранить результат проверки на этом устройстве');
    },
    onError: (e) => message.error(mechFailureText(e)),
  });

  const submit = (values: Values) => {
    // Do not submit a requester that is outside the offered scope or lacks a required site.
    if (!requester.bodyOf(values.customer, values.placeObjectId)) {
      blockers.raise({
        customer: 'Выберите заявителя',
        placeObjectId: requester.isDepartment ? 'Выберите площадку' : undefined,
      });
      return;
    }
    mutation.mutate(values);
  };

  const close = () => {
    if (!request && draft.active) draft.persist();
    restored.current = false;
    onClose();
  };

  return (
    <FormModal
      title={request ? `Заявка ${request.displayNumber}` : 'Новая заявка на аренду'}
      open={open}
      onCancel={close}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okDisabled={!request && draft.pending.length > 0}
      width={620}
    >
      {!request && (
        <>
          <FormDraftAutosave active={open && !!draft.active} form={form} onSave={draft.persist} />
          <LocalFormDraftNotice
            active={!!draft.active}
            pending={draft.pending}
            status={draft.status}
            attemptKey={draft.active?.createAttempt?.key}
            fileNotice
            createMayHaveSucceeded
            onRestore={(candidate) => {
              restored.current = true;
              form.setFieldsValue(
                restoreFormDateFields<Values>(draft.restore(candidate), [
                  'plannedFrom',
                  'plannedTo',
                ]),
              );
            }}
            onDiscard={draft.discardPending}
          />
          <RequestCreateAttemptNotice
            pending={!!draft.active?.createAttempt}
            legacy={
              !!draft.active?.createAttempt && draft.active.createAttempt.protocol !== 'receipt-v1'
            }
            checking={reconcile.isPending || mutation.isPending}
            onCheck={() => reconcile.mutate()}
            onLegacyReset={() => {
              if (draft.resetLegacyCreateAttempt())
                message.info('Старая попытка сброшена. Перед отправкой проверьте данные заявки.');
              else message.error('Не удалось сохранить сброс попытки на этом устройстве');
            }}
          />
        </>
      )}
      {(request || draft.pending.length === 0) && (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            if (!request) draft.persist();
            submit(values);
          }}
          {...blockers.formProps}
        >
          {lockedSubject && (
            // Explain the state gate before submit rather than waiting for an API rejection.
            <Alert
              type="info"
              showIcon
              title="Предмет заявки уже нельзя менять"
              description={
                lockedContact
                  ? 'Заявка закрыта: правятся комментарий и вложения — акт приходит позже, и подшить его надо.'
                  : 'За сроком, моделью и площадкой стоит договорённость с арендодателем. Срок двигает продление, договорённость — действие «Изменить договорённость».'
              }
              style={{ marginBottom: 16 }}
            />
          )}

          {requester.fields}

          {/* A model must come from the directory, not free text (ADR 0156). */}
          <Form.Item
            name="mechModelId"
            label="Модель"
            rules={[{ required: true, message: 'Выберите модель' }]}
          >
            <AutoSelect
              showSearch
              optionFilterProp="label"
              options={models}
              loading={modelsLoading}
              autoSelectSole={modelsCurrent}
              disabled={lockedSubject}
              placeholder="Например: виброплита Wacker DPU 3070Н"
            />
          </Form.Item>

          <Form.Item
            name="plannedFrom"
            label="Подача"
            rules={[{ required: true, message: 'Укажите дату подачи' }]}
          >
            <DatePicker
              style={{ width: 220 }}
              format="DD.MM.YYYY"
              allowClear={false}
              disabled={lockedSubject}
            />
          </Form.Item>

          <Form.Item
            name="plannedTo"
            label="Плановый возврат"
            dependencies={['plannedFrom']}
            rules={[
              { required: true, message: 'Укажите дату возврата' },
              // Validate here too, where the user sees both dates together.
              ({ getFieldValue }) => ({
                validator: (_r, value: Dayjs | null | undefined) => {
                  const from = getFieldValue('plannedFrom') as Dayjs | undefined;
                  return !value || !from || !value.isBefore(from, 'day')
                    ? Promise.resolve()
                    : Promise.reject(new Error('Дата возврата не может быть раньше даты подачи'));
                },
              }),
            ]}
          >
            <DatePicker
              style={{ width: 220 }}
              format="DD.MM.YYYY"
              allowClear={false}
              disabled={lockedSubject}
            />
          </Form.Item>

          {/* The receiving contact is locked after completion to preserve the rental history. */}
          <ResponsibleFields
            nameField="responsibleName"
            phoneField="responsiblePhone"
            nameLabel="Кто принимает технику"
            phoneLabel="Телефон для связи"
            disabled={lockedContact}
            kept={
              request
                ? { name: request.responsibleName, phone: request.responsiblePhone }
                : undefined
            }
            phoneInput={PhoneInput}
          />

          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} maxLength={2000} placeholder="Необязательно" />
          </Form.Item>

          {/* Bills and acceptance acts may arrive after completion, so attachments stay editable. */}
          <MechRequestAttachments attachments={attachments} disabled={scope === 'none'} />
        </Form>
      )}
    </FormModal>
  );
}
