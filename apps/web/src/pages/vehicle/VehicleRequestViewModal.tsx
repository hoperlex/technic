import { Button, Descriptions, Space, Spin, Tag, Typography } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { type ReactNode, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  assignmentRateLabel,
  assignmentTitle,
  completionLabel,
  earlyEndDaysSaved,
  type RequestHistoryEntryDto,
  requestStatusColors,
  requestStatusLabels,
  type VehicleRequestDto,
  type VehicleRequestEarlyEndDto,
  vehicleClassificationLabel,
  vehicleEarlyEndStatusColors,
  vehicleEarlyEndStatusLabels,
  vehicleOwnershipColors,
  vehicleOwnershipLabels,
  vehicleRequestChangeLabels,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
  routePurposeLabels,
  routePurposeShortLabels,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { useAuth } from '../../auth/AuthContext';
import { AddressCell } from '../../components/AddressAutoComplete';
import { FileLinkList } from '../../components/FileLinks';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
import { ResponsibleValue } from '../../components/ResponsibleFields';
import { UserAvatar } from '../../components/UserAvatar';
import { ViewModal } from '../../components/ViewModal';
import { PrintWaybillButton } from '../../components/WaybillPrint';
import { useIsMobile } from '../../hooks/useIsMobile';
import { calendarDaysLabel } from '../../utils/date';
import { formatDateTime, formatDateTimeMaybe, formatMoney } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Карточка заявки на технику: поля только на чтение и история событий (ADR 0015). Открывается
 * кнопкой в «Действиях» — в таблице колонок на всё не хватает, а автор, адреса и то, кто и когда
 * заявку правил, нужны не в списке, а при разборе конкретной заявки. Правка — отдельным окном,
 * той же формой. Устроена как карточка заявки на вывоз (ADR 0012), только предъявлять при
 * закрытии здесь нечего: машин и талонов у заявок на технику нет.
 */
interface Props {
  /** null — окно закрыто; поля берутся из строки списка, отдельный запрос за ними не нужен. */
  request: VehicleRequestDto | null;
  onClose: () => void;
  /** Не передана — правка этой заявки недоступна (роль, статус или архив). */
  onEdit?: (r: VehicleRequestDto) => void;
  /**
   * Сменить назначенную машину (ADR 0048). Не передана — действие этой заявке недоступно: у
   * «Новой» машину назначает перевод в работу, у закрытой её уже не меняют, а подбирает технику
   * не всякий, кто заявку видит. Кнопка стоит здесь, потому что здесь же поле «Техника»: видеть
   * значение и не иметь, чем его изменить, — ровно то, из-за чего действие и появилось.
   */
  onReassign?: (r: VehicleRequestDto) => void;
  /**
   * Перенести заявку в другой рейс (ADR 0052). Не передана — действие недоступно: рейсами
   * распоряжается тот, кто ведёт маршруты, а карточку заявки читают многие. Кнопка стоит рядом
   * со строкой «Маршрут» по той же причине, что и «Сменить технику» рядом с техникой.
   */
  onTransfer?: (r: VehicleRequestDto) => void;
  /**
   * Завести перегон техники: доставку на объект или вывоз с него (миграция 0082). Не передан —
   * заводить нечем: заявка не в работе, машины на ней нет либо у роли нет прав на рейсы.
   */
  onRelocate?: (r: VehicleRequestDto, purpose: 'delivery' | 'pickup') => void;
  /**
   * Кнопки решения по досрочному завершению (ADR 0044). Функция, а не флаг: доступность зависит
   * и от роли, и от состояния запроса, и знает об этом вкладка, а не карточка. Не передана —
   * карточка показывает запрос на чтение, как и всё остальное в ней.
   */
  earlyEndActions?: (r: VehicleRequestDto) => ReactNode;
}

/**
 * Запрос на досрочное завершение: до какого числа просят сократить срок, почему, кто попросил и
 * чем кончилось. Причина здесь обязательна к показу — по ней и принимают решение; отказ без
 * причины оставил бы заявку на прежнем сроке без объяснений.
 */
function EarlyEndDetails({
  earlyEnd,
  actions,
}: {
  earlyEnd: VehicleRequestEarlyEndDto;
  actions?: ReactNode;
}) {
  return (
    <div style={{ lineHeight: 1.6 }}>
      <Space size={8} wrap>
        <Tag color={vehicleEarlyEndStatusColors[earlyEnd.status]} style={{ marginInlineEnd: 0 }}>
          {vehicleEarlyEndStatusLabels[earlyEnd.status]}
        </Tag>
        <span>
          {formatDateOnly(earlyEnd.previousDateTo)} → {formatDateOnly(earlyEnd.newDateTo)}
        </span>
        {earlyEndDaysSaved(earlyEnd.previousDateTo, earlyEnd.newDateTo) != null && (
          <Typography.Text type="secondary">
            освобождается {earlyEndDaysSaved(earlyEnd.previousDateTo, earlyEnd.newDateTo)} дн.
          </Typography.Text>
        )}
      </Space>
      <div>
        <Typography.Text type="secondary">
          {earlyEnd.requestedByName} · {formatDateTime(earlyEnd.requestedAt)} — {earlyEnd.reason}
        </Typography.Text>
      </div>
      {earlyEnd.decidedAt && (
        <div>
          <Typography.Text type="secondary">
            {earlyEnd.status === 'approved' ? 'Согласовал' : 'Отклонил'}{' '}
            {earlyEnd.decidedByName ?? '—'} · {formatDateTime(earlyEnd.decidedAt)}
            {earlyEnd.decisionComment ? ` — ${earlyEnd.decisionComment}` : ''}
          </Typography.Text>
        </div>
      )}
      {actions && <div style={{ marginTop: 8 }}>{actions}</div>}
    </div>
  );
}

function toRows(history: RequestHistoryEntryDto[] | undefined): HistoryRow[] {
  return (history ?? []).map((e) => ({ key: e.id, entry: e }));
}

/**
 * Срок: у спецтехники период работы, у грузоперевозки — дата подачи (и время, если задано).
 * К периоду приписано число календарных дней — та же подсказка, что и в форме заявки: по двум
 * датам длину аренды в уме считают с ошибкой, а решают по ней.
 */
function termOf(r: VehicleRequestDto): ReactNode {
  if (r.requestType !== 'special_equipment') {
    return formatDateTimeMaybe(r.scheduledAt, r.scheduledTimeUnspecified);
  }
  const period = r.dateTo
    ? `${formatDateOnly(r.dateFrom)} – ${formatDateOnly(r.dateTo)}`
    : formatDateOnly(r.dateFrom);
  const days = calendarDaysLabel(r.dateFrom, r.dateTo);
  return (
    <Space size={6} wrap>
      <span>{period}</span>
      {days && <Typography.Text type="secondary">{days}</Typography.Text>}
    </Space>
  );
}

export function VehicleRequestViewModal({
  request,
  onClose,
  onEdit,
  onReassign,
  onTransfer,
  onRelocate,
  earlyEndActions,
}: Props) {
  const isMobile = useIsMobile();
  const { can } = useAuth();

  /**
   * Перенос требует обоих прав сразу, как и все операции с рейсами: `vehicleRequests.status` есть
   * и у внешнего арендодателя (ADR 0038), а в подсказке лежат чужие рейсы и фамилии водителей
   * собственного парка.
   */
  const canTransfer = !!onTransfer && can('waybills.read') && can('vehicleRequests.status');
  const { data: history, isPending } = useQuery({
    queryKey: ['vehicle-requests', request?.id, 'history'],
    queryFn: () => vehicleRequestsApi.history(request!.id),
    enabled: !!request,
  });

  /**
   * Лист, выписанный по заявке (ADR 0041): его печатают отсюда, не уходя в журнал — диспетчер
   * взял заявку в работу и тут же отдаёт бланк водителю. Спрашивается только у грузоперевозки:
   * заказ техники на объект путевого листа не знает, и ходить за ним незачем. Права своего нет —
   * значит, персональные данные водителя этой роли не показывают (ADR 0037 п. 13).
   */
  const asksWaybill =
    !!request && request.requestType === 'freight_transport' && can('waybills.read');
  const { data: waybill } = useQuery({
    queryKey: ['vehicle-requests', request?.id, 'waybill'],
    queryFn: () => vehicleRequestsApi.waybill(request!.id),
    enabled: asksWaybill,
  });

  /**
   * Перегоны заявки: доставка техники на объект и вывоз с него (миграция 0082). Спрашиваются у
   * заказа техники на объект — там, где они бывают: у грузоперевозки сам рейс и есть работа.
   * Пусто — перегон не заводили: технику могли привезти тралом, и это законный ход, а не пробел.
   */
  const asksRelocations =
    !!request && request.requestType === 'special_equipment' && can('waybills.read');
  const { data: relocations } = useQuery({
    queryKey: ['vehicle-requests', request?.id, 'relocations'],
    queryFn: () => vehicleRequestsApi.relocations(request!.id),
    enabled: asksRelocations,
  });

  const rows = useMemo(() => toRows(history), [history]);

  const fields = request
    ? [
        {
          key: 'status',
          label: 'Статус',
          children: (
            <Tag color={requestStatusColors[request.status]}>
              {requestStatusLabels[request.status]}
            </Tag>
          ),
        },
        {
          key: 'requestType',
          label: 'Тип заявки',
          children: (
            <Tag color={vehicleRequestTypeColors[request.requestType]}>
              {vehicleRequestTypeLabels[request.requestType]}
            </Tag>
          ),
        },
        {
          // Виза (ADR 0025): в карточке важно не только «есть ли», но и кто согласовал.
          key: 'approval',
          label: 'Согласование',
          span: 3,
          children: request.approvedAt ? (
            <Space size={8}>
              <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
                Завизирована
              </Tag>
              <span>
                {request.approvedByName ?? '—'} · {formatDateTime(request.approvedAt)}
              </span>
            </Space>
          ) : (
            <Tag color="orange" icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
              Ждёт визы руководителя строительства
            </Tag>
          ),
        },
        {
          key: 'customer',
          // Заказчик заявки (ADR 0040): у объекта показывается код, у отдела — тоже свой.
          label: request.departmentId ? 'Отдел' : 'Объект',
          span: 3,
          children: request.departmentId
            ? `${request.departmentCode} — ${request.departmentName}`
            : `${request.objectCode} — ${request.objectName}`,
        },
        // Заказанная позиция классификатора (ADR 0028): категория с её ТТХ, а у типа без
        // характеристик — сам тип.
        {
          key: 'vehicleType',
          label: 'Тип/категория',
          children: vehicleClassificationLabel({
            typeName: request.vehicleTypeName,
            categoryName: request.vehicleCategoryName,
          }),
        },
        // Назначенная техника (ADR 0027): у «Новой» заявки её нет, у остальных это ответ на
        // вопрос «чем и почём» — вместе с тем, кто и когда назначил.
        {
          key: 'assignment',
          label: 'Техника',
          span: 3,
          children: request.assignment ? (
            <Space direction="vertical" size={2}>
              <Space size={8} wrap>
                <span>{assignmentTitle(request.assignment)}</span>
                <Tag color={vehicleOwnershipColors[request.assignment.ownership]}>
                  {vehicleOwnershipLabels[request.assignment.ownership]}
                </Tag>
                {request.assignment.lessorName && <Tag>{request.assignment.lessorName}</Tag>}
                {/* Смена машины — рядом со значением, а не в подвале окна: подвал отвечает за
                    заявку целиком, а меняют здесь одно поле (ADR 0048). */}
                {onReassign && (
                  <Button size="small" onClick={() => onReassign(request)}>
                    Сменить технику
                  </Button>
                )}
              </Space>
              <Typography.Text>
                {assignmentRateLabel(request.assignment) || 'Ставка не указана'}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Назначил {request.assignment.assignedByName || '—'} ·{' '}
                {formatDateTime(request.assignment.assignedAt)}
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">
              Не назначена — заявку ещё не брали в работу
            </Typography.Text>
          ),
        },
        // Рейс, которым заявка едет (ADR 0050). Строка появляется у заявки, стоящей в маршруте:
        // «Маршрут: —» у новой заявки читалось бы как забытый рейс, а у грузоперевозки в работе
        // без маршрута об этом говорит тег в списке. Перенос — рядом со значением, как и смена
        // техники: меняют одно поле, а не заявку целиком (ADR 0052).
        ...(request.route
          ? [
              {
                key: 'route',
                label: 'Маршрут',
                span: 3,
                children: (
                  <Space size={8} wrap>
                    <span>
                      {request.route.displayNumber} · талон {request.route.position}
                    </span>
                    {request.route.hasWaybill ? (
                      <Typography.Text type="secondary">
                        лист выписан — состав рейса заморожен
                      </Typography.Text>
                    ) : (
                      canTransfer && (
                        <Button size="small" onClick={() => onTransfer?.(request)}>
                          Перенести в другой рейс
                        </Button>
                      )
                    )}
                  </Space>
                ),
              },
            ]
          : []),
        // Путевой лист (ADR 0037, печать — ADR 0041). Строка появляется, только когда лист
        // выписан: у аренды его нет вовсе, и «Путевой лист: —» у такой заявки читалось бы как
        // забытый документ. Номер рядом с кнопкой не для красоты — по нему лист ищут в журнале
        // и на бумаге.
        ...(waybill
          ? [
              {
                key: 'waybill',
                label: 'Путевой лист',
                span: 2,
                children: (
                  <Space size={8} wrap>
                    <span>{waybill.number}</span>
                    <Tag color={waybillStatusColors[waybill.status]}>
                      {waybillStatusLabels[waybill.status]}
                    </Tag>
                    <Typography.Text type="secondary">
                      {waybill.driverName} · талон {waybill.slot}
                    </Typography.Text>
                    <PrintWaybillButton waybillId={waybill.id} number={waybill.number}>
                      Печать
                    </PrintWaybillButton>
                  </Space>
                ),
              },
            ]
          : []),
        // Перегоны (миграция 0082): чем и когда технику привезли на объект и увезли с него.
        // Строка появляется, только когда перегон заведён: его может не быть вовсе — технику
        // везут тралом, — и «Перегон: —» читалось бы как забытый документ.
        ...(asksRelocations && (onRelocate || (relocations && relocations.length > 0))
          ? [
              {
                key: 'relocations',
                label: 'Перегон техники',
                span: 3,
                children: (
                  <Space direction="vertical" size={4}>
                    {(relocations ?? []).map((route) => (
                      <Space key={route.id} size={8} wrap>
                        <Tag color={route.purpose === 'delivery' ? 'blue' : 'gold'}>
                          {routePurposeShortLabels[route.purpose]}
                        </Tag>
                        <span>{route.displayNumber}</span>
                        <Typography.Text type="secondary">
                          {formatDateOnly(route.routeDate)} · {route.moveFrom} → {route.moveTo}
                        </Typography.Text>
                        {route.waybill ? (
                          <>
                            <Tag color={waybillStatusColors[route.waybill.status]}>
                              {route.waybill.number}
                            </Tag>
                            <PrintWaybillButton
                              waybillId={route.waybill.id}
                              number={route.waybill.number}
                            >
                              Печать
                            </PrintWaybillButton>
                          </>
                        ) : (
                          <Typography.Text type="secondary">
                            лист не выписан — выпишите его в карточке маршрута
                          </Typography.Text>
                        )}
                      </Space>
                    ))}
                    {/* Заводить перегон предлагается, а не требуется: технику могут привезти
                      тралом — тогда листа не бывает вовсе. Уже заведённый второй раз не
                      предлагается: доставка и вывоз бывают по одному разу на заявку. */}
                    {onRelocate && (
                      <Space size={8} wrap>
                        {(['delivery', 'pickup'] as const)
                          .filter((purpose) => !relocations?.some((r) => r.purpose === purpose))
                          .map((purpose) => (
                            <Button
                              key={purpose}
                              size="small"
                              onClick={() => onRelocate(request, purpose)}
                            >
                              {routePurposeLabels[purpose]}
                            </Button>
                          ))}
                      </Space>
                    )}
                  </Space>
                ),
              },
            ]
          : []),
        // Факт выполнения (ADR 0029): «сколько отработали и сколько это стоило». Есть только у
        // закрытой фактом заявки — у отменённой его не бывает, у выполненной раньше не восстановить.
        ...(request.completion
          ? [
              {
                key: 'completion',
                label: 'Выполнение',
                span: 3,
                children: (
                  <Space direction="vertical" size={2}>
                    <Space size={8} wrap>
                      <Typography.Text strong>
                        {formatMoney(request.completion.totalCost)}
                      </Typography.Text>
                      <Typography.Text>{completionLabel(request.completion)}</Typography.Text>
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Закрыл {request.completion.completedByName || '—'} ·{' '}
                      {formatDateTime(request.completion.completedAt)}
                    </Typography.Text>
                  </Space>
                ),
              },
            ]
          : []),
        {
          key: 'term',
          label: request.requestType === 'special_equipment' ? 'Период работы' : 'Подача',
          children: termOf(request),
        },
        // Досрочное завершение (ADR 0044): карточка — то место, где решают по запросу, потому
        // что решают, прочитав причину, а она только здесь. Строка стоит сразу под сроком: она
        // о нём и говорит.
        ...(request.requestType === 'special_equipment' && request.earlyEnd
          ? [
              {
                key: 'earlyEnd',
                label: 'Досрочное завершение',
                span: 3,
                children: (
                  <EarlyEndDetails
                    earlyEnd={request.earlyEnd}
                    actions={earlyEndActions?.(request)}
                  />
                ),
              },
            ]
          : []),
        // Кто встречает технику на объекте (миграция 0062): у грузоперевозки контакт свой на
        // каждом конце маршрута — он стоит ниже, рядом со своим адресом.
        ...(request.requestType === 'special_equipment'
          ? [
              {
                key: 'responsible',
                label: 'Ответственный',
                span: 3,
                children: (
                  <ResponsibleValue
                    name={request.responsibleName}
                    phone={request.responsiblePhone}
                  />
                ),
              },
            ]
          : []),
        // Объём/масса и адреса есть только у грузоперевозки: спецтехника заказывается на срок.
        ...(request.requestType === 'freight_transport'
          ? [
              {
                key: 'amount',
                label: 'Объём / масса',
                span: 3,
                children:
                  [
                    request.volumeM3 != null ? `${request.volumeM3} м³` : null,
                    request.weightTons != null ? `${request.weightTons} т` : null,
                  ]
                    .filter(Boolean)
                    .join(' / ') || '—',
              },
              {
                key: 'loading',
                label: 'Погрузка',
                span: 3,
                // Отметка о верификации адреса (ADR 0006) — та же, что в таблице.
                children: (
                  <AddressCell text={request.loadingLocation} meta={request.loadingAddress} />
                ),
              },
              {
                key: 'loadingResponsible',
                label: 'Ответственный за погрузку',
                span: 3,
                children: (
                  <ResponsibleValue
                    name={request.loadingResponsibleName}
                    phone={request.loadingResponsiblePhone}
                  />
                ),
              },
              {
                key: 'unloading',
                label: 'Разгрузка',
                span: 3,
                children: (
                  <AddressCell text={request.unloadingLocation} meta={request.unloadingAddress} />
                ),
              },
              {
                key: 'unloadingResponsible',
                label: 'Ответственный за разгрузку',
                span: 3,
                children: (
                  <ResponsibleValue
                    name={request.unloadingResponsibleName}
                    phone={request.unloadingResponsiblePhone}
                  />
                ),
              },
            ]
          : []),
        {
          key: 'author',
          label: 'Автор',
          children: (
            <Space size={8}>
              <UserAvatar name={request.createdByName} size="small" />
              <span>{request.createdByName}</span>
            </Space>
          ),
        },
        { key: 'createdAt', label: 'Создана', children: formatDateTime(request.createdAt) },
        ...(request.cancelReason
          ? [
              {
                key: 'cancelReason',
                label: 'Причина отмены',
                span: 3,
                children: request.cancelReason,
              },
            ]
          : []),
        { key: 'comment', label: 'Комментарий', span: 3, children: request.comment || '—' },
      ]
    : [];

  return (
    <ViewModal
      title={request ? `Заявка ${request.displayNumber}` : 'Заявка'}
      open={!!request}
      onClose={onClose}
      width={1000}
      // Окно переоткрывают на соседней заявке — раскрытые строки прошлой истории не её дело.
      destroyOnHidden
      footer={[
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* На телефоне поля идут в одну колонку: в две подпись и значение делят 180 px
              и переносятся по слогам. Набор полей общий — меняется только число колонок. */}
          <Descriptions
            size="small"
            bordered
            // Три колонки на десктопе: окно шире, и в двух его половина оставалась пустой,
            // а карточка всё равно скроллилась. `span: 3` у поля означает «во всю ширину» —
            // раньше ту же роль играла двойка. На телефоне колонка одна, и span не действует.
            column={isMobile ? 1 : 3}
            layout={isMobile ? 'vertical' : 'horizontal'}
            items={fields}
          />

          {request.files.length > 0 && (
            <div>
              <Typography.Text strong>Файлы</Typography.Text>
              <FileLinkList files={request.files} maxNameWidth={420} />
            </div>
          )}

          <div>
            <Typography.Text strong>История</Typography.Text>
            <div style={{ marginTop: 12 }}>
              {isPending ? (
                <Spin size="small" />
              ) : rows.length > 0 ? (
                // Событие строкой: слева баблы статусов, дальше суть и значения изменений.
                <RequestHistoryTable rows={rows} labels={vehicleRequestChangeLabels} />
              ) : (
                <Typography.Text type="secondary">История недоступна</Typography.Text>
              )}
            </div>
          </div>
        </div>
      )}
    </ViewModal>
  );
}
