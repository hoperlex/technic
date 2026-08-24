import { Button, Input, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  containerOwnerMismatch,
  type FileDto,
  isPricedRequestType,
  type RequestHistoryEntryDto,
  requestStatusColors,
  requestStatusLabels,
  requestTypeColors,
  requestTypeLabels,
  usesContainerGroup,
  usesContainerType,
  wasteFactLabel,
  vehicleVolume,
  type WasteRequestCompletionDto,
  type WasteRequestDto,
  type WasteRequestVehicleDto,
  wasteRequestChangeLabels,
  wasteRequestCommentLines,
  wasteSubjectLabel,
} from '@technic/contracts';
import { wasteRequestsApi } from '../../api/resources';
import { TicketRecognitionBanner, WasteTicketsPanel } from '@features/waste-ticket-review';
import { useAuth } from '../../auth/AuthContext';
import { FileLinkList, FilesButton } from '../../components/FileLinks';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
import { ResponsibleValue } from '../../components/ResponsibleFields';
import { UserAvatar } from '../../components/UserAvatar';
import { ViewFields, ViewModal } from '@shared/ui';
import { formatDateTime, formatDateTimeMaybe, formatMoney } from '../../utils/format';

/**
 * Карточка заявки: поля на чтение и история событий (ADR 0012). Открывается кнопкой в
 * «Действиях» — в таблице колонок на всё не хватает, а автор, цена за м³ и состав машин нужны
 * не в списке, а при разборе конкретной заявки. Правка заявки — отдельным окном, той же формой.
 *
 * Исключение одно: примечание исполнителя (ADR 0053) правится прямо здесь. Оно не часть предмета
 * заявки, и у того, кто его пишет, формы правки может не быть вовсе — у оператора её нет.
 */
interface Props {
  /** null — окно закрыто; поля берутся из строки списка, отдельный запрос за ними не нужен. */
  request: WasteRequestDto | null;
  onClose: () => void;
  /** Не передана — правка этой заявки недоступна (роль, статус или архив). */
  onEdit?: (r: WasteRequestDto) => void;
  /** Не передана — примечание исполнителя этой роли недоступно либо заявка уже закрыта. */
  onSaveOperatorComment?: (r: WasteRequestDto, operatorComment: string) => void;
  savingOperatorComment?: boolean;
}

/**
 * Комментарий заявки: две подписанные строки (ADR 0053) и, если позволено, правка строки
 * исполнителя. Пустое поле — «не сказали ничего»: так примечание и снимают.
 */
function CommentField({
  request,
  onSave,
  saving,
}: {
  request: WasteRequestDto;
  onSave?: (r: WasteRequestDto, operatorComment: string) => void;
  saving?: boolean;
}) {
  const [draft, setDraft] = useState(request.operatorComment);
  // Окно переоткрывают на соседней заявке, а список обновляется после сохранения — черновик
  // следует за самой заявкой, иначе в нём остался бы текст от прошлой.
  useEffect(() => setDraft(request.operatorComment), [request.id, request.operatorComment]);
  const lines = wasteRequestCommentLines(request);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lines.length > 0
        ? lines.map((l) => (
            <div key={l.key}>
              <Typography.Text type="secondary">{l.label}: </Typography.Text>
              {l.text}
            </div>
          ))
        : '—'}
      {onSave && (
        <>
          {/* Своей строкой, а не в ряд с кнопкой: текст многострочный, и кнопка в одной группе с
              ним растягивалась бы на всю высоту поля. */}
          <Input.TextArea
            rows={2}
            maxLength={2000}
            showCount
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Комментарий исполнителя"
          />
          <div style={{ textAlign: 'right' }}>
            <Button
              type="primary"
              loading={saving}
              // Текст не трогали — сохранять нечего: лишняя правка версии заявки сбила бы
              // открытые карточки у соседей.
              disabled={draft.trim() === request.operatorComment}
              onClick={() => onSave(request, draft.trim())}
            >
              Сохранить
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

const secondary = { fontSize: 12 } as const;

/**
 * Чем подтверждено выполнение — у закрытия заявки, а не в теле карточки: и факт вывоза
 * (ADR 0035), и талоны (ADR 0013) предъявляются именно при переходе в «Выполнена», к нему они
 * и цепляются. Состав техники показывается у заявок, закрытых до ADR 0035: новых строк не
 * появляется, но по этим заявку принимали — молчать о них нельзя.
 */
function ClosingFact({
  completion,
  vehicles,
  tickets,
}: {
  completion: WasteRequestCompletionDto | null;
  vehicles: WasteRequestVehicleDto[];
  tickets: FileDto[];
}) {
  return (
    <>
      {completion && (
        <Space size={8} wrap>
          <Typography.Text>
            {/* Единица берётся из самого факта (ADR 0067): мусор меряют объёмом, металлолом —
                весом, и подставить «м³» строкой значило бы соврать в половине карточек. */}
            Вывезено {wasteFactLabel(completion)}
            {completion.totalCost != null ? ` · ${formatMoney(completion.totalCost)}` : ''}
          </Typography.Text>
          {completion.pricePerM3 != null && (
            <Typography.Text type="secondary" style={secondary}>
              по {formatMoney(completion.pricePerM3)}/м³
            </Typography.Text>
          )}
        </Space>
      )}
      {/* Помеченные на удаление остаются в списке зачёркнутыми — иначе снятую машину нечем
          заметить. */}
      {vehicles.map((v) => (
        <Space key={v.id} size={8} wrap>
          <Typography.Text delete={v.isDeleted} type={v.isDeleted ? 'secondary' : undefined}>
            {v.containerTypeName}
            {v.count > 1 ? ` × ${v.count}` : ''} — {vehicleVolume(v)} м³
            {v.amount != null ? ` · ${formatMoney(v.amount)}` : ''}
          </Typography.Text>
          {v.isDeleted && (
            <Typography.Text type="secondary" style={secondary}>
              помечена на удаление
            </Typography.Text>
          )}
        </Space>
      ))}
      {/* Талоны — общий пул заявки (ADR 0024): бумаги за всё закрытие, без деления по машинам.
          Кнопкой: список открывается окном, файлы смотрят по одному. */}
      {tickets.length > 0 && (
        <Space size={8} wrap>
          <Typography.Text>Талоны заявки</Typography.Text>
          <FilesButton files={tickets} title="Талоны заявки" label={`талонов: ${tickets.length}`} />
        </Space>
      )}
    </>
  );
}

/**
 * Чем предъявлен факт выполнения: вывезенным (ADR 0035, ADR 0067) и талонами заявки
 * (ADR 0013, ADR 0024).
 */
function factOf(
  completion: WasteRequestCompletionDto | null,
  vehicles: WasteRequestVehicleDto[],
  tickets: FileDto[],
): string {
  const parts = [
    completion ? wasteFactLabel(completion) : null,
    completion?.totalCost != null ? formatMoney(completion.totalCost) : null,
    // Состав техники — только у закрытий до ADR 0035; у них объёма в факте не было.
    !completion && vehicles.length > 0
      ? `машин: ${vehicles.reduce((acc, v) => acc + v.count, 0)}`
      : null,
    tickets.length > 0 ? `талонов: ${tickets.length}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function buildRows(
  history: RequestHistoryEntryDto[] | undefined,
  completion: WasteRequestCompletionDto | null,
  vehicles: WasteRequestVehicleDto[],
  tickets: FileDto[],
): HistoryRow[] {
  const entries = history ?? [];
  // Повторное закрытие (после отката) — последнее слово о факте, к нему его и цепляем.
  const closingIndex = entries.findLastIndex((e) => e.kind === 'status' && e.toStatus === 'done');
  // Закрытие без факта и талона (контейнерная операция, талон донесут позже) не должно
  // раскрываться в пустоту — тогда факта у строки просто нет.
  const hasFact = completion != null || vehicles.length > 0 || tickets.length > 0;
  const fact: Partial<HistoryRow> = hasFact
    ? {
        fact: factOf(completion, vehicles, tickets),
        details: <ClosingFact completion={completion} vehicles={vehicles} tickets={tickets} />,
      }
    : {};
  const rows = entries.map<HistoryRow>((e, i) => ({
    key: e.id,
    entry: e,
    ...(i === closingIndex ? fact : {}),
  }));
  // Талоны без закрытия означают обрезанную историю, а машины у незакрытой заявки остались от
  // прежнего порядка (их заводили и правкой) — без такой строки и то, и другое просто пропало бы.
  if (closingIndex < 0 && hasFact) {
    rows.push({
      key: 'fact',
      entry: null,
      tag: vehicles.length > 0 ? 'Машины' : 'Талоны',
      ...fact,
    });
  }
  return rows;
}

export function WasteRequestViewModal({
  request,
  onClose,
  onEdit,
  onSaveOperatorComment,
  savingOperatorComment,
}: Props) {
  // Право разбора талонов (ADR 0114, Р25). Оно же управляет видимостью замечаний и журнала
  // попыток: у внешнего исполнителя есть право закрывать заявку, но не проверять собственную бумагу.
  const { can } = useAuth();
  const canReviewTickets = can('wasteRequests.ticketReview');

  const { data: history, isPending } = useQuery({
    queryKey: ['waste-requests', request?.id, 'history'],
    queryFn: () => wasteRequestsApi.history(request!.id),
    enabled: !!request,
  });

  /**
   * Блок «объём — тип мусора — стоимость» показывается по самим данным, а не по типу заявки:
   * тарифицируется только вывоз (ADR 0019), но у замены и снятия, заведённых до
   * этого решения, цена сохранена — прятать её значило бы потерять историю сумм.
   */
  const priced =
    request != null && (isPricedRequestType(request.requestType) || request.amount != null);
  const rows = useMemo(
    () =>
      buildRows(
        history,
        request?.completion ?? null,
        request?.vehicles ?? [],
        request?.tickets ?? [],
      ),
    [history, request?.completion, request?.vehicles, request?.tickets],
  );

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
            <Tag color={requestTypeColors[request.requestType]}>
              {requestTypeLabels[request.requestType]}
            </Tag>
          ),
        },
        {
          key: 'object',
          label: 'Объект',
          full: true,
          children: `${request.objectCode} — ${request.objectName}`,
        },
        {
          key: 'delivery',
          label: 'Доставка',
          children: formatDateTimeMaybe(request.deliveryAt, request.deliveryTimeUnspecified),
        },
        {
          key: 'operator',
          label: 'Оператор вывоза',
          children: request.operatorName ?? 'не назначен',
        },
        // Кто принимает машину на площадке (миграция 0062): по этому телефону звонят с подъезда.
        {
          key: 'responsible',
          label: 'Ответственный',
          children: (
            <ResponsibleValue name={request.responsibleName} phone={request.responsiblePhone} />
          ),
        },
        // Контейнер — предмет только контейнерных операций: вывоз заказывает объём и технику не
        // называет (ADR 0022), а у металлолома нет и объёма (ADR 0067). У заявок вывоза,
        // заведённых раньше, тип в базе остался, но строка о нём в карточке говорила бы о поле,
        // которого у этого типа заявки больше нет.
        ...(usesContainerType(request.requestType)
          ? [
              {
                key: 'containerType',
                label: 'Контейнер / машина',
                // Количество — частью предмета: «Контейнер 8 м³ × 2» (ADR 0054).
                children: wasteSubjectLabel(request),
              },
            ]
          : []),
        // Чей контейнер трогает заявка и не расходится ли это с исполнителем (ADR 0054).
        // Только у замены и снятия: у остальных типов контейнер на площадке не стоит.
        ...(usesContainerGroup(request.requestType)
          ? [
              {
                key: 'containerOwner',
                label: 'Владелец контейнера',
                full: true,
                children: containerOwnerMismatch(request) ? (
                  <Typography.Text type="warning">
                    {`${request.containerOwnerName ?? 'не указан'} — вывозит «${request.operatorName ?? '—'}»`}
                  </Typography.Text>
                ) : (
                  (request.containerOwnerName ?? 'не указан')
                ),
              },
            ]
          : []),
        ...(priced
          ? [
              {
                key: 'volume',
                label: 'Объём',
                children: request.volumeM3 != null ? `${request.volumeM3} м³` : '—',
              },
              { key: 'wasteType', label: 'Тип мусора', children: request.wasteTypeName ?? '—' },
              {
                key: 'amount',
                label: 'Стоимость',
                children:
                  request.amount == null ? (
                    // Заявка заведена, когда цены на этот тип мусора в прайсе не было (ADR 0046).
                    // Прочерк тут читался бы как «поле не заполнили» — сказано, почему пусто.
                    // У заявок старше тарификации нет и типа мусора: там сказать нечего.
                    request.wasteTypeId == null ? (
                      '—'
                    ) : (
                      <Typography.Text type="warning">
                        тариф не задан — стоимость не рассчитана
                      </Typography.Text>
                    )
                  ) : (
                    <div style={{ lineHeight: 1.3 }}>
                      {/* Без исполнителя цена взята по самому дешёвому прайсу (ADR 0026):
                          «от» показывает, что назначение оператора её уточнит. */}
                      <div>
                        {request.operatorCounterpartyId ? '' : 'от '}
                        {formatMoney(request.amount)}
                      </div>
                      {request.pricePerM3 != null && (
                        <Typography.Text type="secondary" style={secondary}>
                          {formatMoney(request.pricePerM3)}/м³
                        </Typography.Text>
                      )}
                    </div>
                  ),
              },
            ]
          : []),
        // Факт выполнения (ADR 0035): что вывезли и во сколько это обошлось. Его сумма и есть то,
        // что заявка стоила — цена выше плановая, по заявленному объёму. Состав техники прошлых
        // закрытий сюда не поднимается: он в истории, у самого закрытия.
        ...(request.completion
          ? [
              {
                key: 'hauled',
                label: 'Вывезено',
                full: true,
                children: (
                  <div style={{ lineHeight: 1.3 }}>
                    <div>
                      {wasteFactLabel(request.completion)}
                      {request.completion.totalCost != null
                        ? ` · ${formatMoney(request.completion.totalCost)}`
                        : ''}
                    </div>
                    {request.completion.totalCost != null &&
                      request.amount != null &&
                      request.completion.totalCost !== request.amount && (
                        <Typography.Text type="secondary" style={secondary}>
                          заявка оформлялась на {formatMoney(request.amount)}
                        </Typography.Text>
                      )}
                    {request.completion.totalCost == null && (
                      <Typography.Text type="secondary" style={secondary}>
                        стоимость не указана — цены в прайсе не было
                      </Typography.Text>
                    )}
                  </div>
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
                full: true,
                children: request.cancelReason,
              },
            ]
          : []),
        {
          key: 'comment',
          label: 'Комментарий',
          full: true,
          children: (
            <CommentField
              request={request}
              onSave={onSaveOperatorComment}
              saving={savingOperatorComment}
            />
          ),
        },
      ]
    : [];

  return (
    <ViewModal
      title={request ? `Заявка № ${request.displayNumber}` : 'Заявка'}
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
          {/* Раскладка — забота карточки: поля говорят только, годится ли им доля строки
              (`full`). Число колонок и их ширины считает ViewFields, на телефоне колонка одна. */}
          <ViewFields items={fields} />

          {request.files.length > 0 && (
            <div>
              <Typography.Text strong>Файлы</Typography.Text>
              <FileLinkList files={request.files} maxNameWidth={420} />
            </div>
          )}

          {/* Талоны стоят отдельным блоком от документов заявки: это не сопроводительная
              бумага, а подтверждение вывоза (ADR 0013). С ADR 0024 список общий у заявки
              любого типа — по машинам талоны не делятся. */}
          {/* Блок показывается и когда талонов нет вовсе — если заявка выполнена. Бумага должна
              быть: сверка объёма считает «в талонах 0 м³ против 40 в закрытии» и без единого
              файла, а спрятанный блок означал бы посчитанное и никому не показанное замечание. */}
          {(request.tickets.length > 0 || (canReviewTickets && request.status === 'done')) && (
            <div>
              <Typography.Text strong>Талоны</Typography.Text>
              {/* Разбор показывается только с правом `ticketReview` (ADR 0114, Р25): распознанные
                  значения — такой же результат сверки, как и замечания, и видеть их проверяемому
                  незачем. Без права карточка остаётся прежней: список файлов и просмотр. */}
              {canReviewTickets ? (
                <div style={{ marginTop: 12 }}>
                  <TicketRecognitionBanner enabled />
                  {/* Списка файлов здесь больше нет: панель показывает те же сканы, но рядом с
                      номерами найденных в них талонов. Два списка одних и тех же файлов, один из
                      которых знает про разбор, а другой нет, — приглашение читать не тот. */}
                  <WasteTicketsPanel requestId={request.id} />
                </div>
              ) : (
                <FileLinkList files={request.tickets} maxNameWidth={420} />
              )}
            </div>
          )}

          <div>
            <Typography.Text strong>История</Typography.Text>
            <div style={{ marginTop: 12 }}>
              {isPending ? (
                <Spin size="small" />
              ) : rows.length > 0 ? (
                // Событие строкой: слева баблы статусов, дальше суть и значения изменений.
                <RequestHistoryTable
                  rows={rows}
                  labels={wasteRequestChangeLabels}
                  // Машины и талоны на телефоне раскрыты сразу: за ними карточку и открывают.
                  defaultExpandedKeys={rows.filter((r) => r.details).map((r) => r.key)}
                />
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
