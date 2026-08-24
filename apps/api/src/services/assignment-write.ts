import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type {
  AssignmentChangeOrigin,
  AssignmentChangeTarget,
  AssignmentSupersedeKind,
  DriverState,
  DriverStateKind,
} from '@technic/contracts';
import { vehicleRequestAssignmentChanges, vehicleRequestAssignments } from '../db/schema';
import { AppError, err } from '../lib/errors';
import type { AssignmentChangeRow } from './assignment-history';
import type { AssignmentModeTx } from './assignment-mode';

/**
 * Ядро записи истории назначения — единственное место, где строки
 * `vehicle_request_assignment_changes` появляются, гаснут и сверяются с денормализацией
 * (`docs/assignment-periods-plan.md`, Р3, Р10, Р17, Р30; миграция `0166`).
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Есть механика неизменяемых строк: гашение прежней и вставка новой с
 * обратной ссылкой, групповое гашение и проверка Р17 — «денормализацию трогает только то изменение,
 * которое её определяет». Нет ни одной предметной двери: ни расчёта последствий (он в
 * `assignment-effects.ts`), ни свёртки (`assignment-history.ts`), ни бумаги (`esm2-plan.ts`), ни
 * состояний готовности (Р26 — их автомат приезжает вместе с `ensureAssignmentHistory`). Модуль
 * `assignment_history_state` не трогает вовсе: состояние — вывод из проверенной истории, и
 * поднимать его в тот же миг, когда строки только легли, значило бы объявить валидным то, что ещё
 * никто не проверял.
 *
 * ПОЧЕМУ ЗАПИСЬ ВЫНЕСЕНА В ОТДЕЛЬНЫЙ МОДУЛЬ. Дверей истории пять (§8), и каждая из них способна
 * записать те же три вида мутаций. Разложенные по дверям `INSERT`/`UPDATE` расходятся с правилами
 * Р3 при первой же правке — так и вышло у сегодняшнего снятия подписей, где «назначение одно на
 * весь срок» повторено в трёх местах разными словами. Здесь правила выписаны один раз, и дверь их
 * не переписывает, а называет.
 *
 * СОЕДИНЕНИЕ ПРИХОДИТ АРГУМЕНТОМ, И МОДУЛЬ НЕ ИМПОРТИРУЕТ ПРИКЛАДНОЙ ПУЛ (урок Ю23). Цена
 * противоположного вскрылась на живом прогоне двери режима: `src/db/client` тянет `src/config`, а
 * тот валидирует **весь** env приложения при загрузке, — и административная команда отказывалась
 * работать без `JWT_PUBLIC_KEY_PEM` и `S3_*`, которых у оператора в аварии может не быть. Здесь то
 * же требование не стилистическое: этим же ядром будет писать массовый бэкфилл этапа 4 —
 * maintenance-скрипт со своими кредами, — и импорт пула сделал бы его заложником портального
 * окружения. Поэтому тип транзакции берётся у drizzle (`AssignmentModeTx`), а `db` не импортируется.
 *
 * ЧТО ОБЯЗАН ДЕРЖАТЬ ВЫЗЫВАЮЩИЙ. Строку заявки под `FOR UPDATE` (`lockRequestRow`) и открытую
 * дверь режима (`requireOpenDoor`) — то и другое даёт каркас `assignment-command.ts`, и ходить сюда
 * мимо него не следует. Ядро блокировок не берёт само намеренно: взяв их вторым местом, оно
 * перевернуло бы канонический порядок §8 у той двери, которая уже держит рейсы.
 */

/** Транзакция записи. Тип берётся у drizzle — прикладной пул модуль не импортирует (Ю23). */
export type AssignmentWriteTx = AssignmentModeTx;

// ── Строка истории, как её читает и пишет ядро ──

/**
 * Строка `vehicle_request_assignment_changes` со всеми колонками провенанса.
 *
 * Расширяет `AssignmentChangeRow` свёртки, а не заводит вторую форму: свёртке `correction_id` и
 * автор не нужны, а отмене, ремонту и снимку операции — нужны, и урезанный тип заставил бы их
 * держать собственную выборку той же таблицы.
 */
export interface AssignmentChangeRecord extends AssignmentChangeRow {
  requestId: string;
  correctionId: string | null;
  createdBy: string | null;
  createdAt: Date;
  supersedesChangeId: string | null;
  supersededKind: AssignmentSupersedeKind | null;
}

const changeColumns = {
  id: vehicleRequestAssignmentChanges.id,
  requestId: vehicleRequestAssignmentChanges.requestId,
  effectiveDate: vehicleRequestAssignmentChanges.effectiveDate,
  dimension: vehicleRequestAssignmentChanges.dimension,
  vehicleId: vehicleRequestAssignmentChanges.vehicleId,
  driverPersonId: vehicleRequestAssignmentChanges.driverPersonId,
  driverState: vehicleRequestAssignmentChanges.driverState,
  origin: vehicleRequestAssignmentChanges.origin,
  changeGroupId: vehicleRequestAssignmentChanges.changeGroupId,
  correctionId: vehicleRequestAssignmentChanges.correctionId,
  createdBy: vehicleRequestAssignmentChanges.createdBy,
  createdAt: vehicleRequestAssignmentChanges.createdAt,
  supersedesChangeId: vehicleRequestAssignmentChanges.supersedesChangeId,
  supersededAt: vehicleRequestAssignmentChanges.supersededAt,
  supersededKind: vehicleRequestAssignmentChanges.supersededKind,
};

/**
 * Вся история заявки либо только действующая её часть.
 *
 * Порядок — по дате и затем по времени вставки: свёртка сортирует сама, но детерминированный
 * порядок нужен и тестам, и снимку операции, и разбору «что тут вообще было».
 */
export async function readAssignmentChanges(
  tx: AssignmentWriteTx,
  requestId: string,
  options: { actualOnly?: boolean } = {},
): Promise<AssignmentChangeRecord[]> {
  const where = options.actualOnly
    ? and(
        eq(vehicleRequestAssignmentChanges.requestId, requestId),
        isNull(vehicleRequestAssignmentChanges.supersededAt),
      )
    : eq(vehicleRequestAssignmentChanges.requestId, requestId);
  return tx
    .select(changeColumns)
    .from(vehicleRequestAssignmentChanges)
    .where(where)
    .orderBy(
      asc(vehicleRequestAssignmentChanges.effectiveDate),
      asc(vehicleRequestAssignmentChanges.createdAt),
      asc(vehicleRequestAssignmentChanges.id),
    );
}

// ── Значение и мутации ──

/**
 * Значение изменения — union по шкале (Р3, Р19).
 *
 * Разложить его по трём необязательным полям (`vehicleId?`, `driverPersonId?`, `driverState?`)
 * нельзя: тогда представимо «vehicle-изменение с человеком» и «`unknown` с названной фамилией» —
 * ровно то, что CHECK таблицы запрещает, и ровно то, из-за чего `unknown` перестал бы означать
 * признание неполноты.
 */
export type AssignmentChangeValue =
  { dimension: 'vehicle'; vehicleId: string } | { dimension: 'driver'; driver: DriverState };

/**
 * Что команда делает с историей. Три вида, и третьего способа изменить строку не существует (Р3):
 *
 * - `insert` — новая строка. Ничего не гасит; дата и шкала обязаны быть свободны, иначе частичный
 *   UNIQUE `(request_id, dimension, effective_date) WHERE superseded_at IS NULL` отвергнет вставку;
 * - `replace` — правка решения: прежняя строка гасится `replaced`, новая ссылается на неё
 *   **обратной** ссылкой `supersedes_change_id`. Шкалу и дату замена не меняет — их держит
 *   составной FK; перенос даты выражается парой `cancel` + `insert` (Р13);
 * - `cancel` — отмена решения: гасится **вся группа** `change_group_id` и замены не вставляется.
 *   Шкала возвращается к значению, действовавшему до неё.
 */
export type AssignmentWriteMutation =
  | {
      kind: 'insert';
      effectiveDate: string;
      value: AssignmentChangeValue;
      origin: AssignmentChangeOrigin;
      /**
       * Логический ключ группы **внутри команды** (В2): строки, рождённые одним решением, получают
       * один `change_group_id`. Не назван — строка сама себе группа. Идентификатор группы ядро
       * выдаёт само: доверять его двери значило бы разрешить ей вписать свои строки в чужую группу
       * и погасить их следующей отменой заодно.
       */
      group?: string;
    }
  | {
      kind: 'replace';
      target: AssignmentChangeTarget;
      value: AssignmentChangeValue;
      /**
       * Происхождение **новой** строки называется явно и не наследуется от заменяемой. Наследование
       * было бы прямой ложью на главном случае: правка `backfill`-строки человеком означает, что у
       * решения появился автор, а `origin = 'backfill'` вместе с `created_by` объявляет обратное.
       */
      origin: AssignmentChangeOrigin;
      /**
       * Группа **новой** строки, если она рождена не тем же решением, что заменяемая (найдено
       * волной 3.2). По умолчанию замена остаётся в группе цели — так правка решения не рвёт его
       * состав. Но заполнение `unknown` (Ц4) начинает **своё** решение поверх чужой строки: его
       * группа обязана содержать только `known_fill` и границу `unknown_remainder` (Ю2), иначе
       * отмена по `changeGroupId` не найдёт свою пару. Без этого поля заполнение выражалось бы
       * парой `cancel` + `insert`, а групповой `cancel` заодно гасил бы спутников чужого решения.
       */
      group?: string;
    }
  | { kind: 'cancel'; target: AssignmentChangeTarget };

// ── Денормализация (Р17) ──

/**
 * Что команда делает с `vehicle_request_assignments` — называется явно, умолчания нет.
 *
 * Вывести это из самих мутаций нельзя, и попытка вывести была бы ошибкой в обе стороны. Бэкфилл
 * вставляет в том числе последнее vehicle-изменение — по правилу «затронуто последнее активное»
 * денормализацию пришлось бы переписать, а он её как раз читает как источник (Р30: расхождение
 * хвоста законно и остаётся предупреждением). Решение хвоста `assignment_wins`, наоборот, пишет
 * последнюю vehicle-строку и денормализацию трогать не вправе. Поэтому намерение приносит дверь, а
 * ядро его проверяет — на живом состоянии и после того, как обе записи сделаны.
 */
export type AssignmentDenormalizationIntent =
  /**
   * Историческое изменение (Р17, общий случай): назначение отвечает на «чем заявка закрыта
   * сейчас», а команда правит прошлое. Ядро проверит, что хвост истории от этого не сдвинулся:
   * сдвинулся — значит команда обязана была перевести и назначение, и это ошибка двери, а не
   * данных.
   */
  | { kind: 'keep' }
  /**
   * Назначение обязано показать хвост истории. Полный путь (`resolveAssignment` со ставками,
   * правила аренды, рейс) остаётся у двери — Р17 требует именно его, а половинчатая запись «только
   * машина» разошлась бы со ставками. Ядро сверяет результат: после команды в денормализации стоит
   * та машина, которую даёт последнее активное vehicle-изменение.
   */
  | { kind: 'follow' }
  /**
   * Решение хвоста `assignment_wins` (Р17, исключение 1): дремлющая vehicle-граница на `dateTo + 1`
   * пишется **со значением текущего назначения**, а само назначение и ставки не трогаются. Ядро
   * проверяет и то и другое — «assert значение == машине текущего назначения» из предписания.
   */
  | { kind: 'tail_assignment_wins' }
  /**
   * Первая материализация истории по денормализации (бэкфилл, Р20/Р30): история догоняет
   * назначение, а не наоборот, и хвост её законно расходится с ним — это предупреждение отчёта, а
   * не блокер. Ядро проверяет только, что назначение осталось нетронутым.
   */
  | { kind: 'materialize' }
  /**
   * Отмена дремлющего решения хвоста (Р31, найдено волной 3.2): группа `assignment_wins` гасится,
   * назначение и ставки не трогаются. Хвост истории при этом **законно расходится** с назначением —
   * граница снята, и вопрос «чем заявка закрыта после срока» снова открыт; это не то же, что
   * `keep`, где сдвинувшийся хвост означает ошибку двери. Ядро проверяет единственное, что здесь
   * можно проверить: назначение осталось нетронутым.
   */
  | { kind: 'tail_release' };

/**
 * Снимок для проверки Р17: намерение двери и машины, между которыми она обещала согласие.
 *
 * Отдаётся из `applyAssignmentMutations` и проверяется **отдельным вызовом в конце шага 11** —
 * потому что дверь пишет назначение своим полным путём после мутаций истории, и проверка,
 * выполненная тут же, читала бы состояние до её записи.
 */
export interface AssignmentDenormalizationCheck {
  requestId: string;
  intent: AssignmentDenormalizationIntent;
  /** Машина денормализации до команды; `null` — назначения у заявки нет. */
  vehicleBefore: string | null;
  /** Машина хвоста истории до команды (свёртка последнего активного vehicle-изменения). */
  tailBefore: string | null;
  /** Она же после команды. */
  tailAfter: string | null;
}

// ── Результат записи ──

export interface AssignmentWriteResult {
  /** Строки, легшие в базу, — в порядке мутаций команды. */
  inserted: AssignmentChangeRecord[];
  /**
   * Погашенные строки целиком, а не одними идентификаторами: снимок операции обязан объяснить
   * «было → стало» через месяцы, а в самой таблице прежнее значение к тому времени будет лежать
   * рядом с десятком других — искать его там придётся тем же запросом, который уже сделан здесь.
   */
  superseded: { kind: AssignmentSupersedeKind; row: AssignmentChangeRecord }[];
  /** Группы, погашенные целиком (Р13, В2) — их называет `payload` и показывает портал. */
  cancelledGroups: string[];
  /** Действующая история после команды: вход свёртки для сверки бумаги и постусловий. */
  changesAfter: AssignmentChangeRecord[];
  /** Обещание Р17, которое проверит `assertAssignmentDenormalization` в конце шага 11. */
  denormalization: AssignmentDenormalizationCheck;
}

export interface AssignmentWriteInput {
  requestId: string;
  /**
   * Автор строк. `null` — только бэкфилл: у восстановленной по бумаге истории автора нет, и
   * приписывать её запустившему скрипт значило бы называть автором решения того, кто его не
   * принимал. Гасить строки без автора нельзя вовсе — `superseded_by_user` объявлен `NOT NULL`
   * тройкой погашения, и это не техническая деталь: отмена решения всегда чья-то.
   */
  actorUserId: string | null;
  /** Операция журнала, породившая строки; `null` — обычная работа без бумаги задним числом. */
  correctionId: string | null;
  mutations: readonly AssignmentWriteMutation[];
  denormalization: AssignmentDenormalizationIntent;
}

/**
 * Применить мутации команды — единственный вход записи истории.
 *
 * ПОРЯДОК ВНУТРИ КОМАНДЫ ЗАДАЁТ ЯДРО, А НЕ ПОРЯДОК СПИСКА: сначала гаснут все строки (замены и
 * отмены), потом вставляются новые. Иначе перенос решения на другую дату — пара `cancel` + `insert`
 * (Р13) — упирался бы в частичный UNIQUE ровно тогда, когда дверь перечислила мутации в
 * «естественном» порядке «сначала новое, потом убрать старое». Правило Р3 «гасим → вставляем»
 * должно быть свойством ядра, а не дисциплины пяти дверей.
 *
 * ЦЕЛИ РАЗРЕШАЮТСЯ ПО СВЕЖЕМУ ЧТЕНИЮ ПОД БЛОКИРОВКОЙ, а не по снимку, с которым дверь планировала.
 * Стоит это один запрос, а отвечает на вопрос, который иначе решался бы верой: «та ли это строка,
 * которую человек видел».
 */
export async function applyAssignmentMutations(
  tx: AssignmentWriteTx,
  input: AssignmentWriteInput,
): Promise<AssignmentWriteResult> {
  const before = await readAssignmentChanges(tx, input.requestId, { actualOnly: true });
  const vehicleBefore = await readAssignmentVehicle(tx, input.requestId);

  const supersedes = await plannedSupersedes(tx, input, before);
  const cancelledGroups = [
    ...new Set(supersedes.filter((s) => s.kind === 'cancelled').map((s) => s.row.changeGroupId)),
  ];

  // 1. Гасим. Двумя запросами, а не одним: вид погашения — часть строки, и «replaced» с
  //    «cancelled» в одном `UPDATE` пришлось бы разводить `CASE`, то есть тем же двумя запросами,
  //    только неразличимо в логе.
  for (const kind of ['replaced', 'cancelled'] as const) {
    const ids = supersedes.filter((s) => s.kind === kind).map((s) => s.row.id);
    if (ids.length === 0) continue;
    await supersedeRows(tx, ids, kind, requireActor(input.actorUserId));
  }

  // 2. Вставляем. Группа выдаётся ядром: одна на логический ключ команды, своя у каждой строки без
  //    ключа, а у замены — та же, что у заменяемой строки (замена правит принятое решение, а не
  //    заводит новое, и следующая отмена обязана снять их вместе).
  const groups = new Map<string, string>();
  const inserted: AssignmentChangeRecord[] = [];
  for (const mutation of input.mutations) {
    if (mutation.kind === 'cancel') continue;
    const replaced =
      mutation.kind === 'replace'
        ? (supersedes.find((s) => s.mutation === mutation)?.row ?? null)
        : null;
    if (mutation.kind === 'replace' && !replaced) {
      throw internal('замена без разрешённой цели: порядок гашения нарушен');
    }
    // Дата и шкала замены берутся у заменяемой строки, а не у тела: их держит составной FK, и
    // «замена с другой датой» — это перенос, то есть пара `cancel` + `insert` (Р13).
    const effectiveDate =
      mutation.kind === 'insert' ? mutation.effectiveDate : replaced!.effectiveDate;
    // Названная группа сильнее унаследованной: замена, начинающая своё решение поверх чужой строки
    // (заполнение `unknown`, Ю2), обязана уйти в собственную группу — иначе отмена по
    // `changeGroupId` подхватит спутников заменённого решения.
    const group = mutation.group;
    const named =
      group === undefined ? null : (groups.get(group) ?? setAndGet(groups, group, randomUUID()));
    const groupId = named ?? replaced?.changeGroupId ?? randomUUID();
    inserted.push(
      await insertRow(tx, {
        requestId: input.requestId,
        effectiveDate,
        value: mutation.value,
        origin: mutation.origin,
        changeGroupId: groupId,
        correctionId: input.correctionId,
        createdBy: input.actorUserId,
        supersedesChangeId: replaced?.id ?? null,
      }),
    );
  }

  const changesAfter = await readAssignmentChanges(tx, input.requestId, { actualOnly: true });
  return {
    inserted,
    superseded: supersedes.map((s) => ({ kind: s.kind, row: s.row })),
    cancelledGroups,
    changesAfter,
    denormalization: {
      requestId: input.requestId,
      intent: input.denormalization,
      vehicleBefore,
      tailBefore: tailVehicleOf(before),
      tailAfter: tailVehicleOf(changesAfter),
    },
  };
}

/**
 * Проверка Р17 — **после** того, как обе записи сделаны: и история, и назначение.
 *
 * Зовётся каркасом в конце шага 11, а не дверью: дверей истории пять, и «не забыть сверить»
 * держалось бы дисциплиной ровно до первой новой. Отказ здесь — не пользовательский: тело запроса
 * такого состояния не описывает, его создаёт код двери, и внятная 500 с указанием правила дешевле
 * молчаливого расхождения, которое обнаружится через месяц по счёту арендодателя.
 */
export async function assertAssignmentDenormalization(
  tx: AssignmentWriteTx,
  check: AssignmentDenormalizationCheck,
): Promise<void> {
  const vehicleAfter = await readAssignmentVehicle(tx, check.requestId);
  const untouched = vehicleAfter === check.vehicleBefore;

  switch (check.intent.kind) {
    case 'keep':
      if (!untouched) {
        throw internal('Р17: команда объявила себя исторической, но переписала назначение заявки');
      }
      // Сдвинувшийся хвост означает, что затронуто последнее активное vehicle-изменение, — а его
      // денормализация обязана повторять. Молча разойтись нельзя: «чем заявка закрыта сейчас»
      // станет ответом на другой вопрос.
      if (check.tailAfter !== check.tailBefore) {
        throw internal(
          'Р17: команда сдвинула последнее активное vehicle-изменение, не переведя назначение',
        );
      }
      return;
    case 'follow':
      if (vehicleAfter === null) {
        throw internal('Р17: назначение обязано следовать за историей, но его у заявки нет');
      }
      if (vehicleAfter !== check.tailAfter) {
        throw internal(
          'Р17: назначение и хвост истории разошлись — команда обещала перевести назначение',
        );
      }
      return;
    case 'tail_assignment_wins':
      // Предписание Р31 дословно: границу пишем значением текущего назначения, назначение и ставки
      // не трогаем. Проверяются обе половины — вторая ловит дверь, которая заодно «поправила»
      // машину, первая ловит границу, поставленную на чужую единицу.
      if (!untouched) {
        throw internal('Р17: решение `assignment_wins` переписало назначение — оно его не трогает');
      }
      if (check.tailAfter !== vehicleAfter) {
        throw internal(
          'Р17: дремлющая граница хвоста не равна машине назначения — это не `assignment_wins`',
        );
      }
      return;
    case 'tail_release':
      if (!untouched) {
        throw internal('Р17: отмена решения хвоста переписала назначение — она его не трогает');
      }
      return;
    case 'materialize':
      if (!untouched) {
        throw internal('Р17: материализация истории переписала назначение — она его только читает');
      }
      return;
  }
}

/** Машина денормализации; `null` — назначения у заявки нет. */
export async function readAssignmentVehicle(
  tx: AssignmentWriteTx,
  requestId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ vehicleId: vehicleRequestAssignments.vehicleId })
    .from(vehicleRequestAssignments)
    .where(eq(vehicleRequestAssignments.requestId, requestId));
  return row?.vehicleId ?? null;
}

/**
 * Хвост истории — машина последнего активного vehicle-изменения (Р17).
 *
 * По `effective_date`, а не по `created_at`: порядок записи и порядок действия — разные вещи, и
 * коррекция, заведённая сегодня про январь, текущей машиной не становится.
 */
export function tailVehicleOf(changes: readonly AssignmentChangeRecord[]): string | null {
  let tail: AssignmentChangeRecord | null = null;
  for (const row of changes) {
    if (row.dimension !== 'vehicle' || row.supersededAt !== null) continue;
    if (!tail || row.effectiveDate > tail.effectiveDate) tail = row;
  }
  return tail?.vehicleId ?? null;
}

// ── Адресация цели (Р10) ──

/**
 * Цель команды — строка, и только **актуальная** (Р10).
 *
 * Два адреса, и оба обязательны. `changeId` — для готовой истории и для портала, который её уже
 * прочитал; логический ключ `{ dimension, effectiveDate }` — единственный доступный адрес там, где
 * история ещё не материализована: строк нет вовсе, предпросмотр не коммитит (Р20), и `changeId`
 * появился бы только внутри будущего apply.
 *
 * Погашенная строка целью не бывает: она описывает уже отменённое решение, и правка её была бы
 * второй веткой той же цепочки — а цепочка замен не ветвится по построению (частичный UNIQUE по
 * `supersedes_change_id`).
 */
export function resolveChangeTarget(
  changes: readonly AssignmentChangeRecord[],
  target: AssignmentChangeTarget,
): AssignmentChangeRecord {
  const actual = changes.filter((row) => row.supersededAt === null);
  if ('changeId' in target) {
    const row = actual.find((r) => r.id === target.changeId);
    if (!row) throw targetGone();
    return row;
  }
  const row = actual.find(
    (r) => r.dimension === target.dimension && r.effectiveDate === target.effectiveDate,
  );
  if (!row) throw targetGone();
  return row;
}

const targetGone = (): AppError =>
  err.unprocessable(
    'Изменение, которое вы правите, уже заменено или отменено — откройте историю заново',
  );

// ── Внутреннее ──

interface PlannedSupersede {
  row: AssignmentChangeRecord;
  kind: AssignmentSupersedeKind;
  /** Мутация, которой строка гасится: у замены по ней же находится вставляемая строка. */
  mutation: AssignmentWriteMutation;
}

/**
 * Что гасим — до первой записи и целиком.
 *
 * Отмена гасит **всю группу** (В2): погасив vehicle-границу и оставив её `cleared`-спутника, мы
 * получили бы отрезок «собственная машина без машиниста» — либо 422 на Р16, либо молчаливое
 * наследование чужого человека следующим отрезком. Спутник же, оставшийся один, оживёт при
 * следующем продлении срока, когда объяснять его будет уже нечем.
 */
async function plannedSupersedes(
  tx: AssignmentWriteTx,
  input: AssignmentWriteInput,
  actual: readonly AssignmentChangeRecord[],
): Promise<PlannedSupersede[]> {
  const planned: PlannedSupersede[] = [];
  const seen = new Set<string>();
  for (const mutation of input.mutations) {
    if (mutation.kind === 'insert') continue;
    const row = resolveChangeTarget(actual, mutation.target);
    if (mutation.kind === 'replace') {
      if (row.dimension !== mutation.value.dimension) {
        // Составной FK замены ссылается на `(id, request_id, dimension, effective_date)`: сменить
        // шкалу заменой физически нельзя, и попытка означает ошибку двери, а не запроса.
        throw internal('замена не меняет шкалу изменения: перенос выражается парой cancel + set');
      }
      if (seen.has(row.id)) throw internal('одна строка гасится дважды в одной команде');
      seen.add(row.id);
      planned.push({ row, kind: 'replaced', mutation });
      continue;
    }
    const group = await readGroupRows(tx, input.requestId, row.changeGroupId);
    for (const member of group) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      planned.push({ row: member, kind: 'cancelled', mutation });
    }
  }
  return planned;
}

/**
 * Актуальные строки группы — с условием по заявке.
 *
 * Цели для составного FK у группы нет (миграция `0166`), то есть база не мешает двум заявкам
 * поделить один `change_group_id`; принадлежность проверяет сервис. Условие по `request_id` здесь и
 * есть та проверка: без него отмена одной заявки погасила бы строки другой — и это был бы худший
 * вид ошибки, потому что заметен он стал бы только на бумаге.
 */
async function readGroupRows(
  tx: AssignmentWriteTx,
  requestId: string,
  changeGroupId: string,
): Promise<AssignmentChangeRecord[]> {
  return tx
    .select(changeColumns)
    .from(vehicleRequestAssignmentChanges)
    .where(
      and(
        eq(vehicleRequestAssignmentChanges.requestId, requestId),
        eq(vehicleRequestAssignmentChanges.changeGroupId, changeGroupId),
        isNull(vehicleRequestAssignmentChanges.supersededAt),
      ),
    )
    .orderBy(asc(vehicleRequestAssignmentChanges.effectiveDate));
}

/**
 * Погасить строки: тройка `superseded_*` целиком и условие «ещё актуальна».
 *
 * Условие не лишнее даже под `lockRequestRow`: гасить дважды в одной команде нечего, а разошедшееся
 * число строк означает, что список гашения посчитан не по тому состоянию, в котором пишем.
 */
async function supersedeRows(
  tx: AssignmentWriteTx,
  ids: readonly string[],
  kind: AssignmentSupersedeKind,
  actorUserId: string,
): Promise<void> {
  const updated = await tx
    .update(vehicleRequestAssignmentChanges)
    .set({
      supersededAt: new Date(),
      supersededByUser: actorUserId,
      supersededKind: kind,
    })
    .where(
      and(
        inArray(vehicleRequestAssignmentChanges.id, [...ids]),
        isNull(vehicleRequestAssignmentChanges.supersededAt),
      ),
    )
    .returning({ id: vehicleRequestAssignmentChanges.id });
  if (updated.length !== ids.length) {
    throw internal('строки истории погасил кто-то ещё: команда шла без блокировки заявки');
  }
}

interface InsertRowInput {
  requestId: string;
  effectiveDate: string;
  value: AssignmentChangeValue;
  origin: AssignmentChangeOrigin;
  changeGroupId: string;
  correctionId: string | null;
  createdBy: string | null;
  supersedesChangeId: string | null;
}

/** Вставка строки: значение раскладывается по колонкам ровно так, как их держит CHECK таблицы. */
async function insertRow(
  tx: AssignmentWriteTx,
  input: InsertRowInput,
): Promise<AssignmentChangeRecord> {
  const value =
    input.value.dimension === 'vehicle'
      ? {
          dimension: 'vehicle' as const,
          vehicleId: input.value.vehicleId,
          driverPersonId: null,
          driverState: null,
        }
      : {
          dimension: 'driver' as const,
          vehicleId: null,
          driverPersonId: input.value.driver.state === 'set' ? input.value.driver.personId : null,
          driverState: input.value.driver.state as DriverStateKind,
        };
  const [row] = await tx
    .insert(vehicleRequestAssignmentChanges)
    .values({
      requestId: input.requestId,
      effectiveDate: input.effectiveDate,
      ...value,
      origin: input.origin,
      changeGroupId: input.changeGroupId,
      correctionId: input.correctionId,
      createdBy: input.createdBy,
      supersedesChangeId: input.supersedesChangeId,
    })
    .returning(changeColumns);
  if (!row) throw internal('строка истории не вставилась');
  return row;
}

function setAndGet(map: Map<string, string>, key: string, value: string): string {
  map.set(key, value);
  return value;
}

/**
 * Автор погашения обязателен: `superseded_by_user` объявлен `NOT NULL` внутри тройки погашения, и
 * это правило модели, а не схемы, — отмена решения всегда чья-то. Бэкфилл, у которого автора нет,
 * только вставляет.
 */
function requireActor(actorUserId: string | null): string {
  if (!actorUserId) throw internal('гашение строки истории без автора: у отмены всегда есть автор');
  return actorUserId;
}

/**
 * Нарушение правил модели, а не запроса. 500 и текст с номером правила: такое состояние тело
 * запроса не описывает — его создаёт код двери, и читать этот отказ будет разработчик.
 */
function internal(message: string): AppError {
  return new AppError(500, 'assignment_write_invariant', `История назначения: ${message}`);
}
