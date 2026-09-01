import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  esm2Periods,
  monthEndKey,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type Esm2Period,
} from '@technic/contracts';
import { describeReadModes, useReadModeDatabase } from './assignment-read-mode';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as Esm2 from '../src/services/waybill-esm2';
import type * as Split from '../scripts/esm2-month-split';

/**
 * Месячный разрез недельного листа ЭСМ-2 (ADR 0142, план `docs/esm2-month-split-plan.md`).
 *
 * Зачем база. Правило разреза — чистая функция, и она проверена юнит-тестами. Здесь проверяется
 * то, чего на правилах не воспроизвести: что сверка **и правда** выписывает по такому сроку два
 * бланка разными номерами, что вторая её попытка не жжёт третий, что уже выписанный лист «на два
 * месяца» переоформляется парой — и что в снимке каждого бланка стоят числа только своих дней.
 *
 * ЭСМ2-РАЗРЕЗ. Файл — про сам разрез, и оба режима чтения обязаны давать по нему одно и то же:
 * границы считает общий `esm2Periods`, которым режут и недельная сверка, и отрезковый план. Два
 * прогона стоят именно ради этого утверждения — «переключение чтения месячный разрез не сдвинет».
 *
 * Календарь сцены считается от сегодняшнего дня: берётся ближайшая **будущая** неделя, внутри
 * которой кончается месяц. Прошедшую сверка не выписывает вовсе (ADR 0101), и на фиксированных
 * датах файл зеленел бы ровно до конца того месяца, в котором его написали.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/esm2-month-split.db.test.ts
 */

/** Своя база и режим чтения на ней: режим живёт в управляющей строке, одной на базу. */
const readMode = useReadModeDatabase('monthsplit');

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

const TODAY = moscowDateKeyOf(new Date());

/**
 * Ближайшая будущая неделя, в середине которой кончается месяц, — срок сцены.
 *
 * Ищется перебором, а не арифметикой по номеру месяца: «последний день месяца» и «воскресенье»
 * ходят по календарю независимо, и неделя, целиком лежащая в одном месяце, законно встречается
 * подряд несколько раз (например, когда 31-е выпадает на воскресенье).
 */
function crossingWeek(): { monday: string; sunday: string } {
  let monday = shiftDateKey(weekStartKey(TODAY), 7);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const sunday = shiftDateKey(monday, 6);
    if (monthEndKey(monday) < sunday) return { monday, sunday };
    monday = shiftDateKey(monday, 7);
  }
  throw new Error('за двенадцать недель вперёд не нашлось недели с концом месяца внутри');
}

const { monday: TERM_FROM, sunday: TERM_TO } = crossingWeek();
/** Последний день месяца внутри срока — вторая граница листа, ради которой всё и затевалось. */
const MONTH_END = monthEndKey(TERM_FROM);
/**
 * Первый день нового месяца — им сцена изображает опоздавший прогон (Э6).
 *
 * Календарь сцены будущий, а проверить надо поведение **после** границы: в этот день первая
 * половина недели уже отработана, а вторая ещё идёт. Даты сцены ради этого не сдвигаются — сверке
 * передаётся `asOf`, тот же ключ, которым её зовут статусная ручка и сам прогон.
 */
const NEXT_MONTH_DAY = shiftDateKey(MONTH_END, 1);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  esm2: typeof Esm2;
  /** Разовый прогон переоформления: из него берётся вердикт о заднем ходе (Э6). */
  split: typeof Split;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  const { db, closeDb } = await import('../src/db/client');
  ctx = {
    db,
    closeDb,
    esm2: await import('../src/services/waybill-esm2'),
    // Импорт прогона ничего не запускает: сам прогон идёт только из командной строки.
    split: await import('../scripts/esm2-month-split'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

interface Scene {
  requestId: string;
  userId: string;
  vehicleId: string;
  personId: string;
}

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

interface SheetRow {
  id: string;
  status: string;
  period_from: string;
  period_to: string;
  number: string;
  data: Record<string, string>;
}

/** Листы заявки в порядке периода: сгоревшие видны наравне с действующими. */
async function sheetsOf(tx: SceneTx, requestId: string): Promise<SheetRow[]> {
  const res = await tx.execute<SheetRow>(sql`
    SELECT id, status, period_from::text, period_to::text, number::text, data
      FROM waybills WHERE source_request_id = ${requestId}
     ORDER BY period_from, issued_at`);
  return res.rows;
}

const liveOf = (rows: readonly SheetRow[]): SheetRow[] =>
  rows.filter((row) => row.status !== 'cancelled');

/**
 * Заказ спецтехники в работе на срок «неделя с концом месяца внутри», без единого листа.
 *
 * Бумагу заводит уже сам случай: предмет файла — как её выписывают, и выписка в декорациях сцены
 * скрыла бы ровно то, что проверяется.
 */
async function inScene<T>(run: (tx: SceneTx, scene: Scene) => Promise<T>): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<Record<string, string>> => {
        const [row] = (await tx.execute<Record<string, string>>(q)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const vehicle = await one(sql`
        SELECT id, vehicle_type_id FROM vehicles
         WHERE deleted_at IS NULL AND ownership = 'own' ORDER BY id LIMIT 1`);
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`esm2-split-${RUN}@example.invalid`}, 'Разрезов', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const spec = await one(sql`SELECT id FROM specializations WHERE code = 'driver'`);
      // Человека без действующей специализации водителя `findMachinist` не отдаёт вовсе, и сверка
      // ответила бы «укажите машиниста» вместо бумаги.
      const person = await one(
        sql`INSERT INTO persons (last_name, first_name) VALUES ('Машинистов', 'Пров') RETURNING id`,
      );
      await tx.execute(sql`
        INSERT INTO person_specializations (person_id, specialization_id, started_on)
        VALUES (${person.id}, ${spec.id}, ${shiftDateKey(TERM_FROM, -400)})`);

      const request = await one(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                      assignment_history_state, assignment_history_validated_on)
        VALUES ('special_equipment', ${obj.id}, ${vehicle.vehicle_type_id}, 'confirmed',
                ${user.id}, 'materialized', ${TODAY})
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${request.id}, ${TERM_FROM}, ${TERM_TO})`);
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        VALUES (${request.id}, ${vehicle.id}, ${vehicle.vehicle_type_id},
                ${vehicle.vehicle_type_id}, ${user.id})`);

      // История, какой её оставил бы бэкфилл: машина и человек с начала срока. Без неё отрезковый
      // план не знал бы состава, и половина прогонов проверяла бы отказ вместо бумаги.
      for (const change of [
        { dimension: 'vehicle', vehicleId: vehicle.id, driverPersonId: null, state: null },
        { dimension: 'driver', vehicleId: null, driverPersonId: person.id, state: 'set' },
      ]) {
        await tx.execute(sql`
          INSERT INTO vehicle_request_assignment_changes
            (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state,
             origin, change_group_id)
          VALUES (${request.id}, ${TERM_FROM}, ${change.dimension}, ${change.vehicleId},
                  ${change.driverPersonId}, ${change.state}, 'assignment', ${randomUUID()})`);
      }

      out = await run(tx, {
        requestId: request.id!,
        userId: user.id!,
        vehicleId: vehicle.id!,
        personId: person.id!,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

/** Сверка бумаги заявки — единственная дверь, которой файл пользуется. */
function sync(
  tx: SceneTx,
  scene: Scene,
  reason: string,
  /** День расчёта и проверенная операция — ими сцена изображает опоздавший прогон. */
  as?: { asOf?: string; correctionId?: string },
): Promise<Esm2.Esm2SyncResult> {
  return ctx.esm2.syncEsm2Waybills(tx, {
    requestId: scene.requestId,
    actor: { id: scene.userId },
    reason,
    driverPersonId: scene.personId,
    asOf: as?.asOf ?? TODAY,
    ...(as?.correctionId ? { correction: { id: as.correctionId, unlockWaybillIds: [] } } : {}),
  });
}

/**
 * Бумага, выписанная прежним правилом: один лист на всю переходную неделю.
 *
 * Собирается из настоящей выписки, а не вставкой строки: у листа полтора десятка граф снимка, и
 * сцена, написанная руками, проверяла бы переоформление бланка, которого портал не выписывал.
 * Возвращает id того самого листа «на два месяца».
 */
async function staleSheet(tx: SceneTx, scene: Scene): Promise<string> {
  await sync(tx, scene, 'перевод заявки в работу');
  const [first, second] = liveOf(await sheetsOf(tx, scene.requestId));
  await tx.execute(sql`
    UPDATE waybills SET status = 'cancelled', cancelled_at = now(),
                        cancel_reason = 'сцена теста: бумага прежнего разреза'
     WHERE id = ${second!.id}`);
  await tx.execute(sql`
    UPDATE waybills SET period_to = ${TERM_TO}::date WHERE id = ${first!.id}`);
  return first!.id;
}

/** Строка операции коррекции — та, что заводит прогон, получив `--backdate`. */
async function correctionRow(tx: SceneTx, scene: Scene): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`
    INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id)
    VALUES (${randomUUID()}, ${randomUUID()}, 'esm2',
            'Разрез листа ЭСМ-2 границей месяца (ADR 0142)', ${scene.userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** План прогона: тот же вход, что считает и предпросмотр прогона, и его исполнение. */
async function splitPlan(
  tx: SceneTx,
  scene: Scene,
  asOf: string,
): Promise<{ input: Esm2.Esm2SyncPlanInput; plan: { cancel: string[]; issue: Esm2Period[] } }> {
  const built = await ctx.esm2.buildEsm2SyncPlan(tx, {
    requestId: scene.requestId,
    driverPersonId: scene.personId,
    asOf,
    // Тот же планировочный контекст, что и у прогона: задний ход в расчёте разрешён, названных
    // листов нет — отработанное прошлое остаётся неприкосновенным.
    correction: { id: '', unlockWaybillIds: [] },
  });
  return built!;
}

describeReadModes(readMode, 'месячный разрез листа ЭСМ-2 (ADR 0142)', () => {
  it('неделя с концом месяца внутри закрывается двумя листами, а не одним', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      const result = await sync(tx, scene, 'перевод заявки в работу');
      expect(result.cancelled).toEqual([]);
      expect(result.issued).toHaveLength(2);

      const live = liveOf(await sheetsOf(tx, scene.requestId));
      expect(live.map((row) => `${row.period_from}..${row.period_to}`)).toEqual([
        `${TERM_FROM}..${MONTH_END}`,
        `${shiftDateKey(MONTH_END, 1)}..${TERM_TO}`,
      ]);
      // Номера разные: это два бланка строгой отчётности, а не один документ, показанный дважды.
      expect(new Set(live.map((row) => row.number)).size).toBe(2);
      // Границы, которые считает разрез, и границы записанных листов — одно и то же.
      expect(live.map((row) => ({ from: row.period_from, to: row.period_to }))).toEqual(
        esm2Periods(TERM_FROM, TERM_TO),
      );
    });
  });

  it('графа «месяца» у каждого листа одна, и числа дней печатаются только свои', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      await sync(tx, scene, 'перевод заявки в работу');
      const [august, september] = liveOf(await sheetsOf(tx, scene.requestId));

      // Прежде у переходной недели в графе стояли оба номера через тире («08–09»); разрез снял
      // сам случай, и в каждом бланке теперь месяц один.
      expect(august!.data.period_month).toBe(TERM_FROM.slice(5, 7));
      expect(september!.data.period_month).toBe(TERM_TO.slice(5, 7));

      /*
       * Числа дней. Строки «пн…вс» впечатаны в бланк и остаются семью, но число стоит только у
       * своего дня: у двух листов одной недели сетка чисел совпала бы полностью, и часы 1-го
       * числа заказчик вписал бы в бланк прошлого месяца.
       */
      const days = (row: SheetRow): string[] =>
        [1, 2, 3, 4, 5, 6, 7].map((index) => row.data[`day${index}_date`] ?? '');
      const filled = (row: SheetRow): number => days(row).filter((value) => value !== '').length;
      expect(filled(august!) + filled(september!)).toBe(7);
      expect(filled(august!)).toBe(
        Number(MONTH_END.slice(8, 10)) - Number(TERM_FROM.slice(8, 10)) + 1,
      );
      // Пересечения нет: день напечатан ровно в одном из двух бланков.
      expect(
        days(august!).filter((value, index) => value !== '' && days(september!)[index] !== ''),
      ).toEqual([]);
    });
  });

  it('вторая сверка того же срока номеров не жжёт: разрез идемпотентен', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      await sync(tx, scene, 'перевод заявки в работу');
      const before = await sheetsOf(tx, scene.requestId);

      const again = await sync(tx, scene, 'повторная сверка');
      expect(again).toEqual({ cancelled: [], issued: [] });
      expect(await sheetsOf(tx, scene.requestId)).toEqual(before);
    });
  });

  it('лист, выписанный на два месяца до разреза, переоформляется парой', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      // Так выглядит бумага, выписанная прежним правилом: один лист на всю переходную неделю.
      // Ровно её и переоформляет разовый прогон `scripts/esm2-month-split.ts` после выката.
      const staleId = await staleSheet(tx, scene);
      const stale = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM waybills
         WHERE source_request_id = ${scene.requestId} AND status <> 'cancelled'
           AND substr(period_from::text, 1, 7) <> substr(period_to::text, 1, 7)`);
      // Отбор прогона видит ровно такой лист — тем же условием, каким он написан в скрипте.
      expect(stale.rows[0]!.n).toBe('1');

      const result = await sync(tx, scene, 'разрез листа ЭСМ-2 границей месяца (ADR 0142)');
      // Номера в ответе печатные, с ведущими нулями серии; сравнивается поэтому не строка, а сам
      // факт: сгорел ровно один лист — тот, что покрывал два месяца, — и взамен вышли два.
      expect(result.cancelled).toHaveLength(1);
      expect(result.issued).toHaveLength(2);

      const live = liveOf(await sheetsOf(tx, scene.requestId));
      expect(live.map((row) => `${row.period_from}..${row.period_to}`)).toEqual([
        `${TERM_FROM}..${MONTH_END}`,
        `${shiftDateKey(MONTH_END, 1)}..${TERM_TO}`,
      ]);
      // Прежний номер сгорел и объяснён причиной: бланк строгой отчётности не правят, а списывают.
      const burned = (await sheetsOf(tx, scene.requestId)).find((row) => row.id === staleId);
      expect(burned?.status).toBe('cancelled');
    });
  });

  /*
   * ОПОЗДАВШИЙ ПРОГОН (Э6). Переоформление писалось под запуск до конца месяца, когда обе половины
   * недели ещё впереди. Запущенное после границы, оно встречает лист, у которого первая половина
   * уже отработана, — и вот что из этого следует.
   */
  it('прогон считает по датам листа: сегодняшний день выписал бы одну половину, дата листа — обе', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      const staleId = await staleSheet(tx, scene);

      /*
       * Два плана на одну и ту же бумагу — вся разница в дне расчёта.
       *
       * Сегодняшним днём (первое число нового месяца) первая половина недели уже кончилась:
       * обычная сверка её не выпишет вовсе (ADR 0101, Р21), а прогон, посчитанный на этот день,
       * отказывается от заявки — выписывать неделю раньше дня расчёта не его работа. Днём начала
       * самого листа обе половины выписываются обычным порядком: в той точке времени вся неделя
       * ещё впереди. Ровно поэтому прогон считает по датам листа, а не по календарю запуска.
       */
      const late = await splitPlan(tx, scene, NEXT_MONTH_DAY);
      expect(ctx.split.judgeSplit(late.input, late.plan, [staleId])).toEqual({
        kind: 'stray',
        stray: [{ from: TERM_FROM, to: MONTH_END }],
      });

      const onSheetDates = await splitPlan(tx, scene, TERM_FROM);
      expect(onSheetDates.plan.issue).toEqual([
        { from: TERM_FROM, to: MONTH_END },
        { from: NEXT_MONTH_DAY, to: TERM_TO },
      ]);
      expect(onSheetDates.plan.cancel).toEqual([staleId]);
      // И этот план прогон исполняет целиком: чужого листа в нём не горит, недель раньше дня
      // расчёта не выписывается.
      expect(ctx.split.judgeSplit(onSheetDates.input, onSheetDates.plan, [staleId])).toEqual({
        kind: 'plain',
      });

      // А вот что случилось бы, тронь заявку обычная дверь сегодняшним днём.
      const result = await sync(tx, scene, 'касание заявки после границы месяца', {
        asOf: NEXT_MONTH_DAY,
      });
      expect(result.cancelled).toHaveLength(1);
      // Лист сгорел, а выписан один — сентябрьский: дни до границы остались бы без документа.
      // Это не гипотеза о прогоне, а то, что делает **любая** дверь, тронувшая такую заявку.
      expect(result.issued).toHaveLength(1);
      const live = liveOf(await sheetsOf(tx, scene.requestId));
      expect(live.map((row) => `${row.period_from}..${row.period_to}`)).toEqual([
        `${NEXT_MONTH_DAY}..${TERM_TO}`,
      ]);
    });
  });

  it('под строкой операции обе половины выписываются одним номером за раз и объяснены', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      const staleId = await staleSheet(tx, scene);
      const correctionId = await correctionRow(tx, scene);

      const result = await sync(tx, scene, 'разрез листа ЭСМ-2 границей месяца (ADR 0142)', {
        asOf: NEXT_MONTH_DAY,
        correctionId,
      });
      expect(result.cancelled).toHaveLength(1);
      expect(result.issued).toHaveLength(2);

      const rows = await sheetsOf(tx, scene.requestId);
      const live = liveOf(rows);
      expect(live.map((row) => `${row.period_from}..${row.period_to}`)).toEqual([
        `${TERM_FROM}..${MONTH_END}`,
        `${NEXT_MONTH_DAY}..${TERM_TO}`,
      ]);
      expect(rows.find((row) => row.id === staleId)?.status).toBe('cancelled');

      /*
       * Разрыв нумерации за прошедшие дни объяснён, а не подразумевается: оба новых номера
       * сослались на операцию, и её причина стоит в каждом. Без этого журнал строгой отчётности
       * не отвечает, почему за уже отработанный день выписан новый бланк.
       *
       * Заменой сгоревшему объявляет себя только первый: связь «заменил» одна на номер
       * (`waybills_corrects_unique`), и два листа, названные заменой одного, ей противоречат.
       * Общее у пары — операция, и через неё второй бланк и находится.
       */
      const links = await tx.execute<{
        correction_id: string;
        corrects: string;
        correction_reason: string;
      }>(sql`
        SELECT correction_id::text, coalesce(corrects_waybill_id::text, '') AS corrects,
               correction_reason
          FROM waybills WHERE source_request_id = ${scene.requestId} AND status <> 'cancelled'
         ORDER BY period_from`);
      expect(links.rows.map((row) => row.correction_id)).toEqual([correctionId, correctionId]);
      expect(links.rows.map((row) => row.corrects)).toEqual([staleId, '']);
      expect(links.rows.every((row) => row.correction_reason.trim() !== '')).toBe(true);
    });
  });

  it('вердикт прогона: чужой лист не горит, чужая неделя не выписывается', async () => {
    if (!readMode.enabled) return;
    const asOf = '2026-08-31';
    const stale = {
      id: 'w1',
      periodFrom: '2026-08-31',
      periodTo: '2026-09-06',
      vehicleId: 'v1',
      driverPersonId: 'd1',
    };
    const neighbour = { ...stale, id: 'w0', periodFrom: '2026-08-24', periodTo: '2026-08-30' };

    // Обе половины своего листа, посчитанные на его же дату, — работа прогона.
    expect(
      ctx.split.judgeSplit(
        { existing: [stale], today: asOf },
        {
          cancel: ['w1'],
          issue: [
            { from: '2026-08-31', to: '2026-08-31' },
            { from: '2026-09-01', to: '2026-09-06' },
          ],
        },
        ['w1'],
      ),
    ).toEqual({ kind: 'plain' });

    /*
     * Лист прошлой недели сегодняшний день защитил бы замком, а дата расчёта — уже нет. Прогон
     * пришёл не за ним: заявка пропускается целиком, а не переоформляется наполовину.
     */
    expect(
      ctx.split.judgeSplit(
        { existing: [stale, neighbour], today: asOf },
        {
          cancel: ['w1', 'w0'],
          issue: [
            { from: '2026-08-31', to: '2026-08-31' },
            { from: '2026-09-01', to: '2026-09-06' },
          ],
        },
        ['w1'],
      ),
    ).toEqual({ kind: 'extra', extra: [{ from: '2026-08-24', to: '2026-08-30' }] });

    // Неделя, кончившаяся раньше дня расчёта, — не его работа: бумагу за неё заводят руками.
    expect(
      ctx.split.judgeSplit(
        { existing: [stale], today: asOf },
        {
          cancel: ['w1'],
          issue: [
            { from: '2026-08-24', to: '2026-08-30' },
            { from: '2026-08-31', to: '2026-08-31' },
          ],
        },
        ['w1'],
      ).kind,
    ).toBe('stray');
  });
});
