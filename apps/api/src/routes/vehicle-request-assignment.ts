import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assignmentCommandPreviewSchema,
  assignmentCommandSchema,
  uuidSchema,
  type AssignmentPreviewDto,
  type RequestAssignmentHistoryDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import { vehicleRequestAssignments, vehicleRequests, vehicles } from '../db/schema';
import { assertLessorScope, assertRequestScope } from '../lib/access';
import { err } from '../lib/errors';
import { previewAssignmentCommand, runAssignmentCommand } from '../services/assignment-command';
import {
  crewAsOf,
  crewCommandSpec,
  crewPreviewDto,
  planCrewCommand,
  readAssignmentHistoryDto,
  type CrewPaper,
  type CrewPlan,
} from '../services/assignment-crew';
import type { AssignmentWriteResult } from '../services/assignment-write';

/**
 * Двери истории назначения заявки — новый роут-модуль
 * (`docs/assignment-periods-plan.md`, §8; этап 3).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ВЕТКА `vehicle-requests.ts`. Тот файл — 7400 строк и барьер плана
 * (§16.1): его хотят одновременно пять дверей истории, четыре ручки смен и кабинет водителя.
 * Пять дверей, дописанных в него, конфликтуют при любом порядке работ, а читать его уже сегодня
 * нельзя. Приём объявлен планом прямо: «новый файл вместо правки старого» — так же уехали чистые
 * функции этапа 1 из `waybill-esm2.ts`.
 *
 * Префикс тот же — `/api/v1/vehicle-requests`: адреса портала от разделения не меняются, потому
 * что двери адресуются заявкой и живут её жизнью. Второй плагин на одном префиксе — приём не
 * новый, так же стоят рядом `vehicle-readings` и `vehicle-readings-stats`.
 *
 * ЧТО СЮДА ВСТАНЕТ (§8, волны 3.2–3.3). Порядок и права выписаны здесь заранее, чтобы двери не
 * договаривались о них по отдельности:
 *
 * | Ручка | Что делает | Права |
 * | --- | --- | --- |
 * | `GET /:id/assignment-changes` | история заявки: отрезки, изменения, дремлющие записи | `waybills.read` + `vehicleRequests.read` |
 * | `POST /:id/assignment-changes/preview` | двухфазный предпросмотр: якоря, последствия, отпечаток | те же |
 * | `POST /:id/assignment-changes` | `set` / `cancel` машиниста | `vehicleRequests.status` + `waybills.read`; при `needsCorrection` — `waybills.correct`, глубже тридцати дней — `waybills.correctBeyondLimit` |
 * | `POST /:id/assignment-changes/repair` (+ `/preview`) | ремонт истории, решение хвоста, `restore` | те же плюс `archive.restore` в режиме восстановления |
 *
 * Права условные считаются **после** разрешения цели под блокировкой (Р31): из тела запроса не
 * видно, задевает ли команда исторический диапазон, а календарная дата сама по себе коррекционных
 * прав не требует — через ту же ручку идёт отмена дремлющей группы хвоста.
 *
 * ТРИ ПЕРВЫЕ РУЧКИ РАБОТАЮТ (волна 3.2): команда машиниста целиком — история, двухфазный
 * предпросмотр и сама команда. Предметные правила у неё свои
 * ([assignment-crew.ts](../services/assignment-crew.ts)), а порядок транзакции — общий
 * (`runAssignmentCommand`): дверь заполняет предметные места канона, а не переписывает его.
 */

/**
 * Пара прав, общая **всем** боевым дверям истории (§8, прецедент ADR 0050 п. 11).
 *
 * `waybills.read` обязателен и на боевой ручке, а не только на предпросмотре: рабочий путь идёт
 * через предпросмотр — он показывает номера бланков и фамилии парка, — и роль без этого права
 * упиралась бы в 403 посреди операции, уже подтвердив разблокировки.
 *
 * Условные права (`waybills.correct`, `waybills.correctBeyondLimit`, `archive.restore`) сюда не
 * попадают никогда: они спрашиваются шагом 9 канона, под блокировкой и по посчитанному исходу
 * (Р32). Guard, повешенный на маршрут, спросил бы их у всех — то есть запретил бы диспетчеру
 * плановую смену машиниста с понедельника.
 */
export function assignmentDoorGuards(app: FastifyInstance) {
  return [
    app.authenticate,
    app.requirePermission('vehicleRequests.status'),
    app.requirePermission('waybills.read'),
  ];
}

/**
 * Читающие двери истории: карточка и предпросмотр (§8).
 *
 * Отличается от боевой пары вторым правом: смотреть состав по датам вправе тот, кто видит заявку,
 * а менять его — тот, кто ведёт её состояние.
 */
export function assignmentHistoryReadGuards(app: FastifyInstance) {
  return [
    app.authenticate,
    app.requirePermission('vehicleRequests.read'),
    app.requirePermission('waybills.read'),
  ];
}

const idParams = z.object({ id: uuidSchema });

/**
 * Ответ боевой ручки: состояние заявки после команды, а не отчёт о ней (Р9).
 *
 * Пересобирается из **текущего** состояния, поэтому повтор отвечает то же, что ответил бы обычный
 * запрос. Версия и переписанная бумага стоят рядом с историей намеренно: окно, сделавшее смену,
 * обязано узнать и то, чем продолжать (версия), и то, что случилось с номерами бланков.
 */
export interface AssignmentCommandResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  /** Что переписала сверка: сгоревшие и выписанные номера. */
  esm2: { cancelled: string[]; issued: string[] };
  history: RequestAssignmentHistoryDto;
}

/**
 * Заявка видима этой учётке.
 *
 * Область спрашивается **до** канонической транзакции и по тем же правилам, что у остальных дверей
 * заявки: объектная и отдельская роли работают со своим, арендодатель — со своей техникой. Внутрь
 * канона это не переносится намеренно: там уже держатся блокировки, и отказ по области означал бы
 * взятые и тут же отпущенные строки.
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
  // Арендодатель видит свои заявки (ADR 0038), но состав экипажа собственного парка — не его дело:
  // машинист портальной единицы едет в бланк строгой отчётности портала.
  assertLessorScope(p, row.lessorId);
}

export default async function vehicleRequestAssignmentRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const readGuards = assignmentHistoryReadGuards(app);
  const writeGuards = assignmentDoorGuards(app);

  /**
   * История назначения заявки — то, из чего портал строит «Состав по датам».
   *
   * Погашенные строки отдаются наравне с актуальными: журнал читают, чтобы понять, **что** правили,
   * а не только чем дело кончилось. Состояние готовности приходит той же ручкой (Р26): окно смены
   * машиниста обязано отличить «истории нет» от «история есть, но невалидна», и второй запрос за
   * этим означал бы, что между ними состояние успевает измениться.
   */
  r.get(
    '/:id/assignment-changes',
    { preHandler: readGuards, schema: { params: idParams } },
    async (req): Promise<RequestAssignmentHistoryDto> => {
      const p = requirePrincipal(req);
      await assertVisible(p, req.params.id);
      const history = await readAssignmentHistoryDto(db, req.params.id);
      if (!history) throw err.notFound('Заявка не найдена');
      return history;
    },
  );

  /**
   * Предпросмотр команды — расчёт без единой записи (Р20) и **двухфазный** (Р16).
   *
   * Первый вызов идёт без якорей и возвращает `requiredAnchors` — границы, на которых свёртка
   * осталась бы без машиниста. Второй, с заполненными именами, отдаёт окончательный план и
   * отпечаток, который и принимает боевая ручка. Одной фазы здесь не хватает: пока человек не
   * назвал людей, набор последствий ещё неизвестен, и подтверждать нечего.
   *
   * Тело у предпросмотра то же, что у боевой команды, и расчёт тот же колбэк: вторая копия правил
   * разошлась бы с первой на первом же новом поле, и окно начало бы обещать не то.
   */
  r.post(
    '/:id/assignment-changes/preview',
    {
      preHandler: readGuards,
      schema: { params: idParams, body: assignmentCommandPreviewSchema },
    },
    async (req): Promise<AssignmentPreviewDto> => {
      const p = requirePrincipal(req);
      await assertVisible(p, req.params.id);
      const asOf = crewAsOf();
      const preview = await previewAssignmentCommand<CrewPlan>(db, {
        requestId: req.params.id,
        actor: { id: p.id },
        asOf,
        plan: (ctx) => planCrewCommand(ctx, req.body),
      });
      return crewPreviewDto(preview.effects, preview.plan, preview.fingerprint, preview.asOf);
    },
  );

  /**
   * Команда машиниста: `set` — заведение или правка решения, `cancel` — его снятие (Р13).
   *
   * Порядок транзакции целиком принадлежит канону (`runAssignmentCommand`, §8): гейт режима,
   * блокировки, повторный поиск операции, версия, отпечаток, журнал коррекций, версия заявки и
   * аудит. Дверь заполняет предметные места — расчёт, рукопожатия, условную авторизацию, мутации,
   * бумагу и снимок, — и ни одного из них не переставляет.
   *
   * Права здесь именно условные (Р32): плановая смена машиниста с понедельника — обычная работа
   * диспетчера и никаких коррекционных прав не требует, а та же команда мартовской датой
   * переоформляет выданную бумагу и спрашивает `waybills.correct`. Из тела это не видно — исход
   * считается под блокировкой, — поэтому право спрашивает шаг 9, а не страж маршрута.
   */
  r.post(
    '/:id/assignment-changes',
    { preHandler: writeGuards, schema: { params: idParams, body: assignmentCommandSchema } },
    async (req): Promise<AssignmentCommandResultDto> => {
      const p = requirePrincipal(req);
      const requestId = req.params.id;
      await assertVisible(p, requestId);
      const input = req.body;
      const asOf = crewAsOf();

      const outcome = await runAssignmentCommand<CrewPlan, AssignmentWriteResult, CrewPaper>(
        db,
        crewCommandSpec({ requestId, actor: p, input, asOf }),
      );

      const history = await readAssignmentHistoryDto(db, requestId);
      if (!history) throw err.notFound('Заявка не найдена');
      return {
        version: outcome.version,
        repeated: outcome.repeated,
        esm2: outcome.paper?.esm2 ?? { cancelled: [], issued: [] },
        history,
      };
    },
  );
}
