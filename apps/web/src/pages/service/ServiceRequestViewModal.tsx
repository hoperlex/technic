import { useMemo, useState } from 'react';
import { Button, Dropdown, Spin, Tabs, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  type RequestHistoryEntryDto,
  type ServiceRequestDto,
  serviceRequestChangeLabels,
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
} from '@technic/contracts';
import {
  ServiceConsumablesTable,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { ActionSheet, ViewFields, ViewModal, type ActionSheetItem } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
import { ServiceRequestDocuments } from './ServiceRequestDocuments';
import { ServiceRequestEstimate } from './ServiceRequestEstimate';
import { serviceRequestViewFields } from './serviceRequestViewFields';

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

  /*
   * Поля вкладки «Заявка» собираются отдельным модулем (`serviceRequestViewFields`): их
   * двенадцать, у каждого своё правило показа, и вместе с устройством окна они перерастали
   * ограничение длины файла. Окно отвечает за вкладки, действия и запросы, состав полей — за
   * ответ «что с заявкой».
   */
  const fields = request ? serviceRequestViewFields({ request, user, equipmentWarrantyUntil }) : [];

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
            /*
             * Предмет заявки — либо смета, либо номенклатура, и вкладка у них одна (Н1): у
             * расходников сметы нет вовсе (согласовывать картридж со своего склада не с кем), а у
             * ремонта нет строк выдачи. Две вкладки, из которых одна всегда пуста, отвечали бы на
             * вопрос «а где тут смета» каждый раз заново.
             */
            request.kind === 'consumable'
              ? {
                  key: 'consumables',
                  label: 'Номенклатура',
                  children: <ServiceConsumablesTable lines={request.consumables} />,
                }
              : {
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
