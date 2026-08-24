import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  periodApplySchema,
  periodPreviewSchema,
  uuidSchema,
  type PeriodPreviewDto,
  type RequestAssignmentHistoryDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicles,
} from '../db/schema';
import { assertLessorScope, assertObjectRoleEditable, assertRequestScope } from '../lib/access';
import { err } from '../lib/errors';
import { previewAssignmentCommand, runAssignmentCommand } from '../services/assignment-command';
import { readAssignmentHistoryDto } from '../services/assignment-crew';
import {
  periodAsOf,
  periodCommandSpec,
  periodPreviewDto,
  planPeriodCommand,
  type PeriodPaper,
  type PeriodPlan,
} from '../services/assignment-period';
import type { AssignmentWriteResult } from '../services/assignment-write';

/**
 * Правка срока работ — `POST /vehicle-requests/:id/period/preview` и
 * `PATCH /vehicle-requests/:id/period` (`docs/assignment-periods-plan.md`, Ж4, З5, Д2, Е3; §7, §8).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ РОУТ-МОДУЛЬ. Тем же приёмом, каким рядом стоят дверь машиниста, дверь ремонта и
 * периодная коррекция (§16.1): `vehicle-requests.ts` — барьерный файл, которого одновременно хотят
 * пять дверей истории, и дописанные в него двери конфликтуют при любом порядке работ. Префикс тот
 * же — `/api/v1/vehicle-requests`: адреса портала от разделения не меняются.
 *
 * ЧТО ПРОИСХОДИТ СО СТАРЫМ ПУТЁМ. Ничего (И5): широкий `PATCH /:id` продолжает принимать
 * `dateFrom`/`dateTo` и вести срок ровно как вёл. Порядок выката записан планом: сначала появляется
 * эта дверь, затем на неё переходит портал, затем по метрике подтверждается исчезновение старых
 * вызовов, и только потом даты уходят из широкой схемы. Двери здесь не соревнуются: последствия
 * срока у них общие — один сервис
 * ([vehicle-request-period.ts](../services/vehicle-request-period.ts)).
 *
 * ПРАВА — СОСТАВНОЙ КОНТРАКТ (§7, Е3), и безусловного стража у него только пара:
 *
 * ```
 * всегда:                     vehicleRequests.update + waybills.read
 * исход `crew` (Р32, Е3):     + waybills.correct
 *   └─ и глубже 30 дней:      + waybills.correctBeyondLimit
 * исход `assignment_tail`:    ничего сверх пары
 * ```
 *
 * `vehicleRequests.update` — за сам срок (то же право, каким его правит широкий маршрут),
 * `waybills.read` — за просмотр последствий: рабочий путь идёт через предпросмотр, и роль без него
 * упиралась бы в 403 посреди операции. Коррекционные права спрашивает шаг 9 канона — под
 * блокировкой и по посчитанному исходу: из тела не видно, задевает ли правка отработанные дни и
 * гасит ли она группы, а страж на маршруте спросил бы их у всех.
 */

const idParams = z.object({ id: uuidSchema });

/**
 * Ответ боевой ручки: состояние заявки после команды, а не отчёт о ней (Р9).
 *
 * Пересобирается из **текущего** состояния, поэтому повтор отвечает то же, что ответил бы обычный
 * запрос. Срок стоит рядом с историей намеренно: окно, подвинувшее его, обязано показать и новый
 * период, и то, что случилось с составом по датам.
 */
export interface PeriodResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  /** Срок, каким он стал. */
  dateFrom: string;
  dateTo: string | null;
  /** Что переписала сверка: сгоревшие и выписанные номера. */
  esm2: { cancelled: string[]; issued: string[] };
  /** Снят ли ожидавший визы запрос на досрочное завершение (ADR 0044). */
  earlyEndDropped: boolean;
  /** Ключ операции журнала; `null` — исход `none`, объяснять нечего (Р32). */
  operationId: string | null;
  history: RequestAssignmentHistoryDto;
}

/**
 * Заявка видима этой учётке и правима ею.
 *
 * Область спрашивается **до** канонической транзакции и по тем же правилам, что у остальных дверей
 * заявки: объектная и отдельская роли работают со своим, арендодатель — со своей техникой, а
 * площадочная роль правит только «Новую». Внутрь канона это не переносится: там уже держатся
 * блокировки, и отказ по области означал бы взятые и тут же отпущенные строки.
 */
async function assertEditable(p: Principal, requestId: string): Promise<void> {
  const [row] = await db
    .select({
      objectId: vehicleRequests.objectId,
      departmentId: vehicleRequests.departmentId,
      status: vehicleRequests.status,
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
  // Арендодатель видит свои заявки (ADR 0038), но срок работ заказывает не он: это договорённость
  // площадки с исполнителем, и двигает её сторона заказчика.
  assertLessorScope(p, row.lessorId);
  assertObjectRoleEditable(p, row.status, 'редактировать');
}

/** Срок заявки, каким он стал: ответ пересобирается из текущего состояния (Р9). */
async function readTerm(requestId: string): Promise<{ dateFrom: string; dateTo: string | null }> {
  const [row] = await db
    .select({
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
    })
    .from(specialEquipmentRequestDetails)
    .where(eq(specialEquipmentRequestDetails.requestId, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  return row;
}

export default async function vehicleRequestPeriodRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  /*
   * Читающая пара у предпросмотра и правящая у боевой ручки — тем же приёмом, что у соседних
   * дверей истории: смотреть последствия вправе тот, кто видит заявку и её бумагу, а двигать срок —
   * тот, кто заявку правит.
   */
  const readGuards = [
    app.authenticate,
    app.requirePermission('vehicleRequests.read'),
    app.requirePermission('waybills.read'),
  ];
  const writeGuards = [
    app.authenticate,
    app.requirePermission('vehicleRequests.update'),
    app.requirePermission('waybills.read'),
  ];

  /**
   * Предпросмотр правки срока — расчёт без единой записи (Р20).
   *
   * Показывает то, ради чего у правки срока вообще появилось рукопожатие: перечень групп истории,
   * которые погасит сокращение (Д2), и бумагу, которая сгорит или выпишется. Тело у предпросмотра —
   * семантическая половина боевого (Л1): отпечатка, исхода и ключей листов он ещё не знает — он их
   * и вычисляет. Расчёт тот же колбэк, что у боя: вторая копия правил разошлась бы с первой на
   * первом же новом поле, и окно начало бы обещать не то.
   */
  r.post(
    '/:id/period/preview',
    { preHandler: readGuards, schema: { params: idParams, body: periodPreviewSchema } },
    async (req): Promise<PeriodPreviewDto> => {
      const p = requirePrincipal(req);
      await assertEditable(p, req.params.id);
      const preview = await previewAssignmentCommand<PeriodPlan>(db, {
        requestId: req.params.id,
        actor: { id: p.id },
        asOf: periodAsOf(),
        plan: (ctx) => planPeriodCommand(ctx, req.body, p),
      });
      return periodPreviewDto(preview.effects, preview.plan, preview.fingerprint, preview.asOf);
    },
  );

  /**
   * Правка срока: заказ работает другими днями, чем договаривались.
   *
   * Порядок транзакции целиком принадлежит канону (`runAssignmentCommand`, §8): гейт режима,
   * блокировки, повторный поиск операции, версия, отпечаток, строка журнала коррекций, мутации,
   * последствия срока, снимок операции, аудит и версия заявки. Дверь заполняет предметные места и
   * ни одного из них не переставляет.
   */
  r.patch(
    '/:id/period',
    { preHandler: writeGuards, schema: { params: idParams, body: periodApplySchema } },
    async (req): Promise<PeriodResultDto> => {
      const p = requirePrincipal(req);
      const requestId = req.params.id;
      await assertEditable(p, requestId);

      const outcome = await runAssignmentCommand<PeriodPlan, AssignmentWriteResult, PeriodPaper>(
        db,
        periodCommandSpec({ requestId, actor: p, input: req.body, asOf: periodAsOf() }),
      );

      const [term, history] = await Promise.all([
        readTerm(requestId),
        readAssignmentHistoryDto(db, requestId),
      ]);
      if (!history) throw err.notFound('Заявка не найдена');
      return {
        version: outcome.version,
        repeated: outcome.repeated,
        dateFrom: term.dateFrom,
        dateTo: term.dateTo,
        esm2: outcome.paper?.esm2 ?? { cancelled: [], issued: [] },
        earlyEndDropped: outcome.paper?.earlyEndDropped ?? false,
        operationId: outcome.operation?.operationId ?? null,
        history,
      };
    },
  );
}
