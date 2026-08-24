import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { moscowDateKeyOf } from '@technic/contracts';
import type * as schema from '../db/schema';
import {
  assignmentDeployAttestations,
  assignmentPeriodsControl,
  assignmentPeriodsModeTransitions,
  assignmentShadowChecks,
  assignmentShadowRuns,
  vehicleRequests,
} from '../db/schema';
import { AppError } from '../lib/errors';
import { ASSIGNMENT_READINESS_POPULATION } from './assignment-readiness';

/**
 * Автомат режимов модуля периодов назначения (план `docs/assignment-periods-plan.md` §6 и §10;
 * решения Ж3, И1, И3, О2, О4, О5; миграция `0167`).
 *
 * Модуль отвечает на три вопроса и больше ни на какие:
 *
 * - **можно ли сейчас писать** — `requireOpenDoor`, первый запрос каждой пишущей транзакции;
 * - **откуда читать «кто и на чём работал»** — `historyIsAuthoritative`;
 * - **чем и когда разрешено переключение** — `setModuleMode` и журнал переходов.
 *
 * ПОЧЕМУ РЕЖИМ, А НЕ ФЛАГ (И1). Булев freeze обслуживал два несовместимых случая. При откате ручная
 * выписка и смены законны — работа продолжается, история просто не меняется; при cutover они
 * недопустимы: обе двигают множество листов и отменяемость бумаги уже после того, как прогон сверки
 * увидел ноль расхождений. Отсюда три значения `write_mode`, а не два состояния флага.
 *
 * ПОЧЕМУ БЛОКИРОВКА И ФЛАГ — ОДНА СТРОКА (Ж3). Пара «advisory lock + флаг» оставляла щель: писатель
 * открывает транзакцию, ждёт shared-локу, получает её уже после коммита оператора — и читает
 * **старое** значение флага из своего снимка. Здесь этого не бывает: писатель берёт управляющую
 * строку `FOR SHARE` первым же запросом, freeze делает по ней `UPDATE` (то есть `FOR UPDATE`) и тем
 * самым дожидается активных писателей — это и есть drain. Писатель, чей снимок старше freeze,
 * получает `40001`, уходит в штатный повтор и во второй раз видит новый режим.
 *
 * ПОЧЕМУ СТРОКА ЧИТАЕТСЯ КАК ЕДИНСТВЕННАЯ (И3). `SELECT ... FOR SHARE` по пустой таблице возвращает
 * ноль строк и ничего не блокирует, а `UPDATE` обновляет ноль строк — и freeze считался бы
 * пройденным. Поэтому её отсутствие здесь не «пусто», а отказ: fail-closed на всех дверях сразу.
 *
 * ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ — ВТОРОЙ ГРАНИЦЕЙ СОВМЕСТИМОСТИ (Ю18). В репозитории уже есть протокол
 * необратимого выката ([schema-cutover-protocol.md](../../../../docs/schema-cutover-protocol.md)):
 * `deploy-auto --cutover`, `schema-floor.state`, teardown вне каталога миграций. Он отвечает на
 * вопрос «ниже какой миграции откатываться нельзя» и остаётся единственным ответом на него. Наш
 * журнал отвечает на другой вопрос — «каким поколением теневого сравнения разрешено переключение
 * чтения», — и потому здесь **нет** ни чтения `schema-floor.state`, ни сверки журнала миграций, ни
 * собственного понятия необратимости: возврат `history → legacy` открыт всегда, `cutover_run_id`
 * при нём не стирается, и запретом отката схемы ведает floor, а не этот сервис. Факты деплоя
 * (какие сборки раскатаны, сколько осталось старых клиентских вызовов) сервис тоже не выясняет
 * сам — их приносит аттестация, которую пишет job деплоя. Иначе на этапе 5 рядом с floor выросла бы
 * вторая граница совместимости, и разошлись бы они на первой же аварии.
 */

/**
 * Соединение приходит аргументом, и модуль намеренно **не** импортирует прикладной пул: тот тянет
 * `src/config`, а он валидирует весь env приложения при загрузке. Административная команда смены
 * режима ходит своими кредами и не должна требовать ни JWT, ни S3, ни почты — а импортируй модуль
 * клиент, она требовала бы их одним фактом загрузки двери.
 */
type AppDatabase = NodePgDatabase<typeof schema>;

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/**
 * Кто исполняет транзакцию двери. Ровно то, что от неё нужно, — `transaction`: административный
 * путь передаёт сюда свой пул, портал не передаёт ничего.
 */
export type ModeExecutor = Pick<AppDatabase, 'transaction'>;
/** Транзакция пишущей двери: гейт обязан идти в ней же, иначе блокировка снимается сразу. */
export type AssignmentModeTx = Tx;
/** Чтение режима без блокировки годится и вне транзакции: карточке и баннеру хватает значения. */
type Reader = Tx | AppDatabase;

/**
 * Значения режимов берутся у самих колонок, а не переписываются сюда списком: реестр держит
 * `assignment_periods_control` вместе со своими `CHECK`, и второй перечень тех же слов разошёлся бы
 * с ним при первом же новом состоянии.
 */
export type AssignmentWriteMode = (typeof assignmentPeriodsControl)['$inferSelect']['writeMode'];
export type AssignmentReadMode = (typeof assignmentPeriodsControl)['$inferSelect']['readMode'];

/** Снимок управляющей строки — всё, что о режиме нужно знать вызывающему. */
export interface AssignmentModeSnapshot {
  writeMode: AssignmentWriteMode;
  readMode: AssignmentReadMode;
  /** Поколение сверки, которым включена история. Возврат в `legacy` его не стирает (аудит). */
  cutoverRunId: string | null;
}

/**
 * Класс двери (§10). Различие не косметическое: «исполнить и записать событие» безопасно там, где
 * дверь не трогает источник истины.
 *
 * - `history` — всё, что пишет историю **или читает её ради бумаги**: команда машиниста, коррекция
 *   назначения, смена техники, статус, правка срока, досрочное завершение, недельное применение,
 *   восстановление из архива. Старая сборка испортит бумагу, не тронув ни одной строки истории, —
 *   поэтому читатели последствий здесь в одном классе с писателями;
 * - `history_free` — ручная выписка `on_demand`, сохранение, удаление, подпись и снятие подписи
 *   смен: истории они не пишут, но двигают множество листов и отменяемость бумаги.
 *
 * Чтение карточек, журналов и кабинета гейт не спрашивает вовсе — оно разрешено в любом режиме
 * (с баннером «только для чтения», который рисует портал).
 */
export type AssignmentDoorClass = 'history' | 'history_free';

/**
 * Версия алгоритма свёртки, которой работает **эта** сборка.
 *
 * Пишется в каждую запись журнала и сверяется при активации истории: поколение сверки, полученное
 * другим алгоритмом, ничего не доказывает про сегодняшний код. Значение меняется вручную и только
 * вместе с правилами свёртки; на этапе 4 его источником станет модуль теневого сравнения — и тогда
 * константа переедет туда целиком, а не размножится.
 */
export const ASSIGNMENT_HISTORY_ALGO_VERSION = '1';

/**
 * Сколько живёт аттестация деплоя.
 *
 * Аттестация описывает раскат «прямо сейчас»: какие сборки активны и сколько старых клиентских
 * вызовов насчитала метрика. За полчаса раскат успевает измениться, и вчерашняя аттестация
 * доказывала бы вчерашнюю площадку. Окно выбрано под сам cutover — drain, revalidation, sweep и
 * переключение, — а не под рабочий день: аттестация снимается непосредственно перед дверью.
 */
export const ATTESTATION_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Код отказа закрытой двери. Экспортирован ради наблюдаемости: каркас команд отличает по нему
 * «дверь закрыта режимом» от обычного 503, и второй копии строкового кода быть не должно —
 * разойдясь, они дали бы метрику, молчащую ровно во время заморозки.
 */
export const ASSIGNMENT_MODE_FROZEN_CODE = 'assignment_mode_frozen';
const CODE_FROZEN = ASSIGNMENT_MODE_FROZEN_CODE;
const CODE_UNAVAILABLE = 'assignment_mode_unavailable';
const CODE_REJECTED = 'assignment_mode_transition_rejected';

/** Отказ перехода: вход операторский, поэтому 422 и текст, по которому видно, что делать. */
const rejected = (message: string): AppError => new AppError(422, CODE_REJECTED, message);

/**
 * Управляющей строки нет — отказ, а не «режим по умолчанию».
 *
 * `TRUNCATE` не ловится триггером `BEFORE DELETE`, и единственная защита от молчаливой работы без
 * freeze — читать строку как единственную (И3, Н3-узкое). 503, а не 500: запрос ни при чём.
 */
const controlRowMissing = (): AppError =>
  new AppError(
    503,
    CODE_UNAVAILABLE,
    'Управляющая строка модуля периодов назначения не найдена — запись остановлена',
  );

const WRITE_MODE_TITLE: Record<AssignmentWriteMode, string> = {
  normal: 'обычный режим',
  history_frozen: 'заморожена история',
  all_frozen: 'заморожена вся запись',
};

/** Открыта ли дверь этого класса при таком режиме записи (§10). */
export function doorIsOpen(writeMode: AssignmentWriteMode, door: AssignmentDoorClass): boolean {
  switch (writeMode) {
    case 'normal':
      return true;
    // Откат: закрыты двери, пишущие историю, открыты явно перечисленные history-free.
    case 'history_frozen':
      return door === 'history_free';
    // Cutover: закрыто всё, что способно изменить бумагу или её отменяемость.
    case 'all_frozen':
      return false;
  }
}

/** Читатели берут «кто и на чём работал» из истории, а не из назначения. */
export function historyIsAuthoritative(mode: AssignmentModeSnapshot): boolean {
  return mode.readMode === 'history';
}

/**
 * Шаг 0 канонического порядка транзакции (§8): управляющая строка `FOR SHARE`.
 *
 * Зовётся **первым** запросом пишущей транзакции — до блокировок рейсов и заявки. Не ради того,
 * чтобы прочитать значение (для этого есть `readAssignmentMode`), а чтобы freeze дождался этой
 * транзакции, а она не проскочила мимо freeze.
 */
export async function lockAssignmentMode(tx: Tx): Promise<AssignmentModeSnapshot> {
  const [row] = await tx
    .select({
      writeMode: assignmentPeriodsControl.writeMode,
      readMode: assignmentPeriodsControl.readMode,
      cutoverRunId: assignmentPeriodsControl.cutoverRunId,
    })
    .from(assignmentPeriodsControl)
    .where(eq(assignmentPeriodsControl.id, true))
    .for('share');
  if (!row) throw controlRowMissing();
  return row;
}

/**
 * Гейт двери: взять блокировку и отказать, если режим её закрыл.
 *
 * 503, а не 403: дверь закрыта временно и не по вине запроса — портал показывает «модуль закрыт на
 * обслуживание», а не «вам нельзя».
 */
export async function requireOpenDoor(
  tx: Tx,
  door: AssignmentDoorClass,
): Promise<AssignmentModeSnapshot> {
  const mode = await lockAssignmentMode(tx);
  if (!doorIsOpen(mode.writeMode, door)) {
    throw new AppError(
      503,
      CODE_FROZEN,
      `Модуль периодов назначения закрыт на запись (${WRITE_MODE_TITLE[mode.writeMode]}) — операция недоступна`,
    );
  }
  return mode;
}

/** Режим без блокировки: для читателей, баннера и диагностики. Пишущей двери этого мало. */
export async function readAssignmentMode(reader: Reader): Promise<AssignmentModeSnapshot> {
  const [row] = await reader
    .select({
      writeMode: assignmentPeriodsControl.writeMode,
      readMode: assignmentPeriodsControl.readMode,
      cutoverRunId: assignmentPeriodsControl.cutoverRunId,
    })
    .from(assignmentPeriodsControl)
    .where(eq(assignmentPeriodsControl.id, true));
  if (!row) throw controlRowMissing();
  return row;
}

/** Что просят у двери: оба целевых режима, причина, автор и сборка, которой переключают. */
export interface AssignmentModeChange {
  targetWriteMode: AssignmentWriteMode;
  targetReadMode: AssignmentReadMode;
  /** Причина обязательна: журнал читают через месяцы, и «переключили» в нём ничего не объясняет. */
  reason: string;
  actorUserId: string;
  /** Сборка, которой идёт переключение. При активации сверяется с набором активных сборок. */
  buildSha: string;
  /** Поколение сверки — только для активации истории. */
  runId?: string | null;
  /** Аттестация деплоя — только для активации истории; потребляется этим переходом. */
  attestationId?: string | null;
}

/** Запись журнала — то, чем переход доказывается годы спустя. */
export interface AssignmentModeTransitionRecord {
  id: number;
  at: Date;
  from: { writeMode: AssignmentWriteMode; readMode: AssignmentReadMode };
  to: { writeMode: AssignmentWriteMode; readMode: AssignmentReadMode };
  runId: string | null;
  attestationId: string | null;
  buildSha: string;
  algoVersion: string;
  reason: string;
  actorUserId: string;
}

/**
 * Допустимые рёбра автомата записи (матрица §6, решение О2).
 *
 * `CHECK` перечисляет значения, а не переходы, — поэтому прямой `history_frozen → normal` прошёл бы
 * базой беспрепятственно. Матрица живёт здесь, и другого пути к управляющей строке нет: прикладной
 * роли `UPDATE` на режим не выдаётся вовсе.
 */
const WRITE_EDGES: Record<AssignmentWriteMode, readonly AssignmentWriteMode[]> = {
  // Заморозка любой глубины — по праву и причине.
  normal: ['history_frozen', 'all_frozen'],
  // Ужесточение: единственная дорога из отката обратно в работу идёт через `all_frozen`.
  history_frozen: ['all_frozen'],
  // Разморозка — только полная и только после revalidation.
  all_frozen: ['normal'],
};

/** Почему это ребро отклонено. Пустая строка невозможна: сообщение объясняет и называет путь. */
function writeEdgeRefusal(from: AssignmentWriteMode, to: AssignmentWriteMode): string | null {
  if (WRITE_EDGES[from].includes(to)) return null;
  if (from === 'history_frozen' && to === 'normal') {
    return (
      'Прямой переход «заморожена история» → «обычный режим» запрещён (К4): пока история была ' +
      'закрыта, ручная выписка и смены двигали отменяемость бумаги. Путь один — сначала ' +
      '«заморожена вся запись», затем полная revalidation, и только потом разморозка.'
    );
  }
  if (from === 'all_frozen' && to === 'history_frozen') {
    return (
      'Ослабление «заморожена вся запись» → «заморожена история» запрещено: оно открывает ручную ' +
      'выписку и смены, то есть ровно то, что полная заморозка и закрывает (И1). Сначала ' +
      'разморозка с revalidation, затем заморозка нужной глубины.'
    );
  }
  return `Переход режима записи «${WRITE_MODE_TITLE[from]}» → «${WRITE_MODE_TITLE[to]}» не предусмотрен матрицей`;
}

/**
 * Одна дверь на весь автомат: заморозка, разморозка, включение и выключение истории.
 *
 * Внутри — единственная транзакция, начинающаяся с управляющей строки `FOR UPDATE`: она и
 * сериализует операторов между собой, и дожидается активных писателей (drain, Ж3). Проверки идут
 * **до** записи и все до одной: матрица переходов, revalidation, поколение сверки, аттестация
 * деплоя, готовность заявок. Порядок блокировок — управляющая строка, затем поколение, затем
 * аттестация; обратный порядок где-нибудь ещё дал бы клинч.
 *
 * Дверь принимает исполнителя явно (`executor`), а не берёт прикладной пул: административный путь
 * ходит своими кредами (`DATABASE_MAINTENANCE_URL`), и подменять ради этого `DATABASE_URL` целого
 * процесса значит требовать от команды смены режима весь env приложения — JWT, S3, почту, — ничего
 * из которого ей не нужно. Умолчания нет намеренно: «чем ходит эта транзакция» — решение
 * вызывающего, и молчаливый прикладной пул был бы ровно тем ответом, которого административный
 * путь не хочет.
 */
export async function setModuleMode(
  change: AssignmentModeChange,
  executor: ModeExecutor,
): Promise<AssignmentModeTransitionRecord> {
  const reason = change.reason.trim();
  if (!reason) {
    throw rejected(
      'Смена режима модуля требует причины: журнал переходов — доказательство, а не отметка',
    );
  }
  const buildSha = change.buildSha.trim();
  if (!buildSha) {
    throw rejected(
      'Не названа сборка, которой идёт переключение: журнал обязан помнить, чем переключили',
    );
  }

  const runIdInput = change.runId ?? null;
  const attestationIdInput = change.attestationId ?? null;

  return executor.transaction(async (tx) => {
    // `FOR UPDATE`, а не `FOR SHARE`: дверь пишет строку, и она же обязана дождаться писателей.
    const [current] = await tx
      .select({
        writeMode: assignmentPeriodsControl.writeMode,
        readMode: assignmentPeriodsControl.readMode,
        cutoverRunId: assignmentPeriodsControl.cutoverRunId,
      })
      .from(assignmentPeriodsControl)
      .where(eq(assignmentPeriodsControl.id, true))
      .for('update');
    if (!current) throw controlRowMissing();

    const writeChanged = current.writeMode !== change.targetWriteMode;
    const readChanged = current.readMode !== change.targetReadMode;
    if (!writeChanged && !readChanged) {
      throw rejected('Режим уже такой: переход, ничего не меняющий, в журнал не пишется');
    }

    // Один шаг — одна перемена. Порядок cutover (§10) разводит их намеренно: сначала полная
    // заморозка, потом переключение чтения, и только потом разморозка. Слей их в один вызов — и
    // чтение переключилось бы в тот же момент, когда открылись двери, то есть без drain.
    if (writeChanged && readChanged) {
      throw rejected(
        'Режимы записи и чтения переключаются разными шагами: сначала заморозка, затем чтение, затем разморозка',
      );
    }

    if (writeChanged) {
      const refusal = writeEdgeRefusal(current.writeMode, change.targetWriteMode);
      if (refusal) throw rejected(refusal);
      if (runIdInput || attestationIdInput) {
        throw rejected('Поколение сверки и аттестация относятся только к включению истории');
      }
      // Разморозка: пока где-то поднят `dirty`, revalidation не закончена — внутри дня история
      // успела разойтись с бумагой, а календарное правило устаревания об этом молчит (К4).
      if (change.targetWriteMode === 'normal') await requireNoDirtyRequests(tx);
    }

    let consumedRunId: string | null = null;
    let consumedAttestationId: string | null = null;
    let nextCutoverRunId = current.cutoverRunId;

    if (readChanged) {
      // Оба переключения чтения идут под полной заморозкой: иначе legacy-транзакция, начатая до
      // проверки, закоммитит старый план уже после того, как прогон увидел ноль расхождений.
      if (current.writeMode !== 'all_frozen') {
        throw rejected(
          'Переключение источника истории идёт только под полной заморозкой записи: сначала «заморожена вся запись»',
        );
      }
      if (change.targetReadMode === 'history') {
        const activation = await checkActivation(tx, {
          runId: runIdInput,
          attestationId: attestationIdInput,
          buildSha,
        });
        consumedRunId = activation.runId;
        consumedAttestationId = activation.attestationId;
        nextCutoverRunId = activation.runId;
      } else {
        // Возврат в `legacy` бывает аварийным: требовать от него поколения и аттестации значило бы
        // запирать откат ровно тогда, когда он нужен. Ссылка на поколение не стирается — она
        // остаётся аудитом того, чем история была включена.
        if (runIdInput || attestationIdInput) {
          throw rejected('Возврат к legacy не потребляет ни поколения сверки, ни аттестации');
        }
      }
    }

    await tx
      .update(assignmentPeriodsControl)
      .set({
        writeMode: change.targetWriteMode,
        readMode: change.targetReadMode,
        cutoverRunId: nextCutoverRunId,
        updatedBy: change.actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(assignmentPeriodsControl.id, true));

    // Аттестация помечается потреблённой той же транзакцией, что и переход: помеченная без
    // перехода запирала бы cutover, потреблённая дважды — обесценивала бы обе записи.
    if (consumedAttestationId) {
      await tx
        .update(assignmentDeployAttestations)
        .set({ consumedAt: new Date() })
        .where(eq(assignmentDeployAttestations.id, consumedAttestationId));
    }

    const [row] = await tx
      .insert(assignmentPeriodsModeTransitions)
      .values({
        actorUserId: change.actorUserId,
        fromReadMode: current.readMode,
        toReadMode: change.targetReadMode,
        fromWriteMode: current.writeMode,
        toWriteMode: change.targetWriteMode,
        runId: consumedRunId,
        attestationId: consumedAttestationId,
        buildSha,
        algoVersion: ASSIGNMENT_HISTORY_ALGO_VERSION,
        reason,
      })
      .returning({
        id: assignmentPeriodsModeTransitions.id,
        at: assignmentPeriodsModeTransitions.at,
      });
    if (!row) throw rejected('Запись перехода не создана');

    return {
      id: row.id,
      at: row.at,
      from: { writeMode: current.writeMode, readMode: current.readMode },
      to: { writeMode: change.targetWriteMode, readMode: change.targetReadMode },
      runId: consumedRunId,
      attestationId: consumedAttestationId,
      buildSha,
      algoVersion: ASSIGNMENT_HISTORY_ALGO_VERSION,
      reason,
      actorUserId: change.actorUserId,
    };
  });
}

/**
 * Предикат готовности Р20 (с расширением Р28): у каждой заявки популяции история доведена.
 *
 * ПОЧЕМУ ЭТОГО НЕ ХВАТАЛО МЕТОК И ПЕРЕСЧЁТА. Дверь спрашивала «не разошлась ли история с бумагой»
 * и «на тот ли день считана», но не спрашивала главного — **есть ли она вообще**. Заявка в
 * состоянии `empty` проходила обе проверки насквозь: меток у неё нет, а из запроса устаревания
 * `empty` исключён явно (у него и валидности нет по ограничению схемы). После переключения портал
 * читает «кто и на чём работал» из истории — и у такой заявки не прочитал бы ничего.
 *
 * ПОЧЕМУ ЗАОДНО И `materialized`. Р26: `materialized` означает «строки есть, но валидности нет», и
 * предикат cutover читает именно колонку состояния. Пропусти дверь такие заявки — она стала бы
 * мягче сводки, а сводка (`assignment-readiness.ts`, ярус `data`) держит их препятствием. Дверь,
 * которая мягче отчёта, защищает ровно до тех пор, пока человек не забудет посмотреть отчёт.
 *
 * ПРЕДИКАТ БЕРЁТСЯ ГОТОВЫМ. {@link ASSIGNMENT_READINESS_POPULATION} — то же самое множество, по
 * которому считают сводка и прогон бэкфилла; псевдонимы `r` и `d` фиксированы его контрактом.
 * Третья копия правила означала бы, что «готово» у двери и «готово» у отчёта считаются по разным
 * заявкам, а различить это по числам нельзя.
 */
async function requireHistoryPopulationReady(tx: Tx): Promise<void> {
  /*
   * Разделение `empty` на две половины — не украшение отказа: у них разные адресаты. Заявку с
   * назначенной машиной доводит массовый прогон, а заявку без машины он пропустит и в десятый раз
   * — историю ей строить не из чего, и чинит её диспетчер (Ю64).
   *
   * `LEFT JOIN` по назначению безопасен: `vehicle_request_assignments.request_id` — первичный ключ,
   * то есть строк не больше одной на заявку, и счёт не удваивается. Той же формой считает сводка.
   */
  const [row] = (
    await tx.execute<Record<string, number>>(sql`
      SELECT count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION}
                                AND r.assignment_history_state = 'empty'
                                AND a.request_id IS NOT NULL)::int AS empty_with_assignment,
             count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION}
                                AND r.assignment_history_state = 'empty'
                                AND a.request_id IS NULL)::int AS empty_without_assignment,
             count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION}
                                AND r.assignment_history_state = 'materialized')::int AS materialized
        FROM vehicle_requests r
        LEFT JOIN special_equipment_request_details d ON d.request_id = r.id
        LEFT JOIN vehicle_request_assignments a ON a.request_id = r.id`)
  ).rows;
  if (!row) throw rejected('База не ответила на подсчёт готовности истории');

  const emptyWithAssignment = Number(row.empty_with_assignment ?? 0);
  const emptyWithoutAssignment = Number(row.empty_without_assignment ?? 0);
  const materialized = Number(row.materialized ?? 0);
  const blocked = emptyWithAssignment + emptyWithoutAssignment + materialized;
  if (blocked === 0) return;

  const parts: string[] = [];
  if (emptyWithAssignment > 0) parts.push(`${emptyWithAssignment} без истории вовсе`);
  if (emptyWithoutAssignment > 0) {
    parts.push(`${emptyWithoutAssignment} без назначенной машины — историю строить не из чего`);
  }
  if (materialized > 0) parts.push(`${materialized} с историей, но без валидности`);

  throw rejected(
    `Предикат готовности Р20 не выполнен: история не доведена у ${blocked} заявок популяции ` +
      `(${parts.join('; ')}). Массовый прогон — ` +
      '`pnpm --filter @technic/api assignment:backfill --apply`; невосстановимое разбирается по ' +
      'блокирующему отчёту `assignment:report`, заявки без назначенной машины чинит диспетчер.',
  );
}

/** Сколько заявок с поднятым `dirty` — их наличие означает незаконченную revalidation. */
async function requireNoDirtyRequests(tx: Tx): Promise<void> {
  const [row] = await tx
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.assignmentHistoryDirty, true));
  const dirty = row?.n ?? 0;
  if (dirty > 0) {
    throw rejected(
      `Разморозка запрещена: у ${dirty} заявок поднята метка загрязнения истории — сначала revalidation`,
    );
  }
}

/** Что именно потреблено активацией: обе ссылки уходят в запись перехода. */
interface Activation {
  runId: string;
  attestationId: string;
}

/**
 * Все проверки включения истории (§6, решения М1, Н3, О3, О4, И5).
 *
 * Ни одна из них не выражается ограничением базы: `CHECK` не знает ни статуса прогона, ни сборки,
 * ни `dirty`, и запрос `set read_mode = 'history', cutover_run_id = '<любой существующий>'` прошёл
 * бы беспрепятственно. Поэтому проверки здесь и в одном месте.
 */
async function checkActivation(
  tx: Tx,
  input: { runId: string | null; attestationId: string | null; buildSha: string },
): Promise<Activation> {
  if (!input.runId) {
    throw rejected(
      'Включение истории требует поколения теневого сравнения: без него переход нечем обосновать',
    );
  }
  if (!input.attestationId) {
    throw rejected(
      'Включение истории требует аттестации деплоя: инвентарь раската приносит job деплоя, а не оператор',
    );
  }

  // `FOR SHARE`: поколение под нами не должно менять статус, но и сериализовать worker'ов сверки
  // этой блокировкой незачем — им хватает своей строки проверки.
  const [run] = await tx
    .select({
      runId: assignmentShadowRuns.runId,
      status: assignmentShadowRuns.status,
      asOf: assignmentShadowRuns.asOf,
      algoVersion: assignmentShadowRuns.algoVersion,
      buildVersion: assignmentShadowRuns.buildVersion,
      expectedChecks: assignmentShadowRuns.expectedChecks,
    })
    .from(assignmentShadowRuns)
    .where(eq(assignmentShadowRuns.runId, input.runId))
    .for('share');
  if (!run) throw rejected('Поколение теневого сравнения не найдено');
  if (run.status !== 'completed') {
    throw rejected(
      `Поколение ${run.runId} не завершено (${run.status}): к переключению допускается только completed`,
    );
  }

  // Прогон, переживший полночь, начинается заново (О3): календарь двигает валидность истории сам,
  // без всякой двери, и вчерашний зелёный прогон сегодня уже ничего не доказывает.
  const today = moscowDateKeyOf(new Date());
  if (run.asOf !== today) {
    throw rejected(
      `Поколение считалось на ${run.asOf}, сегодня ${today}: прогон, переживший полночь, начинается заново`,
    );
  }

  // Manifest сошёлся целиком: строки заводятся заранее, поэтому «нет расхождений» без сверки с
  // `expected_checks` означало бы лишь «до половины целей так и не дошли».
  const [tally] = await tx
    .select({
      total: sql<number>`cast(count(*) as int)`,
      pending: sql<number>`cast(count(*) filter (where ${assignmentShadowChecks.status} = 'pending') as int)`,
      mismatch: sql<number>`cast(count(*) filter (where ${assignmentShadowChecks.status} = 'mismatch') as int)`,
    })
    .from(assignmentShadowChecks)
    .where(eq(assignmentShadowChecks.runId, run.runId));
  const total = tally?.total ?? 0;
  const pending = tally?.pending ?? 0;
  const mismatch = tally?.mismatch ?? 0;
  if (total !== run.expectedChecks) {
    throw rejected(`Manifest поколения неполон: целей ${total} из ожидаемых ${run.expectedChecks}`);
  }
  if (pending > 0)
    throw rejected(`Поколение не досчитано: ${pending} целей осталось непроверенными`);
  if (mismatch > 0)
    throw rejected(`Поколение зафиксировало ${mismatch} расхождений: переключение запрещено`);

  // `FOR UPDATE`: аттестация потребляется этим переходом, и второй оператор не должен потребить её
  // же между нашей проверкой и нашей записью.
  const [attestation] = await tx
    .select({
      id: assignmentDeployAttestations.id,
      attestedAt: assignmentDeployAttestations.attestedAt,
      activeBuildShas: assignmentDeployAttestations.activeBuildShas,
      algoVersion: assignmentDeployAttestations.algoVersion,
      legacyClientCalls: assignmentDeployAttestations.legacyClientCalls,
      consumedAt: assignmentDeployAttestations.consumedAt,
    })
    .from(assignmentDeployAttestations)
    .where(eq(assignmentDeployAttestations.id, input.attestationId))
    .for('update');
  if (!attestation) throw rejected('Аттестация деплоя не найдена');
  if (attestation.consumedAt) {
    throw rejected(
      'Аттестация уже потреблена другим переходом: одна аттестация — одно переключение',
    );
  }
  const ageMs = Date.now() - attestation.attestedAt.getTime();
  if (ageMs > ATTESTATION_MAX_AGE_MS) {
    throw rejected(
      `Аттестация снята ${Math.round(ageMs / 60000)} мин назад и описывает уже не сегодняшний раскат: снимите заново`,
    );
  }
  if (attestation.legacyClientCalls !== 0) {
    throw rejected(
      `Метрика насчитала ${attestation.legacyClientCalls} вызовов старого маршрута с датами: живой клиент разреза не знает (И5)`,
    );
  }
  // Сборку прогона и сборку двери сверяем с инвентарём раската, а не со словами оператора: сам
  // процесс своей роли в кластере не знает, а аттестацию пишет тот, кто раскатывал.
  if (!attestation.activeBuildShas.includes(run.buildVersion)) {
    throw rejected(
      `Поколение получено сборкой ${run.buildVersion}, которой нет среди раскатанных: сверка доказывает не ту площадку`,
    );
  }
  if (!attestation.activeBuildShas.includes(input.buildSha)) {
    throw rejected(
      `Переключение идёт сборкой ${input.buildSha}, которой нет среди раскатанных: переключает не то, что работает`,
    );
  }
  // Три версии алгоритма обязаны совпасть: которой считали сверку, которая раскатана и которая
  // переключает. Разойдись любые две — доказательство относится к другому алгоритму.
  if (
    run.algoVersion !== attestation.algoVersion ||
    attestation.algoVersion !== ASSIGNMENT_HISTORY_ALGO_VERSION
  ) {
    throw rejected(
      `Версии алгоритма разошлись: поколение ${run.algoVersion}, раскат ${attestation.algoVersion}, дверь ${ASSIGNMENT_HISTORY_ALGO_VERSION}`,
    );
  }

  // Готовность заявок — тремя проверками и в том же порядке, в каком их печатает сводка
  // (`assignment-readiness.ts`, ярус `data`): сначала предикат Р20 «история доведена», затем метки
  // загрязнения, затем пересчёт на день поколения.
  await requireHistoryPopulationReady(tx);
  await requireNoDirtyRequests(tx);
  const [stale] = await tx
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(vehicleRequests)
    .where(
      and(
        ne(vehicleRequests.assignmentHistoryState, 'empty'),
        or(
          isNull(vehicleRequests.assignmentHistoryValidatedOn),
          ne(vehicleRequests.assignmentHistoryValidatedOn, run.asOf),
        ),
      ),
    );
  const staleCount = stale?.n ?? 0;
  if (staleCount > 0) {
    throw rejected(
      `У ${staleCount} заявок состояние истории считалось не на ${run.asOf}: revalidation не закончена`,
    );
  }

  return { runId: run.runId, attestationId: attestation.id };
}
