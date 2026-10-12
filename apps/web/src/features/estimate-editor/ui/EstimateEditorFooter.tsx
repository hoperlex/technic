import { Button, Tooltip } from 'antd';

/**
 * The window's buttons. Their set depends on the door: the breakdown has its own footer, the
 * submission by invoice a shorter one, and the warranty button exists only on a warranty request.
 */
export function EstimateEditorFooter({
  breakdown,
  warrantyMode,
  documentOn,
  workDone,
  directDocument,
  locked,
  filled,
  pending,
  saving,
  warrantyPending,
  breakdownPending,
  documentPending,
  documentIssue,
  onBreakdown,
  onWarranty,
  onDraft,
  onPresent,
}: {
  breakdown: boolean;
  warrantyMode: boolean;
  documentOn: boolean;
  workDone: boolean;
  directDocument: boolean;
  locked: boolean;
  /** Something will be sent: counted by the rows that leave, not by the rows in the window. */
  filled: boolean;
  pending: boolean;
  saving: boolean;
  warrantyPending: boolean;
  breakdownPending: boolean;
  documentPending: boolean;
  documentIssue: string | null;
  onBreakdown: () => void;
  onWarranty: () => void;
  onDraft: () => void;
  onPresent: () => void;
}) {
  /*
   * The breakdown has ITS OWN footer, not the common one with disabled buttons: the coordinator has
   * neither a draft nor a submission — no rights to them at all — and disabled buttons would
   * promise actions that do not exist behind this door.
   */
  if (breakdown) {
    return (
      <Button type="primary" loading={breakdownPending} disabled={locked} onClick={onBreakdown}>
        Разложить по графам
      </Button>
    );
  }
  return (
    <>
      {/*
       * THE SUBMISSION BY INVOICE HAS A SHORTER FOOTER, AND BOTH MISSING BUTTONS ARE MISSING FOR A
       * REASON (R10). It has no draft: there is nothing to save — the invoice is already in storage,
       * and the mode types no rows that would become a draft, so the press would carry away the
       * hidden composition the person does not see. The warranty repair is the third revision
       * format, not combinable with a document by the type of the body: offered next to the
       * checkbox, it would promise a choice that does not exist.
       */}
      {warrantyMode && !documentOn && (
        <Tooltip
          title={
            locked
              ? 'Объём работ уже предъявлен: пока идёт согласование, предъявить заново нельзя'
              : filled
                ? 'Уберите строки: гарантийный ремонт предъявляется без оплаты'
                : 'Работы по гарантии: заявка уйдёт на согласование с нулевой суммой'
          }
        >
          <span>
            <Button
              disabled={locked || filled || pending}
              loading={warrantyPending}
              onClick={onWarranty}
            >
              Гарантийный ремонт без оплаты
            </Button>
          </span>
        </Tooltip>
      )}
      {!documentOn && (
        <Button disabled={locked || pending} onClick={onDraft}>
          Сохранить черновик
        </Button>
      )}
      {/*
       * Without a single page the button is LOCKED rather than answering the press, unlike the gaps
       * of the composition. There is nothing to fill in here by eye: the empty list of attached
       * pages is visible right there, and the reason is named by the line under the button. Such a
       * body cannot be sent by the schema either (`fileIds` at least one) — the button would lead
       * to a 400.
       */}
      <Tooltip title={documentOn ? documentIssue : null}>
        <span>
          <Button
            type="primary"
            loading={saving || documentPending}
            disabled={locked || warrantyPending || (documentOn && !!documentIssue)}
            onClick={onPresent}
          >
            {workDone
              ? 'Работы выполнены'
              : directDocument
                ? 'Передать документ на согласование'
                : 'Предъявить на согласование'}
          </Button>
        </span>
      </Tooltip>
    </>
  );
}
