import { useState } from 'react';
import { Alert, Button, Space, Tag, Tooltip, Typography } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  EditOutlined,
  MergeCellsOutlined,
  SplitCellsOutlined,
} from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import {
  type RoutePointAction,
  routeContactsLabel,
  type VehicleRoutePointDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { vehicleRoutesApi } from '../../api/resources';
import {
  actionLabel,
  actionPairLabel,
  blockerMessage,
  mergeHintMessage,
  type PointMergeHint,
  type RouteAssembly,
} from './routeAssembly';
import { RoutePointEditModal } from './RoutePointEditModal';
import { RoutePointSplitModal } from './RoutePointSplitModal';

/**
 * Порядок объезда: как машина едет по дню (§4.3 плана `docs/route-trips-plan.md`).
 *
 * До этого блока карточка показывала **состав** — список заявок, — и стрелки переставляли заявки.
 * Это отвечало на вопрос «что везём», но не на вопрос дня диспетчера: «куда машина заедет и в каком
 * порядке». Разница перестала быть косметической, как только у заявки появились ездки: две ездки
 * `A→B` и `A→C` грузятся за один заезд, а в списке заявок это две строки, и объединить их взглядом
 * нельзя. С печатью по строкам задания (Р11) состав вдобавок перестал задавать порядок бумаги —
 * его задают точки.
 *
 * Поэтому переставляются здесь **точки** (`PUT /:id/points/order`), а не заявки. Серверный мост,
 * выводивший порядок точек из порядка состава (Р14а), с этого момента порталу не нужен: он держал
 * окно между печатью по точкам и этой карточкой.
 *
 * Выписанный лист замораживает список целиком (Р15): бумага у водителя, и запись, разошедшаяся с
 * ней, хуже отсутствия записи. Подсказки при этом гаснут тоже — предлагать действие, которого
 * нельзя сделать, значит обещать несуществующую дверь.
 */

interface Props {
  route: VehicleRouteDto;
  /** Строки задания, блокеры и подсказки — посчитанные один раз на всю карточку. */
  assembly: RouteAssembly;
  frozen: boolean;
  /** Рейс после правки: карточка кладёт его в кэш и гасит списки. */
  onChanged: (route: VehicleRouteDto) => void;
  /** Отказ словами — вместе с перечиткой рейса на конфликте версии; общий на всю карточку. */
  onFail: (e: unknown) => void;
}

export function RoutePointsBlock({ route, assembly, frozen, onChanged, onFail }: Props) {
  /** Точка, открытая на правку адреса и времени; `null` — окно закрыто. */
  const [editing, setEditing] = useState<VehicleRoutePointDto | null>(null);
  /** Точка, которую разносят надвое. */
  const [splitting, setSplitting] = useState<VehicleRoutePointDto | null>(null);

  // Запасное пустое значение — по той же причине, что и в `assembleRoute`: ключ кэша один на
  // карточку и список, а точки отдают не все двери сервера.
  const points = [...(route.points ?? [])].sort((a, b) => a.position - b.position);

  const reorder = useMutation({
    mutationFn: (pointIds: string[]) =>
      vehicleRoutesApi.points.order(route.id, { pointIds, version: route.version }),
    onSuccess: onChanged,
    onError: onFail,
  });

  const merge = useMutation({
    mutationFn: (pointIds: string[]) =>
      vehicleRoutesApi.points.merge(route.id, { pointIds, version: route.version }),
    onSuccess: onChanged,
    onError: onFail,
  });

  const busy = reorder.isPending || merge.isPending;

  /** Сдвиг остановки: порядок уходит на сервер целиком — он переписывает позиции одним заходом. */
  const move = (index: number, delta: number) => {
    const ids = points.map((point) => point.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };

  /** Группа совмещения, в которую входит точка; `null` — совмещать её не с чем. */
  const mergeHintOf = (pointId: string): PointMergeHint | null =>
    assembly.merges.find((hint) => hint.pointIds.includes(pointId)) ?? null;

  /**
   * Отказы над списком — все, кроме непоместившейся строки: та стоит у своей точки (Р11б), потому
   * что чинят её правкой **адреса точки**, а не состава. Водитель отсюда тоже не называется — о нём
   * говорит готовность выписки над кнопкой, и второе сообщение о том же читалось бы как второй
   * пробел.
   */
  const listBlockers = assembly.blockers.filter(
    (blocker) => blocker.code !== 'required_fields_overflow' && blocker.code !== 'no_driver',
  );

  return (
    <div>
      <Typography.Title level={5}>Порядок объезда ({points.length})</Typography.Title>

      {points.length === 0 && (
        <Typography.Paragraph type="secondary">
          Остановок нет: положите в рейс заявку — её ездки разложатся точками сами, а линейный день
          встанет своей точкой из карточки заявки.
        </Typography.Paragraph>
      )}

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {!frozen &&
          listBlockers.map((blocker) => (
            <Alert
              key={blocker.code}
              type={blocker.code === 'capacity_exceeded' ? 'error' : 'warning'}
              showIcon
              message={blockerMessage(blocker, assembly)}
            />
          ))}
        {/* Подсказка совмещения (Р9а): точки одного адреса. Автоматически не склеивается ничего —
          решение «это один заезд» принимает человек: у него данные о том, поместится ли всё в кузов
          и пустят ли машину по одному пропуску. */}
        {!frozen &&
          assembly.merges.map((hint) => (
            <Alert
              key={hint.pointIds.join(':')}
              type="info"
              showIcon
              message={mergeHintMessage(hint)}
              action={
                <Button
                  size="small"
                  loading={merge.isPending}
                  disabled={busy}
                  onClick={() => merge.mutate(hint.pointIds)}
                >
                  Совместить
                </Button>
              }
            />
          ))}

        {points.map((point, index) => (
          <RoutePointRow
            key={point.id}
            point={point}
            index={index}
            total={points.length}
            frozen={frozen}
            busy={busy}
            assembly={assembly}
            mergeHint={mergeHintOf(point.id)}
            onMove={move}
            onEdit={() => setEditing(point)}
            onSplit={() => setSplitting(point)}
            onMerge={(ids) => merge.mutate(ids)}
          />
        ))}
      </Space>

      <RoutePointEditModal
        route={route}
        point={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setEditing(null);
          onChanged(updated);
        }}
      />
      <RoutePointSplitModal
        route={route}
        point={splitting}
        onClose={() => setSplitting(null)}
        onSaved={(updated) => {
          setSplitting(null);
          onChanged(updated);
        }}
      />
    </div>
  );
}

/**
 * Остановка списком: номер, адрес, время, ответственные — и под ними роли, то есть что здесь
 * делают со строками задания.
 *
 * Ответственные стоят **над** ролями, а не в каждой роли: приехав, водитель звонит человеку, а не
 * ездке, и двое встречающих на одной точке (Р9а) — это свойство остановки. Порядок их задан
 * правилом (`pointContacts`), тем же, которым они печатаются в графе «заказчик, телефон» (Р11а), —
 * карточка их не пересортировывает.
 */
function RoutePointRow({
  point,
  index,
  total,
  frozen,
  busy,
  assembly,
  mergeHint,
  onMove,
  onEdit,
  onSplit,
  onMerge,
}: {
  point: VehicleRoutePointDto;
  index: number;
  total: number;
  frozen: boolean;
  busy: boolean;
  assembly: RouteAssembly;
  mergeHint: PointMergeHint | null;
  onMove: (index: number, delta: number) => void;
  onEdit: () => void;
  onSplit: () => void;
  onMerge: (pointIds: string[]) => void;
}) {
  const blockers = assembly.pointBlockers.get(point.id) ?? [];

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        border: '1px solid var(--ant-color-border)',
        borderRadius: 8,
        padding: 8,
      }}
    >
      <Tag style={{ marginTop: 2 }}>{point.position}</Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} wrap>
          <strong>{point.location}</strong>
          {point.arrivalTime && <Tag color="blue">{point.arrivalTime}</Tag>}
        </Space>
        {/* Ответственные: имя и номер тем же видом, каким их печатает бланк (`routeContactsLabel`)
          — их читают и набирают, и два написания одного номера сбивают с толку. */}
        {point.contacts.map((contact) => (
          <div key={`${contact.name}:${contact.phone}`}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ☎ {routeContactsLabel([contact])}
            </Typography.Text>
          </div>
        ))}
        {/* Двое встречающих — не ошибка, а следствие совмещения (Р9а), и бланк напечатает обоих.
          Сказать об этом надо здесь: человек, совместивший точки, иначе узнал бы это с бумаги. */}
        {point.contacts.length > 1 && (
          <Tag color="warning">{point.contacts.length} ответственных — в лист пойдут все</Tag>
        )}
        {point.actions.map((action) => (
          <PointActionLine key={`${action.displayNumber}:${action.role}`} action={action} />
        ))}
        {point.comment && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {point.comment}
            </Typography.Text>
          </div>
        )}
        {/* Непечатаемая строка видна при сборке, а не при выписке (Р11а), и ведёт туда, где чинят:
          в правку адреса **этой** точки — печатается он, а не поле ездки (Р11б). */}
        {!frozen &&
          blockers.map((blocker) => (
            <Alert
              key={`${blocker.code}:${point.id}`}
              style={{ marginTop: 6 }}
              type="error"
              showIcon
              message={blockerMessage(blocker, assembly)}
              action={
                <Button size="small" onClick={onEdit}>
                  Править точку
                </Button>
              }
            />
          ))}
      </div>
      {!frozen && (
        <Space>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            title="Выше"
            aria-label={`Поднять точку ${point.position}`}
            disabled={index === 0 || busy}
            onClick={() => onMove(index, -1)}
          />
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            title="Ниже"
            aria-label={`Опустить точку ${point.position}`}
            disabled={index === total - 1 || busy}
            onClick={() => onMove(index, 1)}
          />
          <Button
            size="small"
            icon={<EditOutlined />}
            title="Править адрес, время и записку"
            aria-label={`Править точку ${point.position}`}
            disabled={busy}
            onClick={onEdit}
          />
          {/* «Совместить» стоит у точки, а не только в подсказке: подсказку прочитали и закрыли
            глазами, а свести две остановки хотят, стоя на одной из них. Действие то же самое —
            вся группа одного адреса разом.

            Обёртка `<span>` — не украшение: выключенная кнопка мышиных событий не отдаёт, и
            подсказка на ней не показалась бы, то есть выключенная кнопка молчала бы о причине. */}
          <span
            title={
              mergeHint
                ? `Свести с точками ${mergeHint.positions.filter((p) => p !== point.position).join(', ')}`
                : 'Совмещать не с чем: другой точки с этим адресом в маршруте нет'
            }
          >
            <Button
              size="small"
              icon={<MergeCellsOutlined />}
              aria-label={`Совместить точку ${point.position}`}
              disabled={busy || !mergeHint}
              onClick={() => mergeHint && onMerge(mergeHint.pointIds)}
            />
          </span>
          <span
            title={
              point.actions.length > 1
                ? 'Разнести: часть работы уйдёт в новую остановку'
                : 'Разносить нечего: на точке одна строка задания'
            }
          >
            <Button
              size="small"
              icon={<SplitCellsOutlined />}
              aria-label={`Разнести точку ${point.position}`}
              disabled={busy || point.actions.length < 2}
              onClick={onSplit}
            />
          </span>
        </Space>
      )}
    </div>
  );
}

/** Роль на точке: что делают со строкой задания и куда она едет дальше. */
function PointActionLine({ action }: { action: RoutePointAction }) {
  const pair = actionPairLabel(action);
  return (
    <div>
      <Space size={6} wrap>
        <Typography.Text style={{ fontSize: 13 }}>{actionLabel(action)}</Typography.Text>
        {pair && (
          <Typography.Text
            // Ездка, у которой второй конец не разложен, не «предупреждение оформления»: по такой
            // строке бумагу не напечатать, и выписка ответит `rows_unplaced`.
            type={action.kind === 'freight' && action.pairPosition === 0 ? 'danger' : 'secondary'}
            style={{ fontSize: 12 }}
          >
            {pair}
          </Typography.Text>
        )}
        {/* Расхождение адреса (Р10): точка держит свой снимок, а в заявке адрес с тех пор поправили.
          Печатается адрес **точки** (Р11б), и подтверждают это при выписке предупреждением
          `address_mismatch` — здесь о нём говорят заранее, пока правка ещё дешева. */}
        {action.addressMismatch && (
          <Tooltip title="В заявке адрес этой строки задания другой. В бланк пойдёт адрес точки — поправьте его, если ехать надо по заявке.">
            <Tag color="warning">адрес ездки изменился</Tag>
          </Tooltip>
        )}
      </Space>
    </div>
  );
}
