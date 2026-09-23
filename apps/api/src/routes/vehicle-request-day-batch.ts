import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  dayBatchApplySchema,
  uuidSchema,
  type VehicleRequestDayBatchResultDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import { vehicleRequestAssignments, vehicleRequests, vehicles } from '../db/schema';
import { assertArchiveVisible, assertLessorScope, assertRequestScope } from '../lib/access';
import { err } from '../lib/errors';
import { runVehicleRequestDayBatch } from '../services/vehicle-request-day-batch';

/**
 * Пачка дней заказа техники на объект — `POST /vehicle-requests/:id/days/batch`
 * ([ADR 0207](../../../../docs/adr/0207-vehicle-request-day-batch.md), план
 * [docs/vehicle-request-day-batch-plan.md](../../../../docs/vehicle-request-day-batch-plan.md)).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ РОУТ-МОДУЛЬ. Тем же приёмом, каким рядом стоят двери истории назначения и
 * правка срока: `vehicle-requests.ts` — барьерный файл, которого одновременно хотят несколько
 * дверей, и дописанные в него двери конфликтуют при любом порядке работ. Префикс тот же —
 * `/api/v1/vehicle-requests`: адреса портала от разделения не меняются, и пачка стоит ровно там
 * же, где подённая дверь (`/:id/days/:date/route`).
 *
 * ДВЕРЬ ОДНА, ЗОВУТ ЕЁ ДВА МЕСТА (ADR 0207 §4): галочка «и выписать листы» в окне принятия заказа
 * в работу и кнопка в карточке заявки — для продлённого срока и добора пропущенного. Со стороны
 * рейса такой двери нет и не будет: рейс не знает срока заказа.
 *
 * ПРАВА — ТА ЖЕ ПАРА, ЧТО У ПОДЁННОЙ ДВЕРИ: `waybills.read` (в рейсе виден водитель) и
 * `vehicleRequests.status` (планирование дней — это ход работы по заявке). Третьего права у пачки
 * нет намеренно: `waybills.correct` спрашивается не стражем, а `backdateGuard` внутри — по
 * КАЖДОМУ дню и от общей даты. Поставь его на маршрут — и пачка на будущий срок, которой прошлое
 * не нужно вовсе, стала бы недоступна всем, кроме коррекционных ролей; а день глубже предела
 * требует ещё и `waybills.correctBeyondLimit`, чего страж по телу запроса не видит вовсе.
 */

const idParams = z.object({ id: uuidSchema });

/**
 * Заявка видима этой учётке и ведётся ею.
 *
 * Область спрашивается ДО всякой работы и по тем же правилам, что у подённой двери: объектная и
 * отдельская роли работают со своим, арендодатель — со своей техникой. Внутрь пачки это не
 * переносится: там уже идут транзакции дней, и отказ по области означал бы взятые и тут же
 * отпущенные блокировки — да ещё и посреди выписанных бумаг.
 *
 * `assertObjectRoleEditable` здесь нет, и это не пропуск: площадочная роль правит заявку только в
 * «Новой», а пачка работает по заявке В РАБОТЕ — дальше её всё равно не пустит `linearDaysBlocker`,
 * и второй отказ о том же говорил бы другими словами.
 */
async function assertBatchAllowed(p: Principal, requestId: string): Promise<void> {
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
  if (!row) throw err.notFound('Заявка не найдена');
  assertArchiveVisible(p, row.deletedAt, 'Заявка не найдена');
  assertRequestScope(p, row);
  // Арендодатель ведёт свои заявки (ADR 0038), но чужой парк и его водители — не его дело: в дни
  // заказа встают машины и люди собственного парка.
  assertLessorScope(p, row.lessorId);
}

export default async function vehicleRequestDayBatchRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Выписать 4-П на весь период заказа: день за днём — рейс назначенной машины и, если просили,
   * лист по нему.
   *
   * Отвечает 200 с ПОСТРОЧНЫМ ОТЧЁТОМ даже тогда, когда часть дней не прошла: пачка делает всё,
   * что может, и рассказывает, чего не смогла (ADR 0207 §7). Отказом маршрута кончается только то,
   * что относится ко всей пачке целиком и узнаётся до первой записи: дней у заявки нет вовсе (422
   * текстом `linearDaysBlocker`), нет причины для прошедших дней или ключа операции под них.
   * Длина срока отказом не бывает: сверх предела пачка берёт порцию и называет остаток в ответе
   * (`remaining`), который добирают повторным нажатием — решение 11 ADR 0207.
   *
   * Повтор с тем же ключом операции и тем же телом продолжает работу: уже поставленный день
   * отсекается уникальным индексом дня (миграция 0127) и уходит в отчёт пропуском, второй лист на
   * рейс — индексом `waybills_route_unique`. Повтор с другим телом упирается в сверку операции —
   * так и должно быть: ключ отвечает только на «повтор?».
   */
  r.post(
    '/:id/days/batch',
    {
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status', 'Недостаточно прав для смены статуса'),
      ],
      schema: { params: idParams, body: dayBatchApplySchema },
    },
    async (req): Promise<VehicleRequestDayBatchResultDto> => {
      const p = requirePrincipal(req);
      await assertBatchAllowed(p, req.params.id);
      return runVehicleRequestDayBatch({
        requestId: req.params.id,
        actor: p,
        input: req.body,
      });
    },
  );
}
