import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  can,
  correctionFloorDateKey,
  repairSchema,
  uuidSchema,
  type AssignmentHistoryState,
  type AssignmentPreviewDto,
  type RepairInput,
  type WaybillCorrectionAuthorizationScope,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import { db } from '../db/client';
import { vehicleRequestAssignments, vehicleRequests } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { AuditEntry } from '../lib/audit';
import { AppError, err } from '../lib/errors';
import {
  previewAssignmentCommand,
  runAssignmentCommand,
  type AssignmentPlanContext,
  type AssignmentPlanned,
  type LockedVehicleRequest,
} from '../services/assignment-command';
import { assignmentCommandEffects, type AssignmentEffects } from '../services/assignment-effects';
import {
  assignmentHistoryUnrestorableReason,
  ensureCommandHistory,
  planAssignmentHistory,
  type AssignmentHistoryUnrestorable,
} from '../services/assignment-ensure';
import {
  assertKnownFillsAllowed,
  blockedDaysOf,
  blockerFactsOf,
  blockerFingerprintOf,
  fillableGapsOf,
  isPaperFree,
  mutableRangesOf,
  planRepair,
  readRepairContext,
  repairHistoryState,
  repairPaperPlan,
  requiredAnchorsOf,
  requiredUnlocksOf,
  tailMismatchOf,
  type AssignmentBlockerFact,
  type RepairContext,
  type RepairPlan,
} from '../services/assignment-repair';
import { applyAssignmentMutations, type AssignmentWriteResult } from '../services/assignment-write';
import { assignmentSegments } from '../services/assignment-history';
import { correctionFingerprint } from '../services/waybill-correction';
import type { Esm2SheetPlan } from '../services/esm2-plan';

/**
 * Дверь ремонта истории назначения — `POST /vehicle-requests/:id/assignment-changes/repair`
 * и `.../repair/preview` (`docs/assignment-periods-plan.md`, Р25–Р31; решения Ц3, Ц4, Х1, Ф1).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ РОУТ-МОДУЛЬ, А НЕ ВЕТКА `vehicle-request-assignment.ts`. Тот файл — общая шапка
 * дверей истории и место команды машиниста; двери волны 3.2 пишутся параллельно, и один файл на
 * троих означал бы конфликт при любом порядке работ (§16.1). Префикс тот же —
 * `/api/v1/vehicle-requests`: адреса портала от разделения не меняются, а третий плагин на одном
 * префиксе — приём не новый (`vehicle-readings` и `vehicle-readings-stats` стоят так же).
 *
 * ПРАВА — УСЛОВНЫЙ КОНТРАКТ (Р29), и безусловного guard'а на маршруте у него только пара:
 *
 * ```
 * всегда:                    vehicleRequests.status + waybills.read
 * needsCorrection (Р32):     + waybills.correct
 *   └─ и глубже 30 дней:     + waybills.correctBeyondLimit
 * заявка в архиве:           ничего дополнительно — доступ по идентификатору (Ц3)
 * режим restore: true:       + archive.restore
 * ```
 *
 * Условные права спрашиваются шагом 9 канона — под блокировкой и по **посчитанному** исходу, а не
 * по составу тела: полностью дремлющая команда, даже с якорем, коррекционных прав не просит, иначе
 * диспетчер не мог бы разрешить продление только из-за того, что `dateTo + 1` старше тридцати дней.
 *
 * АРХИВНАЯ ЗАЯВКА ОТКРЫВАЕТСЯ ПО ИДЕНТИФИКАТОРУ И БЕЗ `archive.read` (Ц3) — осознанное отступление
 * от общей модели доступа, и оно ограничено: дверь не показывает архив ни в списках, ни в поиске,
 * запрошенный идентификатор и результат идут в аудит, а **вывод из архива** по-прежнему требует
 * `archive.restore`. Право `archive.read` означает «видит удалённые записи» во всём модуле записей,
 * то есть открыло бы диспетчеру весь архив портала; альтернатива «ремонт архива только
 * администратором» возвращала бы диспетчера к просьбе позвать администратора ровно в том случае,
 * ради которого дверь и заведена.
 *
 * ЧЕГО ДВЕРЬ НЕ ДЕЛАЕТ. Бумаги: шаг 12 канона (`applyEsm2SyncPlanAndAudit`) пуст у **всех** дверей
 * волны 3.2 — вместе с ним уходят шесть внешних вызовов `auditEsm2Sync`, и наполнять его в одиночку
 * значило бы получить либо двойное событие, либо старое нетранзакционное окно. План листов при этом
 * **считается**: без него не выразить ни «paper-free по расчёту, а не по статусу архива» (Р29), ни
 * предпросмотр. Отмены дремлющей tail-группы здесь тоже нет — она идёт общей командой `cancel`
 * (Р13), и `repairSchema` формы `cancel` не имеет вовсе.
 */

const idParams = z.object({ id: uuidSchema });

/** Имя двери в цели операции журнала (Р9): у ремонта и у команды машиниста тела бывают неотличимы. */
const JOURNAL_DOOR = 'assignment-changes/repair';

/**
 * Ответ ремонта: общие последствия модуля плюс то, что есть только у этой двери.
 *
 * Состояние готовности и блокеры отдаются вместе с планом, а не отдельной ручкой: человек чинит
 * историю ради `ready`, и «сколько осталось» — часть того же ответа. Второй запрос за этим означал
 * бы, что между ними состояние успевает измениться.
 */
interface RepairPreviewDto extends AssignmentPreviewDto {
  /** Состояние истории **сейчас** (Р26): `materialized` — чинить есть что. */
  state: AssignmentHistoryState;
  /** Каким станет состояние, если нажать (Р27). */
  stateAfter: AssignmentHistoryState;
  /** Блокеры до команды интервалами — проекция для карточки, а не единица сравнения. */
  blockedDays: { from: string; to: string }[];
  /** Промежутки `unknown` на заблокированных днях — адреса `knownFills` (Ц4). */
  fillableGaps: { from: string; to: string }[];
  /** Заявка в архиве: дверь открыла её по идентификатору (Ц3). */
  archived: boolean;
  /** Пуст ли бумажный план для гипотетического `deleted_at = null` (Р29). */
  paperFree: boolean;
  /** Архивной заявке с непустым планом ремонт разрешён только режимом `restore` (Р29). */
  restoreRequired: boolean;
}

/** Итог боевой ручки: чем кончилось и в каком состоянии осталась история. */
interface RepairResultDto {
  ok: true;
  repeated: boolean;
  version: number;
  state: AssignmentHistoryState;
  operationId: string | null;
  archived: boolean;
}

export default async function vehicleRequestAssignmentRepairRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  /**
   * Безусловная пара — та же, что у всех боевых дверей истории (§8, ADR 0050 п. 11).
   * `waybills.read` обязателен и здесь: рабочий путь идёт через предпросмотр — он показывает номера
   * бланков и фамилии парка, — и роль без этого права упиралась бы в 403 посреди операции.
   */
  const guards = {
    preHandler: [
      app.authenticate,
      app.requirePermission('vehicleRequests.status'),
      app.requirePermission('waybills.read'),
    ],
  };

  /**
   * Предпросмотр ремонта: что случится, если нажать, — и ни одной записи (Р20).
   *
   * Тело то же, что у боевой ручки (§8): расчёт обязан идти по тем входам, по которым его потом
   * исполнит боевая ручка, а вторая схема разошлась бы с первой на первом же новом поле.
   * Предпросмотр двухфазен: первый вызов без якорей называет `requiredAnchors`, второй — с
   * именами — отдаёт окончательный план и отпечаток.
   */
  r.post(
    '/:id/assignment-changes/repair/preview',
    { ...guards, schema: { params: idParams, body: repairSchema } },
    async (req): Promise<RepairPreviewDto> => {
      const p = requirePrincipal(req);
      const body = req.body as RepairInput;
      // Механический запрет — до всякого расчёта и одинаковый у обеих ручек (Х1): предпросмотр,
      // показавший план заполнения, обещал бы то, чего боевая ручка не сделает.
      assertKnownFillsAllowed(body.mode === 'repair' ? body.knownFills : undefined);

      const outcome = await previewAssignmentCommand(db, {
        requestId: req.params.id,
        actor: { id: p.id },
        plan: (ctx) => planRepairCommand(ctx, body),
      });
      return previewDto(outcome.plan, outcome.effects, outcome.fingerprint, outcome.request);
    },
  );

  /**
   * Ремонт истории. Порядок транзакции — канон §8 целиком, и ни один его шаг здесь не повторён:
   * гейт, блокировки, повтор по ключу, версия, отпечаток, журнал, аудит и инкремент версии
   * принадлежат `runAssignmentCommand`, а дверь заполняет его предметные места.
   */
  r.post(
    '/:id/assignment-changes/repair',
    { ...guards, schema: { params: idParams, body: repairSchema } },
    async (req): Promise<RepairResultDto> => {
      const p = requirePrincipal(req);
      const body = req.body as RepairInput;
      assertKnownFillsAllowed(body.mode === 'repair' ? body.knownFills : undefined);
      const restore = body.restore === true;

      let state: AssignmentHistoryState = 'materialized';
      const outcome = await runAssignmentCommand<RepairPlan & RepairComputed, RepairApplied, void>(
        db,
        {
          door: 'history',
          journalDoor: JOURNAL_DOOR,
          requestId: req.params.id,
          actor: { id: p.id },
          expectedVersion: body.version,
          body,
          operation: body.operation ?? null,
          previewFingerprint: body.previewFingerprint,
          plan: (ctx) => planRepairCommand(ctx, body),
          handshake: (ctx) => {
            /*
             * Р29: paper-free определяется расчётом, а не архивным статусом. Мягкое удаление сверку
             * не зовёт, поэтому листы, выписанные до архивирования, остаются действующими, и «в
             * архиве `esm2Mode` = none» ничего не говорит о бумаге. Иначе получалось бы так: в
             * архиве лежит лист `A + Иван`, ремонт «бесплатно» правит историю на `B + Петров`,
             * restore снимает архив — и живая заявка расходится с действующим бланком, причём
             * сверки может не случиться ещё месяц.
             *
             * Отказ стоит здесь, а не в расчёте: предпросмотр обязан **показать** человеку, что
             * нужен режим восстановления, а не ответить ему отказом вместо плана.
             */
            if (ctx.plan.restoreRequired && !restore) {
              throw err.unprocessable(
                'Ремонт разошёлся бы с действующими бланками архивной заявки — включите режим восстановления',
                { restore: 'Требуется восстановление' },
              );
            }
            // Р31: у архивной заявки решение хвоста без восстановления создало бы дремлющую группу,
            // править и отменять которую нужно общей дверью, а у неё архивной области нет.
            if (ctx.request.deletedAt && ctx.plan.summary.tail !== null && !restore) {
              throw err.unprocessable(
                'Решение о машине после конца срока у архивной заявки принимается только вместе с восстановлением — включите режим восстановления',
                { restore: 'Требуется восстановление' },
              );
            }
            // Рукопожатие по разблокировкам (Р11): отпечаток серверного множества, а не список —
            // заказ живёт годами, и предел в 53 листа делал бы законную команду невыполнимой.
            const required = ctx.plan.unlockFingerprint;
            if (required === null) {
              if (body.unlockFingerprint !== undefined) {
                throw err.unprocessable(
                  'Этот ремонт не переоформляет ни одного выписанного листа — подтверждать нечего. Посмотрите последствия заново и повторите команду без подтверждения',
                  { unlockFingerprint: 'Лишнее подтверждение' },
                );
              }
              return;
            }
            if (body.unlockFingerprint !== required) {
              throw err.unprocessable(
                'Список переоформляемых бланков изменился — посмотрите последствия заново',
                { unlockFingerprint: 'Подтвердите заново' },
              );
            }
          },
          authorize: (ctx) => authorizeRepair(p, ctx.effects, ctx.asOf, restore, ctx.request),
          authorizeRepeat: (scope) => authorizeRepeatRepair(p, scope),
          mutate: async (ctx) => {
            /*
             * Шаг 11 открывается материализацией истории (Р20, Р26): расчёт шага 5 уже показал,
             * какой она станет, — здесь эти строки ложатся в базу, и обязательно **до** мутаций
             * ремонта: якорь заменяет как раз одну из них. Готовность, записанную этим вызовом,
             * ниже перепишет `stateAfter` — она посчитана по истории уже **после** ремонта.
             */
            await ensureCommandHistory(ctx.tx, {
              requestId: ctx.request.id,
              asOf: ctx.asOf,
            });
            const write = await applyAssignmentMutations(ctx.tx, {
              requestId: ctx.request.id,
              actorUserId: p.id,
              correctionId: ctx.operation?.id ?? null,
              mutations: ctx.plan.writeMutations,
              denormalization: ctx.plan.denormalization,
            });
            // Назначение переводится своим полным путём — Р17 требует именно его, а ядро сверит
            // результат по живому состоянию в конце шага 11.
            if (ctx.plan.assignmentUpdate) {
              const update = ctx.plan.assignmentUpdate;
              await ctx.tx
                .update(vehicleRequestAssignments)
                .set({
                  vehicleId: update.vehicleId,
                  vehicleTypeId: update.vehicleTypeId,
                  pricePerHour: update.pricePerHour === null ? null : String(update.pricePerHour),
                  pricePerShift:
                    update.pricePerShift === null ? null : String(update.pricePerShift),
                  shiftHours: update.shiftHours,
                  assignedBy: p.id,
                  assignedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(vehicleRequestAssignments.requestId, ctx.request.id));
            }
            // Архив снимается **той же транзакцией** (Р29): половинчатого исхода «историю
            // починили, а архив не сняли» не бывает, и второй ручкой это состояние не закрыть.
            if (restore && ctx.request.deletedAt) {
              await ctx.tx
                .update(vehicleRequests)
                .set({ deletedAt: null, deletedBy: null })
                .where(eq(vehicleRequests.id, ctx.request.id));
            }
            // Готовность пишется здесь и только здесь (Р26): состояние — вывод из проверенных
            // последствий, считать его до мутаций нечего, а после снимка операции поздно.
            state = ctx.plan.stateAfter;
            await ctx.tx
              .update(vehicleRequests)
              .set({
                assignmentHistoryState: state,
                assignmentHistoryValidatedOn: ctx.asOf,
                assignmentHistoryDirty: false,
              })
              .where(eq(vehicleRequests.id, ctx.request.id));
            return { write, applied: { write, state } };
          },
          payload: (ctx) => ({
            repair: ctx.plan.summary,
            restore,
            blockersBefore: ctx.plan.blockerFingerprint,
            stateBefore: ctx.plan.stateBefore,
            stateAfter: ctx.plan.stateAfter,
          }),
          audit: (ctx) => auditOf(ctx.request, p.id, ctx.plan, restore),
        },
      );

      if (outcome.repeated) {
        const [row] = await db
          .select({
            state: vehicleRequests.assignmentHistoryState,
            deletedAt: vehicleRequests.deletedAt,
          })
          .from(vehicleRequests)
          .where(eq(vehicleRequests.id, req.params.id));
        return {
          ok: true,
          repeated: true,
          version: outcome.version,
          state: row?.state ?? 'materialized',
          operationId: outcome.operation?.operationId ?? null,
          archived: row?.deletedAt != null,
        };
      }

      return {
        ok: true,
        repeated: false,
        version: outcome.version,
        state,
        operationId: outcome.operation?.operationId ?? null,
        archived: false,
      };
    },
  );
}

// ── Расчёт двери: шаги 4–6 канона ──

/** Что дверь донесла из расчёта до рукопожатий, авторизации и мутаций. */
interface RepairComputed {
  /**
   * Состояние истории, из которого дверь исходила (Р26), — **расчётное**, а не то, что стоит в
   * колонке. У заказа, историю которого материализует этот же запрос, колонка ещё говорит `empty`,
   * а работает дверь по восстановленной истории: снимок операции и карточка обязаны называть то,
   * что было на самом деле.
   */
  stateBefore: AssignmentHistoryState;
  stateAfter: AssignmentHistoryState;
  blockerFingerprint: string;
  blockersBefore: AssignmentBlockerFact[];
  paperPlan: Esm2SheetPlan;
  paperFree: boolean;
  restoreRequired: boolean;
  unlockFingerprint: string | null;
  context: RepairContext;
  preview: {
    requiredAnchors: ReturnType<typeof requiredAnchorsOf>;
    requiredVehicleResolution: ReturnType<typeof tailMismatchOf>;
    fillableGaps: { from: string; to: string }[];
    blockedDays: { from: string; to: string }[];
  };
}

interface RepairApplied {
  write: AssignmentWriteResult;
  state: AssignmentHistoryState;
}

/**
 * Шаги 4–6: чтение истории и листов, допуск двери, план, блокеры, бумага и отпечаток.
 *
 * Один колбэк на обе ручки — тот же объект уходит и в предпросмотр, и в бой (§8). Транзакция здесь
 * читающая: записать историю раньше проверок значило бы оставить в базе состояние, которое сама же
 * команда сейчас отвергнет (Р20).
 */
async function planRepairCommand(
  ctx: AssignmentPlanContext,
  body: RepairInput,
): Promise<AssignmentPlanned<RepairPlan & RepairComputed>> {
  const { request, term, asOf } = { request: ctx.request, term: ctx.request.term, asOf: ctx.asOf };
  /*
   * Шаг 5 канона в его расчётной половине (Р20): готовность истории **считается**, а не пишется.
   * До этой волны дверь читала строки напрямую и отказывала заказу, заведённому до модуля, — то
   * есть ровно тому, ради которого ремонт и заведён. Теперь история берётся у автомата готовности:
   * восстановилась — чиним восстановленное, не восстановилась — отказ с названной причиной.
   * Записывает эти же строки шаг 11.
   */
  const history = await planAssignmentHistory(ctx.tx, { requestId: request.id, asOf });
  const stateBefore = history.state;
  const context = await readRepairContext(ctx.tx, request.id, history.changes);
  const restore = body.restore === true;

  assertRepairDoorOpen(stateBefore, history.unrestorable, body);
  const plan = planRepair({ context, term, asOf, request, body });

  const mutable = mutableRangesOf(term, context.sheets, asOf);
  const segmentsBefore = assignmentSegments(context.changes, term);
  const segmentsAfter = assignmentSegments(plan.changesAfter, term);
  const blockersBefore = blockerFactsOf(segmentsBefore, term, context.ownershipByVehicle, mutable);
  const blockersAfter = blockerFactsOf(segmentsAfter, term, context.ownershipByVehicle, mutable);
  // Р27: исход считается сравнением множеств, и отказ здесь — до единой записи.
  const stateAfter = repairHistoryState(blockersBefore, blockersAfter);

  const effects = assignmentCommandEffects({
    changes: context.changes,
    term,
    asOf,
    mutations: plan.effectMutations,
    sheets: context.sheets,
  });

  const paperPlan = repairPaperPlan(context, plan.changesAfter, term, asOf);
  const paperFree = isPaperFree(paperPlan);
  // Р29: paper-free определяется расчётом, а не архивным статусом. Мягкое удаление сверку не
  // зовёт, поэтому листы, выписанные до архивирования, остаются действующими, и «в архиве
  // `esm2Mode` = none» ничего не говорит о бумаге.
  const restoreRequired = request.deletedAt !== null && !paperFree;

  const unlocks = requiredUnlocksOf(context, paperPlan, effects.paperScope);
  const unlockFingerprint =
    unlocks.length === 0 ? null : correctionFingerprint(unlocks.map((sheet) => sheet.id).sort());

  const blockerFingerprint = blockerFingerprintOf(blockersBefore);
  const computed: RepairComputed = {
    stateBefore,
    stateAfter,
    blockerFingerprint,
    blockersBefore,
    paperPlan,
    paperFree,
    restoreRequired,
    unlockFingerprint,
    context,
    preview: {
      requiredAnchors: requiredAnchorsOf(
        request,
        segmentsBefore,
        term,
        context.ownershipByVehicle,
        mutable,
      ),
      requiredVehicleResolution: tailMismatchOf(context, term),
      // Адреса `knownFills` (Ц4): `unknown` на заблокированных днях. На изменяемых днях та же
      // дыра чинится обычным путём якорей, и второго способа назвать человека там не заводится.
      fillableGaps: fillableGapsOf(segmentsBefore, term, context.ownershipByVehicle, mutable),
      blockedDays: blockedDaysOf(blockersBefore),
    },
  };

  return {
    effects,
    /*
     * Отпечаток последствий (Р20, Р27): содержание команды, её последствия **и** множество
     * блокеров до неё. Блокеры входят потому, что человек соглашался чинить одно состояние, а
     * команда исполняется над тем, что застала: сравнение `after \ before` над другим `before`
     * ответило бы на другой вопрос. Идентификаторов расчётной истории в отпечатке нет — их у неё
     * не существует до записи.
     */
    fingerprint: correctionFingerprint({
      door: JOURNAL_DOOR,
      requestId: request.id,
      asOf,
      effects: effects.payload,
      summary: plan.summary,
      stateAfter,
      blockersBefore: blockerFingerprint,
      paper: {
        cancel: [...paperPlan.cancel].sort(),
        issue: paperPlan.issue.map((sheet) => ({
          from: sheet.from,
          to: sheet.to,
          vehicleId: sheet.vehicleId,
          driverPersonId: sheet.driver.personId,
        })),
      },
      unlockFingerprint,
      restore,
    }),
    plan: { ...plan, ...computed },
  };
}

/**
 * Кого дверь пускает (Р29): `materialized` — всегда, `ready` — только ради хвоста.
 *
 * `empty` отвергается: истории нет вовсе, и чинить нечего — её строит `ensureAssignmentHistory`.
 * Допуск `ready` не умолчание, а решение: после первого решения хвоста признак расхождения
 * исчезает, заявка становится `ready`, и допуск «только при mismatch» сделал бы переключение на
 * `history_wins` недостижимым.
 */
function assertRepairDoorOpen(
  state: AssignmentHistoryState,
  unrestorable: readonly AssignmentHistoryUnrestorable[],
  body: RepairInput,
): void {
  if (state === 'empty') {
    throw err.unprocessable(
      `История этой заявки ещё не построена и не восстанавливается: ${assignmentHistoryUnrestorableReason(unrestorable)}`,
      undefined,
      { state: 'empty' },
    );
  }
  if (state !== 'ready') return;
  /*
   * Заполнение и его отмена проходят при `ready` — обе, и по одной причине.
   *
   * Заполнять разрешено только **заблокированные** дни, а они блокерами не бывают (Р16): значит
   * `unknown` в закрытом прошлом состояния не понижает, и заявка с дырой законно числится `ready`.
   * Прежнее условие пускало сюда лишь отмену — и заполнение оказывалось недостижимым: там, где оно
   * нужно, дверь отказывала «история полна», а где дверь пускала, заполнять было нечего. Круг
   * замыкался, и не замечали его потому, что запрет по рубильнику срабатывал раньше расчёта
   * (решение владельца от 24.08.2026).
   *
   * Симметрия здесь не удобство, а смысл: заполнение не меняет решений — оно снимает признание
   * неполноты, а отмена возвращает его обратно. Запрещать одно на полной истории, разрешая другое,
   * значит уметь снять утверждение и не уметь его сделать.
   */
  const tailOnly =
    body.mode === 'repair' && body.tailResolution !== undefined && !body.anchors && !body.knownFills;
  const fillOnly = body.mode === 'repair' && body.knownFills !== undefined && !body.anchors;
  if (!tailOnly && !fillOnly && body.mode !== 'cancel_fill') {
    throw new AppError(
      422,
      'assignment_history_ready',
      'История заявки полна: ремонтировать в ней нечего, кроме решения о машине после конца срока, заполнения неизвестных дней и его отмены',
    );
  }
}

// ── Условная авторизация: шаг 9 канона ──

/**
 * Права считаются по **посчитанному исходу** (Р32), а не по составу тела.
 *
 * Глубина — уточнение коррекционной ветки, а не самостоятельное условие: там, где `needsCorrection`
 * ложно, прошлого не трогают вовсе, и мерить его глубину не по чему. Архивность в снимке
 * отсутствует намеренно (Ц3): дверь адресуется идентификатором и архивную область не проходит.
 */
function authorizeRepair(
  subject: Parameters<typeof can>[0],
  effects: AssignmentEffects,
  asOf: string,
  restore: boolean,
  request: LockedVehicleRequest,
): WaybillCorrectionAuthorizationScope {
  const effectiveDate = effects.correctionEffectiveDate ?? asOf;
  const requiresCorrect = effects.needsCorrection;
  const requiresCorrectBeyondLimit =
    requiresCorrect && effectiveDate < correctionFloorDateKey(asOf);
  const requiresArchiveRestore = restore;

  if (restore && !request.deletedAt) {
    throw err.unprocessable('Заявка не в архиве — восстанавливать нечего');
  }
  if (requiresCorrect && !can(subject, 'waybills.correct')) {
    throw err.forbidden(
      'Ремонт трогает прошедшие дни: нужно право на коррекцию задним числом — обратитесь к диспетчеру или администратору',
    );
  }
  if (requiresCorrectBeyondLimit && !can(subject, 'waybills.correctBeyondLimit')) {
    throw err.forbidden(
      'Такую давность правит администратор: попросите его выполнить коррекцию истории',
    );
  }
  if (requiresArchiveRestore && !can(subject, 'archive.restore')) {
    throw err.forbidden('Вывод заявки из архива — администраторское действие');
  }
  return {
    schemaVersion: 1,
    requiresCorrect,
    requiresCorrectBeyondLimit,
    requiresArchiveRestore,
    effectiveDate,
    authorizedAsOf: asOf,
  };
}

/**
 * Повтор (Р9 п. 4): цель заново не разрешается и план не считается — первая попытка предмет уже
 * изменила, — но права субъекта перепроверяются по **сохранённому** снимку. Пересчитать их нельзя:
 * операция, бывшая моложе тридцати дней при первом вызове, к повтору успевает состариться.
 */
function authorizeRepeatRepair(
  subject: Parameters<typeof can>[0],
  scope: WaybillCorrectionAuthorizationScope,
): void {
  if (scope.requiresCorrect && !can(subject, 'waybills.correct')) throw err.forbidden();
  if (scope.requiresCorrectBeyondLimit && !can(subject, 'waybills.correctBeyondLimit')) {
    throw err.forbidden();
  }
  if (scope.requiresArchiveRestore && !can(subject, 'archive.restore')) throw err.forbidden();
}

// ── Ответы ──

function previewDto(
  plan: RepairPlan & RepairComputed,
  effects: AssignmentEffects,
  fingerprint: string,
  request: LockedVehicleRequest,
): RepairPreviewDto {
  const byId = new Map(plan.context.sheets.map((sheet) => [sheet.id, sheet]));
  return {
    plan: {
      cancel: plan.paperPlan.cancel.flatMap((id) => {
        const sheet = byId.get(id);
        return sheet
          ? [
              {
                waybillId: sheet.id,
                displayNumber: sheet.displayNumber,
                from: sheet.periodFrom,
                to: sheet.periodTo,
              },
            ]
          : [];
      }),
      /*
       * Состав выпускаемого листа лежит в самом плане, а не добирается исполнителем из заявки:
       * после разреза пн–вт и ср–вс — два документа с разными машиной и человеком. Имена людей
       * здесь не подставляются: справочник читает предпросмотр портала, а фамилия, подставленная
       * сервером «по последнему листу», уезжает в бланк строгой отчётности настоящей (ADR 0083).
       */
      issue: plan.paperPlan.issue.map((sheet, index) => ({
        issueKey: index,
        from: sheet.from,
        to: sheet.to,
        vehicleId: sheet.vehicleId,
        vehicleName: plan.context.vehicleNames.get(sheet.vehicleId) ?? sheet.vehicleId,
        driverPersonId: sheet.driver.personId,
        driverName: '',
      })),
    },
    requiredAnchors: plan.preview.requiredAnchors,
    requiredVehicleResolution: plan.preview.requiredVehicleResolution,
    // Р18 меряется только обычной сменой машины (`workBlockRange`), а ремонт таких мутаций не
    // порождает вовсе: `assignment_wins` помечен `tail_resolution` и из запрета исключён.
    blockedShiftDays: [],
    clearedShiftDays: [],
    clearedShiftsFingerprint: null,
    requiredUnlocks: requiredUnlocksOf(plan.context, plan.paperPlan, effects.paperScope).map(
      (sheet) => ({
        waybillId: sheet.id,
        displayNumber: sheet.displayNumber,
        from: sheet.periodFrom,
        to: sheet.periodTo,
      }),
    ),
    unlockFingerprint: plan.unlockFingerprint,
    // Предупреждения листа считает сверка, а она приезжает шагом 12 вместе со своей волной.
    issues: [],
    operationRequirement:
      effects.operationOutcome === 'none'
        ? null
        : {
            kind: effects.operationOutcome,
            reasonRequired: true,
            operationIdRequired: true,
          },
    asOf: effects.asOf,
    fingerprint,
    state: plan.stateBefore,
    stateAfter: plan.stateAfter,
    blockedDays: plan.preview.blockedDays,
    fillableGaps: plan.preview.fillableGaps,
    archived: request.deletedAt !== null,
    paperFree: plan.paperFree,
    restoreRequired: plan.restoreRequired,
  };
}

/**
 * События портала. Их два, когда снимается архив: правка истории и восстановление — разные факты, и
 * слитые в одно событие они дали бы журнал, из которого не видно, чьим решением заявка вернулась.
 */
function auditOf(
  request: LockedVehicleRequest,
  actorUserId: string,
  plan: RepairPlan & RepairComputed,
  restore: boolean,
): AuditEntry[] {
  const entries: AuditEntry[] = [
    {
      action: 'vehicle_request.assignment_repair',
      metadata: {
        // Запрошенный идентификатор архивной заявки идёт в аудит — это условие отступления Ц3.
        archived: request.deletedAt !== null,
        stateBefore: plan.stateBefore,
        stateAfter: plan.stateAfter,
        ...plan.summary,
      },
    },
  ];
  if (restore && request.deletedAt) {
    entries.push({
      action: 'vehicle_request.restore',
      metadata: { via: JOURNAL_DOOR, actorUserId },
    });
  }
  return entries;
}
