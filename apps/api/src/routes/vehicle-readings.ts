import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  dateOnlySchema,
  discrepancyResolveSchema,
  readingRebaseSchema,
  reportAcceptSchema,
  reportItemOrderSchema,
  reportSubmitSchema,
  uuidSchema,
} from '@technic/contracts';
import { err } from '../lib/errors';
import { requirePrincipal } from '../auth/plugin';
import {
  acceptReport,
  loadReport,
  loadReportById,
  openReport,
  rebaseItem,
  reorderShifts,
  resolveDiscrepancy,
  submitReport,
} from '../services/readings';

/**
 * Показания техники со стороны портала (ADR 0103): приёмка дня, правка за водителя, разбор
 * расхождений, порядок смен и приведение снимка к источнику.
 *
 * Отдельный префикс, а не ветка `/driver`: там второй контур со своей узкой областью («свой
 * человек») и двумя правами кабинета, здесь — работа диспетчера над чужими днями под
 * `vehicleReadings.write`. Общее у них ровно одно — сервис, и это правильное общее: правило
 * пересчёта цепочки не должно зависеть от того, кто нажал кнопку.
 *
 * Область видимости у этих ручек не сужается ничем, и это осознанно: показания ведёт тот же
 * человек, который распределяет день парка (`garage.read`), а парк у портала один.
 */

const idParams = z.object({ id: uuidSchema });
const personDateParams = z.object({ personId: uuidSchema, date: dateOnlySchema });

export default async function vehicleReadingsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: [app.authenticate, app.requirePermission('vehicleReadings.read')] };
  const write = { preHandler: [app.authenticate, app.requirePermission('vehicleReadings.write')] };

  /** Отчёт работника за дату — тот же DTO, что видит кабинет, но чужой и целиком. */
  r.get(
    '/reports/:personId/:date',
    { ...read, schema: { params: personDateParams } },
    async (req) => {
      const { personId, date } = req.params;
      const report = await loadReport(personId, date);
      if (!report) throw err.notFound('Отчёт не найден');
      return report;
    },
  );

  r.get('/reports/:id', { ...read, schema: { params: idParams } }, async (req) =>
    loadReportById(req.params.id),
  );

  /**
   * Открыть отчёт за работника. Нужно с первого дня: у части водителей учётки не будет ещё долго,
   * а показания их машин нужны гаражу тогда же, когда и остальные.
   */
  r.post(
    '/reports/:personId/:date/open',
    { ...write, schema: { params: personDateParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { personId, date } = req.params;
      return openReport(personId, date, p.id, { mode: 'staff' });
    },
  );

  /**
   * Внести или поправить показания за работника. Причина обязательна там, где правят уже
   * существующее число (это проверяет сервис): чужую цифру меняют с объяснением, и объяснение
   * уезжает в историю показания, а не в аудит — аудит гасит собственные сбои.
   */
  r.post(
    '/reports/:personId/:date/submit',
    { ...write, schema: { params: personDateParams, body: reportSubmitSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { personId, date } = req.params;
      return submitReport(personId, date, req.body, p.id, null, {
        mode: 'staff',
        reason: req.body.reason,
      });
    },
  );

  /**
   * Приём дня. Версия в теле — та, которую видел принимающий: приём подтверждает данные, а не
   * факт нажатия, и разошедшаяся версия означает, что подтверждать собирались другое.
   */
  r.post(
    '/reports/:id/accept',
    { ...write, schema: { params: idParams, body: reportAcceptSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      return acceptReport(req.params.id, req.body.version, p.id);
    },
  );

  /**
   * Разбор расхождения. Журнал решений append-only: прежнее решение не переписывается, а
   * перекрывается следующим, и действует последнее — по версии отчёта, а не по времени записи.
   */
  r.post(
    '/reports/:id/discrepancies',
    { ...write, schema: { params: idParams, body: discrepancyResolveSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      return resolveDiscrepancy(req.params.id, req.body, p.id);
    },
  );

  /**
   * Порядок смен машины за день. Принимается полный порядок вместе с ожидаемым прежним и версиями
   * затронутых отчётов: перестановка меняет чужие разности, и два диспетчера не должны молча
   * перезаписывать её друг у друга.
   */
  r.patch('/shift-order', { ...write, schema: { body: reportItemOrderSchema } }, async (req) => {
    const p = requirePrincipal(req);
    return reorderShifts(req.body, p.id);
  });

  /**
   * Привести снимок к источнику: рейс переназначили после отправки, и строка вместе с показанием
   * переезжает в отчёт того, кто по документу ехал. Единственный выход из тупика «источник уже
   * занят чужим отчётом» — признать расхождение допустимым можно, но тогда цифры навсегда
   * останутся у чужого человека.
   */
  r.post(
    '/items/:id/rebase',
    { ...write, schema: { params: idParams, body: readingRebaseSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      return rebaseItem(req.params.id, req.body, p.id);
    },
  );
}
