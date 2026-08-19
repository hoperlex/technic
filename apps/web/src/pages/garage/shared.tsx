import type { ReactNode } from 'react';
import { Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  type GarageBusyEntry,
  type GarageBusyRequest,
  type GarageRouteBusy,
  type GarageSpecialBusy,
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
 *
 * Читают этот день вкладки по-разному. Технике довольно одной колонки (`BusyCell`): машина названа
 * первой графой, а день её — список, где каждая занятость сама себя объясняет. Водитель же за день
 * пересаживается с машины на машину, и спрашивают о нём другое — «на чём и по какому заказу», —
 * поэтому его занятость разошлась на три колонки, и строка читается поперёк. Живут они соседним
 * модулем (`busyColumns.tsx`) и собраны из здешних частей: три колонки — другой способ прочитать
 * ту же занятость, а не второй её разбор. Здесь остаётся общее обеим вкладкам, поэтому части,
 * нужные колонкам (`BusyHead`, `WaybillNumber`, `orderParts`, `busyLine` и подписи), вывешены
 * наружу — на них у модуля два потребителя, а не один.
 */

/**
 * Занятости дня — единственное, что нужно ячейкам обеих вкладок: техника показывает весь список,
 * три колонки водителя — одну работу и счёт остальных. Порядок в наборе — серверный (см.
 * `busyColumns.tsx`: он там существен, здесь список показан целиком).
 */
export type BusyCellProps = { entries: readonly GarageBusyEntry[] };

/** Прочерк означает ровно то, что написано: за строкой в этот день ничего не числится. */
export const DASH = <Typography.Text type="secondary">—</Typography.Text>;

/** Подпись под номером — мелким и серым; свойства одни на все вторые строки обеих вкладок. */
export const SUB = { type: 'secondary', style: { fontSize: 12 } } as const;

/** Дата дня без года: срез читают внутри одной недели, и год в каждой строке только шумит. */
export function shortDate(value: string): string {
  return dayjs(value).format('DD.MM');
}

/**
 * Срок заказа спецтехники и состояние его смены строкой: однодневный срок — одним числом
 * (`coalesce(date_to, date_from)`, как и в отборе), смена бывает и не тронута вовсе (ADR 0036).
 */
function specialLine(entry: GarageSpecialBusy): string {
  const to = entry.dateTo && entry.dateTo !== entry.dateFrom ? ` – ${shortDate(entry.dateTo)}` : '';
  const shift = entry.shift ? (entry.shift.approved ? 'согласована' : 'заполнена') : 'не заполнена';
  return `${shortDate(entry.dateFrom)}${to} · смена ${shift}`;
}

/** Что строке нужно от заявки: номер, заказчик и по чему её открыть. */
type BusyRequestRef = Pick<GarageBusyRequest, 'requestId' | 'displayNumber' | 'customerName'>;

/**
 * Номер заявки ссылкой — с заказчиком рядом: по нему в срезе и узнают, куда машина едет.
 *
 * Открывается окном на чтение, а не переходом на вкладку заявок: из среза дня спрашивают одно —
 * что это за заявка, — и уходить ради ответа со своего дня незачем. Отсюда `vehicleRequestViewLink`
 * вместо `vehicleRequestLink`: вкладку выбирали по статусу заявки, а у окна адрес один на любое её
 * состояние (ADR 0120), и статус ему не нужен вовсе. Полного `GarageBusyRequest` строка поэтому и
 * не спрашивает: заказ спецтехники, своей записи состава не имеющий, собирал бы ради него фиктивный
 * DTO — а показывает она номер, заказчика и по чему открывать (`BusyRequestRef`).
 */
function RequestLink({ request }: { request: BusyRequestRef }) {
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

/** Та же заявка текстом — для подсказки, где ссылке не место. */
function requestText({ displayNumber, customerName }: BusyRequestRef): string {
  return customerName ? `${displayNumber} — ${customerName}` : displayNumber;
}

/** Номер выписанного бланка ссылкой в журнал листов — что 4-П по рейсу, что недельный ЭСМ-2. */
export function WaybillNumber({ number }: { number: string }) {
  const { can } = useAuth();
  return (
    <EntityLink to={waybillLink(can, number)} title="Открыть в журнале листов">
      {number}
    </EntityLink>
  );
}

/**
 * Заголовок занятости — чем работа заведена: номером рейса, недельным бланком либо номером заказа.
 * Один на обе вкладки: у техники это первая строка блока дня, у водителя — колонка «Рейс/путевой
 * лист»; `children` дописывается в ту же строку и есть только у рейса (бланк на вкладке техники).
 */
export function BusyHead({ entry, children }: { entry: GarageBusyEntry; children?: ReactNode }) {
  const { can } = useAuth();
  const { openRoute } = useRouteModal();
  if (entry.kind === 'route')
    return (
      <Space size={6} wrap>
        {/* Главный выигрыш среза: рейс открывается окном поверх дня, а не уносит в раздел заказа
            техники — день, фильтр и место в списке остаются нетронутыми. */}
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
        {children}
      </Space>
    );
  if (entry.kind === 'esm2')
    return (
      <Space size={6} wrap>
        <WaybillNumber number={entry.number} />
        <Tag>ЭСМ-2</Tag>
      </Space>
    );

  return (
    <Space size={6} wrap>
      {/* Заказа линейной техники здесь не бывает вовсе — его занятость говорит рейс дня
          (ADR 0100 §12). Пометка — про запрошенный досрочный отъезд (ADR 0044): до визы срок
          прежний, и без неё машина числилась бы занятой до конца заказа. */}
      <RequestLink request={entry} />
      {entry.earlyEndPending && <Tag color="orange">отъезд на визе</Tag>}
    </Space>
  );
}

/** Одна занятость блоком — для вкладки техники: у рейса это состав и бланк, у заказа — срок со
 * сменой, у недельного листа — неделя и заявка-основание. */
function BusyEntry({ entry }: { entry: GarageBusyEntry }) {
  if (entry.kind === 'route')
    return (
      <Space direction="vertical" size={0}>
        {/* Бланк уже выписан — значит рейс заморожен, и это первое, что о нём спрашивают. */}
        <BusyHead entry={entry}>
          {entry.waybill && <WaybillNumber number={entry.waybill.number} />}
        </BusyHead>
        {/* Состав — по строке на заявку: их читают сверху вниз, а не разбирают запятые. У перегона
            состава нет вовсе, и строка там одна: заявка-основание и «откуда — куда». */}
        {isRelocationPurpose(entry.purpose) || entry.requests.length === 0 ? (
          <Typography.Text {...SUB}>
            <OrderParts parts={orderParts(entry)} />
          </Typography.Text>
        ) : (
          entry.requests.map((request) => (
            <Typography.Text {...SUB} key={request.requestId}>
              <RequestLink request={request} />
            </Typography.Text>
          ))
        )}
      </Space>
    );
  if (entry.kind === 'special')
    return (
      <Space direction="vertical" size={0}>
        <BusyHead entry={entry} />
        <Typography.Text {...SUB}>{specialLine(entry)}</Typography.Text>
      </Space>
    );

  return (
    <Space direction="vertical" size={0}>
      <BusyHead entry={entry} />
      <Typography.Text {...SUB}>
        {shortDate(entry.periodFrom)} – {shortDate(entry.periodTo)}
        {entry.sourceRequest ? ' · ' : null}
        {entry.sourceRequest && <RequestLink request={entry.sourceRequest} />}
      </Typography.Text>
    </Space>
  );
}

/**
 * Колонка «Занятость» вкладки техники: весь день списком. Пустая означает ровно то, что написано —
 * в этот день за машиной не числится ни рейса, ни заказа, ни бланка. Машину строки внутри не
 * называют: она уже стоит первой колонкой таблицы. Водителям, у которых машина в каждой работе
 * своя, отвечает не эта колонка, а три отдельные (`busyColumns.tsx`).
 */
export function BusyCell({ entries }: BusyCellProps) {
  if (entries.length === 0) return DASH;
  return (
    <Space direction="vertical" size={4} style={{ display: 'flex' }}>
      {entries.map((entry) => (
        <BusyEntry key={busyKey(entry)} entry={entry} />
      ))}
    </Space>
  );
}

/** Ключ строки занятости: у каждого вида свой идентификатор, общего у них нет. */
export function busyKey(entry: GarageBusyEntry): string {
  return entry.kind === 'route'
    ? `route:${entry.routeId}`
    : entry.kind === 'special'
      ? `special:${entry.requestId}`
      : `esm2:${entry.waybillId}`;
}

/**
 * Та же занятость одной строкой — для карточки телефона, где места на список нет (ADR 0030).
 *
 * Остаётся текстом намеренно: строка набита впритык — номер рейса стоит в ней вперемешку с составом
 * или со стрелкой перегона, — и ссылка внутри неё была бы целью в несколько миллиметров между двумя
 * другими словами. Рейс поэтому открывают пунктом шита действий (`useBusyRouteActions`) — тем же
 * приёмом, каким на телефон вынесены «Статистика за период» и «Обслуживание».
 *
 * Машину строка не называет намеренно: на вкладке техники она стоит заголовком карточки, и номер
 * в каждой строке дня повторял бы её. Там, где занятость читают от человека, машину дописывают
 * спереди — но не руками у каждого места, а общей `driverBusyLine` (`busyColumns.tsx`): собранные
 * порознь, карточка и подсказка «ещё N» уже успели разойтись ровно на неё.
 */
export function busyLine(entry: GarageBusyEntry): string {
  if (entry.kind === 'special') return `${entry.displayNumber} · ${entry.customerName}`;
  if (entry.kind === 'esm2')
    return `${entry.number} · ЭСМ-2 ${shortDate(entry.periodFrom)}–${shortDate(entry.periodTo)}`;
  const what = isRelocationPurpose(entry.purpose)
    ? `${routePurposeShortLabels[entry.purpose]} ${entry.moveFrom} → ${entry.moveTo}`
    : entry.requests.length === 0
      ? 'рейс пуст'
      : entry.requests.map((r) => r.displayNumber).join(', ');
  return `${entry.displayNumber} · ${what}`;
}

/**
 * Рейсы дня пунктами действий карточки телефона: с телефона рейс иначе не открыть вовсе. Пункт на
 * **каждый** рейс дня, а не один «главный»: машина за день ходит несколькими рейсами, у водителя их
 * бывает столько же, и единственный пункт прятал бы как раз те, о которых чаще спрашивают
 * (последний рейс, а не первый). Подпись — номером рейса, каким его называют по телефону (`Р-12`).
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

/** Часть ответа «куда»: заявка ссылкой либо обычный текст. */
type OrderPart = { request?: BusyRequestRef; text?: string };

/** Куда работа едет, разобранное на части: разбор один и на разметку, и на текст подсказки —
 * собирай их порознь, и подсказка однажды показала бы не то, что скрыл обрез ячейки. */
export function orderParts(entry: GarageBusyEntry): OrderPart[] {
  if (entry.kind === 'special') return [{ request: entry }, { text: specialLine(entry) }];
  if (entry.kind === 'esm2') return entry.sourceRequest ? [{ request: entry.sourceRequest }] : [];
  if (isRelocationPurpose(entry.purpose))
    return [
      ...(entry.sourceRequest ? [{ request: entry.sourceRequest }] : []),
      ...(entry.moveFrom || entry.moveTo ? [{ text: `${entry.moveFrom} → ${entry.moveTo}` }] : []),
    ];
  return entry.requests.length === 0
    ? [{ text: 'рейс пуст' }]
    : entry.requests.map((request) => ({ request }));
}

/** Те же части одной строкой: заявки — ссылками, остальное — текстом. */
export function OrderParts({ parts }: { parts: OrderPart[] }) {
  return parts.map((part, index) => (
    <span key={part.request?.requestId ?? part.text ?? index}>
      {index > 0 ? ' · ' : null}
      {part.request ? <RequestLink request={part.request} /> : part.text}
    </span>
  ));
}

/**
 * Те же части сплошным текстом — для подсказки колонки «Заказ/адрес», где ссылкам не место: в
 * подсказке по них не попасть, она уходит из-под курсора. Собирается из того же разбора, что и
 * разметка (`orderParts`), — иначе подсказка однажды показала бы не то, что скрыл обрез ячейки.
 */
export function orderText(parts: OrderPart[]): string {
  return parts.map((part) => (part.request ? requestText(part.request) : part.text)).join(' · ');
}
