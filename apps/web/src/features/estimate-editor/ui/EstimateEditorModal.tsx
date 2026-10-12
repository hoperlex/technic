import { useEffect, useState } from 'react';
import { Form, Input, Typography } from 'antd';
import {
  canCoordinateServiceRequests,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { StaleRecordNotice, ViewModal } from '@shared/ui';
import { useEstimateEditor, type EstimateEditorIntent } from '../model/useEstimateEditor';
import { EstimateComposition } from './EstimateComposition';
import { EstimateDocumentFiles, EstimateDocumentSwitch } from './EstimateDocumentMode';
import {
  estimateEditorModalTitle,
  WorkCompletedActStep,
  WorkDoneNotice,
} from './EstimateDocumentWorkflow';
import { EstimateEditorFooter } from './EstimateEditorFooter';
import { EstimateEditorHint } from './EstimateEditorHint';
import { EstimateExemption } from './EstimateExemption';

/**
 * Presents four doors over one revision model: legacy item editing, coordinator breakdown,
 * direct document submission, and completed work with automatic approval. The model hook owns
 * commands and revision locks; this component only selects the visible workflow. A pending
 * revision locks every door because an approver must sign exactly what was presented.
 *
 * The form is rendered WITHOUT a `<form>` element (`component={false}`). The window never sent
 * anything on Enter, and a `<form>` would start doing it where a single one-line input is left —
 * the price of the free record: the browser's implicit submission fires there. The buttons stay
 * the only way out; the flash class of `useFormBlockers` goes on the body's wrapper instead.
 *
 * The form wraps the whole modal, not its body: the editor reads the store on every render, and
 * the instance must be connected to a mounted `Form` while the window is closed as well (antd warns
 * about a detached instance otherwise). The context reaches the body through the modal's portal.
 */
export function EstimateEditorModal({
  request,
  intent = 'estimate',
  actionRow,
  assignment,
  onClose,
}: {
  /**
   * `null` — the window is closed. It opens in "В работе": before it a scope of work has nowhere to
   * come from, and after the works are closed it is not edited any more.
   */
  request: ServiceRequestDto | null;
  /**
   * The caller names the workflow door: legacy rows, coordinator breakdown, direct document, or
   * completed work with automatic approval. The legacy default preserves direct test callers.
   */
  intent?: EstimateEditorIntent;
  /**
   * The card as the contracts' predicates see it and the assignment flags — READY FROM THE CALLER
   * (R3): the only such translation lives on the pages layer (`serviceActionRow`,
   * `serviceExecutorAssignment`), and a second one built by the window would silently diverge from
   * it. Not passed — no exemption checkbox: shown to the wrong person, it would promise a money
   * decision that stands on a 403.
   */
  actionRow?: ServiceActionRequest;
  assignment?: ServiceExecutorAssignment;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const breakdown = intent === 'breakdown';
  const directDocument = intent === 'document' || intent === 'work_done';
  const workDone = intent === 'work_done';
  const [submittedRequest, setSubmittedRequest] = useState<ServiceRequestDto | null>(null);
  useEffect(() => setSubmittedRequest(null), [request?.id, intent]);
  const editor = useEstimateEditor({
    request,
    intent,
    actionRow,
    assignment,
    onClose,
    onDocumentSubmitted: workDone ? setSubmittedRequest : undefined,
  });
  /*
   * Who gets the explanations (R11): the caller computes it, not `ServiceHint` — the entity layer
   * does not see `AuthContext`, and the rule lives as the one contracts function.
   */
  const coordinator = canCoordinateServiceRequests(user);
  const warrantyMode = !!request?.warrantyClaim && !breakdown;
  const { locked, mode, rows, issue, pending } = editor;
  const { className: blockersClass, ...blockersHandlers } = editor.blockers;
  /*
   * THE SUBMISSION BY INVOICE REMOVES THE FIELDS FROM THE SCREEN, IT DOES NOT DISABLE THEM (R10).
   * The window already has a real disabled state — the lock of a pending submission — and it means
   * something else: "take the submission back first". Two states looking alike would send the
   * person looking for a button that does not exist.
   */
  const documentOn = editor.documentOn;
  /*
   * What stands in the way of sending RIGHT NOW: the invoice asks for one document, the rows for a
   * complete composition. One line under the buttons, because the question is one. A press marks
   * the fields themselves (ADR 0094); the line stays as the summary visible before any press.
   */
  const problem = documentOn ? editor.documentIssue : issue;

  /*
   * One button for two formats, because the action is one — "submit": what differs is what rides
   * in the body (rows or invoice pages, R2). A second button next to it would ask for the format
   * twice — by the checkbox and by the press.
   */
  const present = () => {
    if (documentOn) editor.submitDocument();
    else void editor.submit(false);
  };

  if (submittedRequest) {
    return <WorkCompletedActStep request={submittedRequest} onClose={onClose} />;
  }

  return (
    <Form form={editor.form} component={false} {...blockersHandlers}>
      <ViewModal
        title={estimateEditorModalTitle(request, intent)}
        open={!!request}
        onClose={onClose}
        width={860}
        destroyOnHidden
        footer={
          <EstimateEditorFooter
            breakdown={breakdown}
            warrantyMode={warrantyMode}
            documentOn={documentOn}
            workDone={workDone}
            directDocument={directDocument}
            locked={locked}
            filled={editor.filled}
            pending={pending}
            saving={editor.saving}
            warrantyPending={editor.warrantyPending}
            breakdownPending={editor.breakdownPending}
            documentPending={editor.documentPending}
            documentIssue={editor.documentIssue}
            onBreakdown={() => void editor.runBreakdown()}
            onWarranty={editor.runWarranty}
            onDraft={() => void editor.submit(true)}
            onPresent={present}
          />
        }
      >
        {request && (
          <div
            className={blockersClass}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <StaleRecordNotice session={editor.staleRecord} />
            <EstimateEditorHint
              request={request}
              coordinator={coordinator}
              locked={locked}
              breakdown={breakdown}
              directDocument={directDocument}
              workDone={workDone}
              warrantyMode={warrantyMode}
            />

            {/* The submission method is decided BEFORE typing, so the checkbox stands above the
                switch: placed after, it would remove from the screen what has just been typed.
                With the feature switch off the method is not shown at all (§7): a button leading
                to 422 is worse than none. */}
            {!directDocument && editor.documentOffered && (
              <EstimateDocumentSwitch
                checked={documentOn}
                allowed={editor.documentFits}
                disabled={locked}
                onChange={editor.switchDocumentMode}
              />
            )}

            {documentOn ? (
              <EstimateDocumentFiles
                files={editor.files}
                uploading={editor.uploading}
                disabled={locked}
                onUpload={editor.addFile}
                onRemove={editor.removeFile}
              />
            ) : (
              <EstimateComposition
                mode={mode}
                rows={rows}
                total={editor.total}
                disabled={locked}
                onSwitchMode={editor.switchMode}
              />
            )}

            {/* The comment leaves WITH THE SUBMISSION, so the breakdown has none: the coordinator
                submits nothing in their own words — the route itself sets the submission, and a
                field whose text goes nowhere would promise something never said. */}
            {!breakdown && (
              <Form.Item name="comment" noStyle>
                <Input.TextArea
                  rows={2}
                  maxLength={1000}
                  disabled={locked}
                  placeholder={
                    directDocument
                      ? 'Комментарий к выполненным работам'
                      : 'Комментарий к объёму работ: что нашли при диагностике'
                  }
                />
              </Form.Item>
            )}
            {/* The exemption checkbox is visible in BOTH formats: "rows plus exemption" is a
                lawful combination and the main case of the review (R2), not an appendix to the
                invoice. The feature switch is not in the condition on purpose (§7): it turns off
                the OUTCOME, not the command — with it off the declaration passes and is recorded
                as "observed". A hidden checkbox would kill the observation mode, so the switch
                goes into the text next to it, not into the condition. */}
            {workDone && <WorkDoneNotice />}
            {!workDone && editor.exemptionOffered && (
              <EstimateExemption
                checked={editor.exemption}
                note={editor.exemptionNote}
                applies={editor.exemptionApplies}
                disabled={locked}
                onChange={editor.setExemption}
                onNote={editor.setExemptionNote}
              />
            )}
            {problem && <Typography.Text type="warning">{problem}</Typography.Text>}
          </div>
        )}
      </ViewModal>
    </Form>
  );
}
