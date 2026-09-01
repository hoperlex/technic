import { useMemo, useState } from 'react';
import { Alert, App, Button, Descriptions, Space, Tag, Typography } from 'antd';
import { EditOutlined, PlusOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BLANK_WAYBILL_CONFIRM,
  canCorrectRoute,
  canIssueWaybill,
  driverDocumentGapsWarning,
  isRouteEditable,
  canCancelWaybill,
  isRelocationPurpose,
  LINEAR_DAY_DOOR_MESSAGE,
  routeRequestCapacity,
  routePurposeLabels,
  moscowDateKeyOf,
  ROUTE_FROZEN_MESSAGE,
  type VehicleRequestDto,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  WAYBILL_LOCKED_MESSAGE,
  waybillFormShortLabels,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { vehicleRequestsApi, vehicleRoutesApi, waybillsApi } from '../../api/resources';
import { garageKeys } from '@entities/garage';
import { isApiError } from '@shared/api';
import { AutoSelect } from '@shared/ui';
import { EntityLink } from '@shared/ui';
import { ViewModal } from '@shared/ui';
import { PrintWaybillButton } from '../../components/WaybillPrint';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { canOpenRoute, vehicleRequestViewLink } from '../../utils/links';
import { assembleRoute, blockerMessage } from './routeAssembly';
import { useRouteModal } from '@features/route-modal';
import { RoutePointsBlock } from './RoutePointsBlock';
import { RouteRequestRow } from './RouteRequestRow';
import { RouteTaskRowsBlock } from './RouteTaskRowsBlock';
import { formatDateOnly, tripsCountLabel } from './shared';
import { VehicleRouteCorrectionModal } from './VehicleRouteCorrectionModal';
import { VehicleRouteTransferCorrectionModal } from './VehicleRouteTransferCorrectionModal';
import { ackRequiredDetails, confirmWaybillWarnings } from './waybillAckConfirm';

/**
 * Карточка рейса: кто едет, с кем и в каком порядке.
 *
 * Главное в ней — **порядок объезда** (`RoutePointsBlock`, §4.3 плана `docs/route-trips-plan.md`):
 * остановки со стрелками, ролями и ответственными. Состав заявок остался рядом, но роль у него
 * теперь другая — им кладут и вынимают работу, а не задают порядок: порядок печати задают точки
 * (Р11), и стрелки состава, продолжая переставлять талоны, документ бы уже не двигали. Что
 * напечатается в бланке, показывает свёрнутый блок «Задание листа».
 *
 * Выписанный лист карточку замораживает: состав, точки и водитель правятся только до него — бланк
 * уже у водителя, и запись, разошедшаяся с бумагой на руках, хуже отсутствия записи (ADR 0037
 * п. 9). Чтобы пересобрать рейс, лист аннулируют — тем же правом и с той же причиной, что в
 * журнале.
 */

interface Props {
  /** null — окно закрыто. */
  routeId: string | null;
  onClose: () => void;
  /** Список рейсов и список заявок после правки устарели — их обновляет вкладка. */
  onChanged: () => void;
  /**
   * Открыть правку реквизитов рейса: день, водитель, графы шапки. Отдельным окном, а не полями
   * прямо здесь: карточка отвечает на «что за рейс и что с ним делать», и поля ввода посреди
   * состава превратили бы её в форму.
   */
  onEdit?: (route: VehicleRouteDto) => void;
}

export function VehicleRouteModal({ routeId, onClose, onChanged, onEdit }: Props) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const { openRequest, openRoutesList } = useRouteModal();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | undefined>();
  /** Окно коррекции живёт здесь, а не во вкладке: открывают его из карточки и только из неё. */
  const [correcting, setCorrecting] = useState(false);
  /** Талон, который переносят в рейс другого дня задним числом (Р30); `null` — окно закрыто. */
  const [transferring, setTransferring] = useState<VehicleRouteRequestDto | null>(null);

  /*
   * Рейс всегда перечитывается при открытии карточки, а не берётся из кэша (Р18).
   *
   * Версия рейса поднимается не только его собственными дверьми: правка заявки перекладывает её
   * ездки по точкам и поднимает версию **маршрута** — то есть карточка, оставшаяся в кэше со
   * вчерашним номером версии, отдала бы 409 на первое же действие, и человек увидел бы «маршрут
   * изменён» там, где он ничего не менял. Десяти секунд общей свежести (`staleTime` в `main.tsx`)
   * тут мало: между правкой заявки и возвратом в карточку проходит секунда.
   */
  const { data: route, isFetching } = useQuery({
    queryKey: ['vehicle-routes', routeId],
    queryFn: () => vehicleRoutesApi.get(routeId!),
    enabled: !!routeId,
    staleTime: 0,
    refetchOnMount: 'always',
    // Соседняя вкладка портала — тот же случай: заявку правят там, а действие делают здесь.
    refetchOnWindowFocus: true,
  });

  const frozen = !!route && !isRouteEditable(route.waybill?.status ?? null);

  /**
   * Что можно положить в этот рейс: грузоперевозки в работе на собственной технике, поданные в
   * тот же день. Отбор тот же, что проверит сервер, — иначе список предлагал бы заявки, которые
   * он отклонит.
   *
   * Заказанный тип заявки список не сужает (ADR 0059): день машины собирают по объектам, а объекты
   * заказывают разное — самосвал и бортовой. Раньше такая заявка в рейс не вставала, и второй
   * объект приходилось везти отдельным рейсом. Расхождение с машиной рейса помечено в строке.
   *
   * Заявки чужих рейсов входят сюда наравне со свободными: переложить заявку из Р-7 в Р-9 — это
   * одно действие переноса, а не «вынуть и положить» двумя, между которыми заявка висит без
   * маршрута. Не входят только те, чей рейс заморожен выписанным листом: из бумаги, которая у
   * водителя, заявка исчезнуть не может.
   */
  const { data: candidates } = useQuery({
    queryKey: ['vehicle-requests', 'for-route', route?.routeDate],
    queryFn: () =>
      vehicleRequestsApi.list({
        status: 'confirmed',
        requestType: 'freight_transport',
        dateFrom: route!.routeDate,
        dateTo: route!.routeDate,
        page: 1,
        pageSize: 500,
      }),
    enabled: !!route && !frozen,
  });
  const free = (candidates?.items ?? []).filter(
    (r: VehicleRequestDto) =>
      r.assignment?.ownership === 'own' &&
      r.route?.id !== route?.id &&
      !(r.route && r.route.hasWaybill),
  );

  const afterChange = (updated: VehicleRouteDto) => {
    qc.setQueryData(['vehicle-routes', updated.id], updated);
    onChanged();
  };

  /**
   * Отказ словами — и перечитка карточки, когда отказ про версию.
   *
   * 409 у рейса значит одно из двух: версия уехала (кто-то правил рейс или заявку, Р18) либо лист
   * успели выписать (`ROUTE_FROZEN_MESSAGE`). В обоих случаях на экране устаревшее состояние, и
   * оставить его значило бы обречь человека на второй такой же отказ: он нажмёт ту же кнопку с той
   * же версией. Гасится весь ключ целиком — карточка, список рейсов и подсказки маршрутов читают
   * одно и то же.
   */
  const fail = (e: unknown) => {
    message.error(errorMessage(e));
    if (isApiError(e) && e.status === 409) {
      void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
    }
  };

  /** Заявка, выбранная в списке добавления: по её рейсу и различаются «положить» и «перенести». */
  const candidate = free.find((r) => r.id === adding) ?? null;

  const attach = useMutation({
    mutationFn: (requestId: string) => {
      const source = free.find((r) => r.id === requestId)?.route ?? null;
      return vehicleRoutesApi.attach(route!.id, {
        requestId,
        version: route!.version,
        // Перенос — операция над двумя рейсами, и исходный опознаётся парой «кто + версия»:
        // версии нумеруются в каждом рейсе отдельно, и одинокая совпала бы случайно.
        source: source ? { routeId: source.id, version: source.version } : undefined,
      });
    },
    onSuccess: (updated) => {
      setAdding(undefined);
      afterChange(updated);
    },
    onError: fail,
  });

  const detach = useMutation({
    mutationFn: (requestId: string) =>
      vehicleRoutesApi.detach(route!.id, requestId, route!.version),
    onSuccess: afterChange,
    onError: fail,
  });

  /**
   * Одна попытка выписки: задняя дата и подтверждение предупреждений живут в ней вместе (Р21).
   *
   * Вместе, потому что повторяется попытка **целиком**: после 409 портал шлёт тот же запрос с тем
   * же ключом операции и добавленным отпечатком. Разведи их по двум мутациям — и подтверждение
   * задней выписки потеряло бы либо причину, либо ключ, а второй ключ сжёг бы второй номер.
   */
  type IssueAttempt = {
    backdate?: { reason: string; operationId: string };
    acknowledge?: { fingerprint: string };
  };

  const issue = useMutation({
    mutationFn: (attempt: IssueAttempt) =>
      vehicleRoutesApi.issueWaybill(route!.id, {
        version: route!.version,
        ...(attempt.backdate ?? {}),
        ...(attempt.acknowledge ? { acknowledge: attempt.acknowledge } : {}),
      }),
    onSuccess: (updated) => {
      message.success(`Путевой лист ${updated.waybill?.number ?? ''} выписан`);
      afterChange(updated);
    },
    /*
     * 409 `waybill_ack_required` — не ошибка, а вопрос: сервер посчитал предупреждения под
     * блокировкой и ждёт, что человек их прочитает. Показываем список и повторяем ту же попытку с
     * полученным отпечатком. Ответ на повтор снова может оказаться этим же 409 — значит набор
     * успел измениться между показом и нажатием, и человек читает новый список; петли тут нет —
     * каждый круг требует нажатия.
     */
    onError: (e, attempt) => {
      const details = ackRequiredDetails(e);
      // Повторяется **та же** попытка с добавленным подтверждением, а не собранная заново: ключ
      // операции у задней выписки считается по всему телу, и второе тело сервер встретил бы
      // отказом «это не повтор» вместо листа.
      if (details) {
        confirmWaybillWarnings(modal, details, (acknowledge) =>
          issue.mutateAsync({ ...attempt, acknowledge }),
        );
      } else fail(e);
    },
  });

  /**
   * Чего не хватает водителю рейса для бланка (ADR 0064): выписку это не останавливает, но графа
   * СНИЛСа или номера удостоверения останется в листе пустой, а лист с пустой графой
   * недействителен. Вид документа назван водительским жёстко: `driverGaps` его не несёт, а 4-П и
   * форму № 3 возит водитель (ADR 0095).
   */
  const formLabel = route?.formCode ? waybillFormShortLabels[route.formCode] : null;
  const driverGaps = route
    ? driverDocumentGapsWarning(route.driverGaps, 'driver_license', formLabel)
    : null;

  /** Рейс без заявок: лист по нему выписывается пустым бланком (ADR 0071). */
  const blank = !!route && !isRelocationPurpose(route.purpose) && route.requests.length === 0;

  /**
   * Пустые графы спрашиваются подтверждением, а не просто предупреждением над кнопкой: номер
   * бланка расходуется навсегда, и «выписал не глядя» здесь стоит дороже лишнего клика. Там, где
   * с документами всё в порядке, лишнего окна нет — лист выписывается сразу.
   *
   * Пустой бланк спрашивается тем же окном и всегда: задание в нём не печатается вовсе, и «забыл
   * положить заявки» от «выписываю пустой намеренно» отличает только человек.
   */
  const confirmIssue = () => {
    // Прошедший день — своё окно и своя цена (ADR 0101, дыра 1): лист рождается операцией
    // коррекции, и без причины сервер его не выпишет.
    if (past) {
      confirmBackdatedIssue();
      return;
    }
    if (!driverGaps && !blank) {
      issue.mutate({});
      return;
    }
    modal.confirm({
      title: blank ? 'Выписать пустой лист?' : 'Выписать лист с незаполненными графами?',
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          {blank ? BLANK_WAYBILL_CONFIRM : driverGaps} {blank && driverGaps ? `${driverGaps} ` : ''}
          Номер бланка израсходуется: чтобы переписать лист, его придётся аннулировать.
        </Typography.Paragraph>
      ),
      okText: 'Всё равно выписать',
      cancelText: 'Отмена',
      onOk: () => issue.mutateAsync({}),
    });
  };

  /**
   * Выписка на прошедший день (ADR 0101 п. 4, дыра 1 плана).
   *
   * Раньше портал выписывал такой лист молча — та же кнопка, тот же запрос. Теперь это операция:
   * причина обязательна (её спросит сервер и запишет в журнал коррекций и в сам лист, Р35), а ключ
   * идемпотентности придумывается **до** отправки и не меняется, пока открыто окно, — повтор после
   * обрыва связи обязан вернуть тот же номер, а не сжечь следующий (Р31).
   *
   * Отдельным окном, а не полем в карточке: спрашивают его редко, и постоянное поле «причина» у
   * обычной дневной выписки читалось бы как обязательное.
   */
  const confirmBackdatedIssue = () => {
    let reason = '';
    const operationId = crypto.randomUUID();
    modal.confirm({
      title: `Выписать лист за ${route ? formatDateOnly(route.routeDate) : 'прошедший день'}?`,
      content: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            День уже прошёл: лист уйдёт в журнал с меткой коррекции, вашим именем и этой причиной.
            {blank ? ` ${BLANK_WAYBILL_CONFIRM}` : ''}
            {driverGaps ? ` ${driverGaps}` : ''}
          </Typography.Text>
          <textarea
            className="ant-input"
            rows={2}
            aria-label="Причина выписки задним числом"
            placeholder="Например: бумагу выписали в тот день на месте, в портал вносим сегодня"
            onChange={(e) => {
              reason = e.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Выписать задним числом',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await issue.mutateAsync({ backdate: { reason, operationId } });
      },
    });
  };

  const cancelWaybill = useMutation({
    mutationFn: (reason: string) => waybillsApi.cancel(route!.waybill!.id, { reason }),
    onSuccess: async () => {
      message.success('Лист аннулирован — маршрут снова можно править');
      await qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
      // Аннулированный лист остаётся в журнале со своим состоянием: там его и ищут, чтобы понять,
      // почему номер бланка израсходован.
      await qc.invalidateQueries({ queryKey: ['waybills'] });
      await qc.invalidateQueries({ queryKey: garageKeys.root });
      onChanged();
    },
    onError: fail,
  });

  const confirmCancelWaybill = () => {
    let reason = '';
    modal.confirm({
      title: `Аннулировать лист ${route?.waybill?.number}?`,
      content: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Номер бланка сгорит: после правки рейса выпишется новый.
          </Typography.Text>
          <textarea
            className="ant-input"
            rows={2}
            placeholder="Причина: испорчен при печати, сменился водитель…"
            onChange={(e) => {
              reason = e.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Аннулировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await cancelWaybill.mutateAsync(reason);
      },
    });
  };

  const readiness = route
    ? canIssueWaybill({
        purpose: route.purpose,
        driverPersonId: route.driverPersonId,
        // Пустой бланк — право администратора (ADR 0071). Спрашивается тем же правилом, что и на
        // сервере: иначе кнопка обещала бы то, чего ручка не сделает.
        blankAllowed: can('waybills.issueBlank'),
        formCode: route.formCode,
        requests: route.requests,
        sourceRequest: route.sourceRequest,
        waybillStatus: route.waybill?.status ?? null,
      })
    : null;

  /** Перегон техники: состава у него нет, а задание печатается из самого рейса. */
  const relocation = !!route && isRelocationPurpose(route.purpose);

  /**
   * Заявка перегона — отдельной переменной, потому что внутри `onActivate` сужение типа уже не
   * живёт: обработчик зовут потом, и о непустоте поля TS к тому времени ничего не знает.
   */
  const sourceRequest = route?.sourceRequest ?? null;

  /**
   * Собранный день: строки задания, блокеры выписки и подсказки совмещения — из одного чтения точек
   * (§4.3, Р11а). Считается тем же кодом контрактов, каким ответит сервер: два расчёта одного
   * правила разошлись бы на первой правке, и карточка обещала бы не то, что уйдёт в бумагу.
   *
   * `useMemo` не ради скорости: список объезда, блок «Задание листа» и подписи точек читают один и
   * тот же результат, и пересчитывать его трижды на каждый рендер значило бы трижды раскладывать
   * строки по бланку.
   */
  const assembly = useMemo(() => (route ? assembleRoute(route) : null), [route]);

  /**
   * Первый отказ сборки, который выписке не пережить: нарушенный порядок, неразложенная строка,
   * переполненный бланк, непоместившаяся строка (Р11а). Ими выключается кнопка выписки — сервер
   * ответит на них 422, и кнопка, обещающая лист, обещала бы отказ.
   *
   * Водитель отсюда исключён: о нём отвечает `canIssueWaybill` — первым же своим отказом и теми же
   * словами, что покажет подсказка кнопки. Двух формулировок одного пробела быть не должно.
   */
  const blocking = assembly?.blockers.find((item) => item.code !== 'no_driver') ?? null;

  /**
   * Есть ли куда положить ещё одну заявку. Сколько строк задания у рейса, решает его бланк
   * (ADR 0068): у 4-П семь, у формы № 3 — десять.
   */
  const canAddRequest =
    !!route &&
    !relocation &&
    !frozen &&
    route.requests.length < routeRequestCapacity(route.formCode);

  const waybillEditable =
    !!route?.waybill &&
    route.waybill.status === 'issued' &&
    // Лист рейса периода не имеет — граница у него по дню выезда (ЭСМ-2 сюда не попадает: у
    // недели работы машины на площадке рейса нет вовсе).
    canCancelWaybill(route.waybill, moscowDateKeyOf(new Date()));

  /**
   * Коррекция задним числом (ADR 0101, Р2) — кнопка прошедшего дня.
   *
   * Сегодняшнему рейсу она не нужна: пока день не кончился, лист аннулируют обычным порядком, рейс
   * размораживается и правится соседней кнопкой. Прошедший день так не чинится ничем — там и
   * начинается коррекция: своё право, обязательная причина, сгоревший номер.
   *
   * Готовность считается тем же правилом, что и на сервере (`canCorrectRoute`): иначе кнопка
   * обещала бы то, чего ручка не сделает. Выключенная объясняет себя подсказкой — с закрытой
   * заявкой в составе коррекция становится совместной (Р38), и человеку нужно знать, к кому идти.
   */
  const past = !!route && route.routeDate < moscowDateKeyOf(new Date());
  const correction =
    route && past && can('waybills.correct')
      ? canCorrectRoute(route, moscowDateKeyOf(new Date()), {
          unlimited: can('waybills.correctBeyondLimit'),
        })
      : null;

  return (
    <ViewModal
      title={
        route ? `Маршрут ${route.displayNumber} · ${formatDateOnly(route.routeDate)}` : 'Маршрут'
      }
      open={!!routeId}
      onClose={onClose}
      width={720}
      destroyOnHidden
      footer={
        route && (
          <Space wrap>
            {/* Дверь в список рейсов: вкладки, которой в него ходили, больше нет (ADR 0120), и
              карточка — одна из трёх её замен (§3.3 плана `docs/vehicle-routes-modal-plan.md`).
              День рейса передаётся обязательно: пришли из позавчерашнего рейса, и список,
              оставшийся на своём периоде, не показал бы ни его, ни соседей по дню — а именно за
              соседями из карточки и уходят («чем ещё занята эта машина»).

              Слева, а не рядом с «Выписать лист»: тот расходует номер бланка, и переход, стоящий
              с ним плечом к плечу, спорил бы за нажатие с необратимым действием.

              Право спрашивается своим вызовом, хотя карточку без него не открыть вовсе (держатель
              адреса гасит параметр `?route=`). Кнопка ведёт в **список**, закрытый тем же
              `canOpenRoute`, и выводить «раз карточка открыта — значит и список можно» значило бы
              завести правило, верное лишь до первой правки условий доступа. */}
            {canOpenRoute(can) && (
              <Button
                icon={<UnorderedListOutlined />}
                title="Список рейсов на день этого маршрута"
                onClick={() => openRoutesList({ focusDate: route.routeDate })}
              >
                Все маршруты
              </Button>
            )}
            {/* Правка рейса — тем же правом, что и всё остальное в карточке: день переставляют и
              водителя меняют утром того же дня, ради этого карточку чаще всего и открывают. */}
            {onEdit && (
              <Button
                icon={<EditOutlined />}
                disabled={frozen}
                title={frozen ? ROUTE_FROZEN_MESSAGE : 'Изменить дату, водителя и реквизиты'}
                onClick={() => onEdit(route)}
              >
                Редактировать
              </Button>
            )}
            {/* Аннулированный лист печатать нельзя (`canPrintWaybill`) — кнопка о нём и не
              заикается: рейс уже разморожен, и говорить здесь надо о новом бланке, а не о
              списанном номере. */}
            {route.waybill && route.waybill.status !== 'cancelled' && (
              <PrintWaybillButton
                waybillId={route.waybill.id}
                number={route.waybill.number}
                status={route.waybill.status}
              />
            )}
            {correction && (
              <Button
                danger
                disabled={!correction.ok}
                title={
                  correction.ok
                    ? 'Привести рейс к тому, что было на самом деле: машина, водитель, реквизиты'
                    : `${correction.reason}${correction.blocking.length > 0 ? ` (${correction.blocking.join(', ')})` : ''}`
                }
                onClick={() => setCorrecting(true)}
              >
                Исправить исполнение
              </Button>
            )}
            {route.waybill && can('waybills.cancel') && (
              <Button
                danger
                disabled={!waybillEditable}
                // Выключенная кнопка объясняет себя: иначе она читается как поломка.
                title={
                  route.waybill.status === 'cancelled'
                    ? 'Лист уже аннулирован'
                    : waybillEditable
                      ? 'Аннулировать лист'
                      : WAYBILL_LOCKED_MESSAGE
                }
                onClick={confirmCancelWaybill}
              >
                Аннулировать лист
              </Button>
            )}
            <Button
              type="primary"
              loading={issue.isPending}
              disabled={!readiness?.ok || !!blocking}
              title={
                !readiness?.ok
                  ? readiness?.reason
                  : blocking && assembly
                    ? blockerMessage(blocking, assembly)
                    : 'Выписать путевой лист'
              }
              onClick={confirmIssue}
            >
              Выписать лист
            </Button>
          </Space>
        )
      }
    >
      {route && (
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Техника">
              {route.vehicleLabel}
              {route.withTrailer && ` · с прицепом ${route.trailerLabel}`}
            </Descriptions.Item>
            <Descriptions.Item label="Водитель">
              {route.driverName || <Tag color="orange">не назначен</Tag>}
            </Descriptions.Item>
            {/* Перегон: задание ему даёт не состав, а две строки «откуда — куда» (миграция 0082). */}
            {relocation && (
              <Descriptions.Item label={routePurposeLabels[route.purpose]}>
                {route.moveFrom} → {route.moveTo}
                {/* Заявка перегона — тот же переход, что и у состава грузового рейса: у перегона
                  состава нет вовсе, и эта строка — единственное, чем из него попадают в заявку,
                  ради которой технику и везут. Текстом номер держался по прежней причине —
                  заявка жила соседней вкладкой. */}
                {sourceRequest && (
                  <>
                    {' · по заявке '}
                    <EntityLink
                      to={vehicleRequestViewLink(can, sourceRequest.requestId)}
                      title="Открыть заявку"
                      onActivate={() => openRequest(sourceRequest.requestId)}
                    >
                      {sourceRequest.displayNumber}
                    </EntityLink>
                  </>
                )}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Путевой лист">
              {route.waybill ? (
                <Space>
                  {route.waybill.number}
                  <Tag color={waybillStatusColors[route.waybill.status]}>
                    {waybillStatusLabels[route.waybill.status]}
                  </Tag>
                </Space>
              ) : (
                <Typography.Text type="secondary">не выписан</Typography.Text>
              )}
            </Descriptions.Item>
          </Descriptions>

          {frozen && <Alert type="info" showIcon title={ROUTE_FROZEN_MESSAGE} />}
          {!frozen && readiness && !readiness.ok && (relocation || route.requests.length > 0) && (
            <Alert type="warning" showIcon title={readiness.reason} />
          )}
          {/* Пробелы документов водителя — до нажатия «Выписать лист», а не в подтверждении:
            назначить другого человека проще, пока бланк не израсходован. Замороженный рейс
            молчит — там лист уже напечатан, и говорить о пустых графах поздно. */}
          {!frozen && driverGaps && (
            <Alert
              type="warning"
              showIcon
              title="Документы водителя внесены не полностью"
              description={driverGaps}
            />
          )}

          {/* Порядок объезда и задание бланка — только у грузового рейса: перегон везёт одну
            единицу техники по одной заявке, точек у него нет вовсе, а задание печатается из самого
            рейса («откуда — куда» в шапке, миграция 0082). */}
          {!relocation && assembly && (
            <>
              <RoutePointsBlock
                route={route}
                assembly={assembly}
                frozen={frozen}
                onChanged={afterChange}
                onFail={fail}
              />
              <RouteTaskRowsBlock
                route={route}
                formCode={route.formCode}
                assembly={assembly}
                frozen={frozen}
                onChanged={afterChange}
                onFail={fail}
              />
            </>
          )}

          {/* Состав — то, чем в рейс кладут и вынимают работу. Порядка он больше не задаёт:
            строки задания печатаются в порядке точек (Р11), и стрелки переехали туда. Здесь
            остаётся то, что у заявки своё: её состояние, талон и дверь переноса задним числом. */}
          {!relocation && (
            <div>
              {/* Счётчик — просто число заявок, без «из семи»: бумагу меряют строки задания, а не
                заявки (Р11), и заявка с шестью ездками занимает шесть строк из семи, оставаясь в
                этом списке одной. Ёмкость называет блок «Задание листа» — там, где считают то, что
                печатается. */}
              <Typography.Title level={5}>Заявки рейса ({route.requests.length})</Typography.Title>
              {route.requests.length === 0 && (
                <Typography.Paragraph type="secondary">
                  Рейс пуст: положите в него заявку, взятую в работу на эту машину и дату.
                  {can('waybills.issueBlank') &&
                    ' Либо выпишите пустой лист — с машиной, водителем и датой, но без задания.'}
                </Typography.Paragraph>
              )}
              <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                {route.requests.map((item) => (
                  <RouteRequestRow
                    key={item.requestId}
                    item={item}
                    frozen={frozen}
                    busy={detach.isPending}
                    onDetach={() => detach.mutate(item.requestId)}
                    // Готовность считается тем же правилом, что и у коррекции рейса: сервер
                    // спросит его для обоих рейсов, и кнопка не должна обещать того, чем ручка
                    // ответит отказом. Выключенная объясняет себя — с закрытой заявкой в составе
                    // перенос становится совместной работой (Р38).
                    onTransfer={
                      correction
                        ? {
                            disabledReason: correction.ok
                              ? null
                              : `${correction.reason}${correction.blocking.length > 0 ? ` (${correction.blocking.join(', ')})` : ''}`,
                            onClick: () => setTransferring(item),
                          }
                        : null
                    }
                  />
                ))}
              </Space>
            </div>
          )}

          {canAddRequest && (
            <Space orientation="vertical" size={4} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%' }}>
                <AutoSelect
                  style={{ width: '100%' }}
                  value={adding}
                  onChange={(v) => setAdding(v as string)}
                  // Заявка чужого рейса подписана этим рейсом и строкой задания: диспетчер должен
                  // видеть, что забирает её у Р-7, а не берёт со свободных.
                  //
                  // Номера здесь остаются текстом, и это не пропущенное место: `label` опции —
                  // строка, по ней же идёт поиск (`optionFilterProp="label"`), и разметке внутри
                  // неё взяться неоткуда; да и клик по опции принадлежит выбору — ссылка внутри
                  // отняла бы у списка его единственное действие. То же и у предупреждения ниже:
                  // оно говорит о заявке, которую сейчас кладут в рейс, а не о записи состава,
                  // куда ходят смотреть.
                  options={free.map((r) => ({
                    value: r.id,
                    label: [
                      // Адреса — из **первой** ездки (Р2, §9 плана `docs/route-trips-plan.md`): у
                      // заявки своей пары адресов больше нет, а подсказке нужен ориентир «куда
                      // поедем», а не весь заказ. Число ездок стоит рядом, потому что каждая
                      // занимает свою строку задания в бланке (Р11): «6 ездок» объясняет, почему
                      // после этой заявки в семистрочном 4-П остаётся одна строка.
                      r.requestType === 'freight_transport'
                        ? [
                            r.displayNumber,
                            r.trips[0] && `${r.trips[0].fromLocation} → ${r.trips[0].toLocation}`,
                            r.trips.length > 1 && tripsCountLabel(r.trips.length),
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : r.displayNumber,
                      // Заказанный тип заявки — когда он не совпадает с машиной рейса (ADR 0059).
                      // День машины собирают по объектам, а объекты заказывают разное: «заказан
                      // бортовой» в строке объясняет, почему заявка вообще тут оказалась.
                      r.vehicleTypeId !== route.vehicleTypeId
                        ? `заказан ${r.vehicleTypeName}`
                        : null,
                      r.route ? `из ${r.route.displayNumber}, строка ${r.route.position}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }))}
                  showSearch
                  optionFilterProp="label"
                  placeholder={
                    free.length > 0
                      ? 'Заявка в работе — свободная или из другого рейса'
                      : 'Подходящих заявок на эту дату нет'
                  }
                  disabled={free.length === 0}
                />
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  loading={attach.isPending}
                  disabled={!adding}
                  onClick={() => adding && attach.mutate(adding)}
                >
                  {candidate?.route ? 'Перенести' : 'Добавить'}
                </Button>
              </Space.Compact>
              {/* Рейс — источник истины о том, чем едут: заявка, переехавшая сюда с другой
                машины, поедет этой. Об этом говорят до нажатия, а не после. */}
              {candidate?.route && candidate.assignment?.vehicleId !== route.vehicleId && (
                <Typography.Text type="warning">
                  {candidate.displayNumber} поедет машиной этого рейса — {route.vehicleLabel}
                </Typography.Text>
              )}
              {/* Линейных заказов в этом списке нет и не будет: день кладут из карточки заявки, а
                рейс не знает, какой день срока в него ставят (ADR 0100 решение 8). Сказано это
                там, где их стали бы искать, — иначе отсутствие читалось бы как пропажа. */}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {LINEAR_DAY_DOOR_MESSAGE}
              </Typography.Text>
            </Space>
          )}
        </Space>
      )}
      {!route && isFetching && <Typography.Text type="secondary">Загружаем рейс…</Typography.Text>}

      {/* Окно коррекции поверх карточки: за ним остаётся видно рейс, который правят, — состав,
        номер листа и день. Своим окном, а не полями в карточке: цена действия у него другая. */}
      <VehicleRouteCorrectionModal
        route={correcting ? (route ?? null) : null}
        onClose={() => setCorrecting(false)}
        onSaved={(updated) => {
          setCorrecting(false);
          afterChange(updated);
        }}
      />
      {/* Перенос задним числом (Р30): своё окно, потому что сжигает два номера сразу — и оба
        обязано назвать до нажатия. Открывается со стороны источника: талон видно там, где он
        стоит. */}
      <VehicleRouteTransferCorrectionModal
        route={transferring ? (route ?? null) : null}
        request={transferring}
        onClose={() => setTransferring(null)}
        onDone={(result) => {
          setTransferring(null);
          afterChange(result.source);
        }}
      />
    </ViewModal>
  );
}
