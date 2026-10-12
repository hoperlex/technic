import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceEstimateExemptionDeclaration, ServiceRequestDto } from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { useEstimateFailure } from './conflict';
import {
  breakdownBody,
  documentSubmitBody,
  estimateNeedsSave,
  estimateSaveBody,
  itemsSubmitBody,
  warrantySubmitBody,
  type EstimateFormValues,
} from './estimateForm';
import type { EstimateDocumentFile } from './useEstimatePresentation';

/**
 * The window's four commands: the save-and-submit chain of rows, the warranty repair, the
 * submission by invoice and the coordinator's breakdown.
 *
 * Every command reads the composition AT SEND TIME (`composition`), not from a value captured at
 * render: what leaves is what the person sees when pressing. The request version is the window
 * session's snapshot (stage 5 plan §4.5) and moves only by this window's own answers
 * (`accept`), so a submission right after a draft save does not get 409 for our own change.
 */
export function useEstimateCommands({
  request,
  version,
  accept,
  composition,
  markSent,
  files,
  exemption,
  exemptionBody,
  directDocument,
  workDone,
  onClose,
  onDocumentSubmitted,
}: {
  request: ServiceRequestDto | null;
  version: number;
  accept: (version: number) => void;
  composition: () => EstimateFormValues;
  /** Called as a draft save leaves: the rows sent then may be refilled from our own answer. */
  markSent: () => void;
  files: readonly EstimateDocumentFile[];
  /** Whether a declaration rides along: only the wording of the success message depends on it. */
  exemption: boolean;
  exemptionBody: () => ServiceEstimateExemptionDeclaration | undefined;
  directDocument: boolean;
  workDone: boolean;
  onClose: () => void;
  onDocumentSubmitted?: (request: ServiceRequestDto) => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const failed = useEstimateFailure(request?.id ?? null);
  // The server decides whether the declaration is applied; this message only confirms its input.
  const submittedMessage = () =>
    exemption
      ? 'Объём работ предъявлен вместе с заявлением об освобождении от подписи'
      : 'Объём работ предъявлен на согласование';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
    void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
  };

  /**
   * Save and submit are one chain, not two buttons with the same body: only what lies on the
   * server can be submitted, and "save, then send" by hand would mean a revision diverging from
   * the executor's screen.
   */
  const saveMutation = useMutation({
    mutationFn: async (submit: boolean) => {
      const { rows, mode, comment } = composition();
      let current = version;
      markSent();
      if (estimateNeedsSave(rows, mode, request!.items)) {
        const stored = await serviceRequestsApi.saveEstimate(
          request!.id,
          estimateSaveBody(rows, mode, current),
        );
        current = stored.version;
      }
      if (!submit) return { version: current, submitted: false };
      const sent = await serviceRequestsApi.submitEstimate(
        request!.id,
        itemsSubmitBody({ exemption: exemptionBody(), comment, version: current }),
      );
      return { version: sent.version, submitted: true };
    },
    onSuccess: (result) => {
      accept(result.version);
      refresh();
      if (result.submitted) {
        // Not "sent": the request went nowhere — it stays "В работе" and waits for a signature (R8).
        message.success(submittedMessage());
        onClose();
      } else {
        message.success('Объём работ сохранён');
      }
    },
    // 409 is an ordinary answer here: the request moved while the composition was typed. Its second
    // cause is a submission left hanging from another screen: the lock disables the buttons, but
    // someone else's action fits between opening the window and pressing, and the server explains it.
    onError: failed,
  });

  /** The warranty repair (R27): the scope of work is a zero service row the server assembles. */
  const warrantyMutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.submitEstimate(
        request!.id,
        warrantySubmitBody({ comment: composition().comment, version }),
      ),
    onSuccess: () => {
      message.success('Гарантийный ремонт предъявлен без оплаты');
      refresh();
      onClose();
    },
    onError: failed,
  });

  /**
   * THE SUBMISSION BY INVOICE (R2): a command of its own, not the same one with a flag. Its
   * revision has another format and carries pages of the document instead of rows.
   *
   * THE COMPOSITION IS NOT SAVED BEFORE IT, unlike the rows chain: the typed rows are hidden by the
   * checkbox and do not pass into the document revision, and saving them now would leave a draft
   * the person does not see on screen.
   */
  const documentMutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.submitEstimate(
        request!.id,
        documentSubmitBody({
          fileIds: files.map((file) => file.id),
          exemption: exemptionBody(),
          comment: composition().comment,
          version,
        }),
      ),
    onSuccess: (result) => {
      accept(result.version);
      refresh();
      const automaticallyApproved =
        result.approval?.revision === result.estimateRevision && result.approval.source === 'auto';
      message.success(
        workDone && automaticallyApproved
          ? 'Работы отмечены выполненными, документ согласован автоматически'
          : directDocument
            ? 'Документ выполненных работ передан на согласование'
            : submittedMessage(),
      );
      if (onDocumentSubmitted) onDocumentSubmitted(result);
      else onClose();
    },
    onError: failed,
  });

  /**
   * The breakdown by columns (R2): a door of its own, not the same one with a flag. The
   * coordinator has neither `estimate` nor `submit` nor `reopen` — no "save, then submit" chain to
   * build — and the route itself does everything the agreed revision needs. Hence one action and
   * one button.
   */
  const breakdownMutation = useMutation({
    mutationFn: () => {
      const { rows, mode } = composition();
      return serviceRequestsApi.saveEstimateBreakdown(
        request!.id,
        breakdownBody(rows, mode, version),
      );
    },
    onSuccess: (result) => {
      accept(result.version);
      refresh();
      message.success('Объём работ разложен по графам');
      onClose();
    },
    // 409 — a submission is pending, 422 — the request is not "В работе": the server explains both
    // in words, and the portal does not guess them (the lock disables the button only by what the
    // card shows).
    onError: failed,
  });

  return {
    pending:
      saveMutation.isPending ||
      warrantyMutation.isPending ||
      breakdownMutation.isPending ||
      documentMutation.isPending,
    saving: saveMutation.isPending,
    warrantyPending: warrantyMutation.isPending,
    breakdownPending: breakdownMutation.isPending,
    documentPending: documentMutation.isPending,
    /** The rows chain: a draft (`submit = false`) or the save followed by the submission. */
    save: (submit: boolean) => saveMutation.mutate(submit),
    submitDocument: () => documentMutation.mutate(),
    runWarranty: () => warrantyMutation.mutate(),
    runBreakdown: () => breakdownMutation.mutate(),
  };
}
