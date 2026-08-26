import { useEffect } from 'react';
import { App, Segmented, Select, Space } from 'antd';
import type { TicketAuditPeriod } from '@technic/contracts';
import { useIsMobile } from '@shared/lib';
import { ViewModal } from '@shared/ui';
import { useTicketAudit } from '../model/useTicketAudit';
import { TICKET_AUDIT_VIEWS, TICKET_AUDIT_VIEW_LABELS, type TicketAuditView } from '../model/view';
import { TicketAuditAccuracy } from './TicketAuditAccuracy';
import { TicketAuditCohorts } from './TicketAuditCohorts';
import { TicketAuditEvents } from './TicketAuditEvents';
import { TicketAuditOperations } from './TicketAuditOperations';
import { TicketAuditSummary } from './TicketAuditSummary';

/**
 * Аудит распознавания талонов — большим окном поверх реестра вывоза (ADR 0137, §5 плана).
 *
 * Своей страницы и вкладки у модуля нет намеренно: размещение выбрано временным, модуль может
 * переехать, и переезд обязан менять точку входа, а не содержимое. Образец — ADR 0120: окно живёт
 * в адресе (`?ticketAudit=1&view=cohorts&from=&to=`), поэтому ссылку с периодом и экраном можно
 * переслать, и открывается она сразу нужными числами и с той стороны, о которой шла речь.
 *
 * Монтируется рядом с реестром, а не внутри вкладки: по такой ссылке приходят с любой вкладки, и
 * окно, живущее внутри одной из них, на остальных не открылось бы вовсе.
 */
export function TicketAuditModal({ allowed }: { allowed: boolean }) {
  const { opened, period, view, close, setPeriod, setView } = useTicketAudit();
  const { message } = App.useApp();
  const isMobile = useIsMobile();

  /*
   * Права нет, а параметр в адресе есть: окно не открывается, ключ снимается, причина называется.
   * Молча исчезнувший из адреса ключ читается как поломка портала. Тот же путь отрабатывает потерю
   * права на лету: набор полномочий приходит обновлением сессии, и окно, открытое до неё, обязано
   * закрыться само.
   */
  useEffect(() => {
    if (allowed || !opened) return;
    message.error('Аудит распознавания вам недоступен');
    close();
  }, [allowed, opened, message, close]);

  const open = allowed && opened;

  return (
    <ViewModal
      title="Аудит распознавания талонов"
      open={open}
      onClose={close}
      width={960}
      /* Содержимое пересобирается при каждом открытии: окно открывают за ответом на сегодняшний
         вопрос, а не продолжают вчерашний разговор. */
      destroyOnHidden
      footer={null}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {/* Переключатель экранов. Сегментированный, а не вкладки: все пять — один отчёт с разных
            сторон, а вкладки читались бы как разные документы.
            На телефоне он уезжает в выпадающий список — так и сказано в §5, и с пятью подписями это
            перестало быть запасом на будущее: «Подсистема» и «Точность» вдвое длиннее «Ленты», и
            сегменты либо сжались бы до нечитаемого, либо утащили бы окно в горизонтальную прокрутку
            вместе со всем содержимым. */}
        {isMobile ? (
          <Select<TicketAuditView>
            value={view}
            onChange={setView}
            style={{ width: '100%' }}
            options={TICKET_AUDIT_VIEWS.map((value) => ({
              value,
              label: TICKET_AUDIT_VIEW_LABELS[value],
            }))}
          />
        ) : (
          <Segmented<TicketAuditView>
            value={view}
            onChange={setView}
            options={TICKET_AUDIT_VIEWS.map((value) => ({
              value,
              label: TICKET_AUDIT_VIEW_LABELS[value],
            }))}
          />
        )}
        {/*
         * Экран выбирается адресом, но период сюда приходит один и тот же: переключение не трогает
         * даты, потому что это один отчёт, показанный с разных сторон, — уехавший при переключении
         * период означал бы, что рядом стоят числа за разное время. Те же границы значат разное у
         * ленты (события), у точности (выдача перепроверки) и у экранов метрик (наблюдения, §1.3),
         * и говорит об этом каждый экран сам — подписью периода, а не своими датами. У состояния
         * подсистемы периода нет вовсе, и полосы там тоже нет.
         */}
        <ViewBody view={view} period={period} onPeriodChange={setPeriod} enabled={open} />
      </Space>
    </ViewModal>
  );
}

/**
 * Какой экран показать. Разбором `switch`, а не цепочкой тернарных выражений: экранов пять, и
 * цепочка из пяти условий читается хуже, чем перечисление, — а главное, при добавлении шестого
 * забытая ветка `switch` по исчерпывающему типу видна компилятору, тогда как забытый хвост цепочки
 * молча показал бы соседний экран.
 *
 * `enabled` гасит запрос закрытого экрана: пока смотрят сводку, ручку когорт незачем спрашивать
 * вовсе. Экраны монтируются по очереди, а не прячутся стилями, — иначе невидимый экран продолжал
 * бы ходить на сервер при каждой смене периода.
 */
function ViewBody({
  view,
  period,
  onPeriodChange,
  enabled,
}: {
  view: TicketAuditView;
  period: TicketAuditPeriod;
  onPeriodChange: (period: TicketAuditPeriod) => void;
  enabled: boolean;
}) {
  switch (view) {
    case 'summary':
      return (
        <TicketAuditSummary period={period} onPeriodChange={onPeriodChange} enabled={enabled} />
      );
    case 'cohorts':
      return (
        <TicketAuditCohorts period={period} onPeriodChange={onPeriodChange} enabled={enabled} />
      );
    case 'events':
      return (
        <TicketAuditEvents period={period} onPeriodChange={onPeriodChange} enabled={enabled} />
      );
    case 'operations':
      // Периода не передаём вовсе, а не передаём и не используем: у экрана его нет ни в ручке, ни
      // в вопросе (§1.3), и лишний параметр однажды дорисовал бы ему календарь.
      return <TicketAuditOperations enabled={enabled} />;
    case 'blind':
      return (
        <TicketAuditAccuracy period={period} onPeriodChange={onPeriodChange} enabled={enabled} />
      );
  }
}
