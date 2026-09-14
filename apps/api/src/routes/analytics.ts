import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  analyticsExportQuerySchema,
  analyticsSummaryQuerySchema,
  roleScopeAxis,
  roleScopeAxisLabels,
  type AnalyticsSummaryDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { err } from '../lib/errors';
import { buildAnalyticsExport } from '../services/analytics-export';
import { assertAnalyticsQuery, buildAnalyticsSummary } from '../services/analytics/summary';

/**
 * Сводная аналитика по заказчикам (план `docs/analytics-summary-export-plan.md`).
 *
 * Две ручки на один расчёт: `/summary` отдаёт свод в JSON, `/export` — книгу Excel из тех же
 * атомов. Ручка заводится вместе с книгой не «на будущее» (Р14): когда дойдут руки до экрана
 * аналитики, он вызовет этот же ответ и не потребует ни одного нового запроса, а второй способ
 * посчитать «сколько смен за август» в проекте недопустим (Р13).
 *
 * Право одно на обе — `analytics.export`. Требований (`PERMISSION_REQUIRES`) у него нет намеренно
 * (Р2): свод сводит три модуля, и требование читать все три закрыло бы его финансовой службе, ради
 * которой он и делается. Взамен в ответе нет данных о людях, которых он касается: ни водителей, ни
 * машинистов, ни ответственных на площадках — объекты, техника, количества и деньги. Имя в книге
 * ровно одно, и оно принадлежит тому, кто нажал кнопку (подпись листа «Параметры»).
 */

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * ОБЛАСТЬ СВОДА — ВСЯ ОРГАНИЗАЦИЯ, И ЭТО ПРОВЕРЯЕТСЯ ЯВНО (Р3).
 *
 * Обладателю права с ограниченной областью отвечаем отказом, а не усечённым сводом. Молчаливое
 * усечение здесь опаснее отказа: свод, в котором часть площадок невидима, несравним сам с собой
 * между двумя людьми — два человека выгрузили один период, получили разные итоги и ни в одном
 * файле не написано, почему. Отказ словами оставляет разговор с администратором, усечение —
 * расхождение, которое обнаружат через квартал.
 *
 * Спрашивается ось роли (`roleScopeAxis`), а не список объектов: объектная область — не
 * единственная узкая. У роли от контрагента и у кабинета работника область тоже уже организации, и
 * перечисление осей по одной здесь означало бы забыть очередную при её появлении.
 */
function assertWholeOrganizationScope(p: Principal): void {
  const axis = roleScopeAxis(p.role);
  if (axis === 'none') return;
  throw err.forbidden(
    `Выгрузка сводит все площадки; у вашей учётки область ограничена (${roleScopeAxisLabels[axis]})`,
  );
}

export default async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = [app.authenticate, app.requirePermission('analytics.export')];

  /**
   * Свод в JSON: строки заказчиков, итог, деньги вилкой, качество данных и динамика по шагам.
   *
   * Потолки периода и шага стоят здесь, как у соседней книги показаний, — и повторно внутри
   * сборщика. Это не задвоение правила: правило одно, оно в `assertAnalyticsQuery` и в числах
   * контрактов, а зовётся дважды потому, что сборщик обязан быть безопасен для любого вызова —
   * экран аналитики (Р14) придёт к нему мимо этой ручки.
   */
  r.get(
    '/summary',
    { preHandler: guards, schema: { querystring: analyticsSummaryQuerySchema } },
    async (req): Promise<AnalyticsSummaryDto> => {
      assertWholeOrganizationScope(requirePrincipal(req));
      assertAnalyticsQuery({ from: req.query.from, to: req.query.to }, req.query.step);
      return buildAnalyticsSummary(req.query);
    },
  );

  /**
   * Та же аналитика книгой Excel. Лист инфографики строится по одной площадке, выбранной в форме
   * (Р12а); поле не прислано — книга идёт без этого листа, а не по всем площадкам сразу.
   *
   * Потолок периода проверяется здесь, до единого обращения в базу; потолок атомов — в слое, по
   * загруженному набору, но всё равно ДО сборки листов (Р15): отказ «сузьте период» приходит до
   * работы, а не после десяти секунд над книгой, которую всё равно не отдадут.
   */
  r.get(
    '/export',
    { preHandler: guards, schema: { querystring: analyticsExportQuerySchema } },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      assertWholeOrganizationScope(principal);
      assertAnalyticsQuery({ from: req.query.from, to: req.query.to }, req.query.step);

      /*
       * Подпись книги — ФИО и почта нажавшего плюс московское время, тем же приёмом и теми же
       * словами, что у книги показаний (`vehicle-readings-stats.ts`). Лист «Параметры» обещает
       * «кто и когда выгрузил», и обещание обязано выполняться: книга живёт в чужой папке месяцами
       * и расходится письмом, а вопрос «чьи это цифры и на какой день» задают именно к ней.
       *
       * Время считает вызывающий, а не сборщик: у сборщика нет часов, которым можно верить в
       * тесте, — там книга обязана собираться одинаково при каждом прогоне.
       */
      const book = await buildAnalyticsExport(req.query, {
        actor: `${principal.fullName} (${principal.email})`,
        at: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
      });
      return reply
        .type(XLSX_TYPE)
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(book.filename)}`,
        )
        .send(Buffer.from(book.bytes));
    },
  );
}
