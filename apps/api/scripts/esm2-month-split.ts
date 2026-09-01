import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, ne, sql } from 'drizzle-orm';
import { moscowDateKeyOf, periodsOverlap, type Esm2Period } from '@technic/contracts';
import { db } from '../src/db/client';
import { users, vehicleRequests, waybills } from '../src/db/schema';
import { requireOpenDoor } from '../src/services/assignment-mode';
import { markAssignmentHistoryDirty } from '../src/services/assignment-dirty';
import { lockRequestRow } from '../src/services/vehicle-routes';
import {
  buildEsm2SyncPlan,
  syncEsm2Waybills,
  type Esm2SyncPlanInput,
} from '../src/services/waybill-esm2';
import {
  correctionFingerprint,
  insertCorrection,
  linkCorrectionRequests,
  saveCorrectionPayload,
} from '../src/services/waybill-correction';

/**
 * Разовое переоформление листов ЭСМ-2, оставшихся от прежнего разреза (ADR 0142, Э6 плана
 * `docs/esm2-month-split-plan.md`).
 *
 * ЗАЧЕМ ОН. Месячная граница — правило расчёта, а не свойство записанного листа: выписанный до
 * выката бланк «31.08–06.09» так и остаётся одним документом на два месяца. Сверка переоформит его
 * сама — но только когда кто-нибудь тронет заявку, а следующее касание может случиться и через
 * месяц. Фонового прогона у сверки нет: её зовут шесть дверей, и все — вслед за решением человека.
 * Поэтому переоформление запускается руками, один раз, сразу после выката.
 *
 * ЧТО ОН ДЕЛАЕТ. Ровно то же, что сделала бы любая дверь: зовёт `syncEsm2Waybills` по заявке. Своей
 * записи листов у него нет и быть не должно — второй механизм расхода номеров строгой отчётности
 * разошёлся бы с первым, и разошёлся бы молча.
 *
 * ПОЧЕМУ У НЕГО ЕСТЬ ЗАДНИЙ ХОД. Прогон опоздал: его писали под запуск до конца месяца, когда обе
 * половины переходной недели ещё лежали в будущем. Запущенный после границы, он делает половину
 * работы — и половина эта хуже бездействия. Лист «31.08–06.09» первого сентября ещё аннулируется
 * (`canCancelWaybill` считает по последнему дню, а он впереди), но замена ему выписывается одна:
 * период «31–31 августа» уже кончился, а кончившийся период сверка не выписывает без проверенной
 * коррекции (Р21, ADR 0101). Номер сгорел бы, а 31 августа осталось бы вовсе без документа.
 *
 * Поэтому у прогона два режима. Без `--backdate` он такие заявки **пропускает** — называя, какие
 * дни остались бы без бумаги. С `--backdate` он заводит на каждую заявку строку операции
 * (`waybill_corrections`, вид `esm2`) и отдаёт её сверке: тогда выписываются оба куска, каждый
 * новый номер объявляет себя заменой сгоревшему (`corrects_waybill_id`), а причина разрыва
 * нумерации стоит в журнале коррекций, а не подразумевается.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ И С `--backdate` — НЕ ТРОГАЕТ ЧУЖОЕ ПРОШЛОЕ. Контекст коррекции снимает
 * неприкосновенность прошлого целиком: заодно с половиной переходной недели сверка выписала бы
 * задним числом и всякую давнюю неделю срока, которой листа не было вовсе (дыра 3 из §1 плана).
 * Это не работа этого прогона: такие недели заводят руками, глядя на них. Поэтому план перед
 * исполнением сверяется (`judgeBackdate`), и заявка, у которой задний ход выходит за дни
 * сгорающего двухмесячного листа, пропускается с объяснением.
 *
 * Отработанные листы прогон не трогает ни в одном режиме: `unlockWaybillIds` он не передаёт
 * никогда, и замок сверки (`canCancelWaybill`) остаётся на месте. Работа тех дней состоялась,
 * заказчик заполнил оборот, и переписывать её ради нового разреза нельзя.
 *
 * КЕМ ПОДПИСАНЫ НОМЕРА. Сгоревший и выписанный бланк подписываются учёткой, названной `--actor`:
 * «система» в журнале учёта строгой отчётности не отвечает на вопрос «кто сжёг номер». Ею же
 * подписана операция коррекции. Запускать поэтому от того, кто за выкат отвечает.
 *
 * Коды возврата: 0 — сделано всё, 1 — не разобраны аргументы, 2 — часть заявок пропущена.
 *
 * Использование:
 *   pnpm --filter @technic/api esm2:month-split -- --actor admin@example.ru            # что будет
 *   pnpm --filter @technic/api esm2:month-split -- --actor admin@example.ru --apply    # переоформить
 *   pnpm --filter @technic/api esm2:month-split -- --actor admin@example.ru --backdate --apply
 */

const EXIT_FAILURE = 1;
const EXIT_INCOMPLETE = 2;
const REASON = 'Разрез листа ЭСМ-2 границей месяца (ADR 0142)';

/**
 * Контекст коррекции для **расчёта** плана. Идентификатора операции расчёту не нужно: он смотрит
 * на сам факт заднего хода (`correction: { allowed: true }`) и на список названных листов, а
 * пустой список означает «отработанное прошлое не открывать». Настоящая строка журнала заводится
 * позже и только у тех заявок, где план подтвердил, что задний ход нужен и не шире переходного
 * листа: операция без правки — такая же дыра в журнале, как правка без операции.
 */
const PLANNING_CORRECTION = { id: '', unlockWaybillIds: [] as readonly string[] };

interface Options {
  apply: boolean;
  backdate: boolean;
  actor: string;
}

function parseArgs(argv: readonly string[]): Options | string {
  let apply = false;
  let backdate = false;
  let actor = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Разделитель `pnpm run … -- --actor …` доезжает до `argv` как отдельное слово: команду
    // запускают через pnpm, и спотыкаться о собственный способ запуска скрипт не должен.
    if (arg === '--') continue;
    if (arg === '--apply') apply = true;
    else if (arg === '--backdate') backdate = true;
    else if (arg === '--actor') {
      actor = argv[i + 1] ?? '';
      i += 1;
    } else return `неизвестный аргумент «${arg}»`;
  }
  if (!actor) return 'не указан --actor <email>: номера бланков подписывает человек, а не система';
  return { apply, backdate, actor };
}

/**
 * Заявки, у которых остался лист на два месяца, — и только с неотработанным периодом.
 *
 * Месяц сравнивается по первым семи знакам ключа (`YYYY-MM`), а не `date_trunc`: колонки `date`
 * сравниваются как есть и на проде (PostgreSQL 17), и на деве (16), а приведение к timestamp
 * потянуло бы за собой часовой пояс сессии.
 */
async function findTargets(today: string): Promise<{ id: string; num: number }[]> {
  const rows = await db
    .selectDistinct({ id: vehicleRequests.id, num: vehicleRequests.num })
    .from(waybills)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, waybills.sourceRequestId))
    .where(
      and(
        eq(waybills.formCode, 'esm2'),
        ne(waybills.status, 'cancelled'),
        sql`substr(${waybills.periodFrom}::text, 1, 7) <> substr(${waybills.periodTo}::text, 1, 7)`,
        sql`${waybills.periodTo} >= ${today}`,
      ),
    )
    .orderBy(vehicleRequests.num);
  return rows;
}

const monthKeyOf = (dateKey: string): string => dateKey.slice(0, 7);

/** Что план требует от прошлого — и позволено ли это прогону. */
export type BackdateVerdict =
  /** Задний ход не нужен: всё, что выписывается, ещё не кончилось. */
  | { kind: 'plain' }
  /** Задний ход нужен и ограничен днями сгорающего двухмесячного листа — ровно работа Э6. */
  | { kind: 'backdate'; past: readonly Esm2Period[] }
  /** Задний ход вышел бы за эти дни: не работа прогона, заявку смотрит человек. */
  | { kind: 'stray'; stray: readonly Esm2Period[] };

/**
 * Разобрать план по отношению к прошлому — до того, как сгорел первый номер.
 *
 * Прошедший период в плане означает ровно одно: без контекста коррекции сверка его не выпишет, а
 * лист, который его покрывал, всё равно сожжёт. Вопрос поэтому не «жечь или нет», а «чьё это
 * прошлое»: половина переходного листа, ради которой прогон и написан, или давняя неделя, о
 * которой он ничего не знает.
 *
 * Ответ считается по пересечению дней (ADR 0142), а не по неделе: разрезанные куски живут внутри
 * одной недели, и недельный ключ не отличил бы «первую половину сгорающего листа» от «недели,
 * которой листа не было».
 */
export function judgeBackdate(
  input: Pick<Esm2SyncPlanInput, 'existing' | 'today'>,
  plan: { cancel: readonly string[]; issue: readonly Esm2Period[] },
): BackdateVerdict {
  const past = plan.issue.filter((period) => period.to < input.today);
  if (past.length === 0) return { kind: 'plain' };
  const crossing = input.existing
    .filter((sheet) => plan.cancel.includes(sheet.id))
    .map((sheet) => ({ from: sheet.periodFrom, to: sheet.periodTo }))
    .filter((period) => monthKeyOf(period.from) !== monthKeyOf(period.to));
  const stray = past.filter((period) => !crossing.some((sheet) => periodsOverlap(period, sheet)));
  return stray.length > 0 ? { kind: 'stray', stray } : { kind: 'backdate', past };
}

const showDays = (periods: readonly Esm2Period[]): string =>
  periods.map((period) => `${period.from}…${period.to}`).join(', ');

/** То же, но с пометкой у кончившихся периодов: в общем списке плана их надо различать глазами. */
const showPeriods = (periods: readonly Esm2Period[], today: string): string =>
  periods
    .map((period) => `${period.from}…${period.to}${period.to < today ? ' (задним числом)' : ''}`)
    .join(', ');

/** Почему заявка не тронута — теми же словами и в предпросмотре, и в прогоне. */
function skipReason(verdict: BackdateVerdict): string | null {
  if (verdict.kind === 'stray') {
    return `задний ход вышел бы за переходный лист — ${showDays(verdict.stray)}; эти дни разбирают вручную`;
  }
  if (verdict.kind === 'backdate') {
    return `без --backdate дни ${showDays(verdict.past)} остались бы без бумаги: лист сгорел бы, а замены им сверка не выпишет`;
  }
  return null;
}

interface Tally {
  cancelled: number;
  issued: number;
  skipped: number;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`esm2:month-split: ${parsed}`);
    process.exit(EXIT_FAILURE);
  }
  const { apply, backdate, actor } = parsed;

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, actor));
  if (!user) {
    console.error(`esm2:month-split: учётка «${actor}» не найдена`);
    process.exit(EXIT_FAILURE);
  }

  const today = moscowDateKeyOf(new Date());
  const targets = await findTargets(today);
  console.log(
    `esm2:month-split: заявок с листом на два месяца — ${targets.length}; режим — ${apply ? 'переоформление' : 'только показать'}${backdate ? ', задний ход разрешён' : ''}`,
  );

  const tally: Tally = { cancelled: 0, issued: 0, skipped: 0 };
  for (const target of targets) {
    if (!apply) {
      // Предпросмотр считает **та же** работа, которая потом и исполнит (`buildEsm2SyncPlan`):
      // отдельный расчёт «сколько бумаги сгорит» разошёлся бы с прогоном на первой же правке.
      // Считается он с контекстом коррекции всегда — иначе прошедшая половина недели не показалась
      // бы вовсе, и предупреждать было бы не о чем.
      const built = await buildEsm2SyncPlan(db, {
        requestId: target.id,
        asOf: today,
        correction: PLANNING_CORRECTION,
      });
      if (!built) continue;
      const verdict = judgeBackdate(built.input, built.plan);
      const skip = backdate && verdict.kind === 'backdate' ? null : skipReason(verdict);
      console.log(
        `  ТС-${target.num}: сгорит ${built.plan.cancel.length}, выпишется ${built.plan.issue.length} — ${showPeriods(built.plan.issue, today)}`,
      );
      if (skip) {
        console.log(`    пропущу: ${skip}`);
        tally.skipped += 1;
        continue;
      }
      tally.cancelled += built.plan.cancel.length;
      tally.issued += built.plan.issue.length;
      continue;
    }
    const outcome = await db.transaction(async (tx) => {
      // Порядок и класс двери — как у ручной выписки (`history_free`, план Л3): сперва гейт
      // режима, затем строка заявки, и только потом бумага. Встречный порядок «листы → заявка»
      // стал бы взаимной блокировкой с командами истории.
      await requireOpenDoor(tx, 'history_free');
      await lockRequestRow(tx, target.id);
      // План пересчитывается уже под блокировкой: между отбором и прогоном заявку могли тронуть
      // руками, и решение о заднем ходе обязано опираться на то состояние, которое сейчас правят.
      const built = await buildEsm2SyncPlan(tx, {
        requestId: target.id,
        asOf: today,
        correction: PLANNING_CORRECTION,
      });
      if (!built) return null;
      const verdict = judgeBackdate(built.input, built.plan);
      if (verdict.kind === 'stray' || (verdict.kind === 'backdate' && !backdate)) {
        return { skip: skipReason(verdict)! };
      }
      /*
       * Строка операции заводится только там, где прошлое и правда открывают, — и **до** сверки:
       * на неё ссылаются оба листа (`correction_id`), и завести её после значило бы сослаться на
       * то, чего в этот момент не существует.
       *
       * Ключ идемпотентности здесь свой на каждую заявку и на каждый запуск: клиента, который
       * повторил бы ту же кнопку, у прогона нет, а повторный запуск целей уже не найдёт — листы
       * к тому времени разрезаны.
       */
      const past = verdict.kind === 'backdate' ? verdict.past : [];
      const correction =
        past.length > 0
          ? await insertCorrection(tx, {
              operationId: randomUUID(),
              fingerprint: correctionFingerprint({
                kind: 'esm2',
                target: target.id,
                body: { script: 'esm2:month-split', past },
              }),
              kind: 'esm2',
              reason: REASON,
              actorUserId: user.id,
            })
          : null;
      const synced = await syncEsm2Waybills(tx, {
        requestId: target.id,
        actor: { id: user.id },
        reason: REASON,
        asOf: today,
        ...(correction ? { correction: { id: correction.id, unlockWaybillIds: [] } } : {}),
      });
      if (correction) {
        // «Что делали с этой заявкой задним числом» спрашивают со стороны заявки, и связь операции
        // с ней — единственный ответ (Р16).
        await linkCorrectionRequests(tx, correction.id, [target.id]);
        // Снимок «было → стало» (Р16): через месяцы операцию откроют ради вопроса «почему за 31-е
        // выписан отдельный бланк», и ответом обязаны быть номера, а не пересчёт сегодняшних дат.
        await saveCorrectionPayload(tx, correction.id, {
          script: 'esm2:month-split',
          request: { id: target.id, num: target.num },
          backdated: past,
          burned: synced.cancelled,
          issued: synced.issued,
        });
      }
      // Множество листов заявки изменилось — значит отменяемость её бумаги изменилась внутри дня
      // (К4). Метку ставят все двери этого класса.
      if (synced.cancelled.length > 0 || synced.issued.length > 0) {
        await markAssignmentHistoryDirty(tx, target.id);
      }
      return { synced, backdated: past };
    });
    if (!outcome) continue;
    if ('skip' in outcome) {
      console.log(`  ТС-${target.num}: пропущена — ${outcome.skip}`);
      tally.skipped += 1;
      continue;
    }
    tally.cancelled += outcome.synced.cancelled.length;
    tally.issued += outcome.synced.issued.length;
    console.log(
      `  ТС-${target.num}: аннулировано ${outcome.synced.cancelled.length}, выписано ${outcome.synced.issued.length}${
        outcome.backdated.length > 0 ? ` (задним числом — ${showDays(outcome.backdated)})` : ''
      }`,
    );
  }

  console.log(
    `esm2:month-split: итого ${apply ? 'аннулировано' : 'сгорит'} ${tally.cancelled}, ${apply ? 'выписано' : 'выпишется'} ${tally.issued}${tally.skipped > 0 ? `, пропущено заявок ${tally.skipped}` : ''}`,
  );
  // Пропуски — не успех: прогон, оставивший заявки нетронутыми, обязан отличаться кодом возврата
  // от прогона, сделавшего всё. Иначе «зелёный» запуск в скрипте выката скроет недоделанное.
  if (tally.skipped > 0) process.exit(EXIT_INCOMPLETE);
}

/*
 * Прогон идёт только при запуске из командной строки: сам вердикт (`judgeBackdate`) импортирует
 * db-тест — он проверяет его на собранной сцене, где переходной лист уже наполовину в прошлом.
 * Прогон при импорте жёг бы номера прямо под тестом, который их в это время читает.
 */
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  await main();
  process.exit(0);
}
