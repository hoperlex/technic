import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, App, Button, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import type { TableColumnType } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isRouteEditable,
  LINEAR_DAY_FROZEN_MESSAGE,
  type LinearDaySubject,
  planDayBlocker,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDayDto,
  type VehicleRequestDaysDto,
  waybillStatusColors,
  waybillStatusLabels,
  weeklyWeekLabel,
  weekStartKey,
  workedAmountLabel,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { useAuth } from '../../auth/AuthContext';
import { EntityLink } from '@shared/ui';
import { UserAvatar } from '../../components/UserAvatar';
import { errorMessage } from '../../utils/format';
import { vehicleRouteLink, waybillLink } from '../../utils/links';
import { formatDateOnly } from './shared';
import { useRouteModal } from './routeModal';
import { VehicleDayRouteModal } from './VehicleDayRouteModal';

/**
 * «Дни работ» — единственное место, где планируют дни линейного заказа (ADR 0100 решение 8).
 *
 * Линейная техника вечером возвращается на базу, а за день успевает поработать на двух-трёх
 * площадках. Поэтому её заказ ведётся не неделями стояния на объекте, а днями: каждый день срока —
 * отдельный выезд, который кладут в рейс машины на эту дату и печатают в его 4-П.
 *
 * Дверь одна, и она здесь: день знает свой срок и свою заявку, а из карточки маршрута ту же заявку
 * пришлось бы разыскивать по объекту среди всех работающих. Со стороны рейса день виден в составе и
 * снимается оттуда, но не добавляется (`LINEAR_DAY_DOOR_MESSAGE`).
 *
 * Пачки «распланировать неделю» нет намеренно: на разные дни выходят разные машины и разные
 * водители, а пачка умеет ровно одно — повторить один и тот же выбор.
 *
 * Своим файлом, а не блоком карточки заявки: карточка стоит вплотную к своему лимиту длины, а
 * таблица с окном недели, тремя запросами и двумя мутациями — самостоятельная вещь.
 */

/**
 * Ключ таблицы дней. Одной функцией на файл: его знают и запрос, и обе мутации, и разъехавшийся
 * ключ означал бы таблицу, не заметившую собственной правки.
 */
const daysKey = (requestId: string) => ['vehicle-requests', requestId, 'days'];

/** Список заявок: в строке видны рейс и машина дня, и после планирования они устарели. */
const REQUESTS_KEY = ['vehicle-requests'];

/** Список рейсов: день либо встал в чужой рейс, либо завёл новый — состав изменился у обоих. */
const ROUTES_KEY = ['vehicle-routes'];

interface Props {
  /** Заявка карточки. Дни ведут только у линейного заказа — прочим блок не показывают вовсе. */
  request: SpecialEquipmentRequestDto;
  /**
   * Читалка: заявку открыли окном поверх чужого экрана — из состава рейса, журнала листов или
   * гаража (план «маршрут и заявка окнами», §3.5). Таблица остаётся полной, а планирование уходит:
   * колонки действий нет, окна `VehicleDayRouteModal` нет.
   *
   * Флагом, а не отсутствием пропа-действия, как это сделано у самой карточки: планирование дней
   * живёт внутри этого файла своими мутациями, и «не передать действие» здесь нечего. Условие их
   * доступности (`canPlan` ниже) — ровно то же `vehicleRequests.status && waybills.read`, которым
   * открывается рейс, так что диспетчер, заглянувший в заявку из рейса, получил бы рабочий
   * планировщик там, где просил только посмотреть.
   *
   * Прятать вкладку целиком было бы проще, но читалка стала бы беднее той же карточки в списке:
   * «каким рейсом едет какой день» — тот самый вопрос, ради которого заявку из рейса и открывают.
   */
  readOnly?: boolean;
}

const dash = <Typography.Text type="secondary">—</Typography.Text>;

export function VehicleRequestDays({ request, readOnly }: Props) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { openRoute } = useRouteModal();
  /**
   * Рейс, открытый под нами: заявку читают поверх карточки его же рейса (`?route=X&request=Y`), и
   * день, стоящий именно в X, ссылкой быть не должен — она открывала бы то, что уже под окном
   * (план §3.1, инвариант 3). Признак берётся из адреса, потому что адрес и есть состояние окон:
   * своей копии в React у провайдера нет намеренно.
   */
  const [params] = useSearchParams();
  const openedRouteId = readOnly ? params.get('route') : null;
  /** День, который ставят в рейс; `null` — окно планирования закрыто. */
  const [planning, setPlanning] = useState<string | null>(null);
  /** Неделя, выбранная руками; `null` — показывается неделя дня среза. */
  const [picked, setPicked] = useState<string | null>(null);

  const { data, isPending } = useQuery({
    queryKey: daysKey(request.id),
    queryFn: () => vehicleRequestsApi.days(request.id),
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  /** Дни, уже стоящие в рейсах: ими правило отвечает, свободен ли выбранный день. */
  const plannedDays = useMemo(() => items.filter((d) => d.route).map((d) => d.date), [items]);

  /**
   * Планирование — тот же ход работы по заявке, что и перевод в работу, плюс право на рейсы: в
   * плане стоят чужие машины и ФИО водителей собственного парка. Обе проверки те же, что и на
   * ручке: кнопка не должна обещать того, чего сервер не сделает.
   */
  const canPlan = can('vehicleRequests.status') && can('waybills.read');

  /**
   * Заявка глазами правил дней. Собирается здесь, а не берётся из ответа: причину недоступности
   * каждой строки считает то же правило, которым откажет сервер (`planDayBlocker`), — и слова у
   * отказа обязаны совпасть до буквы.
   */
  const subject: LinearDaySubject = {
    requestType: request.requestType,
    isLinear: request.isLinear,
    status: request.status,
    deletedAt: request.deletedAt,
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    ownership: request.assignment?.ownership ?? null,
  };

  /**
   * Таблица после правки приезжает от сервера целиком — ею и заменяется кэш: своей версии у дней
   * нет, а перечёт свободных строк задания в соседних рейсах портал повторить не может.
   */
  const applyDays = (days: VehicleRequestDaysDto) => {
    qc.setQueryData(daysKey(request.id), days);
    void qc.invalidateQueries({ queryKey: REQUESTS_KEY });
    void qc.invalidateQueries({ queryKey: ROUTES_KEY });
  };

  const unplan = useMutation({
    mutationFn: (date: string) => vehicleRequestsApi.unplanDay(request.id, date),
    onSuccess: (days, date) => {
      message.success(`День ${formatDateOnly(date)} снят с рейса`);
      applyDays(days);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Недели срока: заказ на квартал даёт девяносто строк, а подряд они не читаются (план У13).
   * Неделя здесь календарная, пн–вс (`weekStartKey`) — той же, которой режутся листы ЭСМ-2 и
   * недельная заявка: второй недели в портале быть не должно.
   */
  const weeks = useMemo(() => {
    const byWeek = new Map<string, VehicleRequestDayDto[]>();
    for (const day of items) {
      const start = weekStartKey(day.date);
      const week = byWeek.get(start);
      if (week) week.push(day);
      else byWeek.set(start, [day]);
    }
    return [...byWeek.entries()]
      .map(([start, days]) => ({ start, days }))
      .sort((a, b) => a.start.localeCompare(b.start));
  }, [items]);

  /**
   * Показанная неделя. Умолчание — неделя дня среза: заказ ведут сегодняшним днём, и открывать
   * квартальную заявку на её первой неделе значило бы каждый раз пролистывать её до текущей. День
   * среза считает сервер (`onDate`) — часы браузера бывают сбиты. Срез вне срока (заявка ещё не
   * началась или уже кончилась) — показывается первая неделя.
   */
  const defaultWeek = data
    ? (weeks.find((w) => w.start === weekStartKey(data.onDate))?.start ?? weeks[0]?.start ?? null)
    : null;
  const shown = weeks.find((w) => w.start === picked)?.start ?? defaultWeek;
  const index = weeks.findIndex((w) => w.start === shown);
  const week = index >= 0 ? weeks[index]! : null;

  const busy = unplan.isPending;

  /**
   * Колонка действий: снять день с рейса и поставить его в рейс. В таблицу попадает только у
   * того, кто дни планирует, и только в рабочем режиме (см. `readOnly`) — оба раза отсутствием
   * колонки, а не выключенными кнопками. В читалке права как раз хватает, и выключенная кнопка
   * соврала бы про причину; заказчику, читающему свой план с ADR 0122, права не будет никогда, а
   * две мёртвые кнопки в каждой строке — шум, которым портал нигде не отвечает на «не положено».
   */
  const actions: TableColumnType<VehicleRequestDayDto> = {
    key: 'actions',
    title: '',
    width: 110,
    render: (_v, day) => {
      if (day.route) {
        // Замороженный выписанным листом рейс день не отдаёт: бланк уже у водителя, и исчезнуть
        // из него день не может — сначала лист аннулируют.
        const frozen = !isRouteEditable(day.route.waybill?.status ?? null);
        return (
          <span title={frozen ? LINEAR_DAY_FROZEN_MESSAGE : 'Снять день с рейса'}>
            <Button
              size="small"
              danger
              disabled={frozen || busy}
              onClick={() => unplan.mutate(day.date)}
            >
              Снять
            </Button>
          </span>
        );
      }
      // Причина недоступности — та же строка, которой откажет сервер: правило одно на портал и
      // API, и «день вне срока заявки» портал обязан объяснять теми же словами.
      const blocker = planDayBlocker(subject, day.date, plannedDays);
      return (
        <span title={blocker ?? 'Поставить день в рейс'}>
          <Button
            size="small"
            type="primary"
            disabled={!!blocker || busy}
            onClick={() => setPlanning(day.date)}
          >
            В рейс
          </Button>
        </span>
      );
    },
  };

  const columns: TableColumnType<VehicleRequestDayDto>[] = [
    {
      key: 'date',
      title: 'День',
      width: 140,
      render: (_v, day) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{formatDateOnly(day.date)}</div>
          {/* День за пределами нынешнего срока: в норме таких не бывает — сверка снимает их с
            рейсов, — но замороженный выписанным листом рейс день не отдаёт. Прятать выданную
            бумагу нельзя, поэтому день остаётся в таблице с пометкой. */}
          {day.outOfTerm && (
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
              за сроком
            </Tag>
          )}
        </div>
      ),
    },
    {
      key: 'route',
      title: 'Рейс',
      width: 150,
      render: (_v, day) =>
        day.route ? (
          <div style={{ lineHeight: 1.35 }}>
            {/* Рейс открывается окном поверх той страницы, где о нём спросили: дни планируют,
              стоя в заявке, и уход на другую вкладку стоил бы выбранной недели и обратной
              дороги. Ссылкой, а не кнопкой: Ctrl и средний щелчок обязаны по-прежнему открывать
              рейс соседней вкладкой браузера — этим пользуются постоянно (`EntityLink`).
              Рейс, уже открытый под окном заявки, остаётся текстом (см. `openedRouteId`). */}
            {day.route.id === openedRouteId ? (
              day.route.displayNumber
            ) : (
              <EntityLink
                to={vehicleRouteLink(can, day.route.id)}
                title="Открыть маршрут"
                onActivate={() => openRoute(day.route!.id)}
              >
                {day.route.displayNumber}
              </EntityLink>
            )}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                строка {day.route.position}
              </Typography.Text>
            </div>
          </div>
        ) : (
          <Typography.Text type="secondary">не распланирован</Typography.Text>
        ),
    },
    {
      key: 'vehicle',
      title: 'Машина',
      width: 230,
      render: (_v, day) =>
        day.route ? (
          <div style={{ lineHeight: 1.35 }}>
            <div>{day.route.vehicleLabel}</div>
            {/* Машина дня разошлась с назначением — законно и помечается, а не отклоняется
              (ADR 0100 решение 4): назначение у линейного заказа это машина по умолчанию, а
              работает в конкретный день та, чьим рейсом день закрыт. */}
            {day.otherVehicle && (
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                не машина заявки
              </Tag>
            )}
          </div>
        ) : (
          dash
        ),
    },
    {
      key: 'driver',
      title: 'Водитель',
      width: 190,
      // Пустой водитель — не поломка, а состояние: рейс собрали заранее, человека ставят утром.
      render: (_v, day) =>
        day.route ? day.route.driverName || <Tag color="orange">не назначен</Tag> : dash,
    },
    {
      key: 'waybill',
      title: 'Лист',
      width: 200,
      render: (_v, day) => {
        if (!day.route) return dash;
        const waybill = day.route.waybill;
        return waybill ? (
          <div style={{ lineHeight: 1.35 }}>
            <EntityLink to={waybillLink(can, waybill.number)} title="Открыть в журнале листов">
              {waybill.number}
            </EntityLink>
            <div>
              <Tag color={waybillStatusColors[waybill.status]} style={{ marginInlineEnd: 0 }}>
                {waybillStatusLabels[waybill.status]}
              </Tag>
            </div>
          </div>
        ) : (
          <Typography.Text type="secondary">не выписан</Typography.Text>
        );
      },
    },
    {
      key: 'shift',
      title: 'Часы смены',
      width: 150,
      // Часы дня ведёт таблица смен (ADR 0100 решение 12): здесь короткая выжимка, полную смену
      // показывает своя вкладка. Пусто — за этот день часов ещё не вносили.
      render: (_v, day) =>
        day.shift ? (
          <div style={{ lineHeight: 1.35 }}>
            <div>
              {day.shift.startedAt && day.shift.endedAt
                ? `${day.shift.startedAt} – ${day.shift.endedAt}`
                : '—'}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {workedAmountLabel('hours', day.shift.machineHours)}
            </Typography.Text>
          </div>
        ) : (
          dash
        ),
    },
    {
      key: 'approval',
      title: 'Подпись объекта',
      width: 190,
      render: (_v, day) =>
        day.shift?.approvedAt ? (
          <Space size={6}>
            <UserAvatar name={day.shift.approvedByName ?? ''} size={18} />
            <span>{day.shift.approvedByName}</span>
          </Space>
        ) : (
          <Typography.Text type="secondary">нет</Typography.Text>
        ),
    },
    // Действия — последней колонкой, и только тому, кто в рабочем режиме дни планирует
    // (см. `actions`).
    ...(readOnly || !canPlan ? [] : [actions]),
  ];

  if (isPending) return <Spin size="small" />;

  // Дней у этой заявки не ведут вовсе — и таблица объясняет это словами сервера, а не пустотой:
  // у арендного заказа рейсы ведёт арендодатель, и ждать от портала строк бессмысленно (план У14).
  if (data?.blocker) return <Alert type="info" showIcon message={data.blocker} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Окно недели: заказ на квартал — девяносто дней, и подряд они не читаются. Стрелки рядом
        с выбором недели — ими и листают, а выбор нужен, чтобы прыгнуть в конец срока. */}
      <Space size={[12, 8]} wrap>
        <Space.Compact>
          <Button
            icon={<LeftOutlined />}
            title="Предыдущая неделя"
            aria-label="Предыдущая неделя"
            disabled={index <= 0}
            onClick={() => setPicked(weeks[index - 1]!.start)}
          />
          <Select
            value={shown ?? undefined}
            style={{ minWidth: 260 }}
            onChange={setPicked}
            options={weeks.map((w) => ({
              value: w.start,
              label: `${weeklyWeekLabel(w.start)} · ${w.days.filter((d) => d.route).length} из ${w.days.length}`,
            }))}
          />
          <Button
            icon={<RightOutlined />}
            title="Следующая неделя"
            aria-label="Следующая неделя"
            disabled={index < 0 || index >= weeks.length - 1}
            onClick={() => setPicked(weeks[index + 1]!.start)}
          />
        </Space.Compact>
        {/* Итог по всему сроку, а не по показанной неделе: окно листают, а вопрос «сколько дней
          ещё не занято» задают о заказе целиком. */}
        <Tag color={plannedDays.length === items.length ? 'green' : 'orange'}>
          распланировано {plannedDays.length} из {items.length} дней
        </Tag>
      </Space>

      <Table
        rowKey="date"
        size="small"
        dataSource={week?.days ?? []}
        columns={columns}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        День ставят в рейс по одному: на разные дни выходят разные машины и разные водители. Часы
        дня подтверждают на вкладке «На объекте», а печатается день строкой задания в листе рейса.
      </Typography.Text>

      {/* Форма планирования: день и объект известны, спрашиваются машина и водитель.
        Условно, а не спрятанной флагом: ни в читалке, ни у заказчика планировщика нет вовсе — ни
        на экране, ни взведённым в памяти. Единственная дверь к нему — колонка действий, которой
        там тоже нет, так что `planning` в этих режимах остаётся `null` навсегда. */}
      {!readOnly && canPlan && (
        <VehicleDayRouteModal
          // День среза отдаётся окну: им оно решает, прошедший ли это день, а значит — спрашивать
          // ли причину заднего числа (ADR 0101 п. 4). Считает его сервер (`onDate`) — тем же
          // поясом, которым считает границу `backdateGuard`; часы браузера бывают сбиты, и
          // разойтись форме с ручкой здесь нельзя.
          target={planning ? { request, date: planning, onDate: data?.onDate ?? planning } : null}
          onClose={() => setPlanning(null)}
          onDone={(days) => {
            setPlanning(null);
            applyDays(days);
          }}
        />
      )}
    </div>
  );
}
