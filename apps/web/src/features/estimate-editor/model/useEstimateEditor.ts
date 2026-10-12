import { useReducer, useRef } from 'react';
import { Form } from 'antd';
import {
  serviceEstimatePending,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import { useRecordSession } from '@shared/lib';
import { useFormBlockers } from '@shared/ui';
import { useEstimatePresentation } from './useEstimatePresentation';
import { useEstimateCommands } from './useEstimateCommands';
import { rowsForSave, rowsTotal, type EstimateMode, type EstimateRow } from './rows';
import { draftFieldsToCheck, estimateIssue, type EstimateFieldPath } from './estimateRules';
import { estimateFill, switchedRows, type EstimateFormValues } from './estimateForm';

/**
 * The entry intent selects both the presentation and the command semantics.
 *
 * `estimate` keeps the legacy row editor for existing flows and tests. `breakdown` lets the
 * coordinator reissue a document revision as item rows. `document` is the direct file flow with
 * normal approval, while `work_done` adds the service-company exemption and continues to the act.
 */
export type EstimateEditorIntent = 'estimate' | 'breakdown' | 'document' | 'work_done';

const NO_ROWS: EstimateRow[] = [];

/**
 * Everything the scope-of-work window lives by: the composition, its input mode, the request
 * version and the four ways out — a draft, a submission by rows, the warranty repair and the
 * submission by invoice.
 *
 * SEPARATE FROM THE MARKUP because the subjects differ: here — what happens to the composition and
 * where it goes; there — how it looks.
 *
 * THE COMPOSITION IS AN ANTD FORM (Q10, ADR 0094): the rows are a `Form.List`, every check is the
 * rule of the field at fault, and a refused press marks the fields, scrolls to the first and
 * flashes instead of a toast in the corner. The total is still counted on every keystroke from the
 * watched rows: the scope of work is a conversation about money, and the sum must be visible
 * before the press, not after it.
 *
 * THE REQUEST VERSION IS A SNAPSHOT OF THE WINDOW SESSION (stage 5 plan §4.5): taken when the
 * window fills, moved by this window's own answers — saving the composition raises it, and a
 * submission right after the save with the old version would get 409 out of nowhere (R30). A
 * reread of the card neither refills the window nor moves the version: an untouched window is
 * refilled silently, a changed one shows the notice, and "Reload" is the only way to drop the rows.
 */
export function useEstimateEditor({
  request,
  intent,
  actionRow,
  assignment,
  onClose,
  onDocumentSubmitted,
}: {
  /** `null` — the window is closed; the state lives on so the hook is not recreated on opening. */
  request: ServiceRequestDto | null;
  intent: EstimateEditorIntent;
  /**
   * The card as the contracts' predicates see it and the assignment flags — THE CALLER TRANSLATES,
   * not the window (R3 of `docs/office-equipment-on-site-and-invoice-estimate-plan.md`). There is
   * exactly one such translation in the portal (`serviceActionRow`/`serviceExecutorAssignment` on
   * the pages layer); a second one built by the window would silently diverge from it, and the
   * features layer cannot reach that one.
   *
   * OPTIONAL AND FAIL-CLOSED: not passed — no exemption checkbox at all. A wider checkbox stands
   * on a 403, and a money decision offered to the wrong person reads as a permission.
   */
  actionRow?: ServiceActionRequest;
  assignment?: ServiceExecutorAssignment;
  onClose: () => void;
  /** Keeps the modal open for a following workflow step, such as attaching the closing act. */
  onDocumentSubmitted?: (request: ServiceRequestDto) => void;
}) {
  const breakdown = intent === 'breakdown';
  const directDocument = intent === 'document' || intent === 'work_done';
  const workDone = intent === 'work_done';

  const [form] = Form.useForm<EstimateFormValues>();
  /*
   * THE WINDOW RE-RENDERS ON EVERY CHANGE OF THE STORE, IN THE SAME EVENT. `Form.useWatch` would
   * do it a macrotask later (the form batches its watchers through a `MessageChannel`), and the
   * total, the per-row amounts, the mode switch and the locks of the buttons would trail the
   * keystroke that changed them. The person's edits come through `onValuesChange`; the window's
   * own writes (`setFieldsValue` of a fill or a mode switch) call `rerender` themselves.
   */
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const blockers = useFormBlockers(form, { onValuesChange: () => rerender() });
  /** The composition in the store right now: what a command sends at the moment of the press. */
  const composition = (): EstimateFormValues => ({
    mode: form.getFieldValue('mode') ?? 'rows',
    rows: form.getFieldValue('rows') ?? NO_ROWS,
    comment: form.getFieldValue('comment') ?? '',
  });
  // The store holds every key of a row (`key`, `kind`), while only the visible ones are fields.
  const { rows, mode } = composition();
  /*
   * Rows and mode as the last fill left them. "Changed" is the IDENTITY of the stored rows array:
   * the store copies the array on every edit of a row, an addition, a removal and a mode switch,
   * so an untouched window is the one whose array is still the filled one — the same rule the
   * state-held window had, without a per-type comparison of values.
   */
  const filled = useRef<{ rows: EstimateRow[]; mode: EstimateMode } | null>(null);
  /** The rows array a draft save sent: unchanged since, it may be refilled from the answer. */
  const sentRows = useRef<EstimateRow[] | null>(null);

  /*
   * Both locks of R9 at once: editing the composition and submitting again are closed by one sign —
   * a pending submission. It is asked from the contracts, not inferred from the submission date: a
   * revoked one has `estimateSubmittedAt` set, and the window would lock forever.
   */
  const locked = !!request && serviceEstimatePending(request);

  /*
   * HOW THE REVISION IS SUBMITTED AND ON WHICH TERMS IS A HOOK OF ITS OWN (R2, R3, R10): the
   * submission method, the invoice pages and the exemption declaration. Here stays the COMPOSITION
   * and where it goes; there — what the revision is at all and whether a signature is collected.
   */
  const presentation = useEstimatePresentation({
    request,
    rows,
    breakdown,
    actionRow,
    assignment,
    forceDocument: directDocument,
    forceExemption: workDone,
  });

  const session = useRecordSession({
    open: !!request,
    id: request?.id ?? null,
    data: request ?? undefined,
    version: (r: ServiceRequestDto) => r.version,
    isDirty: () => {
      const now = composition();
      return (
        now.rows !== filled.current?.rows ||
        now.mode !== filled.current?.mode ||
        now.comment !== '' ||
        presentation.changed
      );
    },
    fill: (r, reason) => {
      const start = estimateFill(r.items, breakdown);
      // Our own draft came back: the rows are refilled only if not edited since they were sent; the
      // comment and the submission method are not part of a draft and stay as they are.
      if (reason === 'own') {
        if (form.getFieldValue('rows') !== sentRows.current) return;
        form.setFieldsValue(start);
      } else {
        // Reset first: validation marks belong to the previous fill.
        form.resetFields();
        form.setFieldsValue({ ...start, comment: '' });
        presentation.reset();
      }
      filled.current = { rows: form.getFieldValue('rows'), mode: start.mode };
      rerender();
    },
  });
  // Only behind an open window: every command below is sent after the session has filled.
  const commands = useEstimateCommands({
    request,
    version: session.version ?? 0,
    accept: session.accept,
    composition,
    markSent: () => {
      sentRows.current = form.getFieldValue('rows');
    },
    files: presentation.files,
    exemption: presentation.exemption,
    exemptionBody: presentation.exemptionBody,
    directDocument,
    workDone,
    onClose,
    onDocumentSubmitted,
  });

  /**
   * The rules of the named fields (every mounted field when omitted). A refusal goes the way of
   * `useFormBlockers`: the fields are marked, the screen moves to the first one and they flash.
   */
  const validated = (names?: EstimateFieldPath[]): Promise<boolean> =>
    form.validateFields(names as Parameters<typeof form.validateFields>[0]).then(
      () => true,
      (info: Parameters<NonNullable<typeof blockers.formProps.onFinishFailed>>[0]) => {
        if (info?.errorFields?.length) blockers.formProps.onFinishFailed?.(info);
        return false;
      },
    );

  return {
    form,
    blockers: blockers.formProps,
    /** Someone else's newer request over a changed window: the notice and its "Reload". */
    staleRecord: { stale: session.stale, reload: session.reload },
    rows,
    mode,
    /*
     * The submission method and the declaration go out as they are: the markup needs exactly the
     * signs they are computed from, and a copy renamed on the way would diverge at the first edit.
     */
    ...presentation,
    /** The first gap of the composition, for the line under the buttons. */
    issue: estimateIssue(rows, mode),
    /**
     * Whether anything is typed — by the rows THAT WILL LEAVE, not by the rows in the store. The
     * free mode always keeps its row, and untouched it means an empty scope of work; asked by
     * `rows.length`, the warranty button would go dark in a freshly opened window — exactly where
     * the warranty repair is submitted.
     */
    filled: rowsForSave(rows, mode).length > 0,
    total: rowsTotal(rows),
    locked,
    pending: commands.pending,
    saving: commands.saving,
    warrantyPending: commands.warrantyPending,
    breakdownPending: commands.breakdownPending,
    documentPending: commands.documentPending,
    /** A switch of the input mode rewrites the rows in the same step (`switchedRows`, R8). */
    switchMode: (next: EstimateMode) => {
      form.setFieldsValue({ mode: next, rows: switchedRows(composition().rows, next) });
      rerender();
    },
    /**
     * The composition leaves as a draft or with the submission. A submission asks every rule; a
     * draft leaves unfinished — that is a lawful unfinished set — except a started free record
     * without a price (`draftFieldsToCheck`, defect D1).
     */
    submit: async (asDraft: boolean) => {
      const { rows: now, mode: nowMode } = composition();
      if (await validated(asDraft ? draftFieldsToCheck(now, nowMode) : undefined)) {
        commands.save(!asDraft);
      }
    },
    /** The invoice: its only requirement (a page) locks the button, so nothing is validated here. */
    submitDocument: commands.submitDocument,
    runWarranty: commands.runWarranty,
    runBreakdown: async () => {
      if (await validated()) commands.runBreakdown();
    },
  };
}
