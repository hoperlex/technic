import type { ReactNode } from 'react';
import { Alert } from 'antd';
import { ReasonModal } from '@shared/ui';

interface CancelProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  confirmLoading?: boolean;
  /** Caption above the field: which request is being cancelled. */
  subject?: string;
}

/**
 * Cancelling a request: the reason is mandatory (the server demands it too) and goes into the
 * status history.
 */
export function CancelReasonModal({ subject, ...rest }: CancelProps) {
  return (
    <ReasonModal
      {...rest}
      title="Отмена заявки"
      label={subject ? `Причина отмены заявки ${subject}` : 'Причина отмены'}
      okText="Отменить заявку"
      cancelText="Не отменять"
    />
  );
}

interface RollbackProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  confirmLoading?: boolean;
  /** Caption above the field: which request is being returned. */
  subject?: string;
  /**
   * What the return erases from this very request — as lines built from its own data. The calling
   * screen assembles the list: a waste removal request loses one thing (the fact and the tickets),
   * a mechanization request another (the deal), and promising to remove what the request does not
   * have is not allowed — one shared list for every module would lie to half of the requests.
   *
   * Not asked when the consequences come as a ready notice (`consequences`).
   */
  erases?: string[];
  /**
   * A ready notice of consequences instead of the list of lines.
   *
   * Introduced for the vehicle order, whose list the server computes (ADR 0211): there it is not
   * only "will be erased" but also "stays because a waybill holds it", the wait for the answer, the
   * blockers and a failed preview — and this dialog knows nothing about the request and must not
   * sort those states out. Waste removal and mechanization still pass lines: their rule is their
   * own and lives wholly in the portal.
   *
   * The former `blocker` prop went with the vehicle order's own list: its blocker now arrives in
   * the server's answer, inside this notice.
   */
  consequences?: ReactNode;
}

/**
 * Returning a request from "in work" to "new" (`transitionResetsWork`). It differs from a
 * cancellation not by captions but by erasing what the request gained in work — so the list of
 * what is erased stands above the reason field, before the click: after it there is nothing left
 * to restore.
 *
 * The dialog is the same one as the cancellation's: the reason is mandatory in both and leaves with
 * the same status-change request. A second dialog with a "Reason" field would differ from the first
 * only by its title — and would drift away from it with every edit.
 */
export function RollbackReasonModal({
  subject,
  erases = [],
  consequences,
  ...rest
}: RollbackProps) {
  return (
    <ReasonModal
      {...rest}
      title="Возврат заявки в «Новую»"
      label={subject ? `Причина возврата заявки ${subject}` : 'Причина возврата'}
      okText="Вернуть в «Новую»"
      cancelText="Не возвращать"
      danger
      notice={
        consequences ?? (
          <Alert
            type="warning"
            showIcon
            title="Заявка вернётся в состояние только что заведённой"
            description={
              erases.length > 0 ? (
                <>
                  Будет стёрто:
                  <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                    {erases.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              ) : (
                // Nothing to erase is said so: an empty "will be erased" list reads as one that
                // failed to load, not as "the request gained no work".
                'Стирать у заявки нечего — сменится только статус.'
              )
            }
            style={{ marginBottom: 16 }}
          />
        )
      }
    />
  );
}
