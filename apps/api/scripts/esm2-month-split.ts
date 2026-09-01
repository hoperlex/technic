import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, ne, sql } from 'drizzle-orm';
import { moscowDateKeyOf, type Esm2Period } from '@technic/contracts';
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
 * Переоформление листов ЭСМ-2, оставшихся от прежнего разреза (ADR 0142 §5, ADR 0149).
 *
 * ЗАЧЕМ ОН. Месячная граница — правило расчёта, а не свойство записанного листа: выписанный до
 * выката бланк «31.08–06.09» так и остаётся одним документом на два месяца. Сверка переоформит его
 * сама — но только когда кто-нибудь тронет заявку, а следующее касание может случиться и через
 * месяц. Фонового прогона у сверки нет: её зовут шесть дверей, и все — вслед за решением человека.
 * Поэтому переоформление запускает выкат: `deploy-auto` зовёт этот прогон сразу после наката
 * миграций (ADR 0149 §2).
 *
 * ЧТО ОН ДЕЛАЕТ. Ровно то же, что сделала бы любая дверь: зовёт `syncEsm2Waybills` по заявке. Своей
 * записи листов у него нет и быть не должно — второй механизм расхода номеров строгой отчётности
 * разошёлся бы с первым, и разошёлся бы молча. По той же причине переоформление не делается
 * миграцией: номер бланка и снимок его граф рождаются кодом выписки, а не `INSERT`ом.
 *
 * ПОЧЕМУ ОН СЧИТАЕТ ПО ДАТАМ ЛИСТА, А НЕ ПО СЕГОДНЯШНЕМУ ДНЮ. Прогон опаздывает — в этом всё
 * устройство. Запущенный первого сентября «сегодняшним» днём, он сделал бы половину работы:
 * лист «31.08–06.09» ещё аннулируется (граница аннулирования у ЭСМ-2 — последний день листа), а
 * замена ему вышла бы одна, потому что период «31–31 августа» уже кончился, а кончившийся период
 * сверка не выписывает (ADR 0101, Р21). Номер сгорел бы, а 31 августа осталось бы без документа.
 *
 * Поэтому каждая заявка считается **на день начала её же двухмесячного листа**: в той точке
 * времени обе половины недели ещё впереди, и сверка выписывает их обычным порядком — тем самым,
 * каким выписала бы, пройди прогон вовремя. Прогон не «открывает прошлое», а возвращается в день,
 * когда бумага была выписана неправильно.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ. Дата листа ослабляет замок сверки — и только это в ней и опасно, поэтому
 * границ у прогона три, и каждая проверяется до первой правки:
 *
 * 1. в отбор идут только листы, чей период **ещё не кончился** (`period_to >= сегодня`):
 *    отработанную неделю прогон не трогает вовсе — работа тех дней состоялась, заказчик заполнил
 *    оборот, и переписывать её ради нового разреза нельзя;
 * 2. сгореть в плане могут только сами двухмесячные листы. Разошёлся с планом сосед, которого
 *    сегодняшний день защитил бы, — заявка пропускается целиком;
 * 3. выписываться могут только периоды, не кончившиеся **до дня расчёта** (`judgeSplit`): давнюю
 *    неделю, у которой листа не было вовсе, прогон не заводит.
 *
 * КЕМ ПОДПИСАНЫ НОМЕРА. Замена подписывается тем, кто выписал переоформляемый лист (`issued_by`):
 * прогон не изобретает человека и не расписывается «системой» в журнале учёта строгой отчётности.
 * `--actor <email>` перебивает это, когда за выкат отвечает конкретная учётка.
 *
 * ЧТО ОСТАЁТСЯ В ЖУРНАЛЕ. Бумага, рождённая задним числом (период кончился до сегодняшнего дня),
 * получает строку операции `waybill_corrections` вида `esm2`: причину, автора и связь «какой номер
 * что заменил». Разрешением она не служит — разрешение даёт дата листа, — но исчезнувший и
 * появившийся номер строгой отчётности обязаны быть объяснены.
 *
 * Коды возврата: 0 — сделано всё, 1 — не разобраны аргументы, 2 — часть заявок пропущена.
 *
 * Использование:
 *   pnpm --filter @technic/api esm2:month-split                    # что будет
 *   pnpm --filter @technic/api esm2:month-split -- --apply         # переоформить
 *   pnpm --filter @technic/api esm2:month-split -- --apply --actor admin@example.ru
 */

const EXIT_FAILURE = 1;
const EXIT_INCOMPLETE = 2;
const REASON = 'Разрез листа ЭСМ-2 границей месяца (ADR 0142)';

/**
 * Контекст коррекции для **расчёта** плана. Идентификатора операции расчёту не нужно: он смотрит
 * на сам факт (`correction: { allowed: true }`) и на список названных листов, а пустой список
 * означает «отработанное прошлое не открывать». Настоящая строка журнала заводится позже и только
 * у тех заявок, где бумага и правда рождается задним числом.
 *
 * Стоит он здесь не ради разрешения — его даёт дата расчёта, — а ради того, чтобы предпросмотр
 * считался тем же входом, что и исполнение: `syncEsm2Waybills` получит контекст операции и пересчёт
 * плана внутри неё обязан дать то же самое.
 */
const PLANNING_CORRECTION = { id: '', unlockWaybillIds: [] as readonly string[] };

interface Options {
  apply: boolean;
  actor: string;
}

function parseArgs(argv: readonly string[]): Options | string {
  let apply = false;
  let actor = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Разделитель `pnpm run … -- --apply` доезжает до `argv` как отдельное слово: команду
    // запускают через pnpm, и спотыкаться о собственный способ запуска скрипт не должен.
    if (arg === '--') continue;
    if (arg === '--apply') apply = true;
    else if (arg === '--actor') {
      actor = argv[i + 1] ?? '';
      i += 1;
    } else return `неизвестный аргумент «${arg}»`;
  }
  return { apply, actor };
}

/** Заявка с двухмесячной бумагой: чем считать, кем подписывать и что именно горит. */
interface Target {
  requestId: string;
  num: number;
  /** День расчёта — начало самого раннего двухмесячного листа заявки. */
  asOf: string;
  /** Учётка, выписавшая этот лист: ею подписывается замена, если не назван `--actor`. */
  issuedBy: string;
  /** Идентификаторы самих двухмесячных листов: только им и позволено сгореть. */
  staleIds: string[];
}

/**
 * Заявки, у которых остался лист на два месяца, — и только с неотработанным периодом.
 *
 * Месяц сравнивается по первым семи знакам ключа (`YYYY-MM`), а не `date_trunc`: колонки `date`
 * сравниваются как есть и на проде (PostgreSQL 17), и на деве (16), а приведение к timestamp
 * потянуло бы за собой часовой пояс сессии.
 *
 * Условие `period_to >= сегодня` — первая из трёх границ прогона (см. шапку): неделя, которая уже
 * отработана, не переоформляется ни при какой дате расчёта.
 */
async function findTargets(today: string): Promise<Target[]> {
  const rows = await db
    .select({
      requestId: vehicleRequests.id,
      num: vehicleRequests.num,
      sheetId: waybills.id,
      periodFrom: waybills.periodFrom,
      issuedBy: waybills.issuedBy,
    })
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
    .orderBy(vehicleRequests.num, waybills.periodFrom);

  const targets = new Map<string, Target>();
  for (const row of rows) {
    const known = targets.get(row.requestId);
    if (!known) {
      targets.set(row.requestId, {
        requestId: row.requestId,
        num: row.num,
        // Строки идут по возрастанию `period_from`, поэтому первая встреченная и есть самая ранняя:
        // считать заявку надо в той точке, где ни одна её двухмесячная неделя ещё не началась.
        asOf: row.periodFrom!,
        issuedBy: row.issuedBy,
        staleIds: [row.sheetId],
      });
      continue;
    }
    known.staleIds.push(row.sheetId);
  }
  return [...targets.values()];
}

/** Что план делает с прошлым — и позволено ли это прогону. */
export type SplitVerdict =
  /** План лежит целиком в будущем дня расчёта: обычная сверка, ровно как если бы прогон не опоздал. */
  | { kind: 'plain' }
  /** Сгорел бы лист, которого прогон не звал: дата расчёта сняла с него сегодняшнюю защиту. */
  | { kind: 'extra'; extra: readonly Esm2Period[] }
  /** Выписалась бы неделя, кончившаяся раньше дня расчёта: не работа прогона. */
  | { kind: 'stray'; stray: readonly Esm2Period[] };

/**
 * Разобрать план прогона — до того, как сгорел первый номер.
 *
 * День расчёта, взятый в прошлом, ослабляет замок сверки: лист, отработанный между этим днём и
 * сегодняшним, перестаёт быть неприкосновенным. Ради двухмесячного листа это и делается, но
 * распространяться дальше него не должно ни на строку — поэтому проверяются обе стороны плана.
 *
 * Считается всё пересечением дней (ADR 0142), а не неделей: разрезанные куски живут внутри одной
 * недели, и недельный ключ не отличил бы половину переоформляемого листа от чужой недели.
 */
export function judgeSplit(
  input: Pick<Esm2SyncPlanInput, 'existing' | 'today'>,
  plan: { cancel: readonly string[]; issue: readonly Esm2Period[] },
  /** Двухмесячные листы заявки — те, ради которых прогон и пришёл. */
  staleIds: readonly string[],
): SplitVerdict {
  const extra = input.existing
    .filter((sheet) => plan.cancel.includes(sheet.id) && !staleIds.includes(sheet.id))
    .map((sheet) => ({ from: sheet.periodFrom, to: sheet.periodTo }));
  if (extra.length > 0) return { kind: 'extra', extra };
  const stray = plan.issue.filter((period) => period.to < input.today);
  return stray.length > 0 ? { kind: 'stray', stray } : { kind: 'plain' };
}

const showDays = (periods: readonly Esm2Period[]): string =>
  periods.map((period) => `${period.from}…${period.to}`).join(', ');

/** Почему заявка не тронута — теми же словами и в предпросмотре, и в прогоне. */
function skipReason(verdict: SplitVerdict): string | null {
  if (verdict.kind === 'extra') {
    return `сгорел бы лист, о котором прогон не просил (${showDays(verdict.extra)}) — расчёт по дате листа снял с него защиту сегодняшнего дня; заявку смотрит человек`;
  }
  if (verdict.kind === 'stray') {
    return `выписалась бы неделя раньше дня расчёта (${showDays(verdict.stray)}) — прогон таких недель не заводит`;
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
  const { apply, actor } = parsed;

  let actorId = '';
  if (actor) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, actor));
    if (!user) {
      console.error(`esm2:month-split: учётка «${actor}» не найдена`);
      process.exit(EXIT_FAILURE);
    }
    actorId = user.id;
  }

  const today = moscowDateKeyOf(new Date());
  const targets = await findTargets(today);
  console.log(
    `esm2:month-split: заявок с листом на два месяца — ${targets.length}; режим — ${apply ? 'переоформление' : 'только показать'}`,
  );

  const tally: Tally = { cancelled: 0, issued: 0, skipped: 0 };
  for (const target of targets) {
    if (!apply) {
      // Предпросмотр считает **та же** работа, которая потом и исполнит (`buildEsm2SyncPlan`):
      // отдельный расчёт «сколько бумаги сгорит» разошёлся бы с прогоном на первой же правке.
      const built = await buildEsm2SyncPlan(db, {
        requestId: target.requestId,
        asOf: target.asOf,
        correction: PLANNING_CORRECTION,
      });
      if (!built) continue;
      const verdict = judgeSplit(built.input, built.plan, target.staleIds);
      const skip = skipReason(verdict);
      console.log(
        `  ТС-${target.num}: расчёт на ${target.asOf} — сгорит ${built.plan.cancel.length}, выпишется ${built.plan.issue.length} (${showDays(built.plan.issue)})`,
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
      await lockRequestRow(tx, target.requestId);
      // План пересчитывается уже под блокировкой: между отбором и прогоном заявку могли тронуть
      // руками, и решение обязано опираться на то состояние, которое сейчас правят.
      const built = await buildEsm2SyncPlan(tx, {
        requestId: target.requestId,
        asOf: target.asOf,
        correction: PLANNING_CORRECTION,
      });
      if (!built) return null;
      const verdict = judgeSplit(built.input, built.plan, target.staleIds);
      if (verdict.kind !== 'plain') return { skip: skipReason(verdict)! };
      /*
       * Строка операции — там, где бумага рождается задним числом относительно **сегодняшнего**
       * дня, а не дня расчёта. Разрешения она не даёт (его дала дата листа), но номер, выписанный
       * на уже прошедшие дни, обязан быть объяснён: причина, автор и связь «что заменило что».
       *
       * Заводится она **до** сверки: на неё ссылаются оба листа (`correction_id`), и завести её
       * после значило бы сослаться на то, чего в этот момент не существует.
       */
      const backdated = built.plan.issue.filter((period) => period.to < today);
      const correction =
        backdated.length > 0
          ? await insertCorrection(tx, {
              // Ключ идемпотентности свой на каждую заявку и на каждый запуск: клиента, который
              // повторил бы ту же кнопку, у прогона нет, а повторный запуск целей уже не найдёт —
              // листы к тому времени разрезаны.
              operationId: randomUUID(),
              fingerprint: correctionFingerprint({
                kind: 'esm2',
                target: target.requestId,
                body: { script: 'esm2:month-split', asOf: target.asOf, backdated },
              }),
              kind: 'esm2',
              reason: REASON,
              actorUserId: actorId || target.issuedBy,
            })
          : null;
      const synced = await syncEsm2Waybills(tx, {
        requestId: target.requestId,
        actor: { id: actorId || target.issuedBy },
        reason: REASON,
        asOf: target.asOf,
        ...(correction ? { correction: { id: correction.id, unlockWaybillIds: [] } } : {}),
      });
      if (correction) {
        // «Что делали с этой заявкой задним числом» спрашивают со стороны заявки, и связь операции
        // с ней — единственный ответ (Р16).
        await linkCorrectionRequests(tx, correction.id, [target.requestId]);
        // Снимок «было → стало» (Р16): через месяцы операцию откроют ради вопроса «почему за 31-е
        // выписан отдельный бланк», и ответом обязаны быть номера, а не пересчёт сегодняшних дат.
        await saveCorrectionPayload(tx, correction.id, {
          script: 'esm2:month-split',
          request: { id: target.requestId, num: target.num },
          asOf: target.asOf,
          backdated,
          burned: synced.cancelled,
          issued: synced.issued,
        });
      }
      // Множество листов заявки изменилось — значит отменяемость её бумаги изменилась внутри дня
      // (К4). Метку ставят все двери этого класса.
      if (synced.cancelled.length > 0 || synced.issued.length > 0) {
        await markAssignmentHistoryDirty(tx, target.requestId);
      }
      return { synced, backdated };
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
      `  ТС-${target.num}: расчёт на ${target.asOf} — аннулировано ${outcome.synced.cancelled.length}, выписано ${outcome.synced.issued.length}${
        outcome.backdated.length > 0
          ? ` (задним числом, под операцией — ${showDays(outcome.backdated)})`
          : ''
      }`,
    );
  }

  console.log(
    `esm2:month-split: итого ${apply ? 'аннулировано' : 'сгорит'} ${tally.cancelled}, ${apply ? 'выписано' : 'выпишется'} ${tally.issued}${tally.skipped > 0 ? `, пропущено заявок ${tally.skipped}` : ''}`,
  );
  // Пропуски — не успех: прогон, оставивший заявки нетронутыми, обязан отличаться кодом возврата
  // от прогона, сделавшего всё. Иначе «зелёный» запуск в выкате скроет недоделанное.
  if (tally.skipped > 0) process.exit(EXIT_INCOMPLETE);
}

/*
 * Прогон идёт только при запуске из командной строки: сам вердикт (`judgeSplit`) импортирует
 * db-тест — он проверяет его на собранной сцене, где переходной лист уже наполовину в прошлом.
 * Прогон при импорте жёг бы номера прямо под тестом, который их в это время читает.
 */
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  await main();
  process.exit(0);
}
