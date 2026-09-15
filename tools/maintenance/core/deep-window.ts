/**
 * Автомат тяжёлого окна: как окно идёт зонами и почему оно заканчивается само.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ АВТОМАТ, А НЕ ЦИКЛ СХОДИМОСТИ. Повседневный цикл человек ограничивает проходами
 * и объёмом правки; тяжёлое окно он отдаёт ВРЕМЕНЕМ — «разбери накопленное за два часа». Время
 * меняет главный вопрос: не «сколько ещё можно изменить», а «успеем ли то, что собираемся начать».
 * Отсюда и вся разница с `convergence.ts`: там бюджет проверяется по следам сделанного, здесь —
 * перед началом партии. Форма же нарочно та же, чтобы человек, читавший один автомат, читал второй
 * без нового усилия.
 *
 * ЗДЕСЬ НЕТ НИ ОДНОГО ОБРАЩЕНИЯ К ДИСКУ, GIT ИЛИ ПРОЦЕССАМ. Правило остановки, которое нельзя
 * проверить, не запустив ворота качества, проверяться не будет: за один вопрос «а остановились бы
 * мы здесь» никто не заплатит двухчасовым окном. Отделённая от ввода-вывода логика проверяется
 * тестом за миллисекунды — и потому проверяется вся.
 *
 * ВСЕ ФУНКЦИИ ЧИСТЫЕ: принимают состояние, возвращают новое. Окно живёт дольше одного запуска
 * команды — между партиями система ждёт человека и агента, состояние ездит через файл. Правка на
 * месте в такой схеме означает, что записанное на диск и то, что в памяти, разошлись молча; возврат
 * нового значения делает расхождение невозможным.
 *
 * Время приходит параметром `now` по той же причине, что и в цикле сходимости: иначе ни один тест
 * не может утверждать ничего о сроках, а окно нельзя воспроизвести. Здесь это прямо `Date`, а не
 * часы-функция: каждая функция окна вызывается на одно событие и второй раз время не спрашивает.
 *
 * ПРЕДЕЛЫ ОДНОЙ ПАРТИИ (3 находки, 8 файлов, 400 строк) тут не проверяются намеренно: они
 * ограничивают СОДЕРЖИМОЕ партии, а его набирает отбор. Окно отвечает за другое — стоит ли
 * следующую партию вообще начинать.
 *
 * ПРО ИМЯ ТИПА ПОЛИТИКИ. В плане ЭF политика окна названа `DeepMaintenancePolicy`; в коде она уже
 * существует как `DeepMaintenanceBudget` (`core/types.ts`), и используется существующее имя —
 * заводить второе имя одному типу значит заставить читателя выяснять, чем они отличаются.
 */
import type { DeepMaintenanceBudget } from './types.ts';
import type { Outcome } from '../verification/verifier.ts';

/** На чьём ходу окно. Шагов ожидания ровно два: разбор очереди и правка исполнителя. */
export type WindowStep = 'awaiting-review' | 'awaiting-fix' | 'finished';

/**
 * Причины остановки окна — закрытый список.
 *
 * Закрытый по той же причине, что и в цикле сходимости: человек, увидевший в отчёте незнакомую
 * причину, не может ни проверить её, ни оспорить. Каждая причина считается кодом из чисел
 * `deepMaintenance` в `architecture/policies/maintenance.yaml`.
 */
export type WindowStop =
  | 'timeBudgetSpent'
  | 'maxBatchesReached'
  | 'queueEmpty'
  | 'zonesDone'
  | 'repeatedRollbacks'
  | 'regressionInStabilization'
  | 'manualDecisionRequired';

/** Итог одной партии. Заполняется по ходу: зона и находки — раньше, исход проверки — позже. */
export interface BatchRecord {
  readonly zone: string;
  readonly startedAt: string;
  /**
   * Отпечатки находок партии, а не сами находки.
   *
   * Находка целиком лежит в журнале (`core/finding-io.ts`), и копия её сюда завела бы второй ответ
   * на вопрос «что чинили» — он разойдётся с первым при первой же правке журнала. Отпечатка
   * достаточно, чтобы связать партию с находкой и не предложить её второй раз.
   */
  readonly findings: readonly string[];
  readonly outcome: Outcome | null;
  readonly reason: string | null;
  readonly changedFiles: readonly string[];
  readonly changedLines: number;
  /** `null` — «ушли и не вернулись»: отличить прерванную партию от несостоявшейся иначе нечем. */
  readonly finishedAt: string | null;
}

export interface WindowTotals {
  readonly files: number;
  readonly lines: number;
  readonly rollbacks: number;
  readonly accepted: number;
}

export interface WindowState {
  readonly windowId: string;
  readonly startedAt: string;
  /**
   * Срок окна, посчитанный один раз при открытии.
   *
   * Хранится, а не вычисляется каждый раз из политики: правка `windowMinutes` посреди окна иначе
   * продлевала бы уже идущее окно молча, и «два часа» означали бы столько, сколько не жалко.
   */
  readonly deadline: string;
  /** Номер текущей зоны в списке политики, считая с нуля. */
  readonly zoneIndex: number;
  readonly step: WindowStep;
  readonly batches: readonly BatchRecord[];
  readonly stop: { readonly reason: WindowStop; readonly detail: string } | null;
  readonly totals: WindowTotals;
}

/** Исход проверки партии вместе с тем, что она оставила в дереве. */
export interface BatchOutcomeEntry {
  readonly outcome: Outcome;
  readonly reason: string;
  readonly changedFiles: readonly string[];
  readonly changedLines: number;
}

const MINUTE_MS = 60_000;

/**
 * Открыть окно.
 *
 * Два отказа вместо двух пустых окон: окно без зон и окно нулевой длины бессмысленны одинаково, и
 * сказать об этом надо на первой команде, а не в отчёте о нулевой работе.
 *
 * Рубильник `deepMaintenance.enabled` здесь СОЗНАТЕЛЬНО не проверяется. Он отвечает не на вопрос
 * «бывает ли такое окно», а на вопрос «созывается ли оно без дополнительного подтверждения», и у
 * него есть штатный обход флагом команды. Знать про обход должна команда, а не автомат: проверка
 * тут сделала бы обход невозможным, не добавив ни одной гарантии.
 */
export function startWindow(policy: DeepMaintenanceBudget, now: Date): WindowState {
  if (policy.zones.length === 0) {
    throw new Error('в политике не описано ни одной зоны: разбирать долг нечем');
  }
  if (policy.windowMinutes <= 0) {
    throw new Error(`окно длиной ${policy.windowMinutes} мин: времени нет ни на одну партию`);
  }
  const startedAt = now.toISOString();
  return {
    windowId: windowIdOf(startedAt),
    startedAt,
    deadline: new Date(now.getTime() + policy.windowMinutes * MINUTE_MS).toISOString(),
    zoneIndex: 0,
    step: 'awaiting-review',
    batches: [],
    stop: null,
    totals: { files: 0, lines: 0, rollbacks: 0, accepted: 0 },
  };
}

/**
 * Открыть запись партии.
 *
 * Запись заводится ДО работы исполнителя: партия без `finishedAt` — это «ушли и не вернулись», и
 * прерванное посреди правки окно иначе выглядит как окно, в котором этой партии не было.
 *
 * Шаг переключается на исполнителя, только если ему есть что делать. Пустая партия шагом «ждём
 * правку» заставила бы человека искать несуществующее задание.
 */
export function beginBatch(
  state: WindowState,
  zone: string,
  fingerprints: readonly string[],
  now: Date,
): WindowState {
  if (state.step === 'finished') {
    throw new Error(`окно ${state.windowId} закрыто: партию в него больше не добавить`);
  }
  const record: BatchRecord = {
    zone,
    startedAt: now.toISOString(),
    findings: [...fingerprints],
    outcome: null,
    reason: null,
    changedFiles: [],
    changedLines: 0,
    finishedAt: null,
  };
  return {
    ...state,
    step: fingerprints.length > 0 ? 'awaiting-fix' : 'awaiting-review',
    batches: [...state.batches, record],
  };
}

/**
 * Записать исход проверки и закрыть партию.
 *
 * ОТКАЧЕННОЕ В ИТОГИ ИЗМЕНЕНИЙ НЕ ИДЁТ — так же, как в цикле сходимости, и по той же причине:
 * откат возвращает файлы партии байт в байт, в дереве от неё не осталось следа, и засчитывать
 * такие строки значит исчерпывать бюджет работой, которой нет. Откат наказывается своим
 * счётчиком (`rollbacks`), а не чужим.
 *
 * Исход «нужен человек», наоборот, идёт в итоги: правка исполнителя остаётся в дереве, и итоги
 * обязаны считать то, что в дереве, а не то, что мы одобрили.
 */
export function recordBatchOutcome(
  state: WindowState,
  entry: BatchOutcomeEntry,
  now: Date,
): WindowState {
  const counted = entry.outcome !== 'rollback';
  /*
   * Файлы считаются РАЗНЫМИ, а не суммой по партиям: вторая партия, дочинившая тот же файл, не
   * делает дерево шире на файл. Суммирование исчерпывало бы окно тем раньше, чем аккуратнее оно
   * работает по одному и тому же месту.
   */
  const touched = new Set<string>();
  for (const batch of state.batches.slice(0, -1)) {
    if (batch.outcome === 'rollback') continue;
    for (const file of batch.changedFiles) touched.add(file);
  }
  if (counted) for (const file of entry.changedFiles) touched.add(file);

  const totals: WindowTotals = {
    files: touched.size,
    lines: state.totals.lines + (counted ? entry.changedLines : 0),
    rollbacks: state.totals.rollbacks + (entry.outcome === 'rollback' ? 1 : 0),
    /*
     * Принятой считается партия С ИЗМЕНЕНИЯМИ: зелёная проверка над пустой правкой — не работа, и
     * отчитываться ею о разобранном долге нельзя.
     */
    accepted:
      state.totals.accepted + (entry.outcome === 'accept' && entry.changedFiles.length > 0 ? 1 : 0),
  };

  const withBatch = patchLastBatch(state, (record) => ({
    ...record,
    outcome: entry.outcome,
    reason: entry.reason,
    changedFiles: [...entry.changedFiles],
    changedLines: entry.changedLines,
    finishedAt: now.toISOString(),
  }));

  return { ...withBatch, step: 'awaiting-review', totals };
}

/**
 * Причина остановки окна перед СЛЕДУЮЩЕЙ партией, либо `null` — «можно начинать».
 *
 * ВОПРОС ЗДЕСЬ ВСЕГДА ОДИН: стоит ли начинать ещё одну партию. Именно поэтому бюджет времени
 * проверяется до партии, а не после — см. `enoughTimeFor`.
 *
 * `queueLeft` — сколько находок очередь окна ещё готова отдать ТЕКУЩЕЙ зоне (`state.zoneIndex`).
 * Очередь ранжируется и фильтруется снаружи: здесь о находках не известно ничего, кроме их числа,
 * и это сознательно — автомат не должен уметь передумывать за отбор.
 *
 * ПОРЯДОК ПРОВЕРКИ ЗНАЧИТ БОЛЬШЕ, ЧЕМ САМИ УСЛОВИЯ. Верными разом бывают несколько, а человеку
 * показывается одна — та, ради которой он открывает отчёт:
 *
 * 1. `manualDecisionRequired` — система дошла до места, где решать не вправе. Любая другая причина
 *    поверх этой объяснила бы остановку бухгалтерией, спрятав заданный человеку вопрос;
 * 2. `regressionInStabilization` — откат в зоне стабилизации. Она идёт последней и существует ровно
 *    затем, чтобы убирать хвосты предыдущих зон; если откатывается она, сломано лечение, а не
 *    отдельная партия, и продолжать окно нельзя ни при каком остатке времени;
 * 3. `repeatedRollbacks` — два отката за окно: уже не невезение, а систематическая неспособность
 *    этой связки правил и агента давать принимаемую правку. Ниже регрессии, потому что говорит о
 *    том же классе беды, но менее точно;
 * 4. `timeBudgetSpent` — на следующую партию времени заведомо нет. Выше всех «потолков» ниже,
 *    потому что часы идут независимо от нас: назвать нехватку времени исчерпанием наших же
 *    лимитов значит соврать человеку о том, почему окно оказалось коротким;
 * 5. `queueEmpty` — очередь не дала окну ни одной партии: долг разобран, и второе окно не нужно.
 *    Это лучший исход, и он сообщается прежде потолков — как `noSelectedFindings` в цикле
 *    сходимости;
 * 6. `maxBatchesReached` — исчерпан потолок ремонтных партий. Штатный предел, но всё же предел:
 *    остаток очереди уходит в backlog, и человек должен знать, что окно упёрлось, а не закончило;
 * 7. `zonesDone` — зоны пройдены по порядку и очередь последней из них пуста. Последним намеренно:
 *    это не событие, а отсутствие событий — штатное завершение окна, сделавшего свою работу.
 */
export function evaluateWindowStop(
  state: WindowState,
  policy: DeepMaintenanceBudget,
  now: Date,
  queueLeft: number,
): { reason: WindowStop; detail: string } | null {
  const last = state.batches.at(-1);
  const stabilization = policy.zones.at(-1);
  const candidates: { reason: WindowStop; detail: string }[] = [];

  if (last?.outcome === 'manual-review') {
    candidates.push({
      reason: 'manualDecisionRequired',
      detail: `зона ${last.zone}: решение за человеком — ${last.reason ?? 'причина не записана'}`,
    });
  }

  if (
    last?.outcome === 'rollback' &&
    stabilization !== undefined &&
    stabilization.id === last.zone
  ) {
    candidates.push({
      reason: 'regressionInStabilization',
      detail: `партия зоны стабилизации ${last.zone} откачена — ${last.reason ?? 'причина не записана'}`,
    });
  }

  if (state.totals.rollbacks >= 2) {
    candidates.push({
      reason: 'repeatedRollbacks',
      detail: `откатов за окно: ${state.totals.rollbacks}`,
    });
  }

  const left = minutesLeft(state, now);
  const needed = batchEstimateMinutes(state, policy);
  if (!enoughTimeFor(left, needed)) {
    candidates.push({
      reason: 'timeBudgetSpent',
      detail: `до срока ${round(left)} мин, а партии нужно не меньше ${round(needed)} мин`,
    });
  }

  /*
   * Очередь пуста, а следующей зоны нет — окно отработало всё, что могло. Две причины на одно
   * место различают не механику, а новость для человека: «долга не нашлось» и «долг разобран
   * зонами» требуют разных решений о следующем окне.
   */
  const exhausted = queueLeft <= 0 && state.zoneIndex >= policy.zones.length - 1;
  if (exhausted && state.batches.length === 0) {
    candidates.push({
      reason: 'queueEmpty',
      detail: `очередь пуста во всех зонах (${policy.zones.length}): разбирать нечего`,
    });
  }

  if (state.batches.length >= policy.maxRepairBatches) {
    candidates.push({
      reason: 'maxBatchesReached',
      detail: `сделано партий ${state.batches.length} при лимите ${policy.maxRepairBatches}`,
    });
  }

  if (exhausted && state.batches.length > 0) {
    candidates.push({
      reason: 'zonesDone',
      detail: `зоны пройдены: ${policy.zones.length}, партий сделано ${state.batches.length}`,
    });
  }

  return candidates[0] ?? null;
}

/**
 * Перейти к следующей партии, к следующей зоне либо закрыть окно.
 *
 * Зоны идут строго по порядку политики (архитектура → чистка → стабилизация): порядок здесь —
 * содержательное решение, а не оформление списка. Чистка после перестановки границ разбирает уже
 * новый код, а стабилизация существует затем, чтобы убрать хвосты двух предыдущих зон, — переставь
 * их местами, и последняя зона будет чинить то, чего ещё не сломали.
 *
 * Повторный вызов на закрытом окне ничего не меняет: команду человек может запустить дважды, и
 * второй запуск обязан застать тот же отчёт, а не переписать причину остановки более поздней.
 */
export function advanceWindow(
  state: WindowState,
  policy: DeepMaintenanceBudget,
  now: Date,
  queueLeft: number,
): WindowState {
  if (state.step === 'finished') return state;

  const stop = evaluateWindowStop(state, policy, now, queueLeft);
  if (stop !== null) return { ...state, step: 'finished', stop };

  /*
   * Очередь текущей зоны пуста, а остановки нет — значит впереди есть зона: в последней зоне пустая
   * очередь закрывает окно выше. Брать нечего — переходим, не тратя на зону партию.
   */
  if (queueLeft <= 0) {
    return { ...state, zoneIndex: state.zoneIndex + 1, step: 'awaiting-review' };
  }

  return { ...state, step: 'awaiting-review' };
}

/** Сколько минут окна осталось. Отрицательное — просрочено. */
export function minutesLeft(state: WindowState, now: Date): number {
  return (Date.parse(state.deadline) - now.getTime()) / MINUTE_MS;
}

/**
 * ХВАТИТ ЛИ ВРЕМЕНИ НА ПАРТИЮ — главный вопрос этого автомата, и отвечается он до партии.
 *
 * Партия, начатая на остатке времени, которого ей заведомо мало, кончается не «немного меньшей
 * пользой», а откатом по таймауту: правка брошена на середине, ворота качества не отработали,
 * дерево надо возвращать. То есть остаток времени такая партия тратит гарантированно, а оставляет
 * гарантированно ничего. Поэтому проверка стоит ПЕРЕД началом, а не после.
 *
 * Оценка берётся из двух источников, и берётся худшая из них:
 *
 * 1. план политики — `windowMinutes / maxRepairBatches`, то есть доля окна на партию. Человек,
 *    написавший «два часа и шесть партий», уже сказал, что партия здесь рассчитана на двадцать
 *    минут; выдумывать своё число поверх его собственного незачем. Разрешив одну партию на два
 *    часа, он ровно так же сказал, что партия здесь двухчасовая, — и окно поверит ему;
 * 2. самая длинная ФАКТИЧЕСКИ закрытая партия этого окна. Если партии здесь идут по сорок минут,
 *    план в двадцать — устаревшая надежда, и следующая партия будет такой же, как эти.
 *
 * Берётся максимум, а не среднее: среднее тянут вниз короткие партии, а цена ошибки несимметрична.
 * Начать партию, которая успеет, — потерять несколько минут простоя окна; начать ту, что не
 * успеет, — потерять её целиком вместе с работой исполнителя.
 */
function enoughTimeFor(left: number, needed: number): boolean {
  return left >= needed;
}

function batchEstimateMinutes(state: WindowState, policy: DeepMaintenanceBudget): number {
  const planned = policy.windowMinutes / Math.max(policy.maxRepairBatches, 1);
  let longest = 0;
  for (const batch of state.batches) {
    if (batch.finishedAt === null) continue;
    const started = Date.parse(batch.startedAt);
    const finished = Date.parse(batch.finishedAt);
    if (Number.isNaN(started) || Number.isNaN(finished)) continue;
    longest = Math.max(longest, (finished - started) / MINUTE_MS);
  }
  return Math.max(planned, longest);
}

/** Минуты в отчёт: доли минуты в объяснении человеку — шум, а в сравнении выше они сохранены. */
function round(minutes: number): number {
  return Math.round(minutes * 10) / 10;
}

/**
 * Заменить последнюю запись партии новой.
 *
 * Открытой партии нет — это ошибка порядка команд, а не пустой случай: исход записать некуда, и
 * потерять его молча хуже, чем упасть. Человеку видно, какая команда пропущена.
 */
function patchLastBatch(
  state: WindowState,
  patch: (record: BatchRecord) => BatchRecord,
): WindowState {
  const last = state.batches.at(-1);
  if (last === undefined) {
    throw new Error('открытой партии нет: сначала beginBatch, потом запись её исхода');
  }
  return { ...state, batches: [...state.batches.slice(0, -1), patch(last)] };
}

/** Имя окна из его времени: читаемое человеком и повторяемое при тех же часах. */
function windowIdOf(startedAt: string): string {
  return `window-${startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}
