import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
import type * as Esm2Plan from '../src/services/esm2-plan';
import type * as Esm2 from '../src/services/waybill-esm2';
import { describeReadModes, inLegacy, useReadModeDatabase } from './assignment-read-mode';

/**
 * ПРЕДУПРЕЖДЕНИЯ И СНИМОК БЛАНКА СЧИТАЮТСЯ ПРИ ПОСТРОЕНИИ ПЛАНА, А НЕ ПРИ ВЫПИСКЕ
 * (план `docs/assignment-periods-plan.md`, §7, Б4, В1, Р21; `waybill-esm2.ts`, `assignment-paper.ts`).
 *
 * ЧТО ЗДЕСЬ ЗАКРЫВАЕТСЯ. До этой волны оба считались внутри транзакции выписки — уже после того,
 * как человек нажал «выполнить». Следствий было два, и оба видны только на живой базе: предпросмотр
 * отдавал пустой `issues` (окну нечего было показать), а рукопожатие по каждому листу (Б4) требовать
 * было не с чего — подтверждать нечего, пока набор не посчитан. Теперь набор считается один раз,
 * шагом 6, приходит в предпросмотр вместе с планом, подтверждается шагом 8 и **не пересчитывается**
 * при выписке.
 *
 * ПОЧЕМУ ЭТО НЕ ПРОВЕРИТЬ ЧИСТЫМ ТЕСТОМ. Предупреждение у ЭСМ-2 одно — пробелы в документах
 * машиниста (ADR 0064), — и собирается оно из справочника людей: карточка, СНИЛС, трудовое
 * отношение и удостоверение на дату листа. Ни одного из этих чтений в памяти не подделать так, чтобы
 * утверждение осталось про портал, а не про моки.
 *
 * ЧТО УТВЕРЖДАЕТСЯ.
 *
 *  1. **Предпросмотр называет предупреждения по каждому выпускаемому листу** — и молчит там, где их
 *     нет: у одной команды бывают оба случая сразу (разрез недели оставляет пн–вт прежнему человеку
 *     с пробелами, а ср–вс отдаёт человеку с полным комплектом).
 *  2. **Команда без рукопожатия отвергается, с рукопожатием проходит**, и подписанный лист помнит,
 *     под чем он выписан (`issue_warnings.status = 'acknowledged'`), а чистый — что проверка была
 *     (`clean`). Прежде оба уходили с умолчанием «не проверяли».
 *  3. **Чистый бланк проходит без единой записи рукопожатия**: подпись под пустотой не спрашивают.
 *  4. **Изменение предупреждений делает старое рукопожатие недействительным.** Отпечаток берётся с
 *     фактов, а не с текста, и `previewFingerprint` этот случай НЕ ловит — план-то не изменился.
 *     Случай проверяет ровно это: отпечаток последствий тот же, а рукопожатие уже не годится.
 *  5. **Подтверждение под листом, которому подтверждать нечего, — 422**: человек прислал не то, и
 *     «посмотрите заново» ему не поможет.
 *  6. **Исполнитель не считает набор сам**: план, пришедший без посчитанных листов, падает
 *     внутренней ошибкой и не жжёт ни одного номера. Это и есть доказательство того, что второй
 *     копии расчёта не появилось — молча она проявилась бы тем, что человек подтвердил одно, а
 *     напечаталось другое.
 *
 * ПОЧЕМУ ОСНОВНОЙ ПРОГОН ТОЛЬКО В `history`. Рукопожатие спрашивается там, где бумагу выпускает
 * **этот план**. В `legacy` листы переписывает недельная сверка: просителя у неё нет вовсе, и
 * неполный комплект документов её не останавливает (ADR 0064) — потребуй дверь подпись там, сегодня
 * заперлась бы обычная работа портала, у которого окна рукопожатий ещё нет. Но предупреждения она
 * показывает в обоих режимах, и это проверяется отдельным случаем в `legacy`.
 *
 * Запуск (база из переменной может быть любой — своя всё равно заводится рядом и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/esm2-issue-warnings.db.test.ts
 */

/** Своя база и режим чтения на ней; стоит до собственного `beforeAll` — см. `assignment-read-mode`. */
const readMode = useReadModeDatabase('esm2warn');

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);
/**
 * Реквизиты документов уникальны в справочнике: СНИЛС — одиннадцатью цифрами
 * (`persons_snils_format_check`, `persons_snils_unique`), удостоверение — парой «серия + номер»
 * (`person_credentials_number_unique`). Сцена откатывается, но случаи одного прогона идут по
 * очереди, и внутри сцены людей с документами двое — счётчик обязан различать и тех, и других.
 */
const DOCS_RUN = String(Date.now()).slice(-9);
let docsCounter = 0;
const nextDocsNo = (): string => String((docsCounter += 1) % 100).padStart(2, '0');

// ── Календарь сцены (тем же расчётом, что и в `esm2-apply.db.test.ts`) ──

const MONDAY = weekStartKey(moscowDateKeyOf(new Date()));
/** Понедельник прошлой недели: с него идёт срок, и её лист ко дню расчёта уже отработан. */
const PREV = shiftDateKey(MONDAY, -7);
const NEXT = shiftDateKey(MONDAY, 7);
const TERM_FROM = PREV;
const TERM_TO = shiftDateKey(NEXT, 6);
const TERM_PERIODS = esm2Periods(TERM_FROM, TERM_TO);

/**
 * День расчёта — среда текущей недели, а если среда не годится, ближайший следующий годный день.
 * Годность одна: период листа, внутрь которого попал день, обязан начинаться **строго раньше** него.
 * Иначе резать нечего, и разрез недели — предмет половины случаев — не состоится вовсе (ADR 0142
 * сделал такие недели обычными: месячная граница внутри недели даёт период, начинающийся в среду).
 */
const AS_OF = ((): string => {
  for (let offset = 2; offset <= 6; offset += 1) {
    const day = shiftDateKey(MONDAY, offset);
    const period = TERM_PERIODS.find((p) => p.from <= day && day <= p.to);
    if (period && period.from < day) return day;
  }
  throw new Error('в текущей неделе не нашлось дня, у которого период листа начался бы раньше');
})();

/** Диспетчер: `waybills.correct` есть, предел тридцати дней остаётся. */
const DISPATCHER: AccessSubject = { role: 'dispatcher' };

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  crew: typeof AssignmentCrew;
  command: typeof AssignmentCommand;
  esm2: typeof Esm2;
  esm2Plan: typeof Esm2Plan;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  const { db, closeDb } = await import('../src/db/client');
  ctx = {
    db,
    closeDb,
    crew: await import('../src/services/assignment-crew'),
    command: await import('../src/services/assignment-command'),
    esm2: await import('../src/services/waybill-esm2'),
    esm2Plan: await import('../src/services/esm2-plan'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

// ── Сцена ──

interface Scene {
  requestId: string;
  userId: string;
  vehicleA: string;
  /** Машинист без документов: ни СНИЛСа, ни удостоверения — лист выйдет с предупреждением. */
  gapped: string;
  /** Машинист с полным комплектом: его лист чист, и подтверждать по нему нечего. */
  documented: string;
  /** Второй человек с полным комплектом: им меняют первого, когда нужен разрез без предупреждений. */
  documentedTwo: string;
}

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/**
 * Заказ спецтехники в работе: собственная машина на весь срок, история материализована, бумага
 * выписана на все периоды срока.
 *
 * Бумага выписывается **расчётом от начала срока**, а не от дня команды: иначе прошедший период
 * листа не получил бы вовсе, и разрез недели проверять было бы не на чем.
 */
async function inScene<T>(
  run: (tx: SceneTx, scene: Scene) => Promise<T>,
  options: { initial?: 'gapped' | 'documented' } = {},
): Promise<T> {
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
        VALUES (${`esm2-warn-${RUN}@example.invalid`}, 'Историев', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const spec = await one(sql`SELECT id FROM specializations WHERE code = 'driver'`);
      const licenseType = await one(
        sql`SELECT id FROM credential_types WHERE code = 'driver_license'`,
      );
      /**
       * Человек справочника. `documents: false` — карточка без СНИЛСа и без удостоверения: ровно
       * тот случай, о котором лист и предупреждает (ADR 0064). `true` — полный комплект: СНИЛС,
       * годное водительское удостоверение с реквизитами и датой выдачи.
       *
       * Специализация водителя — реализм сцены, а не требование листа: печать ФИО от неё не зависит
       * (ADR 0164), но водителем справочника человек числится именно ею.
       */
      const person = async (last: string, documents: boolean): Promise<string> => {
        const no = nextDocsNo();
        const row = await one(sql`
          INSERT INTO persons (last_name, first_name, snils)
          VALUES (${last}, 'Пров', ${documents ? `${DOCS_RUN}${no}` : ''})
          RETURNING id`);
        await tx.execute(sql`
          INSERT INTO person_specializations (person_id, specialization_id, started_on)
          VALUES (${row.id}, ${spec.id}, ${shiftDateKey(TERM_FROM, -400)})`);
        if (documents) {
          await tx.execute(sql`
            INSERT INTO person_credentials
              (person_id, credential_type_id, series, number, issued_on, expires_on)
            VALUES (${row.id}, ${licenseType.id}, '77 AA', ${`${DOCS_RUN.slice(-4)}${no}`},
                    ${shiftDateKey(TERM_FROM, -800)}, ${shiftDateKey(TERM_TO, 800)})`);
        }
        return row.id!;
      };
      const gapped = await person('Бездокументов', false);
      const documented = await person('Комплектов', true);
      const documentedTwo = await person('Сменщиков', true);
      const initial = options.initial === 'documented' ? documented : gapped;

      const request = await one(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                      assignment_history_state, assignment_history_validated_on)
        VALUES ('special_equipment', ${obj.id}, ${vehicle.vehicle_type_id}, 'confirmed',
                ${user.id}, 'materialized', ${AS_OF})
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${request.id}, ${TERM_FROM}, ${TERM_TO})`);
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        VALUES (${request.id}, ${vehicle.id}, ${vehicle.vehicle_type_id},
                ${vehicle.vehicle_type_id}, ${user.id})`);

      // История, какой её оставил бы бэкфилл: машина и человек с начала срока.
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'vehicle',
        vehicleId: vehicle.id!,
      });
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'driver',
        driverPersonId: initial,
      });

      await ctx.esm2.syncEsm2Waybills(tx, {
        requestId: request.id!,
        actor: { id: user.id! },
        reason: 'сцена теста: бумага на весь срок',
        driverPersonId: initial,
        asOf: TERM_FROM,
      });

      out = await run(tx, {
        requestId: request.id!,
        userId: user.id!,
        vehicleA: vehicle.id!,
        gapped,
        documented,
        documentedTwo,
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
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverPersonId ? 'set' : null}, 'assignment',
            ${randomUUID()})`);
}

/** Исполнитель команды — вложенная транзакция сцены: настоящая транзакция с настоящим откатом. */
const executorOf = (tx: SceneTx): AssignmentCommand.AssignmentCommandExecutor =>
  ({
    transaction: (fn: (inner: unknown) => Promise<unknown>) => tx.transaction(fn as never),
  }) as unknown as AssignmentCommand.AssignmentCommandExecutor;

function setBody(overrides: {
  driverPersonId: string;
  effectiveDate: string;
}): AssignmentCommandInput {
  return { kind: 'set', dimension: 'driver', version: 0, ...overrides } as AssignmentCommandInput;
}

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

function runCrew(
  tx: SceneTx,
  scene: Scene,
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
      actor: { ...DISPATCHER, id: scene.userId },
      input,
      asOf: AS_OF,
    }),
  );
}

/** Тело боевой команды по посчитанному предпросмотру: отпечаток, разблокировки и рукопожатия. */
function armed(
  body: AssignmentCommandInput,
  preview: { fingerprint: string; unlockFingerprint: string | null },
  extras: { acknowledgements?: Record<string, string>; reason?: string } = {},
): AssignmentCommandInput {
  return {
    ...body,
    previewFingerprint: preview.fingerprint,
    ...(preview.unlockFingerprint ? { unlockFingerprint: preview.unlockFingerprint } : {}),
    ...(extras.acknowledgements ? { acknowledgements: extras.acknowledgements } : {}),
    ...(extras.reason ? { operation: { operationId: randomUUID(), reason: extras.reason } } : {}),
  } as AssignmentCommandInput;
}

/** Рукопожатия по всем листам, которым есть что подтверждать, — так их собирает и окно. */
const acknowledgementsOf = (
  issues: {
    issueKey: number;
    warnings: unknown[];
    warningFingerprint: string;
  }[],
): Record<string, string> =>
  Object.fromEntries(
    issues
      .filter((issue) => issue.warnings.length > 0)
      .map((issue) => [String(issue.issueKey), issue.warningFingerprint]),
  );

const errorOf = async (
  run: () => Promise<unknown>,
): Promise<Error & { code?: string; statusCode?: number }> => {
  try {
    await run();
  } catch (e) {
    return e as Error & { code?: string; statusCode?: number };
  }
  throw new Error('ожидался отказ, а команда прошла');
};

// ── Чтение состояния ──

interface SheetRow {
  id: string;
  period_from: string;
  period_to: string;
  driver_person_id: string;
  status: string;
  issue_warnings: { status?: string; fingerprint?: string; warnings?: unknown[] } | null;
}

async function sheetsOf(tx: SceneTx, requestId: string): Promise<SheetRow[]> {
  return (
    await tx.execute<SheetRow>(sql`
      SELECT id, period_from, period_to, driver_person_id, status, issue_warnings
        FROM waybills
       WHERE source_request_id = ${requestId}
       ORDER BY period_from, id`)
  ).rows;
}

const liveSheets = (rows: readonly SheetRow[]): SheetRow[] =>
  rows.filter((row) => row.status !== 'cancelled');

// ── Основной прогон: бумагу выпускает сам план ──

describeReadModes(
  readMode,
  'предупреждения и рукопожатия по листам (§7, Б4)',
  () => {
    it('предпросмотр называет предупреждения по каждому листу — и молчит там, где их нет', async () => {
      if (!readMode.enabled) return;
      await inScene(async (tx, scene) => {
        const body = setBody({ effectiveDate: AS_OF, driverPersonId: scene.documented });
        const preview = await previewCrew(tx, scene, body);

        // Набор идёт по тем же ключам и в том же порядке, что и сам план: `issueKey` — индекс в
        // нём, и по этому ключу человек подтверждает бумагу.
        expect(preview.issues.map((issue) => issue.issueKey)).toEqual(
          preview.plan.issue.map((issue) => issue.issueKey),
        );
        expect(preview.issues.length).toBeGreaterThan(0);

        const byKey = new Map(preview.plan.issue.map((issue) => [issue.issueKey, issue]));
        const warned = preview.issues.filter((issue) => issue.warnings.length > 0);
        const clean = preview.issues.filter((issue) => issue.warnings.length === 0);

        /*
         * Разрез недели оставляет пн–вт прежнему человеку, у которого документов нет вовсе, а ср–вс
         * отдаёт человеку с полным комплектом: у одной команды оба случая сразу, и окно обязано
         * различать их по листам, а не по команде.
         */
        expect(warned.length).toBeGreaterThan(0);
        expect(clean.length).toBeGreaterThan(0);
        for (const issue of warned) {
          expect(byKey.get(issue.issueKey)!.driverPersonId).toBe(scene.gapped);
          // Предупреждение у ЭСМ-2 ровно одно возможное — пробелы в документах машиниста (ADR 0064),
          // и факты в нём называют, чего именно не хватает: по фактам берётся и отпечаток.
          expect(issue.warnings).toHaveLength(1);
          expect(issue.warnings[0]!.facts).toMatchObject({ code: 'driver_documents' });
          expect(issue.warningFingerprint).toMatch(/^[0-9a-f]{64}$/);
        }
        for (const issue of clean) {
          expect(byKey.get(issue.issueKey)!.driverPersonId).toBe(scene.documented);
        }
      });
    });

    it('без рукопожатия команда отвергается, с рукопожатием проходит, и лист помнит подпись', async () => {
      if (!readMode.enabled) return;
      await inScene(async (tx, scene) => {
        const before = await sheetsOf(tx, scene.requestId);
        const body = setBody({ effectiveDate: AS_OF, driverPersonId: scene.documented });
        const preview = await previewCrew(tx, scene, body);

        /*
         * 409, а не 422: отказано не запросу, а его неподтверждённости — окно обязано показать
         * свежий набор и спросить подпись, а не сказать «поле лишнее».
         */
        const refusal = await errorOf(() => runCrew(tx, scene, armed(body, preview)));
        expect(refusal.statusCode).toBe(409);
        expect(refusal.code).toBe('waybill_ack_required');
        // Ни один номер не сгорел и ни один не выписан: до шага 12 команда не дошла.
        expect(await sheetsOf(tx, scene.requestId)).toEqual(before);

        const acknowledgements = acknowledgementsOf(preview.issues);
        const outcome = await runCrew(tx, scene, armed(body, preview, { acknowledgements }));
        expect(outcome.repeated).toBe(false);

        /*
         * Смотрим **выписанные этой командой** листы, а не все действующие: отработанный период
         * прошлой недели команда не трогает вовсе (Р11), и его бланк остался при том, с чем его
         * выдала сцена, — утверждать по нему что-либо о рукопожатии значило бы проверять декорации.
         */
        const known = new Set(before.map((row) => row.id));
        const issued = liveSheets(await sheetsOf(tx, scene.requestId)).filter(
          (row) => !known.has(row.id),
        );
        const signed = issued.filter((row) => row.driver_person_id === scene.gapped);
        const clean = issued.filter((row) => row.driver_person_id === scene.documented);
        expect(signed.length).toBeGreaterThan(0);
        expect(clean.length).toBeGreaterThan(0);

        /*
         * Подпись живёт в самом листе (Р21): есть бланк — есть и то, под чем его подписали. Прежде
         * такой лист уходил с умолчанием колонки `not_checked` — «выдан мимо рукопожатия», — даже
         * когда человек всё подтвердил секунду назад.
         */
        for (const row of signed) {
          expect(row.issue_warnings?.status).toBe('acknowledged');
          expect(row.issue_warnings?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
          expect(row.issue_warnings?.warnings).toHaveLength(1);
        }
        // Чистый бланк помнит, что проверка была, а предупреждений не нашлось.
        for (const row of clean) expect(row.issue_warnings?.status).toBe('clean');
      });
    });

    it('чистый бланк проходит без единой записи рукопожатия', async () => {
      if (!readMode.enabled) return;
      await inScene(
        async (tx, scene) => {
          const body = setBody({ effectiveDate: AS_OF, driverPersonId: scene.documentedTwo });
          const preview = await previewCrew(tx, scene, body);
          // Подтверждать нечего: у обоих людей комплект полный, и требовать подпись под пустотой
          // значило бы просить её ни о чём.
          expect(preview.issues.every((issue) => issue.warnings.length === 0)).toBe(true);

          const outcome = await runCrew(tx, scene, armed(body, preview));
          expect(outcome.repeated).toBe(false);
          const live = liveSheets(await sheetsOf(tx, scene.requestId));
          expect(live.every((row) => row.issue_warnings?.status === 'clean')).toBe(true);
        },
        { initial: 'documented' },
      );
    });

    it('изменение предупреждений обесценивает старое рукопожатие — при том же отпечатке последствий', async () => {
      if (!readMode.enabled) return;
      await inScene(async (tx, scene) => {
        const body = setBody({ effectiveDate: AS_OF, driverPersonId: scene.documented });
        const before = await previewCrew(tx, scene, body);
        const stale = acknowledgementsOf(before.issues);

        // Кадры дозаполнили карточку: пробелов стало меньше — то есть набор, который человек
        // прочитал в окне, больше не описывает положение дел.
        await tx.execute(
          sql`UPDATE persons SET snils = ${`${DOCS_RUN}${nextDocsNo()}`} WHERE id = ${scene.gapped}`,
        );

        const after = await previewCrew(tx, scene, body);
        /*
         * План не изменился — и `previewFingerprint` этого случая не ловит вовсе: в него входят
         * последствия команды, а не содержание бланка. Ловит его рукопожатие, и потому оно и
         * считается с фактов, а не с текста.
         */
        expect(after.fingerprint).toBe(before.fingerprint);
        const changed = after.issues.filter((issue) => issue.warnings.length > 0);
        expect(changed.length).toBeGreaterThan(0);
        for (const issue of changed) {
          expect(issue.warningFingerprint).not.toBe(
            before.issues.find((old) => old.issueKey === issue.issueKey)!.warningFingerprint,
          );
        }

        const refusal = await errorOf(() =>
          runCrew(tx, scene, armed(body, after, { acknowledgements: stale })),
        );
        expect(refusal.statusCode).toBe(409);
        expect(refusal.code).toBe('waybill_ack_required');

        // Со свежим рукопожатием та же команда проходит: подтверждено то, что есть на самом деле.
        const outcome = await runCrew(
          tx,
          scene,
          armed(body, after, { acknowledgements: acknowledgementsOf(after.issues) }),
        );
        expect(outcome.repeated).toBe(false);
      });
    });

    it('подтверждение под листом, которому подтверждать нечего, — 422', async () => {
      if (!readMode.enabled) return;
      await inScene(async (tx, scene) => {
        const body = setBody({ effectiveDate: AS_OF, driverPersonId: scene.documented });
        const preview = await previewCrew(tx, scene, body);
        const cleanKey = preview.issues.find((issue) => issue.warnings.length === 0)!.issueKey;

        const refusal = await errorOf(() =>
          runCrew(
            tx,
            scene,
            armed(body, preview, {
              acknowledgements: {
                ...acknowledgementsOf(preview.issues),
                [String(cleanKey)]: 'a'.repeat(64),
              },
            }),
          ),
        );
        expect(refusal.statusCode).toBe(422);
      });
    });

    it('исполнитель не считает предупреждения сам: план без посчитанных листов не выписывает ничего', async () => {
      if (!readMode.enabled) return;
      await inScene(async (tx, scene) => {
        const before = await sheetsOf(tx, scene.requestId);
        /*
         * Ровно тот случай, ради которого готовые листы объявлены обязательными: не найдя своего
         * `issueKey`, исполнитель обязан упасть, а не посчитать снимок и предупреждения здесь.
         * Второй расчёт был бы не виден вслух — он проявился бы тем, что человек подтвердил один
         * набор, а в бланк строгой отчётности лёг другой.
         */
        const plan = ctx.esm2Plan.esm2ScopedPlan({
          scope: [],
          cancel: [],
          issue: [
            {
              from: NEXT,
              to: shiftDateKey(NEXT, 6),
              vehicleId: scene.vehicleA,
              driverPersonId: scene.gapped,
            },
          ],
          trim: [],
          withCorrectionLinks: false,
        });
        const failure = await errorOf(() =>
          ctx.esm2.applyEsm2SyncPlanAndAudit(tx, plan, {
            kind: 'ordinary',
            requestId: scene.requestId,
            actorUserId: scene.userId,
            syncReason: 'тест: план без посчитанных листов',
            issues: new Map(),
          }),
        );
        expect(failure.message).toMatch(/без посчитанного листа/);
        expect(await sheetsOf(tx, scene.requestId)).toEqual(before);
      });
    });
  },
  { modes: ['history'] },
);

// ── Режим `legacy`: показываем, но не требуем ──

it('в `legacy` предупреждения показываются, а рукопожатия не спрашиваются', async () => {
  if (!readMode.enabled) return;
  await inLegacy(readMode, async () => {
    await inScene(
      async (tx, scene) => {
        /*
         * Дата — граница периода: такую команду воспроизводит и недельная сверка, а разрез посреди
         * недели в `legacy` отвергает гейт совместимости. Предмет случая — рукопожатие, а не разрез.
         *
         * Люди в сцене поменяны местами нарочно: заказ вёл человек с полным комплектом, а назначают
         * того, у кого документов нет, — иначе вся переписываемая бумага вышла бы чистой, и
         * утверждать было бы не о чем.
         */
        const body = setBody({ effectiveDate: MONDAY, driverPersonId: scene.gapped });
        const preview = await previewCrew(tx, scene, body);
        // Предупреждения считает план — и в `legacy` тоже: человек вправе видеть, с какими пробелами
        // уйдёт бумага, даже когда переписывает её недельная сверка.
        expect(preview.issues.some((issue) => issue.warnings.length > 0)).toBe(true);

        /*
         * А вот требовать подпись здесь нельзя: бумагу выпускает сверка, у которой просителя нет
         * вовсе, и неполный комплект документов её не останавливает (ADR 0064). Потребуй дверь
         * рукопожатие — заперлась бы сегодняшняя работа портала, у которого окна для него ещё нет.
         */
        const outcome = await runCrew(
          tx,
          scene,
          armed(body, preview, { reason: 'проверка: смена машиниста прошедшей датой' }),
        );
        expect(outcome.repeated).toBe(false);
        expect(liveSheets(await sheetsOf(tx, scene.requestId)).length).toBeGreaterThan(0);
      },
      { initial: 'documented' },
    );
  });
});
