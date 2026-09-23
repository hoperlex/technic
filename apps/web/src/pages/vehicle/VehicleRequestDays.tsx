import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, App, Button, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type LinearDaySubject,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDayDto,
  type VehicleRequestDaysDto,
  weeklyWeekLabel,
  weekStartKey,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { garageKeys } from '@entities/garage';
import { formatDateOnly } from './shared';
import { useRouteModal } from '@features/route-modal';
import { dayColumns } from './dayColumns';
import { VehicleDayBatchModal } from './VehicleDayBatchModal';
import { VehicleDayRouteModal } from './VehicleDayRouteModal';

/**
 * «Дни работ» — место, где ведут дни заказа техники на объект (ADR 0100 решение 8).
 *
 * День заказа — отдельный выезд: его кладут в рейс машины на эту дату и печатают в его 4-П. Ради
 * линейной техники дни и заводились — она вечером возвращается на базу, а за день успевает
 * поработать на двух-трёх площадках, — но признаком типа дверь больше не заперта (ADR 0207): 4-П
 * за день просят и у машины, которая неделю стоит на площадке.
 *
 * Дверей к дням две, и обе здесь. Подённая — день знает свой срок и свою заявку, а из карточки
 * маршрута ту же заявку пришлось бы разыскивать по объекту среди всех работающих; со стороны рейса
 * день виден в составе и снимается оттуда, но не добавляется (`LINEAR_DAY_DOOR_MESSAGE`). Пачка —
 * «Распланировать период»: ею проходят срок подряд, и нужна она там, где подённой много, — срок
 * продлили, дни пропустили, листы аннулировали. Прежний запрет на пачку («на разные дни выходят
 * разные машины и разные водители») снят тем, что машину она берёт из назначения и не спрашивает,
 * а конфликтный день пропускает с причиной, а не переставляет.
 *
 * Своим файлом, а не блоком карточки заявки: карточка стоит вплотную к своему лимиту длины, а
 * таблица с окном недели, тремя запросами и двумя мутациями — самостоятельная вещь.
 */

interface Props {
  /** Заявка карточки. Дни ведут у любого заказа техники на объект; прочее объяснит `blocker`. */
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
  /** Открыто ли окно пачки «Распланировать период» (ADR 0207). */
  const [batching, setBatching] = useState(false);
  /** Неделя, выбранная руками; `null` — показывается неделя дня среза. */
  const [picked, setPicked] = useState<string | null>(null);

  const { data, isPending } = useQuery({
    queryKey: vehicleRequestKeys.days(request.id),
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
    qc.setQueryData(vehicleRequestKeys.days(request.id), days);
    // Список заявок: в строке видны рейс и машина дня, и после планирования они устарели.
    void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    // Список рейсов: день либо встал в чужой рейс, либо завёл новый — состав изменился у обоих.
    void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
    // Срез гаража: своих таблиц у него нет — день собирается сервером (ADR 0076), — а видно ли в
    // нём работу, решает состав рейса (ADR 0131). Поставленный день состав наполняет, снятый
    // опустошает: опустевший рейс без листа из среза исчезает вовсе, а машина и её водитель
    // возвращаются в свободные. Без гашения диспетчер читает занятость, которой уже нет.
    void qc.invalidateQueries({ queryKey: garageKeys.root });
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

  /**
   * Колонки таблицы, а с ними и колонка действий (снять день с рейса, поставить в рейс). Действия
   * попадают в таблицу только у того, кто дни планирует, и только в рабочем режиме (см.
   * `readOnly`) — оба раза отсутствием колонки, а не выключенными кнопками. В читалке права как
   * раз хватает, и выключенная кнопка соврала бы про причину; заказчику, читающему свой план с
   * ADR 0122, права не будет никогда, а две мёртвые кнопки в каждой строке — шум, которым портал
   * нигде не отвечает на «не положено».
   */
  const columns = dayColumns({
    can,
    openRoute,
    openedRouteId,
    actions:
      readOnly || !canPlan
        ? null
        : {
            subject,
            plannedDays,
            busy: unplan.isPending,
            onUnplan: (date) => unplan.mutate(date),
            onPlan: setPlanning,
          },
  });

  if (isPending) return <Spin size="small" />;

  // Дней у этой заявки не ведут вовсе — и таблица объясняет это словами сервера, а не пустотой:
  // у арендного заказа рейсы ведёт арендодатель, и ждать от портала строк бессмысленно (план У14).
  if (data?.blocker) return <Alert type="info" showIcon title={data.blocker} />;

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
        {/* Пачка (ADR 0207): срок подряд, машина из назначения, конфликтные дни — в отчёт. Стоит
          рядом со счётчиком незанятых дней: именно он и есть повод её нажать. Доступна там же, где
          подённая дверь, — правило одно, и второго условия у кнопки быть не должно. */}
        {!readOnly && canPlan && (
          <Button onClick={() => setBatching(true)}>Распланировать период</Button>
        )}
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
        День ставят в рейс по одному, когда на него выходит своя машина или свой водитель; весь срок
        разом проходит «Распланировать период» — машиной назначения и одним человеком. Часы дня
        подтверждают на вкладке «На объекте», а печатается день строкой задания в листе рейса.
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

      {/* Пачка — тем же условием и с тем же днём среза, что и подённое окно: правила у них одни,
        и вторая проверка доступности разошлась бы с первой. Отчёт окно показывает само — он
        переживает его закрытие, потому что читают его уже после действия. */}
      {!readOnly && canPlan && (
        <VehicleDayBatchModal
          target={batching && data ? { request, onDate: data.onDate } : null}
          onClose={() => setBatching(false)}
          onDone={applyDays}
        />
      )}
    </div>
  );
}
