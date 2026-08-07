import { Alert, Button, Space } from 'antd';
import type { WeeklyItemCounts, WeeklyVehicleRequestDto } from '@technic/contracts';

/**
 * Состояния недельной заявки словами (§9). Каждое из них легко свести к безликому уведомлению — и
 * тогда человек не поймёт, что делать: «неделя уже началась» без предложенного выхода оставляет
 * черновик в тупике, а «применение не прошло» без построчных причин заставляет сверять список с
 * таблицей глазами.
 */

interface Props {
  request: WeeklyVehicleRequestDto;
  /** Причина отклонения визирующим: показывается сверху в самой заявке, а не только в истории. */
  rejection: string | null;
  /** Почему на эту неделю заявку подать нельзя; `null` — неделя в порядке. */
  weekBlocker: string | null;
  /** Состав ещё правится (`draft`/`pending`) и право на правку есть. */
  editable: boolean;
  composable: boolean;
  /** Отказ применения целиком: «ни одна строка не применима» с перечнем причин; `null` — отказа не было. */
  applyError: string | null;
  counts: WeeklyItemCounts;
  /** Единицы, по которым решение не принято: в состав они не войдут. */
  undecided: number;
  onCancel: () => void;
  /** Завести заявку на следующую неделю; `null` — заводить не вправе. */
  onNextWeek: (() => void) | null;
  nextWeekPending: boolean;
}

export function WeeklyRequestBanners(props: Props) {
  const { request, counts, composable } = props;
  const total = counts.extend + counts.new + counts.leave;
  const allLeaving = total > 0 && counts.extend === 0 && counts.new === 0;

  // Полоса баннеров сама держит расстояние между собой: снаружи она — один блок, и вставлять её
  // в общий поток отдельными элементами значило бы отдать расстановку тому, кто её вызывает.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {request.status === 'draft' && props.rejection && (
        <Alert
          type="error"
          showIcon
          message="Заявка отклонена и возвращена в черновик"
          description={props.rejection}
        />
      )}
      {request.status === 'cancelled' && (
        <Alert type="warning" showIcon message={`Заявка снята: ${request.cancelReason}`} />
      )}
      {/* Черновик дожил до своей недели: подать и завизировать нельзя, отменить — можно всегда
          (§8). Одного 422 от API здесь мало: он объясняет отказ, но не выход из положения. */}
      {props.weekBlocker && (
        <Alert
          type="error"
          showIcon
          message={props.weekBlocker}
          description={
            <Space size={8} wrap style={{ marginTop: 8 }}>
              {props.editable && (
                <Button danger onClick={props.onCancel}>
                  Отменить заявку
                </Button>
              )}
              {/* Состав не переносится: заявка на следующую неделю заводится с пересчитанным
                  предложением — техника за просроченную неделю всё равно частью уехала (§9). */}
              {props.onNextWeek && (
                <Button loading={props.nextWeekPending} onClick={props.onNextWeek}>
                  Создать на следующую неделю
                </Button>
              )}
            </Space>
          }
        />
      )}
      {props.applyError && (
        <Alert
          type="error"
          showIcon
          message="Применение не прошло — неделя осталась там, где была"
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
          message="Решение не принято ни по одной единице"
          description="Недельная заявка отвечает на вопрос, что делать с каждой машиной: отметьте, что остаётся и что уезжает, либо закажите технику дополнительно."
        />
      )}
      {composable && allLeaving && (
        <Alert
          type="info"
          showIcon
          message="Вся техника уезжает — на неделе на площадке не останется ничего"
        />
      )}
      {composable && props.undecided > 0 && (
        <Alert
          type="info"
          showIcon
          message={`Решение не принято по ${props.undecided} ед. — в состав они не войдут`}
        />
      )}
    </div>
  );
}
