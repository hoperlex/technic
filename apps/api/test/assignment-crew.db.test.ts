import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  esm2Periods,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type AccessSubject,
  type AssignmentCommandInput,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentCrew from '../src/services/assignment-crew';
import type * as AssignmentWrite from '../src/services/assignment-write';
import type * as Esm2 from '../src/services/waybill-esm2';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА, И ОН ЕЁ ЗАВОДИТ САМ. Каждая команда здесь берёт управляющую строку модуля
 * `FOR SHARE` (шаг 0 канона), а соседние файлы модуля эту же строку меняют и замораживают (план
 * Ю27, Ю30); сам этот файл её теперь тоже двигает — блок «границы этапа 3» идёт двумя прогонами.
 * Раньше требование стояло здесь просьбой к запускающему; теперь база выводится из
 * `TEST_DATABASE_URL` и создаётся механикой ([assignment-read-mode.ts](assignment-read-mode.ts)).
 */

/**
 * Команда машиниста — первая боевая дверь истории назначения
 * ([assignment-crew.ts](../src/services/assignment-crew.ts),
 * [vehicle-request-assignment.ts](../src/routes/vehicle-request-assignment.ts); план
 * `docs/assignment-periods-plan.md`, Р11–Р13, Р16, Р19, Р24, Р32, §8).
 *
 * ЗАЧЕМ БАЗА. Предмет здесь — не форма запроса, а сцепка четырёх механик, каждая из которых живёт
 * в своей таблице и ни одна не воспроизводится на объектах в памяти:
 *
 * 1. **история как источник истины** — неизменяемые строки `vehicle_request_assignment_changes` с
 *    их частичными UNIQUE и составным FK замены (миграция `0166`);
 * 2. **бумага** — недельные листы ЭСМ-2 с расходом номеров и границей отменяемости: то, что
 *    команда обязана переоформить, и то, что обязана оставить нетронутым;
 * 3. **журнал коррекций** с ключом идемпотентности и снимком авторизации (миграция `0129`);
 * 4. **гейт совместимости** этапа 3 (Б1, В3, Д1): старый недельный план и новый отрезковый
 *    считаются под одной блокировкой и обязаны совпасть — иначе история разошлась бы с бумагой
 *    молча.
 *
 * ПОЧЕМУ ДЕНЬ РАСЧЁТА ФИКСИРОВАН. `asOf` уходит в команду аргументом — рабочий день внутри текущей
 * недели, обычно среда (`AS_OF`), — и это не удобство: исход команды (Р32), граница отменяемости
 * листа и изменяемая область (Р21) считаются по нему, и прогон, взявший «сегодня» из часов, менял
 * бы смысл половины случаев в зависимости от дня недели. Сам день при этом не написан цифрой, а
 * подобран календарём — почему именно так, развёрнуто сказано над его определением.
 *
 * ПОЧЕМУ СЦЕНА ЖИВЁТ В ОТКАТЫВАЕМОЙ ТРАНЗАКЦИИ, А КОМАНДА — В ЕЁ SAVEPOINT. База у db-тестов общая,
 * и оставленные заявка, люди и сожжённые номера бланков испортили бы соседние файлы. Каркас при
 * этом обязан идти в **настоящей** транзакции — иначе проверять откат было бы нечем, — поэтому
 * исполнителем ему отдаётся вложенная транзакция сцены: drizzle разворачивает её в `SAVEPOINT`.
 *
 * Запуск (база из переменной может быть любой — своя всё равно заводится рядом и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-crew.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

/**
 * Своя база и режим чтения на ней — одной строкой. Стоит до собственного `beforeAll` файла
 * намеренно: механика регистрирует свой хук первым и потому успевает выставить `DATABASE_URL` до
 * того, как файл импортирует клиента.
 */
const readMode = useReadModeDatabase('crew');

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

// ── Календарь сцены ──
//
// Всё считается от понедельника текущей недели, а день расчёта подбирается внутри неё (`AS_OF`
// ниже): так у сцены есть и отработанная неделя (прошлая), и ещё не кончившаяся (текущая), и
// предстоящая (следующая).

const MONDAY = weekStartKey(moscowDateKeyOf(new Date()));
/** Понедельник прошлой недели: с него идёт срок, и её лист ко дню расчёта уже отработан. */
const PREV = shiftDateKey(MONDAY, -7);
/** Понедельник следующей недели. */
const NEXT = shiftDateKey(MONDAY, 7);
const TERM_FROM = PREV;
const TERM_TO = shiftDateKey(NEXT, 6);
/**
 * Периоды бумаги срока — тем же расчётом, каким режет портал (`esm2Periods`).
 *
 * Считаются, а не перечисляются тремя понедельниками: лист режет не только воскресенье, но и конец
 * месяца (ADR 0142), и в последнюю неделю месяца тот же срок даёт четыре документа вместо трёх.
 * Числа, записанные цифрой, зеленели бы три недели из четырёх и краснели бы в последнюю — без
 * всякой правки кода.
 */
const TERM_PERIODS = esm2Periods(TERM_FROM, TERM_TO);
/** Сколько листов у нетронутого срока: им меряется «бумага осталась как была». */
const TERM_SHEETS = TERM_PERIODS.length;
/** Период листа, внутрь которого попадает день срока: у любого дня он ровно один (ADR 0142). */
const periodOf = (day: string): { from: string; to: string } | undefined =>
  TERM_PERIODS.find((period) => period.from <= day && day <= period.to);
/**
 * День расчёта команды — среда текущей недели, а если среда не годится, ближайший следующий день,
 * который годится. Годность здесь одна: период листа, внутрь которого попал день, обязан
 * **начинаться строго раньше** него самого.
 *
 * ЗАЧЕМ ЭТО УСЛОВИЕ. На нём стоит посылка половины файла: внутри текущей недели есть уже
 * отработанные дни, до которых плановая команда (её дата — следующий понедельник) сама не
 * дотягивается, и открывает их только якорь — оттого команда и становится коррекцией (Р32), оттого
 * менеджеру 403, а якорю на любую другую дату — 422. Отработанные дни недели — это ровно те, что
 * лежат между началом периода и днём расчёта: раньше начала периода лист закрыт и заперт целиком
 * (`canCancelWaybill`, Р21), а с самого дня расчёта начинается будущее, где коррекции нет вовсе.
 * Совпади начало периода с днём расчёта — таких дней ноль, изменяемая область открывается ровно
 * сегодня, портал честно отвечает `operationRequirement = none`, и неисполнимой оказывается сама
 * посылка сцены, а не портал.
 *
 * ПОЧЕМУ ДЕНЬ СЧИТАЕТСЯ, А НЕ ПИШЕТСЯ ЦИФРОЙ. Пока лист был всегда недельным, «понедельник + 2»
 * условию удовлетворял всегда: период недели начинался в понедельник, среда шла третьим днём, и
 * два отработанных дня были у сцены в любую неделю года. Месячный разрез (ADR 0142) это сломал:
 * когда первое число месяца попадает ровно на среду, неделя даёт «пн–вт» и «ср–вс» — первый кусок
 * к среде отработан и заперт, а второй только открывается, и открывается он тем же днём, что и
 * расчёт. Зафиксированная цифра `2` красила бы набор около сорока дней из 1095 (две недели в году:
 * 12 дней в 2025-м, по 14 в 2026-м и 2027-м) — и красила бы не за дело. Падало бы при этом не три
 * проверки, а пять: обе фазы предпросмотра, боевая команда с якорем, 403 менеджеру и — в `legacy` —
 * разрез недели пополам, которому в такой день резать нечего, потому что день расчёта оказывается
 * точной границей листа. Ещё одна, «чужой якорь отвергается», перестала бы проверять чужой якорь:
 * предпросмотр как раз этот день и назвал бы. Пропуском такие дни закрывать нельзя — покрытие не
 * должно теряться ни в один день года, — поэтому двигается день расчёта, а не набор.
 *
 * ПОЧЕМУ ПЕРЕБОР ИДЁТ ОТ СРЕДЫ ВВЕРХ, А НЕ ОТ ВТОРНИКА. Условию удовлетворяет и вторник, но среда —
 * тот день, вокруг которого написан весь файл: два отработанных дня текущей недели, четыре
 * предстоящих и целая неделя впереди. Перебор со вторника сменил бы день расчёта во **все** 1095
 * дней ради сорока и оставил бы текущей неделе один отработанный день вместо двух — то есть
 * заплатил бы постоянным обеднением сцены за редкий случай. Перебор от среды трогает ровно те дни,
 * ради которых заведён: 1055 дней трёхлетия он оставляет прежнюю среду, 40 — переносит на четверг.
 * Дальше четверга он не уходит никогда: месячная граница внутри недели бывает только одна, поэтому
 * годным оказывается либо первый кандидат, либо следующий за ним.
 *
 * ВОСКРЕСЕНЬЕ В ПЕРЕБОРЕ НЕДОСТИЖИМО, но записано: перебор обязан кончаться внутри текущей недели.
 * День расчёта, ушедший на следующий понедельник, сравнялся бы с `NEXT` — плановой датой всех
 * команд файла, — и «плановая смена будущей датой» перестала бы быть будущей.
 */
const AS_OF = ((): string => {
  for (let offset = 2; offset <= 6; offset += 1) {
    const day = shiftDateKey(MONDAY, offset);
    const period = periodOf(day);
    if (period && period.from < day) return day;
  }
  throw new Error('в текущей неделе не нашлось дня, у которого период листа начался бы раньше');
})();
/**
 * Периоды, начинающиеся не раньше дня, — вся бумага срока от этой даты и до его конца.
 *
 * Отбор отвечает на вопрос «что тут вообще лежит», а не «до чего команда дотягивается»: годится он
 * там, где команда сама открывает себе прошлое — называет запертые листы разблокировкой и
 * выписывает их заново под правом и причиной (ADR 0101, Р11). Такой команде отработанность не
 * преграда, и лишнее условие отняло бы у неё документы, которые она законно жжёт.
 */
const periodsFrom = (day: string): { from: string; to: string }[] =>
  TERM_PERIODS.filter((period) => period.from >= day);
/**
 * Периоды, которые команда с днём расчёта `AS_OF` ещё **может** переоформить: начинаются не раньше
 * дня и не кончились к этому дню.
 *
 * Второго условия и не хватает `periodsFrom`. Отработанный лист неприкосновенен (ADR 0101, Р21):
 * сверка его не гасит и второго документа на его дни не выписывает — работа тех дней состоялась,
 * заказчик заполнил оборот. Пока лист был всегда недельным, разницы между двумя отборами не
 * существовало: понедельник текущей недели всегда лежал в периоде, который ещё не кончился, и
 * «периоды с понедельника» совпадали с «периодами, до которых команда дотягивается» дословно.
 *
 * Месячный разрез (ADR 0142) эти два множества развёл. В переходную неделю срок даёт односуточный
 * кусок «31–31 августа», и ко дню расчёта он уже прошлое: `periodsFrom(MONDAY)` называет
 * три периода, а команда переоформляет два. Портал здесь прав, а отбор, спрашивающий только про
 * начало периода, — нет.
 *
 * Почему отборов всё-таки два, а не один общий: они отвечают на разные вопросы, и подменить один
 * другим нельзя ни в какую сторону. Команда, чья дата сама лежит в прошлом, прошлое себе открывает
 * — ей нужен `periodsFrom`; команда, которая прошлого не трогает (плановая дата, якорь внутри
 * изменяемой области), ограничена этой границей — ей нужен `reissuableFrom`. Один отбор на оба
 * случая либо потребовал бы от портала выписки в прошлое без права, либо отнял бы у коррекции её
 * законную работу.
 */
const reissuableFrom = (day: string): { from: string; to: string }[] =>
  periodsFrom(day).filter((period) => period.to >= AS_OF);
/**
 * Первый день, до которого команда дотягивается, не открывая прошлого, — он же дата якоря (Р16).
 *
 * Считается началом первого ещё не кончившегося периода, а не понедельником: изменяемая область
 * портал считает по самим листам (`canCancelWaybill`, Р21), и в переходную неделю отработанный
 * кусок «31–31 августа» отрезает от неё понедельник — имя спрашивается с первого сентября. В
 * обычную неделю оба ответа совпадают дословно: период, внутрь которого попал день расчёта,
 * начинается в понедельник.
 *
 * Строго раньше `AS_OF` этот день лежит всегда — так подобран сам `AS_OF`, — и на этом стоят все
 * ожидания «якорь превращает команду в коррекцию».
 */
const EDITABLE_FROM = reissuableFrom(MONDAY)[0]!.from;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  crew: typeof AssignmentCrew;
  command: typeof AssignmentCommand;
  esm2: typeof Esm2;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  // Окружение и база готовы хуком механики — остаётся забрать клиента и сервисы.
  const { db, closeDb } = await import('../src/db/client');
  ctx = {
    db,
    closeDb,
    crew: await import('../src/services/assignment-crew'),
    command: await import('../src/services/assignment-command'),
    esm2: await import('../src/services/waybill-esm2'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

// ── Субъекты ──
//
// Права спрашиваются по посчитанному исходу (Р32), поэтому сцене нужны три разных субъекта: без
// коррекционного права, с ним и с ним же плюс снятым пределом глубины.

/** Менеджер: коррекции задним числом у него нет вовсе (ADR 0101, Р4). */
const MANAGER: AccessSubject = { role: 'manager' };
/** Диспетчер: `waybills.correct` есть, предел тридцати дней остаётся. */
const DISPATCHER: AccessSubject = { role: 'dispatcher' };
/** Администратор: и право, и снятый предел. */
const ADMIN: AccessSubject = { role: 'admin' };

// ── Сцена ──

interface SceneOptions {
  /** Что стоит на шкале машиниста с начала срока. */
  driverAtStart?: 'unknown' | 'person_a' | 'none';
  term?: { from: string; to: string };
  /** Выписать бумагу на весь срок (расчётом от начала срока — тогда листы получают все недели). */
  issueSheets?: boolean;
  /** Плановая строка «с понедельника следующей недели — Сменщиков»: цель отмены. */
  plannedRow?: boolean;
  /** Группа смены техники со `cleared`-спутником: цель отказа «это решение о технике». */
  vehicleGroup?: boolean;
  /**
   * Расхождение хвоста, закрытое решением `assignment_wins` (Р31): история знает вторую машину с
   * понедельника, назначение осталось на первой, и граница на `dateTo + 1` написана **значением
   * назначения**. `'live'` ставит ту же группу внутрь срока — так выглядит решение, ожившее после
   * продления.
   */
  tailGroup?: 'dormant' | 'live';
  /** Готовность истории; по умолчанию — материализована. */
  state?: 'empty' | 'materialized' | 'ready';
}

interface Scene {
  requestId: string;
  userId: string;
  vehicleA: string;
  vehicleB: string;
  personA: string;
  personB: string;
}

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/**
 * Заказ спецтехники в работе: собственная машина на весь срок, история материализована, бумага (по
 * запросу) выписана на все три недели срока.
 *
 * Бумага выписывается **расчётом от начала срока**, а не от дня команды: иначе прошедшая неделя
 * листа не получила бы вовсе (`esm2SyncPlan` её не заводит), и проверять «прошлое не тронуто» было
 * бы не на чем.
 */
async function inScene<T>(
  options: SceneOptions,
  run: (tx: SceneTx, scene: Scene) => Promise<T>,
): Promise<T> {
  const term = options.term ?? { from: TERM_FROM, to: TERM_TO };
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<Record<string, string>> => {
        const [row] = (await tx.execute<Record<string, string>>(q)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const fleet = (
        await tx.execute<{ id: string; vehicle_type_id: string }>(
          sql`SELECT id, vehicle_type_id FROM vehicles
               WHERE deleted_at IS NULL AND ownership = 'own' ORDER BY id LIMIT 2`,
        )
      ).rows;
      const [vehicleA, vehicleB] = fleet;
      if (!vehicleA || !vehicleB) throw new Error('в парке меньше двух своих машин');
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`ap-crew-${RUN}@example.invalid`}, 'Историев', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const spec = await one(sql`SELECT id FROM specializations WHERE code = 'driver'`);
      // Человек без действующей специализации водителя в лист не попадает вовсе
      // (`findMachinist`), и сверка ответила бы «укажите машиниста» вместо работы.
      const person = async (last: string): Promise<string> => {
        const row = await one(
          sql`INSERT INTO persons (last_name, first_name) VALUES (${last}, 'Пров') RETURNING id`,
        );
        await tx.execute(sql`
          INSERT INTO person_specializations (person_id, specialization_id, started_on)
          VALUES (${row.id}, ${spec.id}, ${shiftDateKey(term.from, -400)})`);
        return row.id!;
      };
      const personA = await person('Машинистов');
      const personB = await person('Сменщиков');

      const state = options.state ?? 'materialized';
      // День проверки идёт в паре с состоянием: `CHECK` таблицы держит равенство «`empty` ⟺ дня
      // проверки нет» (Р26), и состояние без даты — это не «ещё не считали», а испорченная строка.
      const request = await one(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                      assignment_history_state, assignment_history_validated_on)
        VALUES ('special_equipment', ${obj.id}, ${vehicleA.vehicle_type_id}, 'confirmed',
                ${user.id}, ${state}, ${state === 'empty' ? null : AS_OF})
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${request.id}, ${term.from}, ${term.to})`);
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        VALUES (${request.id}, ${vehicleA.id}, ${vehicleA.vehicle_type_id},
                ${vehicleA.vehicle_type_id}, ${user.id})`);

      // История, какой её оставил бы бэкфилл: машина с начала срока и то, что известно о человеке.
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: term.from,
        dimension: 'vehicle',
        vehicleId: vehicleA.id,
        origin: 'assignment',
      });
      if (options.driverAtStart === 'unknown') {
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: term.from,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'backfill',
        });
      } else if (options.driverAtStart !== 'none') {
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: term.from,
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: personA,
          origin: 'assignment',
        });
      }
      if (options.plannedRow) {
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: NEXT,
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: personB,
          origin: 'machinist_change',
        });
      }
      if (options.tailGroup) {
        // История знает вторую машину внутри срока — это и есть расхождение хвоста: свёртка на
        // конце срока даёт B, а назначение осталось на A.
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: MONDAY,
          dimension: 'vehicle',
          vehicleId: vehicleB.id,
          origin: 'reassignment',
        });
        // Решение `assignment_wins`: граница пишется машиной **назначения**, а не истории, и
        // зависимый якорь получает тот же `origin` и ту же группу — гаснут они вместе (Р16, Р31).
        const group = randomUUID();
        const at = options.tailGroup === 'dormant' ? shiftDateKey(term.to, 1) : NEXT;
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: at,
          dimension: 'vehicle',
          vehicleId: vehicleA.id,
          origin: 'tail_resolution',
          changeGroupId: group,
        });
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: at,
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: personA,
          origin: 'tail_resolution',
          changeGroupId: group,
        });
      }
      if (options.vehicleGroup) {
        const group = randomUUID();
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: NEXT,
          dimension: 'vehicle',
          vehicleId: vehicleB.id,
          origin: 'reassignment',
          changeGroupId: group,
        });
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: NEXT,
          dimension: 'driver',
          driverState: 'cleared',
          origin: 'reassignment',
          changeGroupId: group,
        });
      }

      if (options.issueSheets) {
        await ctx.esm2.syncEsm2Waybills(tx, {
          requestId: request.id!,
          actor: { id: user.id! },
          reason: 'сцена теста: бумага на весь срок',
          driverPersonId: personA,
          // Расчёт от начала срока: тогда лист получает и та неделя, что ко дню расчёта отработана.
          asOf: term.from,
        });
        /*
         * ЭСМ2-РАЗРЕЗ. Событие сверки, записанное **подготовкой сцены**, из журнала убирается.
         *
         * С этапа 5 бумагу пишет единственный владелец строгого события
         * (`applyEsm2SyncPlanAndAudit`), и `waybill.esm2_sync` появляется в той же транзакции, что
         * и листы, — в том числе когда сверку зовёт сцена, а не дверь. Утверждения файла о журнале
         * говорят о **команде**, и подготовка в них попадать не должна: иначе тест мерил бы не
         * дверь, а собственные декорации.
         */
        await tx.execute(sql`DELETE FROM audit_log WHERE entity_id = ${request.id!}`);
      }

      out = await run(tx, {
        requestId: request.id!,
        userId: user.id!,
        vehicleA: vehicleA.id,
        vehicleB: vehicleB.id,
        personA,
        personB,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

async function insertChange(
  tx: SceneTx,
  row: {
    requestId: string;
    effectiveDate: string;
    dimension: 'vehicle' | 'driver';
    vehicleId?: string;
    driverPersonId?: string;
    driverState?: string;
    origin: string;
    changeGroupId?: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
            ${row.changeGroupId ?? randomUUID()})`);
}

/** Исполнитель команды — вложенная транзакция сцены: настоящая транзакция с настоящим откатом. */
const executorOf = (tx: SceneTx): AssignmentCommand.AssignmentCommandExecutor =>
  ({
    transaction: (fn: (inner: unknown) => Promise<unknown>) => tx.transaction(fn as never),
  }) as unknown as AssignmentCommand.AssignmentCommandExecutor;

/** Тело команды `set` — с умолчаниями, чтобы случаи отличались тем, ради чего они написаны. */
function setBody(
  overrides: { driverPersonId: string; effectiveDate: string } & Record<string, unknown>,
): AssignmentCommandInput {
  return { kind: 'set', dimension: 'driver', version: 0, ...overrides } as AssignmentCommandInput;
}

/** Провести команду через каркас — ровно тем же способом, каким её проводит боевая ручка. */
function runCrew(
  tx: SceneTx,
  scene: Scene,
  actor: AccessSubject,
  input: AssignmentCommandInput,
): Promise<
  AssignmentCommand.AssignmentCommandOutcome<
    AssignmentWrite.AssignmentWriteResult,
    AssignmentCrew.CrewPaper
  >
> {
  return ctx.command.runAssignmentCommand<
    AssignmentCrew.CrewPlan,
    AssignmentWrite.AssignmentWriteResult,
    AssignmentCrew.CrewPaper
  >(
    executorOf(tx),
    ctx.crew.crewCommandSpec({
      requestId: scene.requestId,
      actor: { ...actor, id: scene.userId },
      input,
      asOf: AS_OF,
    }),
  );
}

/** Предпросмотр — тем же колбэком `plan`, что и бой (§8). */
async function previewCrew(tx: SceneTx, scene: Scene, input: AssignmentCommandInput) {
  const preview = await ctx.command.previewAssignmentCommand<AssignmentCrew.CrewPlan>(
    executorOf(tx),
    {
      requestId: scene.requestId,
      actor: { id: scene.userId },
      asOf: AS_OF,
      plan: (planCtx) => ctx.crew.planCrewCommand(planCtx, input),
    },
  );
  return ctx.crew.crewPreviewDto(preview.effects, preview.plan, preview.fingerprint, preview.asOf);
}

/** Тело боевой команды по посчитанному предпросмотру: отпечаток, разблокировки и envelope. */
function armed(
  body: AssignmentCommandInput,
  preview: { fingerprint: string; unlockFingerprint: string | null },
  reason?: string,
): AssignmentCommandInput {
  return {
    ...body,
    previewFingerprint: preview.fingerprint,
    ...(preview.unlockFingerprint ? { unlockFingerprint: preview.unlockFingerprint } : {}),
    ...(reason ? { operation: { operationId: randomUUID(), reason } } : {}),
  } as AssignmentCommandInput;
}

const errorOf = async (run: () => Promise<unknown>): Promise<Error & { statusCode?: number }> => {
  try {
    await run();
  } catch (e) {
    return e as Error & { statusCode?: number };
  }
  throw new Error('ожидался отказ, а команда прошла');
};

/** Действующие листы заявки: неделя и напечатанный в бланке человек. */
async function sheetsOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      period_from: string;
      period_to: string;
      driver_person_id: string;
    }>(sql`
      SELECT id, period_from, period_to, driver_person_id FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled'
       ORDER BY period_from`)
  ).rows;
}

async function rowsOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      effective_date: string;
      dimension: string;
      driver_person_id: string | null;
      driver_state: string | null;
      origin: string;
      correction_id: string | null;
      superseded_kind: string | null;
      superseded_at: string | null;
    }>(sql`
      SELECT * FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} ORDER BY effective_date, created_at`)
  ).rows;
}

// ── Р16, Р19, Р32: якорь, неизвестное прошлое и коррекция ──

describe('якорь машиниста (Р16) и три состояния шкалы (Р19)', () => {
  const options: SceneOptions = { driverAtStart: 'unknown', issueSheets: true };

  it('первая фаза предпросмотра называет границу без человека, вторая — план и отпечаток', async () => {
    if (!readMode.enabled) return;
    await inScene(options, async (tx, scene) => {
      const bare = await previewCrew(
        tx,
        scene,
        setBody({ effectiveDate: NEXT, driverPersonId: scene.personB }),
      );
      // `unknown` на изменяемых днях — такое же нарушение, как пустота (Р19): «тронул этот
      // отрезок — назови человека». Имя спрашивается с первого **изменяемого** дня отрезка, а не с
      // его начала: начало лежит в отработанной неделе, куда команда не дотягивается. Изменяемость
      // при этом считается по листам, а не по календарю, и понедельником этот день быть не обязан:
      // в переходную неделю месяц режет её надвое (ADR 0142), первый кусок ко дню расчёта
      // отработан, и первым изменяемым днём оказывается первое число месяца.
      expect(bare.requiredAnchors).toHaveLength(1);
      expect(bare.requiredAnchors[0]).toMatchObject({
        effectiveDate: EDITABLE_FROM,
        from: TERM_FROM,
        to: shiftDateKey(NEXT, -1),
      });
      // Исход первой фазы — `none`: сама смена идёт с будущего понедельника и прошлого не
      // трогает. Коррекцией её делает **якорь**, и увидеть это можно только во второй фазе (Р32).
      expect(bare.operationRequirement).toBeNull();

      const full = await previewCrew(
        tx,
        scene,
        setBody({
          effectiveDate: NEXT,
          driverPersonId: scene.personB,
          anchors: [{ effectiveDate: EDITABLE_FROM, driverPersonId: scene.personB }],
        }),
      );
      expect(full.requiredAnchors).toEqual([]);
      // Якорь задевает уже прошедшие дни изменяемой области — и вся команда становится коррекцией:
      // исход считается максимумом по её логическим эффектам (Р32). Сколько этих дней, решает
      // календарь: в обычную неделю это понедельник и вторник, в переходную — одно первое число
      // месяца. Пустым этот список не бывает никогда, и это не везение календаря, а условие, по
      // которому подобран `AS_OF`: день расчёта берётся такой, чтобы период листа под ним начался
      // раньше него самого. Иначе изменяемая область открывалась бы ровно днём расчёта, коррекции в
      // команде не было бы вовсе, и этот `expect` красил бы набор две недели в году без единой
      // правки кода.
      expect(full.operationRequirement).toEqual({
        kind: 'crew',
        reasonRequired: true,
        operationIdRequired: true,
      });
      // Две фазы — два разных состояния последствий, и отпечаток обязан их различать.
      expect(full.fingerprint).not.toBe(bare.fingerprint);
      // Бумага: отработанное не тронуто, всё остальное переоформляется. «Отработанное» здесь не
      // одна прошлая неделя: в переходную к ней добавляется августовский кусок текущей (ADR 0142),
      // и команда, прошлого не открывающая, до него не дотягивается — потому отбор и по `AS_OF`.
      expect(full.plan.cancel.map((c) => c.from)).toEqual(
        reissuableFrom(MONDAY).map((p) => p.from),
      );
      expect(full.plan.issue.map((i) => `${i.from}|${i.driverPersonId}`)).toEqual(
        reissuableFrom(MONDAY).map((p) => `${p.from}|${scene.personB}`),
      );
      // Разблокировок нет: отработанный лист лежит **вне** области сверки, и просить подтвердить
      // бумагу, которой человек в предпросмотре не видел, было бы неправдой (Р11).
      expect(full.requiredUnlocks).toEqual([]);
      // Отпечаток пустого множества всё равно возвращается: у исхода `crew` человек подтверждает
      // именно пустоту, а не её отсутствие (§8).
      expect(full.unlockFingerprint).not.toBeNull();
      // Часы смена машиниста не трогает вовсе (Р11): фамилии машиниста в них нет.
      expect(full.blockedShiftDays).toEqual([]);
      expect(full.clearedShiftDays).toEqual([]);
    });
  });

  it('команда с якорем переоформляет бумагу и оставляет отработанную неделю нетронутой', async () => {
    if (!readMode.enabled) return;
    await inScene(options, async (tx, scene) => {
      const before = await sheetsOf(tx, scene.requestId);
      expect(before.map((s) => s.period_from)).toEqual(TERM_PERIODS.map((p) => p.from));

      const body = setBody({
        effectiveDate: NEXT,
        driverPersonId: scene.personB,
        anchors: [{ effectiveDate: EDITABLE_FROM, driverPersonId: scene.personB }],
      });
      const preview = await previewCrew(tx, scene, body);
      const outcome = await runCrew(
        tx,
        scene,
        DISPATCHER,
        armed(body, preview, 'Восстановлен состав по табелю'),
      );

      expect(outcome.repeated).toBe(false);
      expect(outcome.effects?.operationOutcome).toBe('crew');
      expect(outcome.operation?.kind).toBe('crew');
      expect(outcome.version).toBe(1);

      // История: две новые строки, обе со ссылкой на операцию, прежний `unknown` не тронут.
      const driver = (await rowsOf(tx, scene.requestId)).filter((r) => r.dimension === 'driver');
      expect(driver.map((r) => `${r.effective_date}|${r.driver_state}|${r.origin}`)).toEqual([
        `${TERM_FROM}|unknown|backfill`,
        `${EDITABLE_FROM}|set|machinist_change`,
        `${NEXT}|set|machinist_change`,
      ]);
      expect(driver.filter((r) => r.correction_id !== null)).toHaveLength(2);
      expect(driver.every((r) => r.superseded_at === null)).toBe(true);

      // Бумага: прошлая неделя со своим номером и прежним человеком осталась как была.
      const after = await sheetsOf(tx, scene.requestId);
      expect(after).toHaveLength(TERM_SHEETS);
      expect(after[0]).toMatchObject({ period_from: PREV, driver_person_id: scene.personA });
      expect(after[0]!.id).toBe(before[0]!.id);
      // Вся бумага, до которой команда дотягивается, — на новом человеке, сколько бы листов её ни
      // было. Граница здесь не понедельник, а первый изменяемый день: в переходную неделю между
      // ними лежит отработанный августовский кусок, и он законно остаётся за прежним машинистом.
      expect(after.filter((s) => s.period_from >= EDITABLE_FROM).map((s) => s.period_from)).toEqual(
        reissuableFrom(MONDAY).map((p) => p.from),
      );
      expect(
        after
          .filter((s) => s.period_from >= EDITABLE_FROM)
          .every((s) => s.driver_person_id === scene.personB),
      ).toBe(true);
      // Переоформление — это аннулирование номера и выписка нового, а не правка бланка. Сверяется
      // первый переоформленный лист, а не второй по счёту: в переходную неделю вторым идёт
      // нетронутый кусок «31–31 августа», и он обязан сохранить свой номер.
      const reissued = TERM_PERIODS.findIndex((p) => p.from === EDITABLE_FROM);
      expect(after[reissued]!.id).not.toBe(before[reissued]!.id);
      expect(outcome.paper?.esm2.issued).toHaveLength(reissuableFrom(MONDAY).length);
      expect(outcome.paper?.esm2.cancelled).toHaveLength(reissuableFrom(MONDAY).length);

      // Событий два: решение о человеке и переписанная бумага — и оба в той же транзакции.
      const events = (
        await tx.execute<{ action: string }>(sql`
          SELECT action FROM audit_log WHERE entity_id = ${scene.requestId} ORDER BY action`)
      ).rows;
      expect(events.map((e) => e.action)).toEqual([
        'vehicle_request.assignment_change',
        'waybill.esm2_sync',
      ]);
    });
  });

  it('чужой якорь отвергается: принимается только дата, названная предпросмотром', async () => {
    if (!readMode.enabled) return;
    await inScene(options, async (tx, scene) => {
      const failure = await errorOf(() =>
        previewCrew(
          tx,
          scene,
          setBody({
            effectiveDate: NEXT,
            driverPersonId: scene.personB,
            // День расчёта вместо первого изменяемого дня: пробел начинается не здесь, и якорь на
            // эту дату был бы второй дверью в историю — мимо Р12 и матрицы исходов Р32. Совпасть с
            // `EDITABLE_FROM` день расчёта не может по построению (см. `AS_OF`) — иначе якорь
            // перестал бы быть чужим, и случай проверял бы не то, ради чего написан.
            anchors: [{ effectiveDate: AS_OF, driverPersonId: scene.personB }],
          }),
        ),
      );
      expect(failure.message).toMatch(/не требуется/);
      expect(failure.statusCode).toBe(422);
    });
  });

  it('команда без якорей до записи не доходит: инвариант проверяется рукопожатием', async () => {
    if (!readMode.enabled) return;
    await inScene(options, async (tx, scene) => {
      const body = setBody({ effectiveDate: NEXT, driverPersonId: scene.personB });
      const preview = await previewCrew(tx, scene, body);
      const failure = await errorOf(() =>
        runCrew(tx, scene, DISPATCHER, armed(body, preview, 'без якоря')),
      );
      expect(failure.message).toMatch(/Назовите машиниста/);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(2);
    });
  });
});

// ── Р32: права спрашивает исход, а не календарь ──

describe('условная авторизация (Р32)', () => {
  const options: SceneOptions = { driverAtStart: 'unknown', issueSheets: true };
  const withAnchor = (scene: Scene): AssignmentCommandInput =>
    setBody({
      effectiveDate: NEXT,
      driverPersonId: scene.personB,
      // Якорь принимается только на дату, названную предпросмотром (Р16), а называет он первый
      // изменяемый день — не обязательно понедельник (ADR 0142, см. `EDITABLE_FROM`).
      anchors: [{ effectiveDate: EDITABLE_FROM, driverPersonId: scene.personB }],
    });

  it('исход `crew` требует права коррекции: без него — 403 и ни одной записи', async () => {
    if (!readMode.enabled) return;
    await inScene(options, async (tx, scene) => {
      const body = withAnchor(scene);
      const preview = await previewCrew(tx, scene, body);
      const failure = await errorOf(() =>
        runCrew(tx, scene, MANAGER, armed(body, preview, 'нет права')),
      );
      expect(failure.statusCode).toBe(403);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(2);
      // Номер бланка на отказе не расходуется: авторизация стоит до первой мутации (шаг 9).
      expect(await sheetsOf(tx, scene.requestId)).toHaveLength(TERM_SHEETS);
    });
  });

  it('глубже тридцати дней нужен снятый предел: диспетчеру — 403, администратору — работа', async () => {
    if (!readMode.enabled) return;
    // Отдельный срок: он весь лежит в прошлом глубже предела, и бумаги у него нет — проверяется
    // ровно глубина, а не расход бланков.
    const deep = { from: shiftDateKey(MONDAY, -70), to: shiftDateKey(MONDAY, -64) };
    await inScene({ driverAtStart: 'person_a', term: deep }, async (tx, scene) => {
      const body = setBody({ effectiveDate: deep.from, driverPersonId: scene.personB });
      const preview = await previewCrew(tx, scene, body);

      const failure = await errorOf(() =>
        runCrew(tx, scene, DISPATCHER, armed(body, preview, 'работал другой машинист')),
      );
      expect(failure.statusCode).toBe(403);
      expect(failure.message).toMatch(/тридцати дней/);

      const outcome = await runCrew(
        tx,
        scene,
        ADMIN,
        armed(body, preview, 'работал другой машинист'),
      );
      expect(outcome.effects?.operationOutcome).toBe('crew');
      // Снимок авторизации записан вместе со строкой журнала: повтор спустя месяц проверяется по
      // нему, а не пересчётом глубины (Р9 п. 4).
      const scope = (
        await tx.execute<{ authorization_scope: Record<string, unknown> }>(sql`
          SELECT authorization_scope FROM waybill_corrections
           WHERE id = ${outcome.operation!.id}`)
      ).rows[0]!.authorization_scope;
      expect(scope).toMatchObject({
        schemaVersion: 1,
        requiresCorrect: true,
        requiresCorrectBeyondLimit: true,
        effectiveDate: deep.from,
        authorizedAsOf: AS_OF,
      });
    });
  });

  it('исход `assignment_tail` коррекционных прав не требует, но причину спрашивает', async () => {
    if (!readMode.enabled) return;
    await inScene(
      { driverAtStart: 'person_a', plannedRow: true, issueSheets: true },
      async (tx, scene) => {
        const body: AssignmentCommandInput = {
          kind: 'cancel',
          version: 0,
          target: { dimension: 'driver', effectiveDate: NEXT },
        };
        const preview = await previewCrew(tx, scene, body);
        expect(preview.operationRequirement).toEqual({
          kind: 'assignment_tail',
          reasonRequired: true,
          operationIdRequired: true,
        });
        // Отпечаток разблокировок у этого исхода не спрашивается вовсе (Д4).
        expect(preview.unlockFingerprint).toBeNull();

        const withoutReason = await errorOf(() =>
          runCrew(tx, scene, MANAGER, armed(body, preview)),
        );
        expect(withoutReason.message).toMatch(/причины/);

        // Тот же менеджер, у которого `waybills.correct` нет, команду проводит: будущее решение
        // прошлого не трогает, и мерить глубину не по чему.
        const outcome = await runCrew(
          tx,
          scene,
          MANAGER,
          armed(body, preview, 'смена отменена заказчиком'),
        );
        expect(outcome.operation?.kind).toBe('assignment_tail');
        const rows = await rowsOf(tx, scene.requestId);
        expect(rows.find((r) => r.effective_date === NEXT)?.superseded_kind).toBe('cancelled');
      },
    );
  });
});

// ── Р13: границы трёх форм одной команды ──

describe('границы команды (Р12, Р13)', () => {
  it('дата раньше начала срока — 422: там нет работы', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a' }, async (tx, scene) => {
      const failure = await errorOf(() =>
        previewCrew(
          tx,
          scene,
          setBody({ effectiveDate: shiftDateKey(TERM_FROM, -1), driverPersonId: scene.personB }),
        ),
      );
      expect(failure.message).toMatch(/раньше начала работ/i);
    });
  });

  it('тот же машинист на ту же дату — пустая команда (Р12)', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a' }, async (tx, scene) => {
      const failure = await errorOf(() =>
        previewCrew(tx, scene, setBody({ effectiveDate: NEXT, driverPersonId: scene.personA })),
      );
      expect(failure.message).toMatch(/тот же машинист/i);
    });
  });

  it('начальное решение не отменяется, а правится', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a' }, async (tx, scene) => {
      const failure = await errorOf(() =>
        previewCrew(tx, scene, {
          kind: 'cancel',
          version: 0,
          target: { dimension: 'driver', effectiveDate: TERM_FROM },
        }),
      );
      expect(failure.message).toMatch(/Начальное назначение не отменяется/);
    });
  });

  it('прошедшие дни отменой не правятся — только коррекцией', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a' }, async (tx, scene) => {
      // Плановое решение, которое ко дню расчёта уже вступило в силу: календарь его отменить не
      // даёт.
      await insertChange(tx, {
        requestId: scene.requestId,
        effectiveDate: MONDAY,
        dimension: 'driver',
        driverState: 'set',
        driverPersonId: scene.personB,
        origin: 'machinist_change',
      });
      const failure = await errorOf(() =>
        previewCrew(tx, scene, {
          kind: 'cancel',
          version: 0,
          target: { dimension: 'driver', effectiveDate: MONDAY },
        }),
      );
      expect(failure.message).toMatch(/отменой не правятся/);
    });
  });

  it('группу со сменой техники эта дверь не трогает (Р7, В2)', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', vehicleGroup: true }, async (tx, scene) => {
      const failure = await errorOf(() =>
        previewCrew(tx, scene, {
          kind: 'cancel',
          version: 0,
          // `cleared`-спутник живёт в группе vehicle-решения: погасив группу, команда увела бы с
          // ним машину, ставки и денормализацию.
          target: { dimension: 'driver', effectiveDate: NEXT },
        }),
      );
      expect(failure.message).toMatch(/решение о технике/i);
    });
  });

  /*
   * Сцена переписана волной 3.5: прежде она ставила `state: 'empty'` **вместе со строками истории**
   * и ждала отказа. Такого состояния в проде не бывает — состояние пишется раньше строк, — а после
   * проводки `ensure` дверь по нему честно работает: расчёт восстанавливает историю и пускает
   * команду. Проверять осталось то, ради чего случай и заведён: заявку, историю которой
   * восстановить **нечем**, дверь не правит и называет причину.
   */
  it('историю, которую нечем восстановить, командой не правят', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', state: 'empty' }, async (tx, scene) => {
      /*
       * Историю нечем восстановить, когда нет ни строк, ни назначения: строки — то, что уже
       * записано, назначение — единственная опора бэкфилла (Р20). Сцена заводит и то и другое,
       * поэтому для этого случая снимаем обе опоры, а не одну.
       */
      await tx.execute(
        sql`DELETE FROM vehicle_request_assignment_changes WHERE request_id = ${scene.requestId}`,
      );
      await tx.execute(
        sql`DELETE FROM vehicle_request_assignments WHERE request_id = ${scene.requestId}`,
      );
      const failure = await errorOf(() =>
        previewCrew(tx, scene, setBody({ effectiveDate: NEXT, driverPersonId: scene.personB })),
      );
      expect(failure.message).toMatch(/восстанов/i);
    });
  });
});

// ── Р24 и Б1/В3/Д1: что до переключения чтения недостижимо ──

/*
 * БЛОК ИДЁТ ДВУМЯ ПРОГОНАМИ (подэтап 4b, У1), и это единственный блок файла, который их требует:
 * весь он про границу «до переключения чтения», то есть про то, что этап 5 и снял.
 *
 * Расходятся теперь четыре случая из пяти, и все четыре — по одной причине. Дремлющая запись (Д1)
 * держалась прямо на `historyIsAuthoritative`; три остальных держал гейт совместимости (Б1, В3), и
 * гейт этот **снят режимом**: в `history` шаг 12 исполняет отрезковый план, а он несёт машину и
 * человека в каждом выпускаемом листе — значит умеет и разрез посреди недели, и разных людей в
 * соседних документах (Ю49). Пятый случай — граница недели — совпадает в обоих прогонах: там оба
 * исполнителя дают тот же документ.
 *
 * Обе половины остаются написанными: режим двигается в обе стороны (§10), и после отката к
 * `legacy` исполнителем снова становится недельная сверка вместе со всеми своими границами.
 */
describeReadModes(readMode, 'границы этапа 3 (Р24, Б1, В3, Д1)', (mode) => {
  it('дремлющая команда за концом срока: отвергается до переключения чтения и проходит после', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      const body = setBody({
        effectiveDate: shiftDateKey(TERM_TO, 1),
        driverPersonId: scene.personB,
      });
      // ЕДИНСТВЕННОЕ место файла, где разрез виден уже сегодня: запрет Д1 стоит прямо на
      // `historyIsAuthoritative` ([assignment-crew.ts](../src/services/assignment-crew.ts)).
      // Логический диапазон у такой записи есть, бумажного нет (Р24) — и именно она единственный
      // источник «сегодня планы совпали, а завтра, после продления срока, разошлись» (Д1). Пока
      // бумагу ведёт недельная сверка, запись эту мину закладывает и потому запрещена; после
      // переключения чтения мины нет — и запись становится обычной плановой командой.
      const expected = byReadMode(mode, {
        legacy: 'refused' as const,
        history: 'dormant' as const,
      });

      if (expected === 'refused') {
        const failure = await errorOf(() => previewCrew(tx, scene, body));
        expect(failure.message).toMatch(/за пределами срока работ/);
        return;
      }

      const preview = await previewCrew(tx, scene, body);
      // Бумаги дремлющая команда не трогает вовсе: срок кончился раньше её даты, и переоформлять
      // нечего — ни одного листа ни в отмену, ни в выписку.
      expect(preview.plan.cancel).toEqual([]);
      expect(preview.plan.issue).toEqual([]);
      expect(preview.requiredAnchors).toEqual([]);
      // Бумаги не трогает — значит и операции журнала не требует (Р32): исход `none`, причину
      // спрашивать не за что.
      expect(preview.operationRequirement).toBeNull();

      const outcome = await runCrew(tx, scene, DISPATCHER, armed(body, preview));
      expect(outcome.effects?.operationOutcome).toBe('none');

      // Запись легла и ждёт продления срока; бумага та же, что была.
      const rows = await rowsOf(tx, scene.requestId);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({
        effective_date: shiftDateKey(TERM_TO, 1),
        dimension: 'driver',
        driver_person_id: scene.personB,
        origin: 'machinist_change',
      });
      expect(await sheetsOf(tx, scene.requestId)).toHaveLength(TERM_SHEETS);
    });
  });

  it('дата в середине выписанной недели режет её надвое — до переключения чтения нечем', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      // Дата команды — день расчёта, и он лежит **внутри** периода листа, а не на его границе: это
      // и есть условие, по которому `AS_OF` подобран. Совпади он с началом периода — резать было бы
      // нечего, `legacy` отвечал бы согласием вместо отказа, а `history` выписывал бы один лист
      // вместо двух, и случай молча проверял бы совсем другой сюжет.
      const body = setBody({ effectiveDate: AS_OF, driverPersonId: scene.personB });

      const expected = byReadMode(mode, { legacy: 'refused' as const, history: 'split' as const });
      if (expected === 'refused') {
        const failure = await errorOf(() => previewCrew(tx, scene, body));
        expect(failure.message).toMatch(/режет уже выписанную неделю/);
        return;
      }

      /*
       * ЭСМ2-РАЗРЕЗ. После переключения чтения тот же разрез — обычная работа: лист пн–вс горит, а
       * вместо него выходят **два** документа — пн–вт прежним человеком и ср–вс новым. Ключ недели
       * такого состава не выражает вовсе, и потому старый исполнитель этой команды не умел (Б1).
       */
      /**
       * Ожидаемый состав переоформляемой бумаги: периоды, до которых команда дотягивается, из
       * которых тот, внутрь которого попала дата, разрезан надвое — дни до неё за прежним
       * человеком.
       *
       * Отбор именно переоформляемых, а не «всех с понедельника»: дата команды — сегодняшняя, и
       * прошлого она себе не открывает. Отработанный кусок переходной недели остаётся при своём
       * номере и своём человеке (ADR 0101), и ждать его в этом списке значило бы требовать от
       * портала второго документа на уже сделанную работу.
       */
      const expectedIssue = reissuableFrom(MONDAY).flatMap((period) =>
        period.from < AS_OF && AS_OF <= period.to
          ? [
              `${period.from}|${shiftDateKey(AS_OF, -1)}|${scene.personA}`,
              `${AS_OF}|${period.to}|${scene.personB}`,
            ]
          : [`${period.from}|${period.to}|${period.from < AS_OF ? scene.personA : scene.personB}`],
      );

      const preview = await previewCrew(tx, scene, body);
      // Горит вся бумага, которую команда вправе переоформить: она выписана на прежнего человека, а
      // новый работает с середины текущей недели и до конца срока.
      expect(preview.plan.cancel).toHaveLength(reissuableFrom(MONDAY).length);
      expect(preview.plan.issue.map((i) => `${i.from}|${i.to}|${i.driverPersonId}`)).toEqual(
        expectedIssue,
      );

      const outcome = await runCrew(
        tx,
        scene,
        DISPATCHER,
        armed(body, preview, 'Смена машиниста с середины недели'),
      );
      expect(outcome.repeated).toBe(false);
      expect(outcome.paper?.esm2.cancelled).toHaveLength(reissuableFrom(MONDAY).length);
      expect(outcome.paper?.esm2.issued).toHaveLength(expectedIssue.length);

      // Бумага заявки: всё отработанное цело (прошлая неделя, а в переходную — и августовский кусок
      // текущей), задетая датой неделя — двумя листами, дальше своё.
      const after = await sheetsOf(tx, scene.requestId);
      expect(after.map((s) => `${s.period_from}|${s.period_to}|${s.driver_person_id}`)).toEqual([
        ...TERM_PERIODS.filter((p) => p.from < EDITABLE_FROM).map(
          (p) => `${p.from}|${p.to}|${scene.personA}`,
        ),
        ...expectedIssue,
      ]);
      // Событие сверки — ровно одно и в той же транзакции: владелец у него один (§7).
      const events = (
        await tx.execute<{ action: string }>(sql`
          SELECT action FROM audit_log WHERE entity_id = ${scene.requestId} ORDER BY action`)
      ).rows;
      expect(events.map((e) => e.action)).toEqual([
        'vehicle_request.assignment_change',
        'waybill.esm2_sync',
      ]);
    });
  });

  /*
   * Ю49. Плановая смена машиниста будущей датой — два сюжета одной причины, и оба ниже.
   *
   * В `legacy` бумагу исполняет недельная сверка, а печатает она **одного** машиниста заявки — того,
   * что работает на день расчёта (`legacyDriverPersonId`). Команда, после которой листы области
   * ждут другого человека, ей неисполнима; гейт же сравнивал планы **без человека** и обоих сюжетов
   * не видел. До волны 3.6 первый умирал постусловием Р11 уже после проведённой команды, а второй
   * получал «дата режет уже выписанную неделю надвое» на дате, которая является точной границей
   * недели. Теперь оба получают один отказ, и получают его в предпросмотре.
   *
   * ЭСМ2-РАЗРЕЗ. В `history` оба сюжета — обычная плановая работа диспетчера: исполнитель
   * отрезкового плана несёт человека в каждом выпускаемом листе, и «машиниста заявки» у него нет
   * вовсе. По матрице Р32 это строка 4 — исход `none`, ни причины, ни коррекционного права.
   */
  it('смена будущей датой при бумаге прежнего человека — до переключения чтения нечем, после — обычная работа', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      const body = setBody({ effectiveDate: NEXT, driverPersonId: scene.personB });

      const expected = byReadMode(mode, {
        legacy: 'refused' as const,
        history: 'planned' as const,
      });
      if (expected === 'refused') {
        const failure = await errorOf(() => previewCrew(tx, scene, body));
        expect(failure.statusCode).toBe(422);
        expect(failure.message).toMatch(/машиниста меняют датой не позже сегодняшней/);
        expect(failure.message).toMatch(/переключением чтения/);
        // `NEXT` — точная граница недели, и прежняя причина была неверна: границу человек выбрал
        // правильно, недостижимо здесь другое.
        expect(failure.message).not.toMatch(/режет уже выписанную неделю/);

        // Боевая ручка отвечает **тем же**: отказ стоит в расчёте, до рукопожатия, — отпечатка у
        // человека нет вовсе, потому что предпросмотр его не выдал.
        const live = await errorOf(() =>
          runCrew(
            tx,
            scene,
            DISPATCHER,
            armed(body, { fingerprint: 'предпросмотра не было', unlockFingerprint: null }),
          ),
        );
        expect(live.message).toBe(failure.message);
        // Ни бумаги, ни истории команда не тронула.
        expect(await sheetsOf(tx, scene.requestId)).toHaveLength(TERM_SHEETS);
        expect(await rowsOf(tx, scene.requestId)).toHaveLength(2);
        return;
      }

      // Исход `none` (Р32, строка 4): дата в будущем, отработанного не задето — причины и
      // коррекционного права не спрашивают.
      const preview = await previewCrew(tx, scene, body);
      expect(preview.operationRequirement).toBeNull();
      expect(preview.plan.cancel).toHaveLength(periodsFrom(NEXT).length);
      expect(preview.plan.issue.map((i) => `${i.from}|${i.to}|${i.driverPersonId}`)).toEqual(
        periodsFrom(NEXT).map((p) => `${p.from}|${p.to}|${scene.personB}`),
      );

      const outcome = await runCrew(tx, scene, DISPATCHER, armed(body, preview));
      expect(outcome.effects?.operationOutcome).toBe('none');
      expect(outcome.operation).toBeNull();
      expect(outcome.paper?.esm2.cancelled).toHaveLength(periodsFrom(NEXT).length);
      expect(outcome.paper?.esm2.issued).toHaveLength(periodsFrom(NEXT).length);

      // Прошлая и текущая недели остались за прежним человеком, следующая вышла за новым.
      const after = await sheetsOf(tx, scene.requestId);
      expect(after.map((s) => `${s.period_from}|${s.driver_person_id}`)).toEqual(
        TERM_PERIODS.map((p) => `${p.from}|${p.from >= NEXT ? scene.personB : scene.personA}`),
      );
    });
  });

  it('смена будущей датой без листа на эту неделю — тот же отказ, а не 409 после проведённой команды', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      /*
       * Лист недели смены аннулирован — так выглядит заявка, бумагу которой этой недели тронули
       * рядом. Планы тогда выписывают **один и тот же** документ: те же границы, та же машина, — и
       * расходятся ровно человеком, которого гейт не сравнивает. Прежде команда проходила гейт,
       * выписывала лист прежним человеком и падала постусловием Р11 (409
       * `assignment_paper_diverged`), а повторный предпросмотр показывал тот же неисполнимый план.
       */
      // Аннулируется вся бумага недели смены, а не первый её лист: месяц режет неделю надвое
      // (ADR 0142), и оставленный сосед сделал бы сцену не той, что описана выше.
      await tx.execute(sql`
        UPDATE waybills SET status = 'cancelled', cancelled_at = now(),
                            cancel_reason = 'сцена теста: неделю смены оставили без листа'
         WHERE source_request_id = ${scene.requestId} AND period_from >= ${NEXT}`);
      expect(await sheetsOf(tx, scene.requestId)).toHaveLength(
        TERM_SHEETS - periodsFrom(NEXT).length,
      );

      const body = setBody({ effectiveDate: NEXT, driverPersonId: scene.personB });

      const expected = byReadMode(mode, { legacy: 'refused' as const, history: 'issued' as const });
      if (expected === 'refused') {
        const failure = await errorOf(() => previewCrew(tx, scene, body));
        expect(failure.statusCode).toBe(422);
        expect(failure.message).toMatch(/машиниста меняют датой не позже сегодняшней/);

        const live = await errorOf(() =>
          runCrew(
            tx,
            scene,
            DISPATCHER,
            armed(body, { fingerprint: 'предпросмотра не было', unlockFingerprint: null }),
          ),
        );
        expect(live.statusCode).toBe(422);
        expect(live.message).toBe(failure.message);
        // Номер не сгорел и лист не выписан: до шага 12 команда не доходит вовсе.
        expect(await sheetsOf(tx, scene.requestId)).toHaveLength(
          TERM_SHEETS - periodsFrom(NEXT).length,
        );
        expect(await rowsOf(tx, scene.requestId)).toHaveLength(2);
        return;
      }

      /*
       * ЭСМ2-РАЗРЕЗ. После переключения чтения гореть нечему — лист недели уже аннулирован, — и
       * команда просто выписывает недостающую неделю на нового человека. Прежде именно здесь
       * старый исполнитель печатал **прежнего** и падал постусловием Р11 уже после расхода номера.
       */
      const preview = await previewCrew(tx, scene, body);
      expect(preview.plan.cancel).toEqual([]);
      expect(preview.plan.issue.map((i) => `${i.from}|${i.driverPersonId}`)).toEqual(
        periodsFrom(NEXT).map((p) => `${p.from}|${scene.personB}`),
      );

      const outcome = await runCrew(tx, scene, DISPATCHER, armed(body, preview));
      expect(outcome.paper?.esm2.cancelled).toEqual([]);
      expect(outcome.paper?.esm2.issued).toHaveLength(periodsFrom(NEXT).length);
      const after = await sheetsOf(tx, scene.requestId);
      expect(after.map((s) => `${s.period_from}|${s.driver_person_id}`)).toEqual(
        TERM_PERIODS.map((p) => `${p.from}|${p.from >= NEXT ? scene.personB : scene.personA}`),
      );
    });
  });

  it('граница недели проходит: оба плана дают тот же документ', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      const body = setBody({ effectiveDate: MONDAY, driverPersonId: scene.personB });
      const preview = await previewCrew(tx, scene, body);
      expect(preview.plan.issue.map((i) => i.from)).toEqual(periodsFrom(MONDAY).map((p) => p.from));
      const outcome = await runCrew(
        tx,
        scene,
        DISPATCHER,
        armed(body, preview, 'с понедельника вышел другой машинист'),
      );
      expect(outcome.effects?.operationOutcome).toBe('crew');
      const after = await sheetsOf(tx, scene.requestId);
      expect(after.map((s) => s.driver_person_id)).toEqual(
        TERM_PERIODS.map((p) => (p.from >= MONDAY ? scene.personB : scene.personA)),
      );
    });
  });
});

// ── §8: рукопожатия каркаса ──

describe('рукопожатия каркаса (§8, Р9, Р20)', () => {
  it('устаревший отпечаток — 409 «посмотрите последствия заново», а не 422', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      const body = setBody({ effectiveDate: MONDAY, driverPersonId: scene.personB });
      const failure = await errorOf(() =>
        runCrew(
          tx,
          scene,
          DISPATCHER,
          armed(body, { fingerprint: 'не тот отпечаток', unlockFingerprint: null }, 'смена'),
        ),
      );
      expect(failure.statusCode).toBe(409);
      expect(await sheetsOf(tx, scene.requestId)).toHaveLength(TERM_SHEETS);
    });
  });

  it('повтор по тому же ключу возвращает прежний результат и не поднимает версию', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      const body = setBody({ effectiveDate: MONDAY, driverPersonId: scene.personB });
      const preview = await previewCrew(tx, scene, body);
      const full = armed(body, preview, 'смена машиниста');
      const first = await runCrew(tx, scene, DISPATCHER, full);
      const again = await runCrew(tx, scene, DISPATCHER, full);
      expect(again.repeated).toBe(true);
      expect(again.version).toBe(first.version);
      expect(again.operation?.id).toBe(first.operation?.id);
      // Второй раз номера не жгутся: работы второй раз не происходит.
      expect(await sheetsOf(tx, scene.requestId)).toHaveLength(TERM_SHEETS);
    });
  });
});

// ── История заявки: `GET /:id/assignment-changes` ──

describe('история заявки', () => {
  it('отдаёт изменения с именами, провенансом и состоянием готовности', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      const body = setBody({ effectiveDate: MONDAY, driverPersonId: scene.personB });
      const preview = await previewCrew(tx, scene, body);
      await runCrew(tx, scene, DISPATCHER, armed(body, preview, 'смена машиниста'));

      const history = await ctx.crew.readAssignmentHistoryDto(tx, scene.requestId);
      // `ready`, а не `materialized`: команда зовёт revalidation (Р26), а блокеров у этой сцены нет
      // — расчёт честно поднимает состояние. До проводки `ensure` (волна 3.5) колонка оставалась
      // такой, какой её объявила сцена, и тест фиксировал именно это, а не поведение модуля.
      expect(history?.state).toBe('ready');
      const driver = history!.changes.filter((c) => c.dimension === 'driver');
      expect(driver).toHaveLength(2);
      expect(driver[0]).toMatchObject({
        effectiveDate: TERM_FROM,
        driver: { state: 'set', personId: scene.personA },
        origin: 'assignment',
      });
      expect(driver[1]).toMatchObject({
        effectiveDate: MONDAY,
        driver: { state: 'set', personId: scene.personB },
        origin: 'machinist_change',
      });
      expect(driver[1]!.correctionId).not.toBeNull();
      expect(driver[1]!.createdByName).toContain('Историев');
      // Машина показана строкой своей шкалы, а состояние машиниста у неё пусто (Р3).
      const vehicle = history!.changes.find((c) => c.dimension === 'vehicle');
      expect(vehicle?.vehicle?.vehicleId).toBe(scene.vehicleA);
      expect(vehicle?.driver).toBeNull();
    });
  });
});

// ── Р31: дремлющее решение хвоста снимается этой же дверью ──

describe('отмена решения хвоста (Р31, Р17 `tail_release`)', () => {
  /** Цель — vehicle-граница группы: назвав её, команда обязана погасить и зависимый якорь (В2). */
  const cancelTail = (at: string): AssignmentCommandInput => ({
    kind: 'cancel',
    version: 0,
    target: { dimension: 'vehicle', effectiveDate: at },
  });

  /** Машина назначения и хвост истории — те две записи, согласие которых держит Р17. */
  async function tailAndAssignment(tx: SceneTx, requestId: string) {
    const [assignment] = (
      await tx.execute<{ vehicle_id: string }>(sql`
        SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${requestId}`)
    ).rows;
    const [tail] = (
      await tx.execute<{ vehicle_id: string }>(sql`
        SELECT vehicle_id FROM vehicle_request_assignment_changes
         WHERE request_id = ${requestId} AND dimension = 'vehicle' AND superseded_at IS NULL
         ORDER BY effective_date DESC LIMIT 1`)
    ).rows;
    return { assignment: assignment!.vehicle_id, tail: tail!.vehicle_id };
  }

  it('дремлющая группа гасится целиком: назначение нетронуто, хвост вернулся к истории', async () => {
    if (!readMode.enabled) return;
    await inScene(
      { driverAtStart: 'person_a', tailGroup: 'dormant', issueSheets: true },
      async (tx, scene) => {
        const at = shiftDateKey(TERM_TO, 1);
        const before = await tailAndAssignment(tx, scene.requestId);
        // Решение хвоста тем и закрывало расхождение, что граница написана машиной назначения.
        expect(before).toEqual({ assignment: scene.vehicleA, tail: scene.vehicleA });

        const body = cancelTail(at);
        const preview = await previewCrew(tx, scene, body);
        // Дремлющая группа бумаги не трогает вовсе (Р24): плана нет, разблокировок нет, а причина
        // обязательна — команда переписывает уже принятое решение (Р32).
        expect(preview.plan).toEqual({ cancel: [], issue: [] });
        expect(preview.unlockFingerprint).toBeNull();
        expect(preview.operationRequirement?.kind).toBe('assignment_tail');

        const sheetsBefore = await sheetsOf(tx, scene.requestId);
        const outcome = await runCrew(
          tx,
          scene,
          MANAGER,
          armed(body, preview, 'продления не будет — решение по хвосту снимаем'),
        );
        expect(outcome.operation?.kind).toBe('assignment_tail');
        // Гасится **вся** группа: и граница, и её зависимый якорь (В2).
        expect(outcome.applied?.cancelledGroups).toHaveLength(1);
        const cancelled = (await rowsOf(tx, scene.requestId)).filter(
          (r) => r.effective_date === at,
        );
        expect(cancelled).toHaveLength(2);
        expect(cancelled.every((r) => r.superseded_kind === 'cancelled')).toBe(true);

        // Р17 через `tail_release`: назначение осталось на своей машине, а хвост истории вернулся
        // к той, что стоит внутри срока, — и это законное расхождение, а не ошибка двери.
        const after = await tailAndAssignment(tx, scene.requestId);
        expect(after.assignment).toBe(scene.vehicleA);
        expect(after.tail).toBe(scene.vehicleB);
        // Бумага не тронута: у команды с пустой областью сверки шаг 12 не работает вовсе.
        expect(await sheetsOf(tx, scene.requestId)).toEqual(sheetsBefore);
        expect(outcome.paper?.esm2).toEqual({ cancelled: [], issued: [] });
      },
    );
  });

  it('повтор той же отмены возвращает прежний результат и второй раз не гасит', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', tailGroup: 'dormant' }, async (tx, scene) => {
      const body = cancelTail(shiftDateKey(TERM_TO, 1));
      const preview = await previewCrew(tx, scene, body);
      const full = armed(body, preview, 'решение по хвосту снимаем');

      const first = await runCrew(tx, scene, MANAGER, full);
      const again = await runCrew(tx, scene, MANAGER, full);
      expect(again.repeated).toBe(true);
      expect(again.operation?.id).toBe(first.operation?.id);
      expect(again.version).toBe(first.version);
      // Второй раз не гасится ничего: повтор предмет операции не пересчитывает вовсе (Р9 п. 4).
      const rows = await rowsOf(tx, scene.requestId);
      expect(rows.filter((r) => r.superseded_kind === 'cancelled')).toHaveLength(2);
    });
  });

  it('ожившее решение хвоста этой дверью не снимается: там уже ставки и занятость', async () => {
    if (!readMode.enabled) return;
    // Та же группа, но внутри срока: так выглядит дремавшая граница после продления работ.
    await inScene({ driverAtStart: 'person_a', tailGroup: 'live' }, async (tx, scene) => {
      const failure = await errorOf(() => previewCrew(tx, scene, cancelTail(NEXT)));
      expect(failure.message).toMatch(/попала внутрь срока работ/);
      expect(failure.statusCode).toBe(422);
      const rows = await rowsOf(tx, scene.requestId);
      expect(rows.every((r) => r.superseded_at === null)).toBe(true);
    });
  });
});

// ── Р24: дремлющая запись не должна становиться неудаляемой ──

/*
 * Блок тоже идёт двумя прогонами: снятие дремлющей записи от разреза не зависит вовсе, а вот
 * попытка завести её заново — зависит (Д1), и обе половины стоят в одном случае. Разделять их
 * незачем: смысл Р24 в том, что разминирование разрешено там, где закладывание мины запрещено, —
 * и в `history`, где запрета нет, это утверждение звучит иначе, но остаётся верным.
 */
describeReadModes(readMode, 'отмена дремлющего решения о машинисте (Р24)', (mode) => {
  it('снимается — а завести такую запись заново можно только после переключения чтения', async () => {
    if (!readMode.enabled) return;
    await inScene({ driverAtStart: 'person_a', issueSheets: true }, async (tx, scene) => {
      const at = shiftDateKey(TERM_TO, 1);
      // Запись «со 2-го работает Сменщиков», поставленная до сокращения срока: рабочих дней она
      // теперь не задевает, но при любом будущем продлении оживёт.
      await insertChange(tx, {
        requestId: scene.requestId,
        effectiveDate: at,
        dimension: 'driver',
        driverState: 'set',
        driverPersonId: scene.personB,
        origin: 'machinist_change',
      });

      const body: AssignmentCommandInput = {
        kind: 'cancel',
        version: 0,
        target: { dimension: 'driver', effectiveDate: at },
      };
      const preview = await previewCrew(tx, scene, body);
      // Бумаги у неё нет вовсе (`inTermRange` пуст), а причина обязательна: команда снимает уже
      // принятое решение человека (Р32).
      expect(preview.plan).toEqual({ cancel: [], issue: [] });
      expect(preview.operationRequirement?.kind).toBe('assignment_tail');

      const outcome = await runCrew(tx, scene, MANAGER, armed(body, preview, 'продления не будет'));
      expect(outcome.operation?.kind).toBe('assignment_tail');
      const rows = await rowsOf(tx, scene.requestId);
      expect(rows.find((r) => r.effective_date === at)?.superseded_kind).toBe('cancelled');
      // А вот заведение такой же записи заново от разреза зависит (Д1): пока бумагу ведёт
      // недельная сверка, запрет стоит на закладывании мины, а не на её разминировании; после
      // переключения чтения мины нет, и запись заводится как обычная плановая команда.
      const again = () =>
        previewCrew(tx, scene, setBody({ effectiveDate: at, driverPersonId: scene.personB }));
      await byReadMode(mode, {
        legacy: async () => {
          const forward = await errorOf(again);
          expect(forward.message).toMatch(/за пределами срока работ/);
        },
        history: async () => {
          const forward = await again();
          expect(forward.plan).toEqual({ cancel: [], issue: [] });
          expect(forward.requiredAnchors).toEqual([]);
        },
      })();
    });
  });
});
