import { Button, Space, Typography } from 'antd';
import type { WeeklyItemCounts } from '@technic/contracts';
import { weeklyCountsText } from './weeklyShared';

/**
 * Панель действий недельной заявки — закреплена внизу страницы (§5 шаг 1): состав длинный, и итог
 * с кнопками не должны уезжать за его конец.
 *
 * Итог стоит слева от кнопок и рядом с предупреждением о необратимости: «Подать и завизировать»
 * двигает сроки заказов и выписывает листы той же транзакцией (Р6), и прочесть, что именно
 * согласуют, надо до нажатия, а не после.
 *
 * Виза и отказ разведены **двумя** признаками, а не одним «право визы есть» (ADR 0101). У
 * просроченной недели это разные люди: провести её может только тот, у кого право прошлого
 * (диспетчер, администратор), а отклонить — по-прежнему руководитель этой площадки, потому что
 * отказ ничего в прошлом не двигает, он возвращает заявку в черновик. Слить их обратно в один
 * признак нельзя: одному тогда предложили бы кнопку, которой ручка ответит 403, а у другого отняли
 * бы отказ, который она принимает.
 */

interface Props {
  counts: WeeklyItemCounts;
  /** Состав ещё правится и право на правку есть. */
  editable: boolean;
  isDraft: boolean;
  /** Виза применяет заявку сразу — своя площадка руководителя строительства (Р8). */
  approvesOwn: boolean;
  /**
   * Право визы **этой** недели и заявка ждёт её: у будущей — `weeklyRequests.approve`, у
   * просроченной — право прошлого (`weeklyApprovalPermission`).
   */
  canApproveWeek: boolean;
  /** Право отказа: прежнее правило площадки, недели оно не знает — отказ прошлого не двигает. */
  canReject: boolean;
  /** Неделя уже началась или прошла: виза по ней становится операцией задним числом (ADR 0101). */
  overdue: boolean;
  /** Состав пуст: подавать нечего. */
  empty: boolean;
  /**
   * Неделя закрыта для этой учётки: подать и завизировать нельзя, снять — можно всегда (§8). У
   * того, кто вправе провести прошлое, признак снимается — тупика у него нет.
   */
  blockedByWeek: boolean;
  /** Строки «нужна дополнительно» заполнены не до конца — их не примут, а молча потерять нельзя. */
  hasIssues: boolean;
  dirty: boolean;
  savePending: boolean;
  submitPending: boolean;
  approvePending: boolean;
  onSave: () => void;
  onSubmit: () => void;
  onApprove: () => void;
  /** Открыть окно проведения задним числом: причина, листы к перевыписке и цена операции. */
  onConduct: () => void;
  onReject: () => void;
  onCancel: () => void;
}

export function WeeklyRequestActions(props: Props) {
  const blocked = props.empty || props.blockedByWeek || props.hasIssues;
  return (
    <div
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        paddingTop: 8,
        borderTop: '1px solid rgba(0,0,0,0.08)',
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 200, lineHeight: 1.3 }}>
        <Typography.Text strong>{weeklyCountsText(props.counts)}</Typography.Text>
        {props.editable && props.approvesOwn && props.isDraft && (
          <div>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              Сроки продлятся сразу, будут выписаны путевые листы
            </Typography.Text>
          </div>
        )}
        {/* Одинокая кнопка «Отклонить» без визы рядом читается как поломка экрана: сказать, куда
            делось согласование, обязана та же панель, где его нет. */}
        {props.overdue && props.canReject && !props.canApproveWeek && (
          <div>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              Неделя уже началась: провести её задним числом может диспетчер или администратор — вам
              остаётся отклонить заявку или снять её
            </Typography.Text>
          </div>
        )}
        {props.hasIssues && (
          <div>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              Заполните строки дополнительной техники — незаполненная в состав не уйдёт
            </Typography.Text>
          </div>
        )}
      </div>
      <Space size={8} wrap>
        {props.editable && (
          <Button onClick={props.onSave} loading={props.savePending} disabled={!props.dirty}>
            Сохранить черновик
          </Button>
        )}
        {props.editable && props.isDraft && (
          <Button
            type="primary"
            loading={props.submitPending}
            disabled={blocked}
            onClick={props.onSubmit}
          >
            {props.approvesOwn ? 'Подать и завизировать' : 'Подать'}
          </Button>
        )}
        {/* Просроченная неделя визируется не нажатием, а окном: причина, листы к перевыписке и цена
            операции спрашиваются до того, как сгорит первый номер бланка (ADR 0101). Кнопка красная
            — она отнимает бланки и двигает прошлое, а не сохраняет. */}
        {props.canApproveWeek && props.overdue && (
          <Button danger type="primary" disabled={blocked} onClick={props.onConduct}>
            Провести задним числом
          </Button>
        )}
        {props.canApproveWeek && !props.overdue && (
          <Button
            type="primary"
            loading={props.approvePending}
            disabled={blocked}
            onClick={props.onApprove}
          >
            Завизировать
          </Button>
        )}
        {props.canReject && (
          <Button danger onClick={props.onReject}>
            Отклонить
          </Button>
        )}
        {/* Снять заявку можно всегда, пока она не применена (§8 плана): просроченность к отмене не
            применяется ни на сервере, ни здесь. Прежнее `!blockedByWeek` запирало ровно тот выход,
            который баннер просроченной недели человеку и предлагал. */}
        {props.editable && (
          <Button danger onClick={props.onCancel}>
            Снять заявку
          </Button>
        )}
      </Space>
    </div>
  );
}
