import { Button, Result, Space, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import type { WeeklyVehicleRequestDto } from '@technic/contracts';
import { errorMessage } from '../../utils/format';
import { hasStatus, WeeklyStatusTag } from './weeklyShared';

/**
 * Обрамление страницы недельной заявки: шапка с номером и статусом и экран не открывшейся заявки.
 *
 * Вынесены из `WeeklyRequestPage` не за длину, а за то, что оба куска ничего не знают о сборке
 * состава — им нужны только сама заявка и «куда уйти». Страница же держит четыре мутации и общий
 * разбор их отказов, и разметка, к этому разбору не относящаяся, стояла у него по обе стороны.
 *
 * Оба куска говорят про одно: как выглядит документ, который **не** правят. Шапка отвечает «что
 * это за неделя и в каком она состоянии», экран отказа — «почему её не видно и что делать
 * дальше». Тупика без выхода здесь нет ни в одном случае: у исчезнувшей заявки названа причина
 * (её удалили вместе с площадкой), и кнопка возвращает в список, а не оставляет на пустой странице.
 */

/** Шапка страницы: номер, неделя, статус и площадка с автором — всё, чем документ называют. */
export function WeeklyRequestHeader({
  request,
  onBack,
}: {
  request: WeeklyVehicleRequestDto;
  onBack: () => void;
}) {
  return (
    <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
      <Button icon={<ArrowLeftOutlined />} onClick={onBack} aria-label="К списку" />
      <div style={{ lineHeight: 1.3 }}>
        <Space size={8} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {request.displayNumber} · {request.weekLabel}
          </Typography.Title>
          <WeeklyStatusTag status={request.status} />
        </Space>
        <div>
          <Typography.Text type="secondary">
            {request.objectName}
            {request.objectCode ? ` · ${request.objectCode}` : ''} · автор {request.createdByName}
          </Typography.Text>
        </div>
      </div>
    </div>
  );
}

/**
 * Заявка не открылась. Исчезнувшая отличается от сбоя связи и подписана причиной: неприменённые
 * недельные заявки погашенной площадки удаляются вместе с ней, и «Заявка не открылась» на такой
 * ссылке отправило бы человека искать поломку там, где её нет.
 */
export function WeeklyRequestNotOpened({
  error,
  onLeave,
}: {
  error: unknown;
  onLeave: () => void;
}) {
  const gone = hasStatus(error, 404);
  return (
    <Result
      status={gone ? '404' : 'error'}
      title={gone ? 'Заявка удалена вместе с площадкой' : 'Заявка не открылась'}
      subTitle={
        gone
          ? 'Неприменённые недельные заявки погашенной площадки удаляются вместе с ней: документа больше нет.'
          : errorMessage(error)
      }
      extra={
        <Button type="primary" onClick={onLeave}>
          К списку недельных заявок
        </Button>
      }
    />
  );
}
