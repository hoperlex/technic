import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  readingStatsQuerySchema,
  uuidSchema,
  type VehicleReadingStatsRow,
} from '@technic/contracts';
import { err } from '../lib/errors';
import { writeWorkbook } from '../lib/xlsx';
import {
  loadFleetReadingStats,
  loadVehicleReadingJournal,
  readingStatsSheet,
  type VehicleReadingJournalDto,
} from '../services/readings-stats';

/**
 * Журнал показаний машины и сводка по парку за период (ADR 0103, Р27).
 *
 * Обе ручки читающие и обе под одним правом — `vehicleReadings.read`. Права гаража здесь мало:
 * срез дня отвечает «чем занята машина», а журнал показывает, кто и какие цифры передал, — это
 * данные модуля показаний, и открывает их его собственное право (Р34).
 *
 * Правки нет ни одной: исправляют показания в своём модуле (`vehicle-readings`), под
 * `vehicleReadings.write` и с историей. Второе место, где можно поменять чужое число, означало бы
 * второй набор правил приёмки.
 */

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const vehicleParams = z.object({ vehicleId: uuidSchema });

/**
 * Потолок периода. Схема запроса его не знает намеренно — она общая с порталом и проверяет лишь
 * порядок дат, — а вот запрос «с 2000 года» обязан упереться в отказ, а не в память процесса:
 * сводка собирает все показания периода целиком, чтобы пройти по цепочке снимков.
 */
const MAX_PERIOD_DAYS = 366;

function checkPeriod(from: string, to: string): void {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_PERIOD_DAYS) {
    throw err.badRequest('Период больше года: выберите отрезок покороче', {
      to: 'Не больше года от начала периода',
    });
  }
}

/** Период в подписи листа и в имени файла — тем же видом, каким его выбирали на экране. */
function periodLabel(from: string, to: string): string {
  return from === to ? from : `${from} – ${to}`;
}

export default async function vehicleReadingsStatsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = [app.authenticate, app.requirePermission('vehicleReadings.read')];

  /**
   * Журнал одной машины: строки ожидания периода с показаниями, разностями, аномалиями, файлами и
   * историей правок. Строка без показания из журнала не выпадает — «смена была, цифр нет» и есть
   * то, ради чего журнал открывают.
   */
  r.get(
    '/journal/:vehicleId',
    { preHandler: guards, schema: { params: vehicleParams, querystring: readingStatsQuerySchema } },
    async (req): Promise<VehicleReadingJournalDto> => {
      const { from, to } = req.query;
      checkPeriod(from, to);

      const journal = await loadVehicleReadingJournal(req.params.vehicleId, from, to);
      if (!journal) throw err.notFound('Машина не найдена');
      return journal;
    },
  );

  /**
   * Сводка по парку. Страниц у неё нет намеренно: её читают целиком и выгружают тем же составом,
   * что видят, — а отбор «работавшая в периоде техника» держит список в размерах парка.
   */
  r.get(
    '/stats',
    { preHandler: guards, schema: { querystring: readingStatsQuerySchema } },
    async (req): Promise<{ items: VehicleReadingStatsRow[]; from: string; to: string }> => {
      const { from, to } = req.query;
      checkPeriod(from, to);
      return { items: await loadFleetReadingStats(from, to), from, to };
    },
  );

  /** Та же сводка книгой Excel — тем же механизмом, что и прочие выгрузки портала (`lib/xlsx`). */
  r.get(
    '/stats/export',
    { preHandler: guards, schema: { querystring: readingStatsQuerySchema } },
    async (req, reply) => {
      const { from, to } = req.query;
      checkPeriod(from, to);

      const rows = await loadFleetReadingStats(from, to);
      const bytes = writeWorkbook([readingStatsSheet(rows, periodLabel(from, to))]);

      const name = `Показания техники ${periodLabel(from, to)}.xlsx`;
      return reply
        .type(XLSX_TYPE)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(Buffer.from(bytes));
    },
  );
}
