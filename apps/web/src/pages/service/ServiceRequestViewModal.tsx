import { useMemo, useState, type ReactNode } from 'react';
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
 * Ход заявки карточка не решает сама: набор действий ей строит коридор переходов
 * (`useServiceRequestActions`) — тот же, что и строке списка. Но открываются они отсюда, и потому
 * окна действий карточки живут внутри неё (ADR 0140): снаружи они делят слой с самой карточкой и
 * прячутся под ней. Исполнители — единственное действие, вынесенное из меню в тело: состав правят
 * там же, где его читают.
 */
export function ServiceRequestViewModal({
  request: row,
  equipmentWarrantyUntil,
  onClose,
  onEdit,
  actions,
  modals,
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
  /**
   * Окна действий карточки (ADR 0140). Рендерятся **внутри** окна, и это не вкусовщина:
   * вложенная модалка получает от antd собственный слой (`ZIndexContext` даёт ей z-index на сотню
   * выше родительской), а соседняя по странице делит слой с карточкой — у корневых модалок
   * z-index один на всех, и спор решает порядок узлов в `body`. Карточка же пересоздаёт свой узел
   * при каждом открытии (`destroyOnHidden`), поэтому рано или поздно оказывается последней и
   * накрывает окно действия: человек нажимает пункт меню и видит, что «ничего не произошло».
   *
   * Отсюда и раздельное владение: набор окон для строк списка живёт на уровне страницы, набор
   * окон карточки — здесь. Один и тот же отрисовать в двух местах нельзя — это два экземпляра
   * одного окна.
   */
  modals?: ReactNode;
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
  const allActions = request && actions ? actions(request) : [];
  /*
   * Назначение исполнителей ушло из меню карточки в саму карточку (ADR 0140): кнопка стоит у поля
   * «Исполнители», там же, где читают состав. Из меню оно здесь вычеркнуто — двум ручкам к одному
   * действию в одном окне взяться неоткуда; в меню строки списка пункт остаётся, там карточка не
   * открыта, и подпись «Вам: назначить исполнителей» ведёт прямо в окно (Р117).
   *
   * Пункт берётся готовым, а не строится заново: кому назначение доступно, решает коридор
   * переходов — и второй раз этот вопрос в портале не задаётся.
   */
  const assign = allActions.find((item) => item.key === 'assign');
  const actionItems = allActions.filter((item) => item.key !== 'assign');

  const fields = request
    ? serviceRequestViewFields({
        request,
        user,
        equipmentWarrantyUntil,
        onAssign: assign?.onClick,
      })
    : [];

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

      {/* Окна действий — внутри карточки, а не соседями по странице (ADR 0140): только так antd
          считает им слой сам, и окно назначения не уходит под карточку, из которой его позвали. */}
      {modals}
    </ViewModal>
  );
}
