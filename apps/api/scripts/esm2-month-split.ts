import { and, eq, ne, sql } from 'drizzle-orm';
import { moscowDateKeyOf } from '@technic/contracts';
import { db } from '../src/db/client';
import { users, vehicleRequests, waybills } from '../src/db/schema';
import { requireOpenDoor } from '../src/services/assignment-mode';
import { markAssignmentHistoryDirty } from '../src/services/assignment-dirty';
import { lockRequestRow } from '../src/services/vehicle-routes';
import { buildEsm2SyncPlan, syncEsm2Waybills } from '../src/services/waybill-esm2';

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
 * ЧЕГО ОН НЕ ДЕЛАЕТ — НЕ ТРОГАЕТ ПРОШЛОЕ. Отработанный лист защищён замком сверки
 * (`canCancelWaybill`), и снимается замок только коррекцией — с правом, причиной и записью в
 * журнале. Контекста коррекции скрипт не собирает намеренно: работа тех дней состоялась, заказчик
 * заполнил оборот, и переписывать её задним числом ради нового разреза нельзя. В отбор поэтому
 * идут только заявки, у которых переходной лист **ещё не отработан** (`period_to >= сегодня`).
 *
 * КЕМ ПОДПИСАНЫ НОМЕРА. Сгоревший и выписанный бланк подписываются учёткой, названной `--actor`:
 * «система» в журнале учёта строгой отчётности не отвечает на вопрос «кто сжёг номер». Запускать
 * поэтому от того, кто за выкат отвечает.
 *
 * Использование:
 *   pnpm --filter @technic/api esm2:month-split -- --actor admin@example.ru          # что будет
 *   pnpm --filter @technic/api esm2:month-split -- --actor admin@example.ru --apply  # переоформить
 */

const EXIT_FAILURE = 1;
const REASON = 'Разрез листа ЭСМ-2 границей месяца (ADR 0142)';

interface Options {
  apply: boolean;
  actor: string;
}

function parseArgs(argv: readonly string[]): Options | string {
  let apply = false;
  let actor = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Разделитель `pnpm run … -- --actor …` доезжает до `argv` как отдельное слово: команду
    // запускают через pnpm, и спотыкаться о собственный способ запуска скрипт не должен.
    if (arg === '--') continue;
    if (arg === '--apply') apply = true;
    else if (arg === '--actor') {
      actor = argv[i + 1] ?? '';
      i += 1;
    } else return `неизвестный аргумент «${arg}»`;
  }
  if (!actor) return 'не указан --actor <email>: номера бланков подписывает человек, а не система';
  return { apply, actor };
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

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`esm2:month-split: ${parsed}`);
    process.exit(EXIT_FAILURE);
  }
  const { apply, actor } = parsed;

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, actor));
  if (!user) {
    console.error(`esm2:month-split: учётка «${actor}» не найдена`);
    process.exit(EXIT_FAILURE);
  }

  const today = moscowDateKeyOf(new Date());
  const targets = await findTargets(today);
  console.log(
    `esm2:month-split: заявок с листом на два месяца — ${targets.length}; режим — ${apply ? 'переоформление' : 'только показать'}`,
  );

  let cancelled = 0;
  let issued = 0;
  for (const target of targets) {
    if (!apply) {
      // Предпросмотр считает **та же** работа, которая потом и исполнит (`buildEsm2SyncPlan`):
      // отдельный расчёт «сколько бумаги сгорит» разошёлся бы с прогоном на первой же правке.
      const built = await buildEsm2SyncPlan(db, { requestId: target.id, asOf: today });
      const plan = built?.plan ?? { cancel: [], issue: [] };
      console.log(
        `  ТС-${target.num}: сгорит ${plan.cancel.length}, выпишется ${plan.issue.length} — ${plan.issue
          .map((p) => `${p.from}…${p.to}`)
          .join(', ')}`,
      );
      cancelled += plan.cancel.length;
      issued += plan.issue.length;
      continue;
    }
    const result = await db.transaction(async (tx) => {
      // Порядок и класс двери — как у ручной выписки (`history_free`, план Л3): сперва гейт
      // режима, затем строка заявки, и только потом бумага. Встречный порядок «листы → заявка»
      // стал бы взаимной блокировкой с командами истории.
      await requireOpenDoor(tx, 'history_free');
      await lockRequestRow(tx, target.id);
      const synced = await syncEsm2Waybills(tx, {
        requestId: target.id,
        actor: { id: user.id },
        reason: REASON,
        asOf: today,
      });
      // Множество листов заявки изменилось — значит отменяемость её бумаги изменилась внутри дня
      // (К4). Метку ставят все двери этого класса.
      if (synced.cancelled.length > 0 || synced.issued.length > 0) {
        await markAssignmentHistoryDirty(tx, target.id);
      }
      return synced;
    });
    cancelled += result.cancelled.length;
    issued += result.issued.length;
    console.log(
      `  ТС-${target.num}: аннулировано ${result.cancelled.length}, выписано ${result.issued.length}`,
    );
  }

  console.log(
    `esm2:month-split: итого ${apply ? 'аннулировано' : 'сгорит'} ${cancelled}, ${apply ? 'выписано' : 'выпишется'} ${issued}`,
  );
}

await main();
process.exit(0);
