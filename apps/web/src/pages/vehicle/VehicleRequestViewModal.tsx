import { Button, Space, Spin, Table, Tabs, Tag, Typography } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { type ReactNode, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  assignmentRateLabel,
  assignmentTitle,
  completionLabel,
  earlyEndDaysSaved,
  formatWeeklyRequestNumber,
  isVehicleSubstitution,
  type RequestHistoryEntryDto,
  requestCargoTotal,
  requestStatusColors,
  requestStatusLabels,
  tripCargoLabel,
  type VehicleRequestDto,
  type VehicleRequestTripDto,
  type VehicleRequestEarlyEndDto,
  vehicleClassificationLabel,
  vehicleEarlyEndStatusColors,
  vehicleEarlyEndStatusLabels,
  vehicleOwnershipColors,
  vehicleOwnershipLabels,
  vehicleRequestChangeLabels,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
  vehicleSubstitutionHint,
  vehicleSubstitutionOf,
  routePurposeLabels,
  routePurposeShortLabels,
  waybillStatusColors,
  waybillStatusLabels,
  weeklyWeekLabel,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { useAuth } from '../../auth/AuthContext';
import { AddressCell } from '@entities/address';
import { FileLinkList } from '../../components/FileLinks';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
import { ResponsibleValue } from '../../components/ResponsibleFields';
import { UserAvatar } from '../../components/UserAvatar';
import { useIsMobile } from '@shared/lib';
import { EntityLink } from '@shared/ui';
import { ViewFields, ViewModal } from '@shared/ui';
import { canOpenRoute, vehicleRequestLink, vehicleRouteLink, waybillLink } from '../../utils/links';
import { PrintWaybillButton } from '../../components/WaybillPrint';
import { PhoneLink } from '../../components/PhoneField';
import { calendarDaysLabel } from '../../utils/date';
import { formatDate, formatDateTime, formatDateTimeMaybe, formatMoney } from '../../utils/format';
import { formatDateOnly, tripsCountLabel } from './shared';
import { useRouteModal } from './routeModal';
import { VehicleRequestDays } from './VehicleRequestDays';
import { VehicleShiftsView } from './VehicleShiftsView';
import { weeklyRequestPath } from './weeklyShared';

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
   * Выписать недельный ЭСМ-2 по требованию (ADR 0100 решение 6). Не передана — выписывать нечем:
   * у обычного заказа листы портал выписывает сам, у линейного — только пока он в работе на
   * собственной машине, и распоряжается бланками не всякий, кто карточку читает. Кнопка стоит у
   * списка листов по той же причине, что «Сменить технику» у техники: видеть документы и не
   * иметь, чем выписать недостающий, — ровно то, из-за чего действие и появилось.
   */
  onIssueEsm2?: (r: VehicleRequestDto) => void;
  /**
   * Кнопки решения по досрочному завершению (ADR 0044). Функция, а не флаг: доступность зависит
   * и от роли, и от состояния запроса, и знает об этом вкладка, а не карточка. Не передана —
   * карточка показывает запрос на чтение, как и всё остальное в ней.
   */
  earlyEndActions?: (r: VehicleRequestDto) => ReactNode;
  /**
   * Читалка: карточку открыли окном поверх чужого экрана — из состава рейса, задания листа,
   * журнала листов или гаража (план «маршрут и заявка окнами», §3.5). Действия за этим окном не
   * ведут: каждое тянет своё окно вкладки заявок (`VehicleAssignModal` и ещё пять), и провайдер,
   * взявший их на себя, стал бы половиной вкладки. За ними ведёт кнопка футера «Открыть в списке
   * заявок».
   *
   * Отдельный флаг, а не одно лишь «не передавать действия»: пропами закрыто не всё. Вкладка «Дни
   * работ» монтируется карточкой безусловно, а планирование дня и снятие его с рейса живут внутри
   * `VehicleRequestDays` своими мутациями — и открыты ровно тем же правом, каким открывается рейс
   * (`vehicleRequests.status && waybills.read`). Диспетчер, заглянувший в заявку из рейса, получил
   * бы там рабочий планировщик, ничего для этого не сделав.
   *
   * Что режим НЕ прячет — решено планом явно, чтобы не решать по ходу кода:
   * — вкладка «Дни работ» остаётся (беднее списочной карточки читалке быть незачем: «каким рейсом
   *   едет какой день» и есть вопрос, ради которого заявку из рейса открывают);
   * — печать путевого листа остаётся: печать бумаги — чтение, а `waybills.read` у открывшего рейс
   *   заведомо есть.
   */
  readOnly?: boolean;
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

/** Конец ездки в таблице: адрес с отметкой верификации и тот, кто встречает на этом конце. */
function TripEnd({
  location,
  meta,
  name,
  phone,
}: {
  location: string;
  meta: VehicleRequestTripDto['fromAddress'];
  name: string;
  phone: string;
}) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <AddressCell text={location} meta={meta} />
      <div style={{ fontSize: 12 }}>
        <ResponsibleValue name={name} phone={phone} />
      </div>
    </div>
  );
}

/**
 * Ездки заявки таблицей (Р1, §9 плана `docs/route-trips-plan.md`) — строкой на ездку, в порядке
 * их номеров.
 *
 * Показывается только там, где ездок больше одной: заявка с единственной (а до плана такими были
 * все — Р24) называет её парой полей «Погрузка/Разгрузка», как называла всегда. Таблица на одну
 * строку — это шапка, рамка и полоса прокрутки ради того, что помещается в два поля карточки.
 *
 * Порядка объезда здесь нет и быть не может: он принадлежит рейсу, а не заказу (Р1), и спрашивают
 * его у карточки маршрута. Эта таблица отвечает на «что заказчик просил везти», а не «в каком
 * порядке машина это объедет».
 *
 * Правки в ней нет и не будет: ездки правятся формой заявки (§4.1, `RequestTripsBlock`), а
 * карточка отвечает на «что заказано» — второй редактор того же списка разошёлся бы с первым.
 */
function RequestTripsTable({ trips }: { trips: VehicleRequestTripDto[] }) {
  return (
    <Table<VehicleRequestTripDto>
      dataSource={trips}
      rowKey="id"
      size="small"
      pagination={false}
      // Адреса длинные, а окно карточки шире не становится: таблица прокручивается вбок сама,
      // не растягивая окно и не ломая раскладку на телефоне (ADR 0030).
      scroll={{ x: 'max-content' }}
      columns={[
        {
          key: 'num',
          title: '№',
          width: 64,
          // Номер ездки внутри заявки, а не позиция в списке: он неизменяем и не переиспользуется
          // (Р13а), и ровно им ездка названа в выданном листе — «ТС-40/2».
          render: (_v, t) => t.num,
        },
        {
          key: 'from',
          title: 'Погрузка',
          render: (_v, t) => (
            <TripEnd
              location={t.fromLocation}
              meta={t.fromAddress}
              name={t.fromResponsibleName}
              phone={t.fromResponsiblePhone}
            />
          ),
        },
        {
          key: 'to',
          title: 'Разгрузка',
          render: (_v, t) => (
            <TripEnd
              location={t.toLocation}
              meta={t.toAddress}
              name={t.toResponsibleName}
              phone={t.toResponsiblePhone}
            />
          ),
        },
        {
          key: 'cargo',
          title: 'Груз',
          width: 160,
          // Подпись груза — та же, что печатает бланк (`tripCargoLabel`): расхождение единиц между
          // карточкой и листом означало бы спор о том, что везли. Примечание ездки идёт второй
          // строкой — это оно объясняет «песок, звонить за час».
          render: (_v, t) => (
            <div style={{ lineHeight: 1.35 }}>
              <div>{tripCargoLabel(t) || '—'}</div>
              {!!t.comment && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.comment}
                </Typography.Text>
              )}
            </div>
          ),
        },
        {
          key: 'scheduledAt',
          title: 'Подача',
          width: 150,
          // Своё время ездки (Р3) — уточняющее: пусто значит «как у заявки», и подписано это
          // словами. Прочерк читался бы как «времени нет вовсе», а оно есть — заявкино.
          render: (_v, t) =>
            t.scheduledAt ? (
              formatDateTime(t.scheduledAt)
            ) : (
              <Typography.Text type="secondary">как у заявки</Typography.Text>
            ),
        },
      ]}
    />
  );
}

export function VehicleRequestViewModal({
  request,
  onClose,
  onEdit,
  onReassign,
  onTransfer,
  onRelocate,
  onIssueEsm2,
  earlyEndActions,
  readOnly,
}: Props) {
  const { can } = useAuth();
  const isMobile = useIsMobile();
  const { openRoute, openRoutesList } = useRouteModal();
  /**
   * Рейс, открытый под нами: заявку читают поверх карточки её же рейса (`?route=X&request=Y`),
   * и тогда номер этого рейса в карточке рисуется текстом — ссылка открывала бы то, что уже лежит
   * под окном (план §3.1, инвариант 3, и §3.5). Во всех прочих случаях переход к рейсу заявку
   * вытесняет, и это забота провайдера, а не карточки.
   *
   * Признак берётся из адреса, а не из React-состояния, потому что адрес и есть состояние окон:
   * второй копии у провайдера нет намеренно — иначе «назад» и экран разошлись бы на первом же
   * переходе. Спрашивается только в читалке: в списочной карточке `route` в адресе — чужой рейс,
   * открытый под самим списком, и заявка к нему отношения не имеет.
   */
  const [params] = useSearchParams();
  const openedRouteId = readOnly ? params.get('route') : null;

  /**
   * Перенос требует обоих прав сразу, как и все операции с рейсами: `vehicleRequests.status` есть
   * и у внешнего арендодателя (ADR 0038), а в подсказке лежат чужие рейсы и фамилии водителей
   * собственного парка.
   */
  const canTransfer = !!onTransfer && can('waybills.read') && can('vehicleRequests.status');

  /**
   * «Все маршруты» — одна из трёх дверей в список рейсов (план «маршрут и заявка окнами»): рядом
   * со строкой «Маршрут», в тулбаре раздела и в карточке самого рейса. Здесь она стоит потому, что
   * отсюда в список и ходят: посмотреть, чем занята машина в этот день, и найти рейс, в который
   * заявку положить.
   *
   * Право спрашивается то же, каким открывается сам рейс: список — это те же чужие машины и ФИО
   * водителей собственного парка. В читалке кнопки нет вовсе — окно, открытое поверх окна поверх
   * окна, читатель уже не разберёт, а список рейсов у него под рукой и так (`openRoutesList`
   * зовут оттуда, откуда он заявку открыл).
   */
  const showAllRoutes = !readOnly && canOpenRoute(can);

  /**
   * Куда ведёт «Открыть в списке заявок» — вкладка раздела с открытой карточкой этой же заявки.
   * Считается по уже загруженному DTO, а не по одному статусу: вкладку выбирает и `deletedAt` —
   * удалённая заявка живёт в архиве, — а сам архив закрыт правом `archive.read`. Роли без него
   * функция вернёт `null`, и кнопки в футере не будет вовсе (см. футер).
   */
  const requestListHref =
    request && readOnly
      ? vehicleRequestLink(can, {
          id: request.id,
          status: request.status,
          deleted: !!request.deletedAt,
        })
      : null;
  const { data: history, isPending } = useQuery({
    queryKey: ['vehicle-requests', request?.id, 'history'],
    queryFn: () => vehicleRequestsApi.history(request!.id),
    enabled: !!request,
  });

  /**
   * Контакт водителя — персональные данные путевого листа, поэтому он приходит отдельным
   * запросом и только роли с `waybills.read`. Основной DTO заявки намеренно его не содержит:
   * карточку читают также заказчики со стороны объекта.
   */
  const asksDriver = !!request?.assignment && can('waybills.read');
  const { data: driver, isPending: isDriverPending } = useQuery({
    queryKey: ['vehicle-requests', request?.id, 'driver'],
    queryFn: () => vehicleRequestsApi.driver(request!.id),
    enabled: asksDriver,
  });

  /**
   * Листы, выписанные по заявке (ADR 0041): их печатают отсюда, не уходя в журнал — диспетчер
   * взял заявку в работу и тут же отдаёт бланк. Права своего нет — значит, персональные данные
   * водителя этой роли не показывают (ADR 0037 п. 13).
   *
   * Спрашиваются у заявок обоих видов, а не только у грузоперевозки: заказ техники на объект
   * теперь тоже документ имеет — недельные ЭСМ-2, по листу на каждую неделю срока (миграция
   * 0087). Их и бывает несколько, поэтому список, а не один.
   */
  const asksWaybill = !!request && can('waybills.read');
  const { data: waybills } = useQuery({
    queryKey: ['vehicle-requests', request?.id, 'waybills'],
    queryFn: () => vehicleRequestsApi.waybills(request!.id),
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

  /**
   * Откуда заказ взялся и чем его продлевали (ADR 0085 Р11, Р16). Приходит в самом DTO — второго
   * запроса на это не нужно.
   *
   * Только тем, у кого есть право на раздел: ссылка, ведущая в отказ, хуже номера обычным
   * текстом. И только у заказа техники на объект: недельная заявка грузоперевозки не касается —
   * у той не период работ, а момент подачи.
   */
  const weekly =
    request?.requestType === 'special_equipment' && can('weeklyRequests.read')
      ? {
          origin: request.weeklyOrigin ?? null,
          extensions: request.weeklyExtensions ?? [],
        }
      : null;

  /**
   * Чем назначенная машина разошлась с заказанным (ADR 0045, ADR 0059, ADR 0064) — тегом рядом с
   * техникой. Правило то же, что в окне назначения: одна формулировка на выбор, карточку и историю.
   */
  const assignmentHint = useMemo(() => {
    const a = request?.assignment;
    if (!request || !a) return null;
    const substitution = vehicleSubstitutionOf(
      {
        vehicleKindId: request.vehicleKindId,
        vehicleTypeId: request.vehicleTypeId,
        vehicleCategoryId: request.vehicleCategoryId,
        categorySpecs: request.vehicleCategorySpecs,
      },
      {
        vehicleKindId: a.vehicleKindId,
        vehicleTypeId: a.vehicleTypeId,
        vehicleCategoryId: a.vehicleCategoryId,
        categorySpecs: a.categorySpecs,
      },
    );
    if (!isVehicleSubstitution(substitution)) return null;
    const hint = vehicleSubstitutionHint(substitution);
    return {
      label: [a.categoryName ?? a.typeName, hint].filter(Boolean).join(' · '),
      level:
        // Чужой вид — самое крупное расхождение, и тег у него жёлтый независимо от ТТХ: сравнить
        // их у самосвала с автокраном всё равно нечем.
        substitution.kindMismatch ||
        substitution.relation === 'smaller' ||
        substitution.relation === 'mixed'
          ? 'warning'
          : 'info',
    };
  }, [request]);

  /**
   * Ездки заявки (Р1, Р2): `null` — заказ техники на объект, у которого их не бывает вовсе.
   *
   * Рядом — итог по ним (`requestCargoTotal`, §9) и единственная ездка, если она единственная: от
   * неё зависит, показывает карточка привычную пару адресов или таблицу.
   */
  const trips = request?.requestType === 'freight_transport' ? request.trips : null;
  const total = trips ? requestCargoTotal(trips) : null;
  /**
   * Ездка, которую карточка вправе показать привычной парой полей вместо таблицы: единственная и
   * не несущая ничего, чему в этой паре места нет.
   *
   * Своё время подачи (Р3) и примечание — как раз то, чего пара полей сказать не может, а прятать
   * их нельзя: «во сколько именно эта» и «песок, звонить за час» и есть то, ради чего они
   * заполнены. У всех доехавших бэкфилом ездок оба поля пусты (миграция `0136` их не заполняет), и
   * заявка, заведённая до плана, показывается ровно как показывалась.
   */
  const singleTrip =
    trips && trips.length === 1 && !trips[0]?.scheduledAt && !trips[0]?.comment ? trips[0] : null;
  /**
   * «60 м³ / 5 т · 6 ездок» — количество по всей заявке.
   *
   * Обе единицы печатаются рядом, а не через `tripCargoLabel`: тот отдаёт то, что влезает в графу
   * бланка (объём, а без него массу), и смешанная заявка — часть в кубах, часть в тоннах —
   * потеряла бы в карточке половину заказа. Счёт ездок приписан к итогу, потому что «60 м³» без
   * него не отличить от одной ездки на шестьдесят кубов.
   */
  const amountText = total
    ? [
        [
          total.volumeM3 != null ? `${total.volumeM3} м³` : null,
          total.weightTons != null ? `${total.weightTons} т` : null,
        ]
          .filter(Boolean)
          .join(' / ') || '—',
        total.trips > 1 ? tripsCountLabel(total.trips) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

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
          full: true,
          children: request.approvedAt ? (
            // Подпись — строкой под тегом, а не рядом: в узком окне на ФИО рядом с тегом
            // остаётся столбец в пару букв, и оно переносится по слогам.
            <Space direction="vertical" size={4}>
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
          full: true,
          children: request.departmentId
            ? `${request.departmentCode} — ${request.departmentName}`
            : `${request.objectCode} — ${request.objectName}`,
        },
        // ─── Что заказали: позиция классификатора, срок, кто встречает, а у грузоперевозки —
        // груз и адреса. Заказ стоит выше исполнения: карточку открывают с вопроса «что просили»,
        // а «чем закрыли» отвечает уже на него.
        //
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
        // Заявку застигло переключение признака у типа (миграция 0137): справочник ведёт заказы
        // этого типа уже иначе, а она дорабатывает так, как была заведена. Строка стоит сразу под
        // типом — она о нём и говорит. Без неё диспетчер видит две заявки одного типа, ведущие
        // себя по-разному, и ни одного объяснения на экране.
        ...(request.requestType === 'special_equipment' && request.linearFrozen
          ? [
              {
                key: 'linearFrozen',
                label: 'Режим заказа',
                full: true,
                children: (
                  <Space direction="vertical" size={4}>
                    <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                      прежний режим: {request.linearFrozen.isLinear ? 'по дням' : 'по неделям'}, с{' '}
                      {formatDate(request.linearFrozen.at)}
                    </Tag>
                    <Typography.Text type="secondary">
                      С этого числа тип «{request.vehicleTypeName}» ведёт заказы иначе, а эта заявка
                      дорабатывает так, как заведена:{' '}
                      {request.linearFrozen.isLinear
                        ? 'дни планируются в рейсах, недельные листы ЭСМ-2 портал по ней не выписывает.'
                        : 'ЭСМ-2 портал выписывает по ней сам за каждую неделю срока, дни ей не планируются.'}
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
                full: true,
                children: (
                  <EarlyEndDetails
                    earlyEnd={request.earlyEnd}
                    actions={earlyEndActions?.(request)}
                  />
                ),
              },
            ]
          : []),
        // Недельная заявка, породившая заказ (ADR 0085 Р11). Стоит рядом со сроком: заказ обязан
        // объяснять своё появление, а появился он там же, где решали, что машина останется на
        // площадке ещё на неделю.
        ...(weekly?.origin
          ? [
              {
                key: 'weeklyOrigin',
                label: 'Создан по недельной заявке',
                children: (
                  <EntityLink
                    to={weeklyRequestPath(weekly.origin.weeklyRequestId)}
                    title="Открыть недельную заявку"
                  >
                    {formatWeeklyRequestNumber(weekly.origin.weeklyRequestNum)}
                  </EntityLink>
                ),
              },
            ]
          : []),
        // Продления — отдельной строкой и списком (ADR 0085 Р16): создан заказ ровно одной
        // недельной заявкой, а продлевают его неделю за неделей. Одно поле «Основание» солгало бы
        // на второй же неделе. Рядом с номером — сама неделя: по ней и понимают, за что продление.
        ...(weekly && weekly.extensions.length > 0
          ? [
              {
                key: 'weeklyExtensions',
                label: 'Продления',
                full: true,
                children: (
                  <Space size={12} wrap>
                    {weekly.extensions.map((e) => (
                      <span key={`${e.weeklyRequestId}-${e.weekStart}`}>
                        <EntityLink
                          to={weeklyRequestPath(e.weeklyRequestId)}
                          title="Открыть недельную заявку"
                        >
                          {formatWeeklyRequestNumber(e.weeklyRequestNum)}
                        </EntityLink>{' '}
                        <Typography.Text type="secondary">
                          ({weeklyWeekLabel(e.weekStart)})
                        </Typography.Text>
                      </span>
                    ))}
                  </Space>
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
                children: (
                  <ResponsibleValue
                    name={request.responsibleName}
                    phone={request.responsiblePhone}
                  />
                ),
              },
            ]
          : []),
        // Груз и адреса есть только у грузоперевозки: спецтехника заказывается на срок.
        ...(trips ? [{ key: 'amount', label: 'Объём / масса', children: amountText }] : []),
        // Единственная ездка показывается парой адресов с контактами — ровно тем видом, что был у
        // заявки до плана: заявка с одной ездкой и есть вчерашняя заявка (Р24), и заводить ради
        // неё таблицу в одну строку значило бы менять карточку всем существующим заявкам, ничего
        // им не добавив. Ездки заявки, у которой их несколько, идут таблицей ниже полей.
        ...(singleTrip
          ? [
              {
                key: 'loading',
                label: 'Погрузка',
                full: true,
                // Отметка о верификации адреса (ADR 0006) — та же, что в таблице.
                children: (
                  <AddressCell text={singleTrip.fromLocation} meta={singleTrip.fromAddress} />
                ),
              },
              {
                key: 'loadingResponsible',
                label: 'Ответственный за погрузку',
                children: (
                  <ResponsibleValue
                    name={singleTrip.fromResponsibleName}
                    phone={singleTrip.fromResponsiblePhone}
                  />
                ),
              },
              {
                key: 'unloading',
                label: 'Разгрузка',
                full: true,
                children: <AddressCell text={singleTrip.toLocation} meta={singleTrip.toAddress} />,
              },
              {
                key: 'unloadingResponsible',
                label: 'Ответственный за разгрузку',
                children: (
                  <ResponsibleValue
                    name={singleTrip.toResponsibleName}
                    phone={singleTrip.toResponsiblePhone}
                  />
                ),
              },
            ]
          : []),
        // ─── Чем закрыли: техника, рейс, лист, перегоны, факт выполнения.
        //
        // Назначенная техника (ADR 0027): у «Новой» заявки её нет, у остальных это ответ на
        // вопрос «чем и почём» — вместе с тем, кто и когда назначил.
        {
          key: 'assignment',
          label: 'Техника',
          full: true,
          children: request.assignment ? (
            <Space direction="vertical" size={2}>
              <Space size={8} wrap>
                <span>{assignmentTitle(request.assignment)}</span>
                {/* Чем закрыли заявку, когда это не то, что заказывали (ADR 0045, ADR 0059):
                    позиция классификатора машины плюс направление — «крупнее», «меньше
                    заказанного». Совпало — тега нет: повторять заказ строкой ниже незачем. */}
                {assignmentHint && (
                  <Tag color={assignmentHint.level === 'warning' ? 'orange' : 'gold'}>
                    {assignmentHint.label}
                  </Tag>
                )}
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
              {/* Ставка и человек, который работает на машине, — один уровень ответа «чем и
                  почём выполняют заявку». На узком экране Space перенесёт контакт целиком. */}
              <Space size={[16, 4]} wrap>
                <Typography.Text>
                  {assignmentRateLabel(request.assignment) || 'Ставка не указана'}
                </Typography.Text>
                {asksDriver ? (
                  <Space size={8} wrap>
                    <Typography.Text type="secondary">Водитель:</Typography.Text>
                    {isDriverPending ? (
                      <Spin size="small" />
                    ) : driver ? (
                      <>
                        <span>{driver.fullName}</span>
                        {driver.phone ? (
                          <PhoneLink phone={driver.phone} />
                        ) : (
                          <Typography.Text type="secondary">телефон не указан</Typography.Text>
                        )}
                      </>
                    ) : (
                      <Typography.Text type="secondary">не назначен</Typography.Text>
                    )}
                  </Space>
                ) : null}
              </Space>
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
        // Рейс, которым заявка едет (ADR 0050), и дверь в список рейсов. Строка со значением
        // появляется у заявки, стоящей в маршруте: «Маршрут: —» у новой заявки читалось бы как
        // забытый рейс, а у грузоперевозки в работе без маршрута об этом говорит тег в списке.
        // Перенос — рядом со значением, как и смена техники: меняют одно поле, а не заявку целиком
        // (ADR 0052).
        //
        // У заявки без рейса строка всё же появляется — но только ради «Всех маршрутов» и только
        // тому, кому список положен: искать рейс, в который заявку положить, ходят как раз отсюда.
        // Прочерка в ней нет — вместо него сказано словами, иначе вернулся бы тот самый «забытый
        // рейс», ради которого строку и прятали.
        ...(request.route || showAllRoutes
          ? [
              {
                key: 'route',
                label: 'Маршрут',
                full: true,
                children: (
                  <Space size={8} wrap>
                    {request.route ? (
                      <>
                        <span>
                          {/* Рейс открывается окном поверх карточки, а не уводит на свою вкладку:
                            вопрос «что там за маршрут» задают, стоя в заявке, и ответ не должен
                            стоить экрана, с которого спросили. Ссылкой, а не кнопкой: Ctrl и
                            средний щелчок обязаны по-прежнему открывать рейс соседней вкладкой
                            браузера (`EntityLink`). Рейс, под которым эта карточка и открыта,
                            остаётся текстом — см. `openedRouteId`. */}
                          {request.route.id === openedRouteId ? (
                            request.route.displayNumber
                          ) : (
                            <EntityLink
                              to={vehicleRouteLink(can, request.route.id)}
                              title="Открыть маршрут"
                              onActivate={() => openRoute(request.route!.id)}
                            >
                              {request.route.displayNumber}
                            </EntityLink>
                          )}{' '}
                          · строка {request.route.position}
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
                      </>
                    ) : (
                      <Typography.Text type="secondary">Не поставлена в рейс</Typography.Text>
                    )}
                    {showAllRoutes && (
                      <Button size="small" onClick={() => openRoutesList()}>
                        Все маршруты
                      </Button>
                    )}
                  </Space>
                ),
              },
            ]
          : []),
        // Путевые листы (ADR 0037, печать — ADR 0041). Строка появляется, только когда лист
        // выписан: у аренды его нет вовсе, и «Путевой лист: —» у такой заявки читалось бы как
        // забытый документ. Номер рядом с кнопкой не для красоты — по нему лист ищут в журнале
        // и на бумаге.
        //
        // У заказа техники на объект листов столько, сколько недель в сроке (ЭСМ-2): каждый
        // подписан своей неделей, иначе в списке одинаковых номеров не разобрать, какой из них
        // печатать. Аннулированные остаются в списке — сгоревший номер видно там же, где выдан.
        //
        // У линейного заказа строка появляется и пустой: листов по нему может не быть ни одного —
        // портал их не выписывает, — но выписать недостающий надо откуда-то (ADR 0100 решение 6).
        ...((waybills && waybills.length > 0) || onIssueEsm2
          ? [
              {
                key: 'waybills',
                label: (waybills?.length ?? 0) > 1 ? 'Путевые листы' : 'Путевой лист',
                full: true,
                children: (
                  <Space direction="vertical" size={4}>
                    {(waybills ?? []).map((waybill) => (
                      <Space key={waybill.id} size={8} wrap>
                        {waybill.periodFrom && waybill.periodTo && (
                          <Tag>
                            {formatDateOnly(waybill.periodFrom)} —{' '}
                            {formatDateOnly(waybill.periodTo)}
                          </Tag>
                        )}
                        <span>
                          <EntityLink
                            to={waybillLink(can, waybill.number)}
                            title="Открыть в журнале листов"
                          >
                            {waybill.number}
                          </EntityLink>
                        </span>
                        <Tag color={waybillStatusColors[waybill.status]}>
                          {waybillStatusLabels[waybill.status]}
                        </Tag>
                        <Typography.Text type="secondary">
                          {waybill.driverName}
                          {waybill.periodFrom ? '' : ` · строка ${waybill.slot}`}
                        </Typography.Text>
                        {/* Аннулированный лист печатать нельзя ни отсюда, ни из журнала: номер
                          списан, а бумага от действующего бланка неотличима. Кнопка остаётся
                          выключенной с объяснением — исчезнувшая читалась бы как поломка. */}
                        <PrintWaybillButton
                          waybillId={waybill.id}
                          number={waybill.number}
                          status={waybill.status}
                        >
                          Печать
                        </PrintWaybillButton>
                      </Space>
                    ))}
                    {/* Выписка по требованию (ADR 0100): у линейного заказа лист рождается только
                      этой кнопкой. Пустой список у такой заявки — не пробел, и сказано это
                      словами: иначе он читался бы как забытый документ. */}
                    {onIssueEsm2 && (
                      <Space size={8} wrap>
                        {(waybills?.length ?? 0) === 0 && (
                          <Typography.Text type="secondary">
                            Листов нет — по этой заявке их выписывают по требованию
                          </Typography.Text>
                        )}
                        <Button size="small" onClick={() => onIssueEsm2(request)}>
                          Выписать ЭСМ-2
                        </Button>
                      </Space>
                    )}
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
                full: true,
                children: (
                  <Space direction="vertical" size={4}>
                    {(relocations ?? []).map((route) => (
                      <Space key={route.id} size={8} wrap>
                        <Tag color={route.purpose === 'delivery' ? 'blue' : 'gold'}>
                          {routePurposeShortLabels[route.purpose]}
                        </Tag>
                        {/* Перегон — такой же рейс, как и рабочий, и открывается тем же окном
                          поверх карточки: лист по нему выписывают из карточки маршрута, а
                          подсказка ниже как раз туда и посылает. Номером текстом он оставался
                          только потому, что переход стоил бы ухода на вкладку. */}
                        <span>
                          {route.id === openedRouteId ? (
                            route.displayNumber
                          ) : (
                            <EntityLink
                              to={vehicleRouteLink(can, route.id)}
                              title="Открыть маршрут"
                              onActivate={() => openRoute(route.id)}
                            >
                              {route.displayNumber}
                            </EntityLink>
                          )}
                        </span>
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
                              status={route.waybill.status}
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
                full: true,
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
        { key: 'comment', label: 'Комментарий', full: true, children: request.comment || '—' },
      ]
    : [];

  /** Сама заявка: поля, файлы и её история — то, что карточка показывала до появления вкладок. */
  const main = request && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Раскладка — забота карточки: поля говорят только, годится ли им доля строки
          (`full`). Число колонок и их ширины считает ViewFields, на телефоне колонка одна. */}
      <ViewFields items={fields} />

      {/* Ездки — своим разделом, а не полем карточки: таблица шире доли строки даже с `full`, а
          рядом с «Файлами» и «Историей» она встаёт тем же, чем является, — списком строк заказа.
          Заявка с одной ездкой сюда не доходит: её показала пара полей выше (Р24). */}
      {trips && !singleTrip && (
        <div>
          <Typography.Text strong>Ездки</Typography.Text>
          <div style={{ marginTop: 12 }}>
            <RequestTripsTable trips={trips} />
          </div>
        </div>
      )}

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
  );

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
        // Читалку действия не ведут — вместо них дверь туда, где ведут: в список заявок с
        // открытой карточкой этой же заявки (план §3.5). Адрес считается по уже загруженному
        // DTO, потому что одного статуса мало: удалённая заявка живёт в архиве, и выбирает его
        // `deletedAt`. Он же закрыт своим правом — без `archive.read` адреса не будет вовсе
        // (`vehicleRequestLink` вернёт `null`), и кнопки тогда нет: ссылка, кончающаяся отказом,
        // хуже её отсутствия.
        //
        // Настоящей ссылкой, а не `navigate` по нажатию: список заявок открывают соседней
        // вкладкой, оставив рейс на экране, — тем же приёмом, что и `EntityLink`. Переход при
        // этом уносит из адреса `request` и `route`, и окна закрываются сами: состояние окон
        // живёт только в адресе (§3.1).
        ...(requestListHref
          ? [
              <Link key="list" to={requestListHref}>
                {/* На телефоне кнопки футера делят ширину поровну (`.sheet-footer`), и делит её
                  ссылка, а не кнопка внутри неё: без `block` кнопка осталась бы по тексту, а
                  соседняя «Закрыть» — во всю свою долю. */}
                <Button type="primary" block={isMobile}>
                  Открыть в списке заявок
                </Button>
              </Link>,
            ]
          : []),
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Вкладки появляются только у заказа спецтехники — ровно там, где есть что положить
              на вторую: смены ведутся по дням работ, а у грузоперевозки не период, а момент
              подачи. Прятать за вкладку одну-единственную страницу карточки незачем. */}
          {request.requestType === 'special_equipment' ? (
            <Tabs
              items={[
                { key: 'request', label: 'Заявка', children: main },
                // Дни работ (ADR 0100 решение 8) — вкладка линейного заказа и единственное место,
                // где дни планируют. У обычного заказа их не бывает вовсе: машина стоит на
                // площадке весь срок, и работа считается неделями, а не выездами. Право своё,
                // `waybills.read`: в плане стоят машины и ФИО водителей собственного парка, то
                // есть ровно то, чего заказчику со стороны объекта не показывают (ADR 0037 п. 13).
                ...(request.isLinear && can('waybills.read')
                  ? [
                      {
                        key: 'days',
                        label: 'Дни работ',
                        // Читалка не планирует дни: право на это (`vehicleRequests.status` +
                        // `waybills.read`) совпадает с тем, каким открывается рейс, и без флага
                        // диспетчер, заглянувший в заявку из рейса, получил бы рабочий
                        // планировщик. Сама вкладка остаётся — она и отвечает на «каким рейсом
                        // едет какой день» (план §3.5).
                        children: <VehicleRequestDays request={request} readOnly={readOnly} />,
                      },
                    ]
                  : []),
                {
                  key: 'shifts',
                  label: 'Смены',
                  // Только чтение: подтверждают смены на вкладке «На объекте», где видно, что
                  // стоит на площадке сегодня. Сюда за ними приходят те, кто к площадке
                  // отношения не имеет, — разобрать счёт и спор о часах.
                  children: <VehicleShiftsView requestId={request.id} />,
                },
              ]}
            />
          ) : (
            main
          )}
        </div>
      )}
    </ViewModal>
  );
}
