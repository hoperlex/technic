import { Alert, Button, Space } from 'antd';
import type { WeeklyItemCounts, WeeklyVehicleRequestDto } from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { weeklyOverdueWord } from '@entities/weekly-request';

/** Explain both the blocker and the recovery path for every non-routine weekly state. */

/** Without backdate authority, escalation to an operator remains an alternative to cancellation. */
const NO_RIGHT_HINT =
  'Провести неделю задним числом может тот, у кого есть право коррекции, — диспетчер или ' +
  'администратор. Если техника действительно отработала эти дни, попросите его подать и провести ' +
  'заявку: сроки продлятся, а на прошедшие недели выпишутся листы ЭСМ-2. Если не отработала — ' +
  'снимите заявку и заведите её на следующую неделю.';

/** Beyond the correction depth, an administrator must conduct the week (ADR 0101 R37). */
const DEPTH_HINT =
  'Такую давность проводит администратор: попросите его завизировать заявку — сроки продлятся, а ' +
  'на прошедшие недели выпишутся листы ЭСМ-2. Либо снимите её и заведите неделю заново.';

interface Props {
  request: WeeklyVehicleRequestDto;
  /** The rejection reason remains visible in the document, not only in history. */
  rejection: string | null;
  /** Why this account cannot submit the week; `null` means it is open. */
  weekBlocker: string | null;
  /** The week has started or elapsed. */
  overdue: boolean;
  /** Whether this account has ordinary backdate authority. */
  canPast: boolean;
  /** Conduct's effective date, the target week's Sunday. */
  effectiveDate: string;
  /** Composition is still editable and this account may update it. */
  editable: boolean;
  composable: boolean;
  /** Conduct is requested during approval, not submission. */
  isPending: boolean;
  /** Whole-application failure with its server explanation. */
  applyError: string | null;
  counts: WeeklyItemCounts;
  /** Orders without a decision are intentionally omitted from the command. */
  undecided: number;
  onCancel: () => void;
  /** Create the next week's request; `null` when unavailable. */
  onNextWeek: (() => void) | null;
  nextWeekPending: boolean;
}

export function WeeklyRequestBanners(props: Props) {
  const { request, counts, composable } = props;
  const total = counts.extend + counts.new + counts.leave;
  const allLeaving = total > 0 && counts.extend === 0 && counts.new === 0;

  // The banner stack owns its spacing so callers compose it as one stable block.
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
      {request.status === 'cancelled' && (
        <Alert type="warning" showIcon title={`Заявка снята: ${request.cancelReason}`} />
      )}
      {/* An overdue draft remains cancellable and names who can conduct it; a 422 alone would
          explain the refusal without giving the user a recovery path. */}
      {props.weekBlocker && (
        <Alert
          type="error"
          showIcon
          title={props.weekBlocker}
          description={
            <>
              {/* Missing authority escalates to an operator; exhausted depth escalates further to
                  an administrator whose correction access has no date boundary. */}
              {props.overdue && <div>{props.canPast ? DEPTH_HINT : NO_RIGHT_HINT}</div>}
              <Space size={8} wrap style={{ marginTop: 8 }}>
                {props.editable && (
                  <Button danger onClick={props.onCancel}>
                    Отменить заявку
                  </Button>
                )}
                {/* Recompute the next week's suggestion instead of copying a stale composition. */}
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
      {/* For an authorized operator this is a cost disclosure, not a blocker; the single command
          remains in the action bar to avoid two apparently different conduct buttons. */}
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
