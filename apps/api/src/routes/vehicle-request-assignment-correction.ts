import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assignmentVehicleCorrectionPreviewSchema,
  assignmentVehicleCorrectionSchema,
  uuidSchema,
  type AssignmentCorrectionPreviewDto,
  type RequestAssignmentHistoryDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import { vehicleRequestAssignments, vehicleRequests, vehicles } from '../db/schema';
import { assertLessorScope, assertRequestScope } from '../lib/access';
import { err } from '../lib/errors';
import { previewAssignmentCommand, runAssignmentCommand } from '../services/assignment-command';
import { readAssignmentHistoryDto } from '../services/assignment-crew';
import {
  correctionAsOf,
  correctionPreviewDto,
  planVehicleCorrection,
  vehicleCorrectionSpec,
  type CorrectionPaper,
  type VehicleCorrectionPlan,
} from '../services/assignment-correction';
import type { AssignmentWriteResult } from '../services/assignment-write';
import { assignmentDoorGuards, assignmentHistoryReadGuards } from './vehicle-request-assignment';

/**
 * Периодная коррекция истории назначения — `POST /vehicle-requests/:id/assignment-changes/correction`
 * и `.../correction/preview` (`docs/assignment-periods-plan.md`, Р7, Р10, Р11, Р32; §8, волна 3.3).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ РОУТ-МОДУЛЬ. Тем же приёмом, каким рядом стоят дверь машиниста и дверь ремонта
 * (§16.1): `vehicle-requests.ts` — барьерный файл в 7400 строк, которого одновременно хотят пять
 * дверей истории и четыре ручки смен, и дописанные в него двери конфликтуют при любом порядке
 * работ. Префикс тот же — `/api/v1/vehicle-requests`: адреса портала от разделения не меняются.
 *
 * ГДЕ ЭТА ДВЕРЬ ВСТРЕТИТСЯ С ОКНОМ СМЕНЫ ТЕХНИКИ. Коррекция машины **задним числом** живёт здесь, а
 * смена машины, которой заявка закрыта сейчас, — по-прежнему в `PATCH /:id/assignment` вместе со
 * ставками, арендой и рейсом (Р7). Граница проходит не по календарю, а по цели: последнее активное
 * vehicle-изменение эта дверь править отказывается и называет ту, которая его правит. Когда этап 4a
 * переведёт окно назначения на новые рукопожатия, обе двери будут звать один и тот же каркас — а
 * до тех пор общими у них остаются журнал коррекций и проекции последствий, а не код ручки.
 *
 * ПРАВА — УСЛОВНЫЙ КОНТРАКТ (Р32), и безусловного стража на маршруте у него только пара:
 *
 * ```
 * всегда:                     vehicleRequests.status + waybills.read
 * исход `crew` (Р32):         + waybills.correct
 *   └─ и глубже 30 дней:      + waybills.correctBeyondLimit
 * исход `assignment_tail`:    ничего сверх пары — прошлого команда не трогает
 * ```
 *
 * Условные права спрашивает шаг 9 канона — под блокировкой и по посчитанному исходу: из тела не
 * видно, задевает ли коррекция отработанные дни, а страж на маршруте спросил бы их у всех.
 */

const idParams = z.object({ id: uuidSchema });

/**
 * Ответ боевой ручки: состояние заявки после команды, а не отчёт о ней (Р9).
 *
 * Пересобирается из **текущего** состояния, поэтому повтор отвечает то же, что ответил бы обычный
 * запрос. Снятые подписи стоят рядом с историей намеренно: окно, сделавшее коррекцию, обязано
 * показать объекту, какие именно дни придётся принять заново.
 */
export interface AssignmentCorrectionResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  /** Дни, с которых снята подпись объекта; на повторе пусто — работы во второй раз не было. */
  clearedApprovals: string[];
  /** Ключ операции журнала; `null` — исход `none`, объяснять нечего (Р32). */
  operationId: string | null;
  history: RequestAssignmentHistoryDto;
}

/**
 * Заявка видима этой учётке.
 *
 * Область спрашивается **до** канонической транзакции и по тем же правилам, что у остальных дверей
 * заявки. Внутрь канона это не переносится: там уже держатся блокировки, и отказ по области
 * означал бы взятые и тут же отпущенные строки.
 */
async function assertVisible(p: Principal, requestId: string): Promise<void> {
  const [row] = await db
    .select({
      objectId: vehicleRequests.objectId,
      departmentId: vehicleRequests.departmentId,
      deletedAt: vehicleRequests.deletedAt,
      lessorId: vehicles.lessorId,
    })
    .from(vehicleRequests)
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .where(eq(vehicleRequests.id, requestId));
  if (!row || row.deletedAt) throw err.notFound('Заявка не найдена');
  assertRequestScope(p, row);
  // Арендодатель видит свои заявки (ADR 0038), но правка чужого прошлого — не его дело: коррекция
  // снимает подписи объекта и переписывает то, чем работали.
  assertLessorScope(p, row.lessorId);
}

export default async function vehicleRequestAssignmentCorrectionRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const readGuards = assignmentHistoryReadGuards(app);
  const writeGuards = assignmentDoorGuards(app);

  /**
   * Предпросмотр коррекции — расчёт без единой записи (Р20).
   *
   * Показывает то, ради чего у команды вообще есть рукопожатие: диапазон снятия подписей и сами
   * дни. Тело у предпросмотра то же, что у боевой ручки, и расчёт тот же колбэк — вторая копия
   * правил разошлась бы с первой на первом же новом поле, и окно начало бы обещать не то.
   */
  r.post(
    '/:id/assignment-changes/correction/preview',
    {
      preHandler: readGuards,
      schema: { params: idParams, body: assignmentVehicleCorrectionPreviewSchema },
    },
    async (req): Promise<AssignmentCorrectionPreviewDto> => {
      const p = requirePrincipal(req);
      await assertVisible(p, req.params.id);
      const asOf = correctionAsOf();
      const preview = await previewAssignmentCommand<VehicleCorrectionPlan>(db, {
        requestId: req.params.id,
        actor: { id: p.id },
        asOf,
        plan: (ctx) => planVehicleCorrection(ctx, req.body),
      });
      return correctionPreviewDto(preview.effects, preview.plan, preview.fingerprint, preview.asOf);
    },
  );

  /**
   * Коррекция: прошлое решение о машине заменяется тем, что было на самом деле (Р13).
   *
   * Порядок транзакции целиком принадлежит канону (`runAssignmentCommand`, §8): гейт режима,
   * блокировки, повторный поиск операции, версия, отпечаток, строка журнала коррекций, мутации,
   * снятие подписей, снимок операции, аудит и версия заявки. Дверь заполняет предметные места и ни
   * одного из них не переставляет.
   */
  r.post(
    '/:id/assignment-changes/correction',
    {
      preHandler: writeGuards,
      schema: { params: idParams, body: assignmentVehicleCorrectionSchema },
    },
    async (req): Promise<AssignmentCorrectionResultDto> => {
      const p = requirePrincipal(req);
      const requestId = req.params.id;
      await assertVisible(p, requestId);

      const outcome = await runAssignmentCommand<
        VehicleCorrectionPlan,
        AssignmentWriteResult,
        CorrectionPaper
      >(
        db,
        vehicleCorrectionSpec({
          requestId,
          actor: p,
          input: req.body,
          asOf: correctionAsOf(),
        }),
      );

      const history = await readAssignmentHistoryDto(db, requestId);
      if (!history) throw err.notFound('Заявка не найдена');
      return {
        version: outcome.version,
        repeated: outcome.repeated,
        clearedApprovals: outcome.paper?.clearedApprovals ?? [],
        operationId: outcome.operation?.operationId ?? null,
        history,
      };
    },
  );
}
