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
 */

interface Props {
  counts: WeeklyItemCounts;
  /** Состав ещё правится и право на правку есть. */
  editable: boolean;
  isDraft: boolean;
  /** Виза применяет заявку сразу — своя площадка руководителя строительства (Р8). */
  approvesOwn: boolean;
  /** Право визы и заявка ждёт её. */
  canApprove: boolean;
  /** Состав пуст: подавать нечего. */
  empty: boolean;
  /** Неделя уже началась: подать и завизировать нельзя, снять — можно (§8). */
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
        {props.canApprove && (
          <>
            <Button
              type="primary"
              loading={props.approvePending}
              disabled={blocked}
              onClick={props.onApprove}
            >
              Завизировать
            </Button>
            <Button danger onClick={props.onReject}>
              Отклонить
            </Button>
          </>
        )}
        {props.editable && !props.blockedByWeek && (
          <Button danger onClick={props.onCancel}>
            Снять заявку
          </Button>
        )}
      </Space>
    </div>
  );
}
