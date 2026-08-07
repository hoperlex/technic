import { useMemo, useState } from 'react';
import { Button, Dropdown, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  isWaitingOn,
  type RequestHistoryEntryDto,
  type ServiceRequestDto,
  serviceRequestChangeLabels,
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
  warrantyClaimSourceLabels,
} from '@technic/contracts';
import {
  serviceRequestKeys,
  serviceRequestsApi,
  ServiceStatusTag,
  statusAgeLabel,
  WaitingOnTag,
} from '@entities/service-request';
import { WarrantyTag } from '@entities/office-equipment';
import {
  ActionSheet,
  ViewFields,
  ViewModal,
  type ActionSheetItem,
  type ViewField,
} from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
import { ResponsibleValue } from '../../components/ResponsibleFields';
import { formatDateTime } from '../../utils/format';
import { formatDateOnly } from '../../utils/date';
import { ServiceRequestDocuments } from './ServiceRequestDocuments';
import { ServiceRequestEstimate } from './ServiceRequestEstimate';

/**
 * События истории для общей таблицы (ADR 0012).
 *
 * Переход дублируется строкой под событием, хотя слева от него и так стоят баблы статусов. Причина
 * в том, что баблы общей таблицы подписаны словарём статусов «Вывоза мусора» и «Заказа ТС», а у
 * этого модуля статусы свои (ADR 0085 §5): «Диагностика» и «Смета на согласовании» в том словаре
 * не значатся, и бабл остался бы пустым. Пока подписи не станут модульными, читателю истории
 * важнее увидеть переход словами, чем ровную раскладку.
 */
function toRows(history: RequestHistoryEntryDto[] | undefined): HistoryRow[] {
  return (history ?? []).map((e) => ({ key: e.id, entry: e }));
}

/**
 * Подписи и цвета статусов этого модуля для истории: цикл у него свой (ADR 0085), и общий словарь
 * заявок его статусов не знает — без этого переход подписывался бы чужими словами.
 */
const SERVICE_HISTORY_STATUSES = {
  labels: serviceRequestStatusLabels as Record<string, string>,
  colors: serviceRequestStatusColors as Record<string, string>,
};

/**
 * Карточка заявки на обслуживание (§9.4): вкладки «Заявка», «Смета», «Документы», «История».
 *
 * Вкладками, а не одной длинной страницей: у заявки три стороны и три разных разговора — что
 * сломалось, во сколько это встало и чем подтверждено. В один свиток они складываются так, что
 * смету приходится искать прокруткой между фотографиями и историей.
 *
 * Действия здесь не живут: их строит коридор переходов (`useServiceRequestActions`), и вызываются
 * они из списка — карточка отвечает на «что с заявкой», а не «что с ней сделать».
 */
export function ServiceRequestViewModal({
  request: row,
  equipmentWarrantyUntil,
  onClose,
  onEdit,
  actions,
}: {
  /** `null` — окно закрыто. Строка списка: с неё карточка рисуется, пока едет свежая. */
  request: ServiceRequestDto | null;
  /**
   * Гарантия самой единицы. Приходит извне и бывает не задана вовсе: в заявке лежит снимок
   * реквизитов без срока, а справочник виден не всякому — сервису он закрыт (Р7).
   */
  equipmentWarrantyUntil?: string | null;
  onClose: () => void;
  /** Не передан — правка этой заявки недоступна (роль, статус или архив). */
  onEdit?: (request: ServiceRequestDto) => void;
  /**
   * Ход заявки: список строит коридор переходов (`useServiceRequestActions`). Не передан —
   * карточка только на чтение (архив). Действия стоят в подвале, потому что решают, прочитав
   * смету и историю, — то есть здесь, а не в строке списка.
   */
  actions?: (request: ServiceRequestDto) => ActionSheetItem[];
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  /**
   * Карточка спрашивает заявку сама, а не довольствуется строкой списка: подшитый документ и
   * закрытая смета должны появляться в открытом окне, а строка в списке к этому моменту уже
   * устарела. Строка при этом показывается сразу (`placeholderData`) — ждать ответа, чтобы
   * показать то, что и так есть, незачем.
   */
  const { data: fresh } = useQuery({
    queryKey: serviceRequestKeys.detail(row?.id ?? ''),
    queryFn: () => serviceRequestsApi.get(row!.id),
    enabled: !!row,
    placeholderData: row ?? undefined,
  });
  const request = row ? (fresh ?? row) : null;

  const { data: history, isPending } = useQuery({
    queryKey: serviceRequestKeys.history(request?.id ?? ''),
    queryFn: () => serviceRequestsApi.history(request!.id),
    enabled: !!request,
  });
  const rows = useMemo(() => toRows(history), [history]);

  const fields: ViewField[] = request
    ? [
        {
          key: 'status',
          label: 'Статус',
          children: (
            <Space size={8} wrap>
              <ServiceStatusTag status={request.status} />
              <WaitingOnTag
                waiting={request.waitingOn}
                mine={isWaitingOn(user, request.waitingOn)}
              />
              <Typography.Text type="secondary">
                в статусе {statusAgeLabel(request.statusChangedAt)}
              </Typography.Text>
            </Space>
          ),
          full: true,
        },
        {
          key: 'equipment',
          label: 'Техника',
          full: true,
          children: (
            <Space direction="vertical" size={2}>
              <span>{request.equipment.name}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {[
                  request.equipment.typeName,
                  request.equipment.inventoryNumber && `инв. ${request.equipment.inventoryNumber}`,
                  request.equipment.serialNumber && `SN ${request.equipment.serialNumber}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Typography.Text>
              {/* Два разных признака (§9.2): состояние гарантии самой техники и пометка о том,
                  что заявку завели по гарантии. Первое известно только тому, кому виден
                  справочник, второе — всем. */}
              {equipmentWarrantyUntil !== undefined && (
                <Space size={8} wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    гарантия на технику:
                  </Typography.Text>
                  <WarrantyTag until={equipmentWarrantyUntil} />
                </Space>
              )}
              {request.warrantyClaim && (
                <Tooltip
                  title={
                    request.warrantyClaim.sourceRequestNum
                      ? `Источник: заявка СО-${request.warrantyClaim.sourceRequestNum}`
                      : 'Гарантия поставщика на саму единицу'
                  }
                >
                  <Tag color="purple">
                    {warrantyClaimSourceLabels[request.warrantyClaim.source]}
                    {request.warrantyClaim.itemName ? `: ${request.warrantyClaim.itemName}` : ''}
                  </Tag>
                </Tooltip>
              )}
            </Space>
          ),
        },
        {
          key: 'customer',
          label: 'Заказчик',
          full: true,
          children: (
            <Space size={8} wrap>
              <span>
                {request.object.code} — {request.object.name}
              </span>
              {request.customerDepartment && <Tag>{request.customerDepartment.name}</Tag>}
              {/* Отдел-владелец техники: по нему считается область, и он бывает не тем же, что
                  отдел-заказчик — соседний отдел чинит «чужой» принтер чаще, чем кажется. */}
              {request.equipmentDepartment &&
                request.equipmentDepartment.id !== request.customerDepartment?.id && (
                  <Typography.Text type="secondary">
                    владелец: {request.equipmentDepartment.name}
                  </Typography.Text>
                )}
            </Space>
          ),
        },
        {
          key: 'description',
          label: 'Неисправность',
          full: true,
          children: request.description,
        },
        {
          key: 'dueDate',
          label: 'Желаемый срок',
          children: request.dueDate ? formatDateOnly(request.dueDate) : '—',
        },
        {
          key: 'responsible',
          label: 'Ответственный',
          children: (
            <ResponsibleValue name={request.responsibleName} phone={request.responsiblePhone} />
          ),
        },
        {
          key: 'service',
          label: 'Сервис',
          children: request.service?.name ?? 'не назначен',
        },
        {
          key: 'acceptance',
          label: 'Приёмка',
          children: request.acceptedAt
            ? `${request.acceptedByName || '—'} · ${formatDateTime(request.acceptedAt)}`
            : '—',
        },
        {
          key: 'author',
          label: 'Автор',
          children: `${request.createdByName} · ${formatDateTime(request.createdAt)}`,
        },
        { key: 'comment', label: 'Комментарий', full: true, children: request.comment || '—' },
        // Примечание исполнителя (приём ADR 0053): его строка в заявке, заявку она не редактирует.
        ...(request.serviceComment
          ? [
              {
                key: 'serviceComment',
                label: 'Примечание сервиса',
                full: true,
                children: request.serviceComment,
              },
            ]
          : []),
      ]
    : [];

  const actionItems = request && actions ? actions(request) : [];

  return (
    <ViewModal
      title={request ? `Заявка ${request.displayNumber}` : 'Заявка'}
      open={!!request}
      onClose={onClose}
      width={1000}
      // Окно переоткрывают на соседней заявке: вкладка и раскрытые строки прошлой к ней
      // отношения не имеют.
      destroyOnHidden
      footer={[
        ...(actionItems.length > 0
          ? [
              // На телефоне действия открываются шитом снизу (ADR 0030), на десктопе — меню:
              // набор один и тот же, различается только способ до него дотянуться.
              isMobile ? (
                <Button key="actions" onClick={() => setSheetOpen(true)}>
                  Действия
                </Button>
              ) : (
                <Dropdown
                  key="actions"
                  trigger={['click']}
                  menu={{
                    items: actionItems.map((item) => ({
                      key: item.key,
                      label: item.label,
                      danger: item.danger,
                    })),
                    onClick: ({ key }) => actionItems.find((item) => item.key === key)?.onClick(),
                  }}
                >
                  <Button>Действия</Button>
                </Dropdown>
              ),
            ]
          : []),
        ...(request && onEdit
          ? [
              <Button key="edit" type="primary" onClick={() => onEdit(request)}>
                Редактировать
              </Button>,
            ]
          : []),
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      {request && (
        <Tabs
          items={[
            {
              key: 'request',
              label: 'Заявка',
              children: (
                <>
                  <ViewFields items={fields} />
                  {request.equipmentDepartment == null && request.customerDepartment == null && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Заявка объектная: отдел у неё не указан.
                    </Typography.Text>
                  )}
                </>
              ),
            },
            {
              key: 'estimate',
              label: 'Смета',
              children: <ServiceRequestEstimate request={request} />,
            },
            {
              key: 'documents',
              label: 'Документы',
              children: <ServiceRequestDocuments request={request} />,
            },
            {
              key: 'history',
              label: 'История',
              children: isPending ? (
                <Spin size="small" />
              ) : rows.length > 0 ? (
                // Подписи полей — модульные: сервер шлёт технические ключи, а читателю истории
                // нужны слова заявки на обслуживание.
                <RequestHistoryTable
                  rows={rows}
                  labels={serviceRequestChangeLabels}
                  statuses={SERVICE_HISTORY_STATUSES}
                />
              ) : (
                <Typography.Text type="secondary">История недоступна</Typography.Text>
              ),
            },
          ]}
        />
      )}

      <ActionSheet
        title="Действия по заявке"
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        items={actionItems}
      />
    </ViewModal>
  );
}
