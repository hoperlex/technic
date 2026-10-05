import { Alert, Space, Typography } from 'antd';
import type {
  VehicleRequestCompletionDto,
  VehicleRequestStatusPreviewDto,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';

/**
 * Second step of the assignment dialog on the "done" -> "in work" rollback: what happens after the
 * return.
 *
 * Separate from the dialog because it is another screen, not part of the form: it shares no value
 * with it — it only reads the server answer and asks nothing. In the dialog it always stood apart
 * (the form is hidden entirely at this step) while weighing sixty lines of plain text between the
 * vehicle selection fields.
 */

/**
 * Everything is computed by the server with the same reconciliation that will then run (§5.4 of the
 * plan) — "term weeks minus issued ones" would promise forms for past weeks that reconciliation
 * will not issue.
 *
 * Not a word about the past here, and not by forgetfulness: closing releases the mode snapshot, and
 * a linear order may have been closed without a single planned day — then there is nothing to guess
 * how it was run by. The portal says only what it knows for sure: how the order continues, what
 * ESM-2 reconciliation will do and how vehicle occupancy will be counted.
 */
interface Props {
  preview: VehicleRequestStatusPreviewDto;
  /**
   * Closing snapshot of the returned request (R23, ADR 0178): how it was closed and what the term
   * was before. The dialog names the shortening in numbers by it — "was until the 16th, now until
   * the 12th" — not by a general caveat. `null` — the request was not closed by an actual date
   * (freight, a lessor, a closing before that wave), and nothing was shortened.
   */
  fact: VehicleRequestCompletionDto | null;
}

export function RollbackPreview({ preview, fact }: Props) {
  const { issue, cancel } = preview.esm2;
  /*
   * The term was shortened — so there is something to warn about in concrete numbers. The date pair
   * comes from the closing snapshot, not computed by the portal: after the first term edit the
   * difference of neighbouring request fields cannot be recovered, which is why the snapshot
   * exists.
   */
  const shortened =
    fact?.endedOn && fact.previousDateTo && fact.endedOn < fact.previousDateTo
      ? { endedOn: fact.endedOn, previousDateTo: fact.previousDateTo }
      : null;
  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      <Alert
        type="info"
        showIcon
        title={preview.mode === 'daily' ? 'Заказ пойдёт по дням' : 'Заказ пойдёт по неделям'}
        description={
          preview.mode === 'daily'
            ? 'Работа планируется днями: на каждый день заводится рейс и печатается 4-П, а недельные листы ЭСМ-2 портал сам не выписывает — их просят по требованию.'
            : 'Работа ведётся неделями: на каждую неделю срока портал выписывает свой ЭСМ-2, дни заявке не планируются.'
        }
      />
      <div>
        <Typography.Text strong>Путевые листы ЭСМ-2</Typography.Text>
        {issue.length === 0 && cancel.length === 0 ? (
          <div>
            <Typography.Text type="secondary">
              Останутся как есть: выписывать и аннулировать нечего.
            </Typography.Text>
          </div>
        ) : (
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
            {issue.map((p) => (
              <li key={`issue-${p.from}`}>
                Выпишется лист за {formatDateOnly(p.from)} — {formatDateOnly(p.to)}
              </li>
            ))}
            {cancel.map((w) => (
              <li key={w.id}>
                Аннулируется {w.number} ({formatDateOnly(w.from)} — {formatDateOnly(w.to)})
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* The return does not restore the term (R14 of
        `docs/vehicle-request-actual-end-date-plan.md`, the customer's decision on V2). A request
        closed by an actual date went to "done" with a shortened term and a shortened form;
        returning it to work cancels the status, not the shortening. It must be said before the
        click: someone returning a request "to work two more days" would otherwise find the old
        shortened term afterwards and decide the portal lost the edit. The previous-term snapshot
        stays in history as an explanation, not an undo button. */}
      {shortened && (
        <Alert
          type="info"
          showIcon
          title={`Срок останется сокращённым — по ${formatDateOnly(shortened.endedOn)}`}
          description={`Заказ закрывали фактической датой: срок был по ${formatDateOnly(shortened.previousDateTo)}, стал по ${formatDateOnly(shortened.endedOn)}. Возврат в работу отменяет закрытие, но не сокращение — заявка вернётся с укороченным сроком и укороченным листом. Нужны ещё дни: продлите срок отдельно, и продление выпишет новый лист ЭСМ-2.`}
        />
      )}
      <div>
        <Typography.Text strong>Занятость машины</Typography.Text>
        <div>
          <Typography.Text type="secondary">
            {preview.busy === 'term'
              ? 'Машина будет занята весь срок заявки — в гараже она встанет занятой с первого дня по последний.'
              : 'Машина будет занята только в распланированные дни — в остальные её можно поставить на другой заказ.'}
          </Typography.Text>
        </div>
      </div>
    </Space>
  );
}
