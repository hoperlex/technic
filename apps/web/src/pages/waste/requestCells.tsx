import { useState } from 'react';
import { Button, Dropdown, Space, Tag, Tooltip, Typography } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import {
  allowedStatusTransitions,
  containerOwnerMismatch,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
  wasteFactLabel,
  wasteRequestCommentLines,
  wasteSubjectLabel,
  wasteTicketReviewBlocker,
  type WasteRequestDto,
} from '@technic/contracts';
import { ActionSheet, ExpandableCell } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { formatMoney } from '../../utils/format';

/**
 * Ячейки строки заявки на вывоз: комментарий, предмет, статус и перечень того, что сотрёт возврат
 * в «Новую».
 *
 * Своим файлом — рядом с фильтрами и колонками истории того же раздела. Страница отвечает за
 * вкладки, запросы и форму заявки, а здесь лежит то, как читается одна графа: у каждой из этих
 * ячеек своё правило показа (комментарий сворачивается только в таблице, тег статуса на телефоне
 * открывает шит, а не меню), и в двухтысячестрочной странице эти правила терялись.
 */

export function CommentCell({ r, collapsible }: { r: WasteRequestDto; collapsible?: boolean }) {
  const lines = wasteRequestCommentLines(r);
  if (lines.length === 0) return null;
  const body = lines.map((l) => (
    <div key={l.key}>
      <Typography.Text type="secondary">{l.label}: </Typography.Text>
      {/* Абзацы автора сохраняются: комментарий заводят многострочным полем. */}
      <span style={{ whiteSpace: 'pre-line' }}>{l.text}</span>
    </div>
  ));
  return collapsible ? <ExpandableCell>{body}</ExpandableCell> : <>{body}</>;
}

/**
 * Сданный вес — второй строкой к предмету заявки на металлолом (ADR 0067). Появляется только
 * после закрытия: до него у такой заявки нет ни предмета, ни цифр, и обещать вес заранее нечем —
 * заявка плана не несёт.
 */
export function weightFactLine(r: WasteRequestDto): string | null {
  return r.completion?.unit === 'weight_tons' ? `сдано ${wasteFactLabel(r.completion)}` : null;
}

/**
 * Предмет заявки с пометкой о чужом контейнере (ADR 0054). Сама строка собирается контрактом
 * (`wasteSubjectLabel`) — она нужна и списку, и мобильной карточке, — а тег живёт здесь: это
 * уже показ, а не описание предмета.
 */
export function SubjectCell({ r }: { r: WasteRequestDto }) {
  return (
    <>
      {wasteSubjectLabel(r)}
      {containerOwnerMismatch(r) && (
        <Tooltip title={`Контейнер установил «${r.containerOwnerName ?? '—'}»`}>
          <Tag color="volcano" style={{ marginInlineStart: 8 }}>
            Чужой контейнер
          </Tag>
        </Tooltip>
      )}
    </>
  );
}

/**
 * Что возврат в «Новую» сотрёт у этой заявки (`transitionResetsWork`) — строками, по её
 * собственным данным.
 *
 * У заявок на вывоз это предъявленный факт (ADR 0035, ADR 0067) и талоны вывоза (ADR 0013,
 * ADR 0024): всё, чем закрывали заявку. Есть они не всегда — заявка попадает в «В работе» и без
 * них, а факт с талонами появляются у той, которую уже закрывали и откатили назад, — поэтому
 * перечень собирается по заявке: обещать снятие того, чего у неё нет, значит пугать человека
 * выдуманной потерей.
 */
export function rollbackErases(r: WasteRequestDto): string[] {
  const items: string[] = [];
  if (r.completion) {
    const cost = r.completion.totalCost != null ? ` · ${formatMoney(r.completion.totalCost)}` : '';
    items.push(`Предъявленный факт: вывезено ${wasteFactLabel(r.completion)}${cost}`);
  }
  // Талоны — общий пул на заявку (ADR 0024): считаются штуками, перечислять их имена в окне
  // решения незачем — важно, что бумага открепится от заявки и её придётся прикладывать заново.
  if (r.tickets.length > 0) {
    items.push(`Приложенные талоны вывоза: ${r.tickets.length} шт.`);
  }
  return items;
}

/**
 * Ячейка статуса заявки: тег с доступными роли переходами.
 *
 * Живёт на уровне модуля, а не внутри страницы: объявленный в теле компонента, он был бы новым
 * типом на каждый рендер — React разрушал бы поддерево и терял его состояние, из-за чего
 * открытый список переходов на телефоне закрывался сам при любом обновлении списка.
 *
 * Пользователя и режим устройства берёт своими хуками: они одинаковы для всей страницы. Пропсами
 * приходит только то, что у каждой строки своё.
 */
export function WasteStatusCell({
  request,
  pending,
  onChange,
}: {
  request: WasteRequestDto;
  /** Идёт смена статуса именно этой заявки: тег ждёт ответа и не принимает нажатий. */
  pending: boolean;
  onChange: (request: WasteRequestDto, status: RequestStatus) => void;
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Набор переходов зависит от прав: линейный цикл для всех, откаты — только администратору,
  // а у внешнего исполнителя свой коридор — закрытие взятой в работу заявки.
  const transitions = user ? allowedStatusTransitions(request.status, user, 'waste') : [];
  const tag = (
    <Tag color={requestStatusColors[request.status]} style={{ marginInlineEnd: 0 }}>
      {requestStatusLabels[request.status]}
    </Tag>
  );
  // Причина отмены — в подсказке на теге: в таблице для неё нет колонки, а знать её нужно.
  // На телефоне подсказки нет вовсе — там причина выводится строкой карточки.
  const badge =
    request.cancelReason && !isMobile ? (
      <Tooltip title={`Причина отмены: ${request.cancelReason}`}>{tag}</Tooltip>
    ) : (
      tag
    );
  if (request.deletedAt || transitions.length === 0) {
    return badge;
  }
  /**
   * Завершение — точка в разборе бумаги (ADR 0135), и до конца разбора его предлагать нечем:
   * пункт остаётся в меню, но выключен и объясняет, чего ждёт. Убрать его вовсе нельзя — тогда
   * тот, кто пришёл завершить заявку, не нашёл бы действия и решил бы, что права нет.
   *
   * Считается по тому же значку, что стоит в столбце разбора, и той же функцией, которой
   * отказывает сервер: значок приходит только с правом `ticketReview`, а пункт «Завершена» — ровно
   * тому, у кого это право есть. `null` значка означает «бумаги в разборе нет» — завершать можно.
   */
  const completionBlocker = wasteTicketReviewBlocker(request.ticketBadge);
  const items = transitions.map((s) => ({
    key: s,
    label: requestStatusLabels[s],
    ...(s === 'completed' && completionBlocker ? { disabled: true, title: completionBlocker } : {}),
  }));

  // На телефоне переходы показываются списком снизу: выпадающее меню у тега в карточке
  // открывается под палец мимо цели, а подписи в нём — те же (ADR 0030).
  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className="status-trigger"
          aria-label="Изменить статус"
          disabled={pending}
          onClick={(e) => {
            e.stopPropagation();
            setSheetOpen(true);
          }}
        >
          <Space size={4}>
            {badge}
            <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
          </Space>
        </button>
        <ActionSheet
          title="Изменить статус"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          items={items.map((item) => ({
            key: item.key,
            label: item.label,
            disabled: item.key === 'completed' && !!completionBlocker,
            disabledReason:
              item.key === 'completed' && completionBlocker ? completionBlocker : undefined,
            onClick: () => onChange(request, item.key as RequestStatus),
          }))}
        />
      </>
    );
  }

  return (
    <Dropdown
      trigger={['click']}
      disabled={pending}
      menu={{
        items,
        onClick: ({ key }) => onChange(request, key as RequestStatus),
      }}
    >
      <Button
        type="text"
        size="small"
        loading={pending}
        aria-label="Изменить статус"
        style={{ padding: 0, height: 'auto', border: 'none' }}
      >
        <Space size={4}>
          {badge}
          <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
        </Space>
      </Button>
    </Dropdown>
  );
}

// Вкладка живёт в адресе, а не в состоянии: по ссылке из соседнего раздела («№ заявки установки»
// в списке площадок) сюда приходят с готовым ответом, какую вкладку показать и что на ней открыть.
