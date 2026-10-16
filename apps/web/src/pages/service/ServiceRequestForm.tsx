import { useEffect } from 'react';
import { App, Form, Input, Segmented } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isWarrantyActive,
  serviceRequestKindLabels,
  SERVICE_REQUEST_KINDS,
  type ServiceRequestDto,
  type ServiceRequestKind,
} from '@technic/contracts';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { useAuth } from '@entities/session';
import { RequestCreateAttemptNotice } from '@shared/ui';
import { LocalCreateAttemptError } from '@shared/lib';
import { ServiceRequestCustomerField, useServiceRequestCustomer } from '@features/request-customer';
import { FormModal, useFormBlockers } from '@shared/ui';
import {
  ServiceRequestAttachments,
  useServiceRequestAttachments,
} from './ServiceRequestAttachments';
import {
  submitServiceRequest,
  type ServiceFormValues,
  type WarrantyClaimPreset,
} from './serviceRequestSubmit';
import {
  ServiceRequestEquipmentField,
  useServiceRequestEquipment,
} from './ServiceRequestEquipmentField';
import { ServiceRequestUrgency } from './ServiceRequestUrgency';
import { ServiceRequestWarrantyClaim } from './ServiceRequestWarrantyClaim';
import { useRequesterPlace } from './ServiceRequestRequesterPlace';
import { reportServiceMail } from './serviceMailNotice';
import { reportServiceRequestFailure } from './serviceRequestFailure';
import { useServiceRequestDraft } from './useServiceRequestDraft';
import { PhoneInput } from '@entities/user-account';
import { ResponsibleFields } from '@entities/request';

type Values = ServiceFormValues;
export type { WarrantyClaimPreset };

/**
 * The selected device determines whether a repair can use a specific warranty source (R26).
 * Only an unassigned New request is editable (R14): later changes would break agreements with
 * the executor. Changing the device means creating another request, and later attachments belong
 * in the card's Documents tab. The requester describes consumable needs in words because the
 * executor, not the requester, knows the stock catalogue (R15).
 */
export function ServiceRequestForm({
  open,
  request,
  claim,
  onClose,
}: {
  open: boolean;
  /** `null` means a new request. */
  request: ServiceRequestDto | null;
  /** Warranty registry intake supplies the device and source. */
  claim?: WarrantyClaimPreset | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const [form] = Form.useForm<Values>();
  const local = useServiceRequestDraft({ form, userId: user?.id ?? null, open, request, claim });
  const blockers = useFormBlockers(form);
  const attachments = useServiceRequestAttachments(local.draft.active?.createAttempt);
  const { reset: resetAttachments } = attachments;
  const equipmentId = Form.useWatch('officeEquipmentId', form);
  const chosenKind = Form.useWatch('kind', form);
  const warrantySource = Form.useWatch('warrantySource', form);

  // The field owns its search and selection memory; the form only needs its selected value.
  const equipment = useServiceRequestEquipment({ open, equipmentId });
  const selected = equipment.selected;
  const warrantyActive = isWarrantyActive(selected?.warrantyUntil);

  // Device-only controls cannot appear for a device-free request, including an existing one (R7).
  const noEquipment = request ? !request.equipment : !equipmentId;
  // This permission removes the device requirement from the ordinary create route (R5).
  const canSkipEquipment = can('serviceRequests.createWithoutEquipment');
  // The same urgency permission governs both visibility and the submitted pair (R9).
  const canUrgency = can('serviceRequests.urgency');
  const withoutEquipment = !request && noEquipment && canSkipEquipment;

  // Customer choices follow the selected device, saved edit snapshot or device-free role scope.
  // A candidate supplies its declared site before an equipment record exists (R6, R7, R11).
  const draft = Form.useWatch('equipmentCandidate', { form, preserve: true });
  const site = selected ?? draft?.site;
  const customer = useServiceRequestCustomer({ request, equipment: site, withoutEquipment, open });

  // Requester place comes from one account axis and is fixed by the snapshot during editing.
  const place = useRequesterPlace({ user: request ? null : user, open });
  // Scalar keys avoid resetting the form whenever the customer picker rerenders.
  const { savedKey, soleDepartmentKey } = customer;

  // Editing cannot change request kind; a warranty claim is always a repair, never stock issue.
  const kind: ServiceRequestKind = request
    ? request.kind
    : claim
      ? 'repair'
      : (chosenKind ?? 'repair');
  const consumable = kind === 'consumable';

  useEffect(() => {
    if (!open) return;
    if (local.restored.current && !request) return;
    form.resetFields();
    resetAttachments();
    if (request) {
      form.setFieldsValue({
        // Editing cannot add a device to an originally device-free request (R8).
        officeEquipmentId: request.equipment?.id,
        description: request.description,
        // The saved customer snapshot remains selectable after the directory changes.
        customer: savedKey ?? undefined,
        responsibleName: request.responsibleName,
        responsiblePhone: request.responsiblePhone,
        comment: request.comment,
        warrantySource: request.warrantyClaim?.source,
        isUrgent: request.isUrgent,
        urgencyReason: request.urgencyReason,
      });
      return;
    }
    form.setFieldsValue({
      // Keep the client default aligned with the DB and create schema default.
      kind: 'repair',
      // Another site must be an explicit override, not the default inferred from the device.
      objectOverridden: false,
      // Prefer the account's sole department so its printer request does not become a site request.
      customer: soleDepartmentKey ?? undefined,
      // Prefill editable contact fields from the author to avoid missing contact data (R49).
      responsibleName: user?.fullName ?? '',
      responsiblePhone: user?.phone ?? '',
      // Warranty intake carries an opaque source ID the requester cannot enter manually.
      ...(claim ? { officeEquipmentId: claim.equipmentId, warrantySource: claim.source } : {}),
    });
  }, [
    open,
    request,
    claim,
    form,
    resetAttachments,
    savedKey,
    soleDepartmentKey,
    user?.fullName,
    user?.phone,
    local.restored,
  ]);

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      if (!request && draft && local.draft.active?.createAttempt)
        throw new LocalCreateAttemptError('Сначала проверьте исход предыдущей отправки');
      // Both customer IDs travel together: objectId also represents a device-free site (R6).
      const pair = customer.customerPairOf(values.customer);
      return submitServiceRequest(values, {
        request,
        claim,
        customerDepartmentId: pair.departmentId,
        customerObjectId: pair.objectId,
        requesterPlace: place.body(values.requesterPlaceId),
        fileIds: attachments.ids,
        equipmentCandidate: draft,
        prepareCreate: local.draft.prepareCreate,
        // An out-of-scope device uses the customer's site, not the device's card site (R5).
        foreignSite: !!selected && !selected.objectInOwnScope,
        // The permission also gates urgency in the payload; the server rejects unauthorized create.
        canUrgency,
      });
    },
    onSuccess: (res) => {
      if (!request) local.draft.clear();
      message.success(request ? 'Заявка сохранена' : 'Заявка заведена');
      // Warn about failed mail delivery because the service team works from email.
      reportServiceMail(message, res.mail);
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    // The failure handler needs the form to place an existing duplicate device in its fields.
    onError: (e, values) => {
      if (!request && !(e instanceof LocalCreateAttemptError) && local.draft.active?.createAttempt)
        message.warning('Исход создания нужно проверить перед исправлением заявки.');
      reportServiceRequestFailure(e, {
        withoutEquipment: !request && !values.officeEquipmentId && !draft,
        blockers,
        message,
        form,
      });
    },
  });

  const reconcile = useMutation({
    mutationFn: async () => {
      const attempt = local.draft.active?.createAttempt;
      if (!attempt) throw new LocalCreateAttemptError('Нет попытки создания для проверки');
      if (attempt.protocol !== 'receipt-v1')
        throw new LocalCreateAttemptError(
          'Проверьте исход старой отправки в списке заявок вручную',
        );
      const result = await serviceRequestsApi.reconcileCreate(
        attempt.body as Parameters<typeof serviceRequestsApi.create>[0],
        attempt.key,
      );
      return { key: attempt.key, result };
    },
    onSuccess: ({ key, result }) => {
      if (result.state === 'created') {
        local.draft.clear();
        void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
        void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
        message.success('Заявка создана');
        onClose();
        return;
      }
      if (local.draft.releaseCreateAttempt(key, result.nextOperationId))
        message.info('Создание не произошло. Исправьте форму и отправьте её заново.');
      else message.error('Не удалось сохранить результат проверки на этом устройстве');
    },
    onError: (e) =>
      reportServiceRequestFailure(e, { withoutEquipment: false, blockers, message, form }),
  });

  return (
    <FormModal
      title={request ? `Заявка ${request.displayNumber}` : 'Новая заявка на обслуживание'}
      open={open}
      onCancel={() => {
        if (!request && local.draft.active) local.draft.persist();
        onClose();
      }}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okDisabled={!request && local.draft.pending.length > 0}
      width={620}
    >
      {local.notice}
      {!request && (
        <RequestCreateAttemptNotice
          pending={!!local.draft.active?.createAttempt}
          legacy={
            !!local.draft.active?.createAttempt &&
            local.draft.active.createAttempt.protocol !== 'receipt-v1'
          }
          checking={reconcile.isPending || mutation.isPending}
          onCheck={() => reconcile.mutate()}
          onLegacyReset={() => {
            if (local.draft.resetLegacyCreateAttempt())
              message.info('Старая попытка сброшена. Перед отправкой проверьте данные заявки.');
            else message.error('Не удалось сохранить сброс попытки на этом устройстве');
          }}
        />
      )}
      {(request || local.draft.pending.length === 0) && (
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => {
            if (!request) local.draft.persist();
            mutation.mutate(v);
          }}
          {...blockers.formProps}
        >
          {/* Kind controls later questions; edits and warranty claims have a fixed kind. */}
          {!request && !claim && (
            <Form.Item name="kind" label="Чем помочь">
              <Segmented
                options={SERVICE_REQUEST_KINDS.map((value) => ({
                  value,
                  label: serviceRequestKindLabels[value],
                }))}
              />
            </Form.Item>
          )}

          <ServiceRequestEquipmentField
            request={request}
            claim={!!claim}
            optional={canSkipEquipment}
            open={open}
            {...equipment}
          />

          {/* Warranty claims require a repair on a specific device; the schema rejects other pairs. */}
          {!consumable && !noEquipment && (
            <ServiceRequestWarrantyClaim
              active={warrantyActive}
              claim={claim}
              source={warrantySource}
            />
          )}

          {/* The shared label and validation replace the kind-specific wording from ADR 0145;
              the example remains kind-specific to help the requester describe the issue. */}
          <Form.Item
            name="description"
            label="Описание"
            rules={[
              { required: true, message: 'Опишите, о чём заявка' },
              { min: 5, message: 'Напишите подробнее' },
            ]}
          >
            <Input.TextArea
              rows={3}
              maxLength={4000}
              showCount
              placeholder={
                consumable
                  ? 'Например: закончился чёрный тонер, печатать нечем'
                  : 'Например: мнёт бумагу на каждой второй странице'
              }
            />
          </Form.Item>

          {/* Desired due date was removed (R115): it did not constrain work and soon looked overdue;
              age in the status now carries the useful ordering signal. */}
          <Form.Item
            name="customer"
            label="Для кого заявка"
            // A device-free request needs this customer to establish its scope (R7, R12a).
            rules={[{ required: true, message: 'Выберите заказчика заявки' }]}
          >
            {/* During creation, the picker follows the device's current site when it changes. */}
            <ServiceRequestCustomerField customer={customer} open={open} />
          </Form.Item>

          {/* The requester contact is required because the technician needs someone to reach. */}
          <ResponsibleFields
            nameField="responsibleName"
            phoneField="responsiblePhone"
            nameLabel="Кто обращается"
            phoneLabel="Телефон для связи"
            phoneInput={PhoneInput}
          />

          {/* Requester place differs from the customer department. */}
          {place.field}

          {/* The urgency component owns pair visibility and locking (R9, R56). */}
          <ServiceRequestUrgency editing={!!request} canUrgency={canUrgency} />

          <Form.Item name="comment" label="Что ещё важно знать">
            <Input.TextArea rows={2} maxLength={2000} placeholder="Необязательно" />
          </Form.Item>

          {/* Later attachments belong in the card's Documents tab with their document kinds. */}
          {!request && (
            <ServiceRequestAttachments
              files={attachments.files}
              uploading={attachments.uploading}
              onUpload={attachments.upload}
              onRemove={attachments.remove}
            />
          )}
        </Form>
      )}
    </FormModal>
  );
}
