import { Button, Space, Tag, Typography } from 'antd';
import type { TableColumnType } from 'antd';
import {
  isRouteEditable,
  LINEAR_DAY_FROZEN_MESSAGE,
  type LinearDaySubject,
  planDayBlocker,
  type VehicleRequestDayDto,
  waybillStatusColors,
  waybillStatusLabels,
  workedAmountLabel,
} from '@technic/contracts';
import { EntityLink } from '@shared/ui';
import { UserAvatar } from '../../components/UserAvatar';
import { vehicleRouteLink, waybillLink } from '../../utils/links';
import { formatDateOnly } from './shared';

/**
 * Колонки таблицы «Дни работ»: чем день закрыт, кем, какой бумагой и что за него подтвердили.
 *
 * Отдельным файлом от самой таблицы, а не ради счётчика строк: таблица — это запросы, окно недели
 * и две мутации, а здесь ни одного состояния, только ответ на «как показать день». Ту же границу
 * держат колонки среза «На объекте» (`onSiteColumns`), и по той же причине: разбор строки
 * вперемешку с мутациями читается плохо с обеих сторон.
 */

/** `can` берётся у того же адресника, что строит ссылки: второе описание типа разошлось бы с ним. */
type Can = Parameters<typeof vehicleRouteLink>[0];

/** Чем строка отвечает, когда показывать нечего: день без рейса, часов и подписи. */
const dash = <Typography.Text type="secondary">—</Typography.Text>;

interface Input {
  can: Can;
  /** Открыть рейс окном поверх текущего экрана. */
  openRoute: (routeId: string) => void;
  /**
   * Рейс, открытый под нами: заявку читают поверх карточки его же рейса, и день, стоящий именно в
   * нём, ссылкой быть не должен — она открывала бы то, что уже под окном.
   */
  openedRouteId: string | null;
  /**
   * Колонка действий; `null` — её нет вовсе: читалка или нет права планировать. Отсутствием
   * колонки, а не выключенными кнопками: заказчику, читающему свой план (ADR 0122), права не
   * будет никогда, а две мёртвые кнопки в каждой строке — шум, которым портал нигде не отвечает
   * на «не положено».
   */
  actions: {
    /** Заявка глазами правил дней: ими считается причина недоступности каждой строки. */
    subject: LinearDaySubject;
    /** Дни, уже стоящие в рейсах: ими правило отвечает, свободен ли выбранный день. */
    plannedDays: string[];
    busy: boolean;
    onUnplan: (date: string) => void;
    onPlan: (date: string) => void;
  } | null;
}

export function dayColumns({
  can,
  openRoute,
  openedRouteId,
  actions,
}: Input): TableColumnType<VehicleRequestDayDto>[] {
  /** Снять день с рейса и поставить его в рейс — обе кнопки одной колонкой, последней в таблице. */
  const actionsColumn: TableColumnType<VehicleRequestDayDto> = {
    key: 'actions',
    title: '',
    width: 110,
    render: (_v, day) => {
      if (!actions) return null;
      if (day.route) {
        // Замороженный выписанным листом рейс день не отдаёт: бланк уже у водителя, и исчезнуть
        // из него день не может — сначала лист аннулируют.
        const frozen = !isRouteEditable(day.route.waybill?.status ?? null);
        return (
          <span title={frozen ? LINEAR_DAY_FROZEN_MESSAGE : 'Снять день с рейса'}>
            <Button
              size="small"
              danger
              disabled={frozen || actions.busy}
              onClick={() => actions.onUnplan(day.date)}
            >
              Снять
            </Button>
          </span>
        );
      }
      // Причина недоступности — та же строка, которой откажет сервер: правило одно на портал и
      // API, и «день вне срока заявки» портал обязан объяснять теми же словами.
      const blocker = planDayBlocker(actions.subject, day.date, actions.plannedDays);
      return (
        <span title={blocker ?? 'Поставить день в рейс'}>
          <Button
            size="small"
            type="primary"
            disabled={!!blocker || actions.busy}
            onClick={() => actions.onPlan(day.date)}
          >
            В рейс
          </Button>
        </span>
      );
    },
  };

  return [
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
              (ADR 0100 решение 4): назначение у заказа на объект это машина по умолчанию, а
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
    // Действия — последней колонкой, и только тому, кто в рабочем режиме дни планирует.
    ...(actions ? [actionsColumn] : []),
  ];
}
