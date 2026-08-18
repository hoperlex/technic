import { Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  type GarageBusyEntry,
  type GarageBusyRequest,
  type GarageRouteBusy,
  isRelocationPurpose,
  routePurposeShortLabels,
} from '@technic/contracts';
import { EntityLink, type ActionSheetItem } from '@shared/ui';
import {
  canOpenRoute,
  vehicleRequestViewLink,
  vehicleRouteLink,
  waybillLink,
} from '../../utils/links';
import { useAuth } from '../../auth/AuthContext';
import { useRouteModal } from '../vehicle/routeModal';

/**
 * Общее двух вкладок гаража: чем занят день — строками со ссылками на записи, которыми эта работа
 * заведена.
 *
 * Своих адресов у гаража нет: номер заявки, рейса и бланка спрашиваются у общих обёрток
 * (`utils/links`), и те возвращают `null` там, где роли цель не положена, — тогда номер остаётся
 * текстом, а не ссылкой в пустой экран. Это не отвлечённая осторожность: механику и главному
 * механику гараж открыт (`garage.read`), а заявок у них нет вовсе, и номера заявок в занятости
 * обязаны остаться для них обычным текстом.
 *
 * Рейс и заявка при этом никуда больше не уводят: обычный клик открывает их окном **поверх среза
 * дня** (ADR 0120, план `docs/vehicle-routes-modal-plan.md`). Ради этого план и затевался: вопрос
 * «а что там за маршрут» задают, стоя в гаражном дне с выбранной датой и фильтрами, и до сих пор
 * ответ на него стоил ухода в другой раздел и обратной дороги руками. Ссылки остаются настоящими
 * — Ctrl'ом их по-прежнему открывают соседней вкладкой (см. `EntityLink`).
 *
 * Номер бланка — исключение намеренное: журнал путевых листов остаётся отдельным экраном, окна у
 * него нет, и по нему уходят туда же, куда уходили.
 */

const DATE = 'DD.MM';

/** Дата дня без года: срез читают внутри одной недели, и год в каждой строке только шумит. */
function shortDate(value: string): string {
  return dayjs(value).format(DATE);
}

/**
 * Номер заявки ссылкой — с заказчиком рядом: по нему в срезе и узнают, куда машина едет.
 *
 * Открывается окном на чтение, а не переходом на вкладку заявок: из среза дня спрашивают одно —
 * что это за заявка, — и уходить ради ответа со своего дня незачем. Отсюда `vehicleRequestViewLink`
 * вместо `vehicleRequestLink`: вкладку выбирали по статусу заявки, а у окна адрес один на любое её
 * состояние (ADR 0120), и статус ему не нужен вовсе.
 *
 * Поэтому от строки и требуется ровно то, что она показывает: номер, заказчик и по чему открывать.
 * Полного `GarageBusyRequest` она больше не спрашивает — иначе заказ спецтехники, своей строки
 * состава не имеющий, по-прежнему собирал бы фиктивный DTO ради одного лишь статуса.
 */
function RequestLink({
  request,
}: {
  request: Pick<GarageBusyRequest, 'requestId' | 'displayNumber' | 'customerName'>;
}) {
  const { can } = useAuth();
  const { openRequest } = useRouteModal();
  return (
    <>
      <EntityLink
        to={vehicleRequestViewLink(can, request.requestId)}
        title="Открыть заявку"
        onActivate={() => openRequest(request.requestId)}
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
  const { openRoute } = useRouteModal();
  const secondary = { fontSize: 12 } as const;

  if (entry.kind === 'route') {
    return (
      <Space direction="vertical" size={0}>
        <Space size={6} wrap>
          {/* Главный выигрыш среза: рейс открывается окном поверх дня, а не уносит в раздел
              заказа техники. Диспетчер разбирает день сверху вниз — открыл рейс, закрыл, пошёл
              дальше по списку, — и день, фильтр и место в списке остаются нетронутыми. */}
          <EntityLink
            to={vehicleRouteLink(can, entry.routeId)}
            title="Открыть маршрут"
            onActivate={() => openRoute(entry.routeId)}
          >
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
          {/* Заказ, накрывающий день целиком, строкой состава не является: линейного заказа здесь
              не бывает вовсе — его занятость говорит рейс дня (ADR 0100 §12). Номеру и заказчику
              этого различия не видно, и ссылка у него та же самая. */}
          <RequestLink
            request={{
              requestId: entry.requestId,
              displayNumber: entry.displayNumber,
              customerName: entry.customerName,
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

/**
 * Та же занятость одной строкой — для карточки телефона, где места на список нет (ADR 0030).
 *
 * Остаётся текстом намеренно. Строка одна на весь день и набита впритык — номер рейса стоит в ней
 * вперемешку с составом или со стрелкой перегона, — и ссылка внутри неё была бы целью в несколько
 * миллиметров между двумя другими словами. Поэтому открывают рейс не отсюда, а пунктом шита
 * действий (`useBusyRouteActions`) — тем же приёмом, каким на телефон уже вынесены «Статистика за
 * период» и «Обслуживание».
 */
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

/**
 * Рейсы дня пунктами действий карточки телефона: с телефона рейс иначе не открыть вовсе.
 *
 * Пункт на **каждый** рейс дня, а не один «главный»: машина за день ходит несколькими рейсами, у
 * водителя их бывает столько же, и единственный пункт молча прятал бы остальные — притом именно
 * те, о которых чаще и спрашивают (последний рейс, а не первый). Подпись — номером рейса, тем
 * самым, которым его называют по телефону (`Р-12`).
 *
 * Право спрашивается тем же `canOpenRoute`, что и ссылка на десктопе и сам параметр адреса у
 * провайдера окон: шит действий не должен становиться второй дверью мимо права. Роли без него
 * (механик) достаётся пустой список — карточка тогда не рисует и кнопки действий.
 *
 * Хук, а не чистая функция, потому что обе половины ответа — право и способ открыть окно —
 * приходят из контекстов; обеим вкладкам гаража остаётся позвать его один раз и раскрыть
 * результат в `card.actions`.
 */
export function useBusyRouteActions(): (entries: readonly GarageBusyEntry[]) => ActionSheetItem[] {
  const { can } = useAuth();
  const { openRoute } = useRouteModal();
  const allowed = canOpenRoute(can);
  return (entries) =>
    allowed
      ? entries
          .filter((entry): entry is GarageRouteBusy => entry.kind === 'route')
          .map((entry) => ({
            // Ключ тот же, каким занятость названа в списке строк: рейс в дне один раз, и второго
            // способа его назвать заводить незачем.
            key: busyKey(entry),
            label: `Открыть маршрут ${entry.displayNumber}`,
            onClick: () => openRoute(entry.routeId),
          }))
      : [];
}
