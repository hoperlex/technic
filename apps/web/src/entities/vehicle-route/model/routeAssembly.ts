import {
  type IssueBlocker,
  type PointRoleInput,
  type RoutePointAction,
  routeIssueBlockers,
  routeRequestCapacity,
  suggestPointMerges,
  type TaskRef,
  taskRefKey,
  type TaskRowField,
  type TaskRowOrderGroup,
  taskRowOrderGroups,
  type VehicleRoutePointDto,
  waybillTaskRows,
  type WaybillTaskRow,
  type VehicleRouteDto,
} from '@technic/contracts';

/**
 * Сборка дня глазами карточки: строки задания, блокеры выписки и подсказки совмещения — всё, что
 * карточка считает **из точек**, а не спрашивает у сервера (§4.3, Р11, Р11а, Р11б плана
 * `docs/route-trips-plan.md`).
 *
 * Правила здесь не свои: они целиком в контрактах (`routeIssueBlockers`, `waybillTaskRows`,
 * `suggestPointMerges`), и повторять их в портале нельзя — сервер считает те же и отвечает теми же
 * отказами. Этот модуль отвечает на другое: **чем** их накормить и **как** назвать результат
 * человеку. Обе задачи стоят отдельно от разметки — карточку они бы раздули, а проверяются они
 * данными, а не рисованием.
 */

/**
 * Строки задания состава — то, чем меряется ёмкость бланка и что обязано быть разложено по точкам.
 *
 * Сервер берёт их из состава (`routeTaskRefs`: ездки живых заявок плюс дни линейных заказов), а
 * карточке взять их оттуда **нечем**: `VehicleRouteRequestDto` ездок не несёт — у него адреса и
 * количество первой живой ездки и ни одного `tripId` (`requestsByRoute`). Поэтому грузовые строки
 * собираются из ролей точек: роль ссылается на строку задания составным ключом, и строка, у
 * которой в маршруте есть хоть один конец, отсюда видна вся — в том числе разложенная наполовину,
 * ради которой блокер `rows_unplaced` и заведён.
 *
 * Расходится этот счёт с серверным ровно в одном состоянии: строка состава, у которой нет **ни
 * одной** точки. Через двери портала оно недостижимо — укладка заявки и постановка дня заводят
 * точки сами (Р8), а удаление точки отказывает на последней роли строки (§7), — но если такое
 * состояние в базе появится, карточка о нём промолчит, а сервер откажет при выписке. Честная
 * цена одного поля в DTO; заводить его — этапу 8, вместе с «Задание листа» в списке рейсов.
 *
 * Линейные дни, наоборот, читаются из состава напрямую: `workDate` в строке состава есть, и день
 * без точки карточка называет неразложенным сама.
 */
export function routeCompositionRefs(route: VehicleRouteDto): TaskRef[] {
  const positionOf = new Map(route.requests.map((item) => [item.requestId, item.position]));
  const found = new Map<string, { ref: TaskRef; position: number; tripNum: number }>();
  const add = (ref: TaskRef, position: number, tripNum: number) => {
    const key = taskRefKey(ref);
    if (!found.has(key)) found.set(key, { ref, position, tripNum });
  };

  for (const point of route.points ?? []) {
    for (const action of point.actions) {
      add(action.ref, positionOf.get(action.ref.requestId) ?? 0, action.tripNum);
    }
  }
  // День линейного заказа, снятый со всех точек: строка состава у него осталась, и «не разложен» —
  // это про него. У грузовой строки такой видимости нет (см. выше), и придумывать её нечем.
  for (const item of route.requests) {
    if (!item.workDate) continue;
    add({ kind: 'linear', requestId: item.requestId, workDate: item.workDate }, item.position, 0);
  }

  // Порядок — состава, внутри заявки по номеру ездки: тем же ключом сервер возвращает
  // неразложенные строки, у которых своей позиции в маршруте нет.
  return [...found.values()]
    .sort((a, b) => a.position - b.position || a.tripNum - b.tripNum)
    .map((item) => item.ref);
}

/**
 * Роль точки телом запроса. Точка правится составом ролей **целиком** (§7), и правка адреса обязана
 * прислать те же роли, что на ней стоят, — иначе «поправил время» означало бы «снял с точки всю
 * работу». Разметка та же, что у DTO: у ездки заявка называется рядом с ездкой (по ней сервер берёт
 * строку состава и блокировку, Р17), у линейного дня роль не спрашивается вовсе — она всегда `work`.
 */
export function pointRoleInputOf(action: RoutePointAction): PointRoleInput {
  return action.kind === 'freight'
    ? {
        kind: 'freight',
        requestId: action.ref.requestId,
        tripId: action.ref.tripId,
        role: action.role,
      }
    : { kind: 'linear', requestId: action.ref.requestId, workDate: action.ref.workDate };
}

/**
 * Роль в списке точки: значок, слово и номер строки задания — «↑ погрузка ТС-40/1 · 10 м³».
 *
 * Значок стоит **перед** словом и повторяет направление груза: список читают глазами сверху вниз,
 * и стрелка отвечает на «что здесь происходит» раньше, чем человек дочитает строку. У линейного дня
 * направления нет вовсе (Р5а) — у него шестерёнка работы.
 */
const ROLE_MARKS: Record<RoutePointAction['role'], string> = {
  load: '↑',
  work: '⚙',
  unload: '↓',
};
const ROLE_WORDS: Record<RoutePointAction['role'], string> = {
  load: 'погрузка',
  work: 'работа',
  unload: 'разгрузка',
};

export function actionLabel(action: RoutePointAction): string {
  const cargo = action.kind === 'freight' ? action.cargoLabel : '';
  return [`${ROLE_MARKS[action.role]} ${ROLE_WORDS[action.role]}`, action.displayNumber, cargo]
    .filter((part) => part !== '')
    .join(' · ');
}

/**
 * Где второй конец ездки: «→ к точке 2» у погрузки, «← от точки 1» у разгрузки.
 *
 * Ноль позиции — не «первая точка», а «пары нет» (`pairPosition` в DTO): ездка разложена
 * наполовину, и это не порядок, а `rows_unplaced`. Сказать об этом надо здесь же, у самой роли:
 * блокер над списком назовёт номер строки, а куда смотреть — видно только отсюда. У линейного дня
 * пары не бывает, и второго конца он не ищет.
 */
export function actionPairLabel(action: RoutePointAction): string {
  if (action.kind !== 'freight') return '';
  if (action.pairPosition === 0) {
    return action.role === 'load' ? '→ разгрузка не разложена' : '← погрузка не разложена';
  }
  return action.role === 'load'
    ? `→ к точке ${action.pairPosition}`
    : `← от точки ${action.pairPosition}`;
}

/** Точки одного адреса, которые стоит свести в одну остановку (Р9а). */
export interface PointMergeHint {
  pointIds: string[];
  /** Позиции тех же точек: подсказку человек читает номерами объезда, а не идентификаторами. */
  positions: number[];
  /** Ответственные совпали; `false` — точка выйдет с обоими, и бланк напечатает обоих (Р11а). */
  sameContacts: boolean;
}

export interface RouteAssembly {
  /** Строки задания в порядке печати: ездки и линейные дни одним списком (Р11). */
  rows: WaybillTaskRow[];
  /** Строк задания в составе — включая неразложенные: ими меряется бумага. */
  composition: TaskRef[];
  /** Строк задания в бланке рейса (ADR 0068). */
  capacity: number;
  /** Что мешает выписать лист — тем же правилом, каким ответит сервер. */
  blockers: IssueBlocker[];
  merges: PointMergeHint[];
  /**
   * Блокеры, которые чинятся правкой конкретной точки (Р11б): `pointId` → его список. Сегодня это
   * только непоместившаяся строка задания — у остальных отказов адресат не точка, а состав.
   */
  pointBlockers: Map<string, IssueBlocker[]>;
  /** `taskRefKey` → «ТС-40/2»: отказы адресуются ссылкой, а человек читает номер строки. */
  labels: Map<string, string>;
  /**
   * Строки, которых порядок объезда не различает: `taskRefKey` → его группа (общая точка и порядок
   * строк на ней). Ими решается, у каких строк «Задания листа» показывать стрелки, — у остальных
   * порядок задан объездом, и переставлять их надо точками.
   */
  orderGroups: Map<string, TaskRowOrderGroup>;
}

/**
 * Всё, что карточка знает о собранном дне, — из одного чтения точек.
 *
 * Одной функцией, а не тремя вызовами по месту показа: строки задания нужны и блоку «Задание
 * листа», и счётчику, и блокерам, а `routeIssueBlockers` собирает их внутри себя ещё раз. Пусть
 * лишний проход и дёшев, разъехаться два списка не должны — по одному из них человек читает
 * «5 из 7 строк», по другому получает отказ выписки.
 *
 * Комментарии строк (`TaskRowNotes`) сюда не передаются: в точке их нет — комментарий принадлежит
 * ездке или заявке, а не остановке, и DTO рейса его не несёт. На блокеры это не влияет:
 * `taskRowLayout` отбрасывает комментарий первым, и `required_fields_overflow` считается по
 * адресам и количеству, то есть по тому, что в точке есть. На бумаге комментарий останется — его
 * подставит выписка на сервере.
 */
export function assembleRoute(route: VehicleRouteDto): RouteAssembly {
  /*
   * Точки берутся через запасное пустое значение, хотя тип их обещает. Ключ кэша `vehicle-routes`
   * один на карточку, список и подсказки, а точки отдают не все двери сервера — рейс, положенный
   * туда списком, поля не несёт. Пустой маршрут карточка покажет честно («остановок нет»), а
   * падение на `undefined.map` стоило бы всей карточки, включая аннулирование листа.
   */
  const points = route.points ?? [];
  const composition = routeCompositionRefs(route);
  const rows = waybillTaskRows(points);
  const blockers = routeIssueBlockers({
    driverPersonId: route.driverPersonId,
    formCode: route.formCode,
    points,
    composition,
  });

  const positionOf = new Map(points.map((point) => [point.id, point.position]));
  const merges = suggestPointMerges(points).map((hint) => ({
    ...hint,
    positions: hint.pointIds.map((id) => positionOf.get(id) ?? 0),
  }));

  const pointBlockers = new Map<string, IssueBlocker[]>();
  for (const blocker of blockers) {
    if (blocker.code !== 'required_fields_overflow') continue;
    const list = pointBlockers.get(blocker.pointId) ?? [];
    list.push(blocker);
    pointBlockers.set(blocker.pointId, list);
  }

  const labels = new Map<string, string>();
  for (const point of points) {
    for (const action of point.actions) labels.set(taskRefKey(action.ref), action.displayNumber);
  }

  const orderGroups = new Map<string, TaskRowOrderGroup>();
  for (const group of taskRowOrderGroups(points)) {
    for (const ref of group.refs) orderGroups.set(taskRefKey(ref), group);
  }

  return {
    rows,
    composition,
    capacity: routeRequestCapacity(route.formCode),
    blockers,
    merges,
    pointBlockers,
    labels,
    orderGroups,
  };
}

/**
 * Роли точки в новом порядке: две названные строки задания меняются местами, остальные роли остаются
 * там, где стояли.
 *
 * Порядок присылается полным списком (`PUT /:id/points/:pointId/roles/order`), поэтому карточка и
 * собирает весь состав точки, а не пару. Ищется у каждой строки её **первая** роль — та, что стоит
 * на этой точке: у ездки погрузка, у линейного дня работа. Разгрузка чужой ездки, стоящая тут же,
 * своего места не теряет: строки переставляют друг друга, а не всю остановку.
 */
export function reorderedPointRoles(
  point: VehicleRoutePointDto,
  a: TaskRef,
  b: TaskRef,
): PointRoleInput[] {
  const actions = [...point.actions].sort((x, y) => x.position - y.position);
  const indexOf = (ref: TaskRef) =>
    actions.findIndex(
      (action) => taskRefKey(action.ref) === taskRefKey(ref) && action.role !== 'unload',
    );
  const from = indexOf(a);
  const to = indexOf(b);
  // Роли на точке нет — карточка отстала от сервера: тогда порядок уходит прежним, и ответ сервера
  // приведёт её в чувство. Придумывать перестановку по неполным данным нельзя: переставится не то.
  if (from >= 0 && to >= 0) [actions[from], actions[to]] = [actions[to]!, actions[from]!];
  return actions.map(pointRoleInputOf);
}

/** Номер строки задания человеку; ссылка без номера — строка, которой в маршруте уже нет. */
function refLabel(ref: TaskRef, labels: ReadonlyMap<string, string>): string {
  return labels.get(taskRefKey(ref)) ?? 'строка задания';
}

/** Графа бланка, в которую не влезло: человеку называется то, что он пойдёт править. */
const FIELD_LABELS: Record<TaskRowField, string> = {
  from: 'адрес погрузки',
  to: 'адрес разгрузки',
  cargo: 'количество груза',
};

/**
 * Отказ словами — тем же, чем его назовёт сервер, но с номерами строк вместо ссылок.
 *
 * `no_driver` сюда доходит и здесь же называется: карточка его не показывает (о водителе говорит
 * готовность выписки над кнопкой), но молчаливая ветка в разборе объединения — это отказ, о
 * котором однажды никто не узнает.
 */
export function blockerMessage(blocker: IssueBlocker, assembly: RouteAssembly): string {
  const names = (refs: readonly TaskRef[]) =>
    refs.map((ref) => refLabel(ref, assembly.labels)).join(', ');
  switch (blocker.code) {
    case 'no_driver':
      return 'Водитель не назначен: без него лист не выписать';
    case 'trip_order_broken':
      return blocker.refs.length === 1
        ? `${names(blocker.refs)} разгружается раньше, чем грузится — переставьте точки`
        : `Разгрузка стоит раньше погрузки: ${names(blocker.refs)} — переставьте точки`;
    case 'rows_unplaced':
      return `Не разложено по точкам: ${names(blocker.refs)} — у строки нет второго конца`;
    case 'capacity_exceeded':
      return `Строк задания ${blocker.rows}, а в бланке ${blocker.capacity}: выньте заявку, снимите день или заведите второй маршрут`;
    case 'required_fields_overflow':
      return `Строка ${blocker.slot} (${refLabel(blocker.ref, assembly.labels)}) не поместится в бланк: ${blocker.fields
        .map((field) => FIELD_LABELS[field])
        .join(', ')}`;
  }
}

/**
 * Подсказка совмещения (Р9а): что предлагают свести и чем это обернётся в бланке.
 *
 * Оговорка про разных ответственных — не украшение: совмещение их не выбрасывает и не выбирает
 * между ними, точка выходит с обоими, и графа «заказчик, телефон» напечатает обоих (Р11а).
 * Человек, ждавший «останется один», иначе узнал бы об этом с бумаги.
 */
export function mergeHintMessage(hint: PointMergeHint): string {
  // «1 и 4», «1, 4 и 6»: три заезда в один карьер это одно предложение, а не три попарных, и
  // читаться оно обязано перечислением, а не цепочкой «и».
  const positions = hint.positions.slice(0, -1).join(', ');
  const last = hint.positions[hint.positions.length - 1];
  const head = `Точки ${positions} и ${last} — один адрес.`;
  return hint.sameContacts
    ? `${head} Совместить в одну остановку?`
    : `${head} У точек разные ответственные — в лист пойдут оба.`;
}
