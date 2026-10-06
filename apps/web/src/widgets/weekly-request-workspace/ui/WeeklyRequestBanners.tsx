import { Alert, Button, Space } from 'antd';
import type { WeeklyItemCounts, WeeklyVehicleRequestDto } from '@technic/contracts';
import { formatDateOnly, formatDateTime } from '@shared/lib';
import { weeklyOverdueWord } from '@entities/weekly-request';
import { WEEKLY_RETURN_OVERDUE_NOTE } from '../model/reversalTexts';

/**
 * Weekly request states in words (section 9). Each is easy to reduce to a faceless notice, and then
 * the person does not know what to do: "the week has started" without an offered way out leaves the
 * draft at a dead end, and "apply failed" without per-row reasons makes them reconcile the list
 * with the table by eye.
 *
 * An overdue week now has two different states, separated not by the right to a button but by the
 * answer to "what do I do with this" (ADR 0101). For a holder of the past right the week is open
 * and the banner names the conduct price. For others the week stays closed, but it is no longer a
 * dead end: there is a way out, and it is calling someone who will conduct it.
 */

/** No past right: the way out is calling someone who has it, not only cancelling. */
const NO_RIGHT_HINT =
  'Провести неделю задним числом может тот, у кого есть право коррекции, — диспетчер или ' +
  'администратор. Если техника действительно отработала эти дни, попросите его подать и провести ' +
  'заявку: сроки продлятся, а на прошедшие недели выпишутся листы ЭСМ-2. Если не отработала — ' +
  'снимите заявку и заведите её на следующую неделю.';

/**
 * The right exists but the depth is short: beyond 30 days it is the administrator's job (ADR 0101
 * R37).
 */
const DEPTH_HINT =
  'Такую давность проводит администратор: попросите его завизировать заявку — сроки продлятся, а ' +
  'на прошедшие недели выпишутся листы ЭСМ-2. Либо снимите её и заведите неделю заново.';

interface Props {
  request: WeeklyVehicleRequestDto;
  /** The approver's rejection reason, shown on top of the request itself, not only in history. */
  rejection: string | null;
  /** The return for re-approval that reopened the week (ADR 0219); null while there is none. */
  returned: { by: string; at: string; reason: string } | null;
  /** Why this account cannot submit for this week; null means the week is open to it. */
  weekBlocker: string | null;
  /** The week has started or passed (isWeeklyWeekOverdue). */
  overdue: boolean;
  /** Whether the account has the past right (waybills.correct): it tells the two refusals apart. */
  canPast: boolean;
  /** Effective conduct date, the Sunday of the week (weeklyWeekEffectiveDate). */
  effectiveDate: string;
  /** The composition is still edited (draft/pending) and the account may edit it. */
  editable: boolean;
  composable: boolean;
  /** The request awaits approval: conduct is asked at approval, not at submission. */
  isPending: boolean;
  /** Whole-apply refusal ('no row is applicable' with reasons); null means there was none. */
  applyError: string | null;
  counts: WeeklyItemCounts;
  /** Vehicles without a decision: they will not enter the composition. */
  undecided: number;
  onCancel: () => void;
  /** Create the next week's request; null when the account may not. */
  onNextWeek: (() => void) | null;
  nextWeekPending: boolean;
}

export function WeeklyRequestBanners(props: Props) {
  const { request, counts, composable } = props;
  const total = counts.extend + counts.new + counts.leave;
  const allLeaving = total > 0 && counts.extend === 0 && counts.new === 0;

  // The banner stack keeps its own spacing: outside it is one block, and inserting it into the
  // flow as separate elements would hand the layout to the caller.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {request.status === 'draft' && props.rejection && (
        <Alert
          type="error"
          showIcon
          title="Заявка отклонена и возвращена в черновик"
          description={props.rejection}
        />
      )}
      {request.status === 'pending' && props.returned && (
        <Alert
          type="warning"
          showIcon
          title={`Неделя возвращена на согласование — ${props.returned.by}, ${formatDateTime(props.returned.at)}`}
          description={
            <>
              {props.returned.reason}
              <br />
              Сроки и порождённые заказы развёрнуты.{' '}
              {props.overdue
                ? WEEKLY_RETURN_OVERDUE_NOTE
                : 'Дополните состав — руководитель строительства завизирует неделю заново.'}
            </>
          }
        />
      )}
      {request.status === 'cancelled' && (
        <Alert type="warning" showIcon title={`Заявка снята: ${request.cancelReason}`} />
      )}
      {/* An annulled request gets its own banner rather than the cancelled one: a cancelled week
          never had consequences, while here the approval existed and was rolled back. The
          composition below stays readable — it is what explains exactly what was undone
          (ADR 0218). */}
      {request.status === 'annulled' && (
        <Alert
          type="warning"
          showIcon
          title={`Заявка аннулирована: ${request.annulReason}`}
          description={
            request.annulledAt
              ? `${formatDateTime(request.annulledAt)}${request.annulledByName ? `, ${request.annulledByName}` : ''}. Сроки заказов возвращены, порождённые заказы отменены — что именно развернули, видно в составе и в истории`
              : 'Сроки заказов возвращены, порождённые заказы отменены — что именно развернули, видно в составе и в истории'
          }
        />
      )}
      {/* The draft outlived its week and the past is closed to the reader (no right at all, or not
          enough depth): submitting and approving are impossible, cancelling always possible
          (section 8). A 422 from the API alone is not enough: it explains the refusal, not the way
          out, and the way out now exists and is not only cancelling. */}
      {props.weekBlocker && (
        <Alert
          type="error"
          showIcon
          title={props.weekBlocker}
          description={
            <>
              {/* Two refusals, not one, and they call different people. No past right at all: call
                  the dispatcher. The right exists but depth is short: the reader is the dispatcher,
                  and the one to call has no limit (ADR 0101 R37). */}
              {props.overdue && <div>{props.canPast ? DEPTH_HINT : NO_RIGHT_HINT}</div>}
              <Space size={8} wrap style={{ marginTop: 8 }}>
                {props.editable && (
                  <Button danger onClick={props.onCancel}>
                    Отменить заявку
                  </Button>
                )}
                {/* The composition is not carried over: next week's request is created with a
                    recomputed suggestion, since part of the equipment left during the overdue week
                    anyway (section 9). */}
                {props.onNextWeek && (
                  <Button loading={props.nextWeekPending} onClick={props.onNextWeek}>
                    Создать на следующую неделю
                  </Button>
                )}
              </Space>
            </>
          }
        />
      )}
      {/* The week is overdue but open to the reader by the past right: not a refusal but a price.
          The action stays in the bottom bar: it is one per screen, and a second identical button in
          the banner would make people guess how they differ. The banner answers another question:
          what it will cost. */}
      {!props.weekBlocker && props.overdue && composable && (
        <Alert
          type="warning"
          showIcon
          title={`Неделя ${request.weekLabel} уже ${weeklyOverdueWord(request.weekStart)} — виза по ней станет операцией задним числом`}
          description={
            <>
              <div>
                Сроки заказов продлятся за уже отработанные дни, за прошедшие недели выпишутся листы
                ЭСМ-2, а причина операции и ваше имя останутся в журнале коррекций. Эффективная дата
                операции — воскресенье недели, {formatDateOnly(props.effectiveDate)}.
              </div>
              <div>
                {props.isPending
                  ? 'Нажмите «Провести задним числом» — окно спросит причину и покажет, какие номера бланков сгорят.'
                  : 'Подайте заявку: причину, листы к перевыписке и цену операции спросят на визе — заведение и подача о прошлом ничего не утверждают.'}
              </div>
            </>
          }
        />
      )}
      {props.applyError && (
        <Alert
          type="error"
          showIcon
          title="Применение не прошло — неделя осталась там, где была"
          description={
            <>
              <div>{props.applyError}</div>
              <div>Строки, которые больше не годятся, помечены причиной прямо в составе.</div>
            </>
          }
        />
      )}
      {composable && total === 0 && (
        <Alert
          type="warning"
          showIcon
          title="Решение не принято ни по одной единице"
          description="Недельная заявка отвечает на вопрос, что делать с каждой машиной: отметьте, что остаётся и что уезжает, либо закажите технику дополнительно."
        />
      )}
      {composable && allLeaving && (
        <Alert
          type="info"
          showIcon
          title="Вся техника уезжает — на неделе на площадке не останется ничего"
        />
      )}
      {composable && props.undecided > 0 && (
        <Alert
          type="info"
          showIcon
          title={`Решение не принято по ${props.undecided} ед. — в состав они не войдут`}
        />
      )}
    </div>
  );
}
