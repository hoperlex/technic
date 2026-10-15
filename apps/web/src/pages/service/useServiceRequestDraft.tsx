import { useEffect, useRef } from 'react';
import { type FormInstance } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import { FormDraftAutosave, objectDraftPayload, useLocalFormDraft } from '@shared/lib';
import { LocalFormDraftNotice } from '@shared/ui';
import type { ServiceFormValues, WarrantyClaimPreset } from './serviceRequestSubmit';

export function useServiceRequestDraft({
  form,
  userId,
  open,
  request,
  claim,
}: {
  form: FormInstance<ServiceFormValues>;
  userId: string | null;
  open: boolean;
  request: ServiceRequestDto | null;
  claim?: WarrantyClaimPreset | null;
}) {
  const restored = useRef(false);
  const draft = useLocalFormDraft({
    userId,
    form: 'service-request',
    read: () => form.getFieldsValue(true) as Record<string, unknown>,
    parse: objectDraftPayload,
  });
  const { begin } = draft;
  const target = claim ? `claim:${claim.equipmentId}:${claim.itemId ?? 'supplier'}` : 'create';
  useEffect(() => {
    if (!open) {
      restored.current = false;
      return;
    }
    if (!request) begin(target);
  }, [open, request, target, begin]);

  const notice = !request ? (
    <>
      <FormDraftAutosave active={open && !!draft.active} form={form} onSave={draft.persist} />
      <LocalFormDraftNotice
        active={!!draft.active}
        pending={draft.pending}
        status={draft.status}
        fileNotice
        createMayHaveSucceeded
        onRestore={(candidate) => {
          restored.current = true;
          form.resetFields();
          // An unfinished form may still lack required submit-time fields.
          form.setFieldsValue(draft.restore(candidate) as unknown as ServiceFormValues);
        }}
        onDiscard={draft.discardPending}
      />
    </>
  ) : null;

  return { draft, notice, restored };
}
