import { Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  type GarageBusyEntry,
  type GarageBusyRequest,
  isRelocationPurpose,
  routePurposeShortLabels,
} from '@technic/contracts';
import { EntityLink } from '@shared/ui';
import { vehicleRequestLink, vehicleRouteLink, waybillLink } from '../../utils/links';
import { useAuth } from '../../auth/AuthContext';

/**
 * Общее двух вкладок гаража: чем занят день — строками со ссылками в те модули, где эту работу
 * ведут.
 *
 * Своих адресов у гаража нет: номер заявки, рейса и бланка ведут туда же, куда ведут из списка
 * маршрутов и журнала листов (`utils/links`). Эти функции сами возвращают `null` там, где роли
 * целевая вкладка не положена, — тогда номер остаётся текстом, а не ссылкой в пустой экран.
 */

const DATE = 'DD.MM';

/** Дата дня без года: срез читают внутри одной недели, и год в каждой строке только шумит. */
function shortDate(value: string): string {
  return dayjs(value).format(DATE);
}

/** Номер заявки ссылкой — с заказчиком рядом: по нему в срезе и узнают, куда машина едет. */
function RequestLink({ request }: { request: GarageBusyRequest }) {
  const { can } = useAuth();
  return (
    <>
      <EntityLink
        to={vehicleRequestLink(can, { id: request.requestId, status: request.status })}
        title="Открыть заявку"
      >
        {request.displayNumber}
      </EntityLink>
      {request.customerName ? ` — ${request.customerName}` : null}
    </>
  );
}

/**
 * Одна занятость строкой. Вид решает, что показывать: у рейса — состав и бланк, у заказа — объект
 * со сроком, у недельного листа — номер бланка и его неделя.
 */
function BusyEntry({ entry, showVehicle }: { entry: GarageBusyEntry; showVehicle: boolean }) {
  const { can } = useAuth();
  const secondary = { fontSize: 12 } as const;

  if (entry.kind === 'route') {
    return (
      <Space direction="vertical" size={0}>
        <Space size={6} wrap>
          <EntityLink to={vehicleRouteLink(can, entry.routeId)} title="Открыть маршрут">
            {entry.displayNumber}
          </EntityLink>
          {isRelocationPurpose(entry.purpose) && (
            <Tag color={entry.purpose === 'delivery' ? 'blue' : 'gold'}>
              {routePurposeShortLabels[entry.purpose]}
            </Tag>
          )}
          {/* Бланк уже выписан — значит рейс заморожен, и это первое, что о нём спрашивают. */}
          {entry.waybill && (
            <EntityLink
              to={waybillLink(can, entry.waybill.number)}
              title="Открыть в журнале листов"
            >
              {entry.waybill.number}
            </EntityLink>
          )}
        </Space>
        {showVehicle && (
          <Typography.Text type="secondary" style={secondary}>
            {entry.vehicleLabel}
          </Typography.Text>
        )}
        {/* У перегона состава нет: его задание — «откуда — куда» и заявка-основание. */}
        {isRelocationPurpose(entry.purpose) ? (
          <Typography.Text type="secondary" style={secondary}>
            {entry.sourceRequest && <RequestLink request={entry.sourceRequest} />}
            {entry.moveFrom || entry.moveTo ? ` · ${entry.moveFrom} → ${entry.moveTo}` : null}
          </Typography.Text>
        ) : entry.requests.length === 0 ? (
          <Typography.Text type="secondary" style={secondary}>
            рейс пуст
          </Typography.Text>
        ) : (
          entry.requests.map((request) => (
            <Typography.Text key={request.requestId} type="secondary" style={secondary}>
              <RequestLink request={request} />
            </Typography.Text>
          ))
        )}
      </Space>
    );
  }

  if (entry.kind === 'special') {
    return (
      <Space direction="vertical" size={0}>
        <Space size={6} wrap>
          <RequestLink
            request={{
              requestId: entry.requestId,
              displayNumber: entry.displayNumber,
              status: entry.status,
              customerName: entry.customerName,
              // Заказ, накрывающий день целиком, дня не несёт: линейного заказа здесь не бывает
              // вовсе — его занятость говорит рейс дня (ADR 0100 §12).
              workDate: null,
            }}
          />
          {/* Запрошенный досрочный отъезд (ADR 0044): до визы срок прежний, и без пометки
              машина числилась бы занятой до конца заказа. */}
          {entry.earlyEndPending && <Tag color="orange">отъезд на визе</Tag>}
        </Space>
        {showVehicle && (
          <Typography.Text type="secondary" style={secondary}>
            {entry.vehicleLabel}
          </Typography.Text>
        )}
        <Typography.Text type="secondary" style={secondary}>
          {entry.dateTo && entry.dateTo !== entry.dateFrom
            ? `${shortDate(entry.dateFrom)} – ${shortDate(entry.dateTo)}`
            : shortDate(entry.dateFrom)}
          {' · '}
          {/* Смена дня: заполнена, подписана объектом или ещё не тронута (ADR 0036). */}
          {entry.shift
            ? entry.shift.approved
              ? 'смена согласована'
              : 'смена заполнена'
            : 'смена не заполнена'}
        </Typography.Text>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={0}>
      <Space size={6} wrap>
        <EntityLink to={waybillLink(can, entry.number)} title="Открыть в журнале листов">
          {entry.number}
        </EntityLink>
        <Tag>ЭСМ-2</Tag>
      </Space>
      {showVehicle && (
        <Typography.Text type="secondary" style={secondary}>
          {entry.vehicleLabel}
        </Typography.Text>
      )}
      <Typography.Text type="secondary" style={secondary}>
        {shortDate(entry.periodFrom)} – {shortDate(entry.periodTo)}
        {entry.sourceRequest ? ' · ' : null}
        {entry.sourceRequest && <RequestLink request={entry.sourceRequest} />}
      </Typography.Text>
    </Space>
  );
}

/**
 * Колонка «Занятость». Пустая означает ровно то, что написано: в этот день за строкой ничего не
 * числится — ни рейса, ни заказа, ни бланка.
 *
 * `showVehicle` — вкладка водителей: там машина у каждой занятости своя и её надо назвать. На
 * вкладке техники машина уже стоит первой колонкой, и повторять её в каждой строке незачем.
 */
export function BusyCell({
  entries,
  showVehicle = false,
}: {
  entries: readonly GarageBusyEntry[];
  showVehicle?: boolean;
}) {
  if (entries.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space direction="vertical" size={4} style={{ display: 'flex' }}>
      {entries.map((entry) => (
        <BusyEntry key={busyKey(entry)} entry={entry} showVehicle={showVehicle} />
      ))}
    </Space>
  );
}

/** Ключ строки занятости: у каждого вида свой идентификатор, общего у них нет. */
export function busyKey(entry: GarageBusyEntry): string {
  switch (entry.kind) {
    case 'route':
      return `route:${entry.routeId}`;
    case 'special':
      return `special:${entry.requestId}`;
    default:
      return `esm2:${entry.waybillId}`;
  }
}

/** Та же занятость одной строкой — для карточки телефона, где места на список нет (ADR 0030). */
export function busyLine(entry: GarageBusyEntry): string {
  switch (entry.kind) {
    case 'route':
      return isRelocationPurpose(entry.purpose)
        ? `${entry.displayNumber} · ${routePurposeShortLabels[entry.purpose]} ${entry.moveFrom} → ${entry.moveTo}`
        : `${entry.displayNumber} · ${
            entry.requests.length === 0
              ? 'рейс пуст'
              : entry.requests.map((r) => r.displayNumber).join(', ')
          }`;
    case 'special':
      return `${entry.displayNumber} · ${entry.customerName}`;
    default:
      return `${entry.number} · ЭСМ-2 ${shortDate(entry.periodFrom)}–${shortDate(entry.periodTo)}`;
  }
}
