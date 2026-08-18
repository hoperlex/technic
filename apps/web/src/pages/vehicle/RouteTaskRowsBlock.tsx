import { Button, Collapse, Space, Tag, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import {
  type PointRoleInput,
  type TaskRef,
  taskRefKey,
  taskRowLayoutKind,
  type WaybillFormCode,
  type WaybillTaskRow,
  type VehicleRouteDto,
} from '@technic/contracts';
import { vehicleRoutesApi } from '../../api/resources';
import { EntityLink } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { vehicleRequestViewLink } from '../../utils/links';
import { blockerMessage, reorderedPointRoles, type RouteAssembly } from './routeAssembly';
import { useRouteModal } from './routeModal';

/**
 * «Задание листа» — то же самое, но глазами бумаги (§4.3, Р11 плана `docs/route-trips-plan.md`).
 *
 * Список объезда отвечает на «как поедет машина», этот блок — на «что напечатается в бланке», и
 * порядок у них разный только на вид: строки задания идут в порядке **точек**, но строка это ездка
 * или линейный день, а не остановка (в 4-П графы «откуда» и «куда» стоят парой — точку туда
 * печатать некуда). Из-за этого одна остановка даёт две строки, а две остановки — одну, и увидеть
 * это на списке объезда нельзя.
 *
 * Свёрнутый, потому что вопрос он закрывает редкий: собирают день по объезду, а сюда заглядывают
 * дважды — когда считают, влезет ли ещё одна заявка, и когда спорят, чей талон подпишет заказчик.
 * Счётчик и то, и другое называет в заголовке, не заставляя разворачивать.
 *
 * **Стрелки здесь есть не у всех строк, и это правило, а не недоделка.** Порядок строк задания —
 * это порядок отрывных талонов (Р12, Р20), и почти всегда его задаёт объезд: строка стоит там, где
 * стоят её точки. Не задаёт он его ровно в одном случае — когда две строки стоят на **одной и той
 * же** паре точек: автосборка переиспользовала остановку (Р8), и различить их объездом нечем. Вот
 * им стрелки и показываются, а переставляют они порядок работ на общей точке: «эту ездку на карьере
 * грузим первой». У остальных строк стрелок нет намеренно — их переставляют точками в списке
 * объезда, и предлагать два способа сделать одно значит запутать.
 *
 * Номер строки — ссылка на заявку окном (ADR 0120, план `docs/vehicle-routes-modal-plan.md` §1):
 * сюда заглядывают, когда спорят, чей талон подпишет заказчик, и ответ на «что это за работа»
 * лежит в заявке, а не в бланке. Статуса заявки у строки задания нет **структурно** — `TaskRef`
 * несёт один `requestId` (`packages/contracts/src/route-points.ts`), — и доставать его из состава
 * рейса ради выбора вкладки было бы починкой не того: ссылка ведёт не во вкладку, а в окно, и
 * статус ей не нужен вовсе. Ровно для этого случая в контрактах и появился статус-независимый
 * `vehicleRequestViewPath`, обёрнутый здесь `vehicleRequestViewLink` (§3.5 плана).
 */

interface Props {
  route: VehicleRouteDto;
  formCode: WaybillFormCode | null;
  assembly: RouteAssembly;
  /** Выписанный лист замораживает рейс (Р15): бумага у водителя, и переставлять талоны поздно. */
  frozen: boolean;
  /** Рейс после перестановки: карточка кладёт его в кэш и гасит списки. */
  onChanged: (route: VehicleRouteDto) => void;
  onFail: (e: unknown) => void;
}

/**
 * Как печатается строка: талон заказчика, доп. задание или никак.
 *
 * Считается тем же `taskRowLayoutKind`, которым выписка выбирает раскладку строки: четыре строки
 * таблицы 4-П несут отрывной талон (Р12), строки 5–7 печатаются одной ячейкой блока «Дополнительное
 * задание» (ADR 0068), а `null` — «эта строка на бумагу не попадёт»: либо бланк задания не
 * печатает вовсе (форма № 3, ADR 0071), либо строка вышла за ёмкость.
 */
function slotTag(formCode: WaybillFormCode | null, slot: number) {
  const kind = taskRowLayoutKind(formCode, slot);
  if (kind === 'columns') return <Tag color="green">талон {slot}</Tag>;
  if (kind === 'single-cell') return <Tag>доп. задание, без талона</Tag>;
  return <Tag color="red">не печатается</Tag>;
}

/** Строка задания одной строкой: откуда, куда, груз. У линейного дня «откуда» пусто (Р11). */
function rowLine(row: WaybillTaskRow): string {
  const cargo = row.kind === 'freight' ? row.cargoLabel : row.workNote;
  return [row.kind === 'freight' ? `${row.from} → ${row.to}` : row.to, cargo]
    .filter((part) => part.trim() !== '')
    .join(' · ');
}

export function RouteTaskRowsBlock({
  route,
  formCode,
  assembly,
  frozen,
  onChanged,
  onFail,
}: Props) {
  const { can } = useAuth();
  const { openRequest } = useRouteModal();
  const { rows, composition, capacity } = assembly;
  /** Строки состава, до которых порядок объезда ещё не дошёл: их печатать нечем (`rows_unplaced`). */
  const unplaced = composition.length - rows.length;
  const overflow = new Map(
    assembly.blockers
      .filter((blocker) => blocker.code === 'required_fields_overflow')
      .map((blocker) => [taskRefKey(blocker.ref), blocker] as const),
  );

  const reorder = useMutation({
    mutationFn: ({ pointId, roles }: { pointId: string; roles: PointRoleInput[] }) =>
      vehicleRoutesApi.points.rolesOrder(route.id, pointId, { roles, version: route.version }),
    onSuccess: onChanged,
    onError: onFail,
  });

  /*
   * Запасное пустое значение — по той же причине, что и в `assembleRoute`: ключ кэша один на
   * карточку и список, а точки отдают не все двери сервера.
   */
  const points = route.points ?? [];

  /** Роли общей точки в новом порядке: строка меняется местами с соседкой по группе. */
  const rolesFor = (pointId: string, a: TaskRef, b: TaskRef): PointRoleInput[] => {
    const point = points.find((item) => item.id === pointId);
    return point ? reorderedPointRoles(point, a, b) : [];
  };

  /**
   * Сдвиг строки среди тех, которых объезд не различает.
   *
   * Меняется местами с соседкой **по группе**, а не по списку: соседи по группе стоят в печати
   * подряд (первые два ключа сортировки у них общие), поэтому обмен внутри группы и есть обмен
   * соседними строками бумаги.
   */
  const move = (ref: TaskRef, delta: number) => {
    const group = assembly.orderGroups.get(taskRefKey(ref));
    if (!group) return;
    const index = group.refs.findIndex((item) => taskRefKey(item) === taskRefKey(ref));
    const target = index + delta;
    if (index < 0 || target < 0 || target >= group.refs.length) return;
    const roles = rolesFor(group.pointId, ref, group.refs[target]!);
    if (roles.length === 0) return;
    reorder.mutate({ pointId: group.pointId, roles });
  };

  return (
    <Collapse
      size="small"
      items={[
        {
          key: 'task',
          label: (
            <Space size={8} wrap>
              <span>Задание листа</span>
              <Typography.Text type={composition.length > capacity ? 'danger' : 'secondary'}>
                {composition.length} из {capacity} строк
              </Typography.Text>
              {unplaced > 0 && <Tag color="orange">не разложено: {unplaced}</Tag>}
            </Space>
          ),
          children: (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {/* Форма № 3 задание не печатает (ADR 0071): порядок выполнения у легкового не
                гарантирован, и бланк выходит с реквизитами и пустым оборотом. Сказать об этом
                нужно там, где на задание смотрят, — иначе расхождение бумаги с рейсом обнаружат
                после печати. */}
              {formCode !== '4p' && (
                <Typography.Text type="secondary">
                  Задание в этом бланке не печатается: строки остаются планом рейса, а в лист не
                  идут.
                </Typography.Text>
              )}
              {rows.length === 0 && (
                <Typography.Text type="secondary">
                  Строк задания нет: рейс пуст либо его работа ещё не разложена по точкам.
                </Typography.Text>
              )}
              {rows.map((row) => {
                const blocker = overflow.get(taskRefKey(row.ref));
                const group = assembly.orderGroups.get(taskRefKey(row.ref));
                const index = group
                  ? group.refs.findIndex((item) => taskRefKey(item) === taskRefKey(row.ref))
                  : -1;
                return (
                  <div key={taskRefKey(row.ref)} style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Space size={8} wrap>
                        <Tag>{row.slot}</Tag>
                        {/* Номер строки — это номер заявки с её ездкой («ТС-40/2»), и жирным он
                          остаётся по той же причине, что и в составе: строк семь, и глазами по
                          ним ходят номерами. Без права на заявки останется прежним текстом. */}
                        <EntityLink
                          to={vehicleRequestViewLink(can, row.ref.requestId)}
                          title="Открыть заявку"
                          onActivate={() => openRequest(row.ref.requestId)}
                        >
                          <strong>{row.displayNumber}</strong>
                        </EntityLink>
                        {slotTag(formCode, row.slot)}
                      </Space>
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {rowLine(row)}
                        </Typography.Text>
                      </div>
                      {/* Строка, которая в бумагу не влезет, названа и здесь: в объезде её видно у
                        точки, а тут — на своём месте среди строк, где и обнаруживается, что она
                        длиннее соседних. */}
                      {blocker && (
                        <div>
                          <Typography.Text type="danger" style={{ fontSize: 12 }}>
                            {blockerMessage(blocker, assembly)}
                          </Typography.Text>
                        </div>
                      )}
                    </div>
                    {/* Стрелки — только у строк, которых объезд не различает: у остальных порядок
                      задан точками, и вторая дверь к тому же порядку сбивала бы с толку. */}
                    {!frozen && group && (
                      <Space>
                        <Button
                          size="small"
                          icon={<ArrowUpOutlined />}
                          title="Раньше в задании: на общей точке эта строка идёт первой"
                          aria-label={`Поднять строку задания ${row.displayNumber}`}
                          disabled={index <= 0 || reorder.isPending}
                          onClick={() => move(row.ref, -1)}
                        />
                        <Button
                          size="small"
                          icon={<ArrowDownOutlined />}
                          title="Позже в задании: на общей точке эта строка идёт следующей"
                          aria-label={`Опустить строку задания ${row.displayNumber}`}
                          disabled={
                            index < 0 || index >= group.refs.length - 1 || reorder.isPending
                          }
                          onClick={() => move(row.ref, 1)}
                        />
                      </Space>
                    )}
                  </div>
                );
              })}
              {/* Почему стрелки есть не у всех — сказано там, где их отсутствие заметят: человек,
                двигающий талоны, иначе решит, что кнопка не нарисовалась. */}
              {!frozen && assembly.orderGroups.size > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Стрелки — у строк, стоящих на одних и тех же точках: объезд их не различает, и
                  порядок талонов задаёте вы. Остальные строки переставляются точками в порядке
                  объезда.
                </Typography.Text>
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}
