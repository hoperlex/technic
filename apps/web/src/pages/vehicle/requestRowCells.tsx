import { useState } from 'react';
import { Button, Dropdown, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  DownOutlined,
} from '@ant-design/icons';
import {
  allowedVehicleRequestTransitions,
  isApprovalChangeable,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
} from '@technic/contracts';
import { ActionSheet } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { formatDateTime } from '../../utils/format';

/**
 * Две ячейки, которыми заявкой распоряжаются прямо из строки списка: статус (ADR 0021) и виза
 * руководителя строительства (ADR 0025). Обе живут в списке заказов и больше нигде: в журнале
 * закрытых распоряжаться нечем, а срез «На объекте» только читает.
 *
 * Отдельным файлом от прочего общего страницы (`shared.tsx`): тот упёрся в бюджет длины
 * (`scripts/quality.mjs`), а эти две ячейки — единственная его часть, отвечающая на свой отдельный
 * вопрос «что со строкой можно сделать», и уезжает целиком, не разрывая соседей.
 */
/** Ячейка статуса: дропдаун доступных роли переходов либо тег. */
export function StatusCell({
  status,
  deleted,
  approved,
  cancelReason,
  pending,
  onChange,
}: {
  status: RequestStatus;
  deleted: boolean;
  /** Виза руководителя строительства: без неё заявку не берут в работу (ADR 0025). */
  approved: boolean;
  /** Причина отмены — подсказкой на теге (колонки под неё в таблице нет). */
  cancelReason?: string | null;
  pending: boolean;
  onChange: (s: RequestStatus) => void;
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  // Линейный цикл доступен ведущим заявки ролям, откаты закрытых заявок — только админу;
  // «В работе» до визы не предлагается никому — сервер такой переход отклонит.
  const transitions = user ? allowedVehicleRequestTransitions(status, user, approved) : [];
  const plain = <Tag color={requestStatusColors[status]}>{requestStatusLabels[status]}</Tag>;
  // Причина отмены — подсказкой только на десктопе: на телефоне подсказка по касанию не
  // открывается, и причина выводится строкой карточки (ADR 0030).
  const tag =
    cancelReason && !isMobile ? (
      <Tooltip title={`Причина отмены: ${cancelReason}`}>{plain}</Tooltip>
    ) : (
      plain
    );
  if (deleted || transitions.length === 0) return tag;

  // На телефоне переходы показываются списком снизу: выпадающее меню открывается под палец
  // мимо цели, а нажатие по тегу не должно заодно открывать карточку заявки.
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
          {tag}
          <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
        </button>
        <ActionSheet
          title="Изменить статус"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          items={transitions.map((s) => ({
            key: s,
            label: requestStatusLabels[s],
            onClick: () => onChange(s),
          }))}
        />
      </>
    );
  }

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: transitions.map((s) => ({ key: s, label: requestStatusLabels[s] })),
        onClick: ({ key }) => onChange(key as RequestStatus),
      }}
    >
      <Button size="small" type="text" loading={pending}>
        {tag}
        <DownOutlined />
      </Button>
    </Dropdown>
  );
}

/**
 * Ячейка согласования (ADR 0025). Завизированная заявка — зелёная с галочкой, ждущая визы —
 * оранжевая: состояние читается цветом, не текстом, потому что в списке это первое, на что
 * смотрят и диспетчер, и руководитель строительства.
 *
 * Кнопкой ячейка становится только у того, кто эту заявку визирует, и только пока её не взяли
 * в работу; остальным и в остальных статусах — тег.
 */
export function ApprovalCell({
  status,
  deleted,
  approved,
  approvedByName,
  approvedAt,
  canApprove,
  pending,
  onChange,
}: {
  status: RequestStatus;
  deleted: boolean;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  /** Право визы у роли; чужой объект сервер отсечёт сам (assertObjectScope). */
  canApprove: boolean;
  pending: boolean;
  onChange: (approved: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const approvedTitle =
    approved && approvedAt
      ? `Завизировал ${approvedByName ?? '—'} · ${formatDateTime(approvedAt)}`
      : 'Заявка ждёт визы руководителя строительства';
  const editable = canApprove && !deleted && isApprovalChangeable(status);

  if (!editable) {
    const tag = approved ? (
      <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
        Завизирована
      </Tag>
    ) : (
      <Tag color="orange" icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
        Ждёт визы
      </Tag>
    );
    // На телефоне подсказки нет: кто и когда завизировал, видно в карточке заявки.
    return isMobile ? tag : <Tooltip title={approvedTitle}>{tag}</Tooltip>;
  }

  const button = (
    <Button
      size="small"
      color={approved ? 'green' : 'orange'}
      variant="solid"
      loading={pending}
      icon={approved ? <CheckOutlined /> : undefined}
      // Виза стоит внутри карточки списка: нажатие на неё не должно открывать саму карточку.
      onClick={(e) => {
        e.stopPropagation();
        onChange(!approved);
      }}
    >
      {approved ? 'Завизирована' : 'Согласовать'}
    </Button>
  );

  return isMobile ? (
    button
  ) : (
    <Tooltip
      title={approved ? `${approvedTitle}. Нажмите, чтобы снять визу` : 'Согласовать заявку'}
    >
      {button}
    </Tooltip>
  );
}
