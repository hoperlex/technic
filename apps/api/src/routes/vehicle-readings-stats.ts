import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  can,
  readingExportQuerySchema,
  readingIntakeQuerySchema,
  readingJournalQuerySchema,
  readingStatsQuerySchema,
  uuidSchema,
  type ReadingIntakeDto,
  type VehicleReadingCardDto,
  type VehicleReadingJournalDto,
  type VehicleReadingStatsRow,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import { err } from '../lib/errors';
import { loadFleetStats, loadVehicleCard } from '../services/readings-aggregate';
import { buildReadingsExport, type ReadingsExportResult } from '../services/readings-export';
import { loadReadingIntake } from '../services/readings-intake';
import { loadVehicleReadingJournal } from '../services/readings-stats';

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
/** Карточка адресуется машиной, а не журнальной строкой: `/vehicles/:id/card` (план §6). */
const cardParams = z.object({ id: uuidSchema });

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

/** Книга в ответ: тип, имя файла заголовком и байты. Один ответ на все варианты выгрузки. */
function sendWorkbook(reply: FastifyReply, book: ReadingsExportResult): FastifyReply {
  return reply
    .type(XLSX_TYPE)
    .header(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(book.filename)}`,
    )
    .send(Buffer.from(book.bytes));
}

export default async function vehicleReadingsStatsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = [app.authenticate, app.requirePermission('vehicleReadings.read')];

  /**
   * Журнал одной машины: строки ожидания периода с показаниями, разностями, аномалиями, файлами и
   * историей правок. Строка без показания из журнала не выпадает — «смена была, цифр нет» и есть
   * то, ради чего журнал открывают.
   *
   * Страницами режет сервер (Р25) — теми же параметрами, что и прочие списки портала
   * (`page`, `pageSize`). Проверка длины периода при этом остаётся: страница ограничивает ответ, а
   * не отбор, и запрос «с 2000 года» упирался бы в счётчик строк по всей жизни машины.
   */
  r.get(
    '/journal/:vehicleId',
    {
      preHandler: guards,
      schema: { params: vehicleParams, querystring: readingJournalQuerySchema },
    },
    async (req): Promise<VehicleReadingJournalDto> => {
      const { from, to, page, pageSize } = req.query;
      checkPeriod(from, to);

      const journal = await loadVehicleReadingJournal(req.params.vehicleId, {
        from,
        to,
        page,
        pageSize,
      });
      if (!journal) throw err.notFound('Машина не найдена');
      return journal;
    },
  );

  /**
   * Реестр приёма (Р26): ожидаемые смены периода с пометками, страница строк и отчёты дня со
   * своими счётчиками.
   *
   * Право то же, что у журнала и сводки, — `vehicleReadings.read`: реестр показывает те же данные
   * модуля показаний, только другим разрезом. Правки в нём нет ни одной: и приём отчёта, и ввод за
   * водителя живут в своём модуле под `vehicleReadings.write`.
   *
   * Счётчики отчётов приходят рядом со страницей, а не выводятся из видимых строк (Р9а): пагинация
   * делит отчёт между страницами, и кнопка, считающая по странице, предложила бы принять отчёт с
   * невидимой жёлтой строкой.
   */
  r.get(
    '/intake',
    { preHandler: guards, schema: { querystring: readingIntakeQuerySchema } },
    async (req): Promise<ReadingIntakeDto> => {
      const { from, to, page, pageSize } = req.query;
      checkPeriod(from, to);
      return loadReadingIntake({ from, to, page, pageSize });
    },
  );

  /**
   * Карточка одной машины: итог периода, его месяцы и последние показания счётчиков на конец
   * периода (Р16). Машина без единой смены за период — законная карточка с пустыми месяцами;
   * `null` из расчёта означает только одно — такой машины в справочнике нет.
   *
   * Блока ТО в ответе нет и быть не должно (Р14а): сводка обслуживания приходит своей ручкой под
   * своим правом `vehicleMaintenance.read`, а полную карточку портал собирает композицией двух
   * ответов. Поле, исчезающее по чужому праву, — то же смешение прав, только спрятанное в
   * сериализатор.
   */
  r.get(
    '/vehicles/:id/card',
    { preHandler: guards, schema: { params: cardParams, querystring: readingStatsQuerySchema } },
    async (req): Promise<VehicleReadingCardDto> => {
      const { from, to } = req.query;
      checkPeriod(from, to);

      const card = await loadVehicleCard(req.params.id, from, to);
      if (!card) throw err.notFound('Машина не найдена');
      return card;
    },
  );

  /**
   * Сводка по парку. Страниц у неё нет намеренно: её читают целиком и выгружают тем же составом,
   * что видят, — а отбор «работавшая в периоде техника» держит список в размерах парка.
   *
   * Считает её агрегат (§5), тот же, что и карточку: два ответа на «сколько проехала машина» плану
   * противопоказаны. От прежней сводки состав списка отличается на машины, чей день никто не
   * открывал, — они в нём есть (Р26в), потому что смены у них были.
   */
  r.get(
    '/stats',
    { preHandler: guards, schema: { querystring: readingStatsQuerySchema } },
    async (req): Promise<{ items: VehicleReadingStatsRow[]; from: string; to: string }> => {
      const { from, to } = req.query;
      checkPeriod(from, to);
      return { items: await loadFleetStats(from, to), from, to };
    },
  );

  /**
   * Выгрузки: одна ручка, вариант параметром (Р18, §8). Книг шесть — сводка по парку, помесячная
   * матрица, журнал одной машины сплошняком и по месяцам-листам, срез счётчиков на дату и журнал
   * всего парка; собирает их все `services/readings-export.ts`, и ручка ни про одну из них не
   * знает ничего, кроме имени файла в заголовке.
   *
   * Право — то же `vehicleReadings.read`, что у сводки и журнала: выгружают ровно то, что видят на
   * экране. **Кроме колонок ТО в срезе**: они приходят под `vehicleMaintenance.read` и целиком
   * (Р14а, Р14б). Флаг решается здесь, а не в сборщике: разбор прав — дело ручки.
   *
   * Потолок периода общий с соседями, и стоит он до расчёта. Построчным вариантам его мало —
   * строк в них столько же, сколько смен, — и у них свой предел по числу строк
   * (`READING_EXPORT_ROW_LIMIT`), с отказом «сузьте период» вместо молчаливого обрезания (Р31).
   */
  r.get(
    '/export',
    { preHandler: guards, schema: { querystring: readingExportQuerySchema } },
    async (req, reply) => {
      const { kind, from, to, vehicleId } = req.query;
      checkPeriod(from, to);

      const book = await buildReadingsExport({
        kind,
        from,
        to,
        vehicleId,
        withMaintenance: can(requirePrincipal(req), 'vehicleMaintenance.read'),
      });
      return sendWorkbook(reply, book);
    },
  );

  /**
   * Та же сводка книгой Excel — прежним адресом, которым её выгружает портал.
   *
   * Своей сборки у ручки больше нет: она зовёт общий сборщик вариантом `fleetSummary` и отдаёт
   * файл с прежним именем. Оставить рядом вторую реализацию той же книги значило бы, что правка
   * колонки доезжает до людей через раз — смотря какой кнопкой выгрузили.
   */
  r.get(
    '/stats/export',
    { preHandler: guards, schema: { querystring: readingStatsQuerySchema } },
    async (req, reply) => {
      const { from, to } = req.query;
      checkPeriod(from, to);

      return sendWorkbook(
        reply,
        await buildReadingsExport({ kind: 'fleetSummary', from, to, withMaintenance: false }),
      );
    },
  );
}
