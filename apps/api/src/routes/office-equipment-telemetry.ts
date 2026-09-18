import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  COMPONENT_CODES,
  deviceTelemetryQuerySchema,
  equipmentCursorInstantIsExact,
  encodeDeviceCursor,
  decodeDeviceCursor,
  type DeviceCursor,
  METRIC_CODES,
  type ComponentCode,
  type DeviceEventCode,
  type DeviceEventDto,
  type DeviceEventSeverity,
  type DeviceMetricValueDto,
  type DeviceTelemetryCardDto,
  type MetricCode,
  type MetricUnit,
  type TelemetrySource,
} from '@technic/contracts';
import { db } from '../db/client';
import { deviceEvents, officeEquipment } from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { assertArchiveVisible, assertOfficeEquipmentScope } from '../lib/access';
import { err } from '../lib/errors';

/**
 * ЧТЕНИЕ ТЕЛЕМЕТРИИ АППАРАТА — блок карточки «Показания и события» (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10, первый пункт).
 *
 * СВОИМ ФАЙЛОМ, А НЕ СТРОКАМИ В `office-equipment.ts`. Блоки истории читают заявки, аудит и
 * перемещения — всё это части справочника. Телеметрия к справочнику не относится вовсе: её пишут
 * почтовый приём и будущий коллектор (Р4), и единственное, что у неё общего с карточкой, — область
 * видимости. Сложенная в маршрут справочника, она через полгода делила бы с ним и импорты, и
 * помощников — при том что снимать её предстоит целым модулем.
 *
 * ПРАВО — `officeEquipment.read`, И ЭТО РЕШЕНИЕ ПЛАНА (Р30). Новое право `officeEquipment.telemetry`
 * закрывает ДЕЙСТВИЯ очереди разбора (привязать, игнорировать, перечитать), а не чтение блока:
 * показания стоят в карточке рядом с местом и гарантией, и прятать их от того, кому карточка
 * открыта, значило бы завести вторую, более узкую видимость одного и того же аппарата.
 *
 * ОБЛАСТЬ СЧИТАЕТ ТА ЖЕ ПАРА ПРОВЕРОК, ЧТО У КАРТОЧКИ, и это не дублирование ради симметрии:
 * ручка получает строку по `id`, и без них она отдала бы наработку чужой площадки любому, кто этот
 * `id` знает (`assertOfficeEquipmentScope`), а архивную карточку — тому, кому архив закрыт
 * (`assertArchiveVisible`).
 */

const idParams = z.object({ id: z.string().uuid() });

/**
 * Порядок метрик и разрезов на экране задаёт КОНТРАКТ, а не база.
 *
 * Сортировка по коду строкой поставила бы «Цветная печать» перед «Общим счётчиком», а тонеры —
 * алфавитом английских имён (`black, cyan, magenta, yellow`), то есть в порядке, который человеку
 * ничего не говорит. В контракте оба перечня уже стоят в осмысленном порядке — наработка, потом
 * расходники; чёрный, потом CMY, — и брать его нужно оттуда, иначе порядок станет вторым правилом
 * рядом со словарём подписей.
 */
const METRIC_ORDER = new Map<string, number>(METRIC_CODES.map((code, i) => [code, i]));
const COMPONENT_ORDER = new Map<string, number>(COMPONENT_CODES.map((code, i) => [code, i]));

/** Неизвестное — в конец, а не в начало: словарь пополняется, и новый код не должен лезть вперёд. */
const orderOf = (order: Map<string, number>, code: string): number =>
  order.get(code) ?? Number.MAX_SAFE_INTEGER;

// ── Курсор ленты событий ──

/**
 * Курсор ленты — общим кодеком контрактов, лентой `device-events`.
 *
 * Своей копии здесь больше нет: очередь разбора листает ленту той же формы, и две копии кодека
 * оказались взаимно читаемы — курсор одной ленты разбирался другой и становился якорем по чужому
 * ряду. Лента теперь запечатана в сам курсор, и чужая не декодируется вовсе.
 */
type DeviceEventsCursor = DeviceCursor;

const encodeDeviceEventsCursor = (cursor: DeviceCursor): string =>
  encodeDeviceCursor('device-events', cursor);

const decodeDeviceEventsCursor = (raw: string): DeviceCursor | null =>
  decodeDeviceCursor('device-events', raw);

/**
 * ФОРМА КУСКОВ КУРСОРА ПРОВЕРЯЕТСЯ ЗДЕСЬ, И ЭТО НЕ ПЕДАНТИЗМ.
 *
 * Кодек контракта отвечает за ЛЕНТУ: он снимает версию, сверяет метку и убеждается, что куски не
 * пусты. Формата он не знает и знать не должен — метку он стережёт для всех лент разом, а ключ
 * порядка у каждой свой. Но дальше куски уезжают в SQL приведениями `::timestamptz` и `::uuid`, и
 * `1~device-events~garbage~…` роняет уже сам PostgreSQL — то есть `500` на ссылку, усечённую при
 * копировании. Маршрут при этом сам объявляет честным ответом `422` («откройте заново»), и
 * пятисотка ровно там, где обещан внятный отказ, — худший из возможных исходов.
 *
 * Образец — курсоры блоков карточки (`office-equipment-blocks.ts`): там форма payload'а тоже часть
 * СХЕМЫ, а не проверка в коде, и разбор чужой строки падает в одном месте и одинаково.
 */
const eventsCursorForm = z.object({
  observedAt: z.string().datetime(),
  id: z.string().uuid(),
});

/** `null` — курсор чужой ленты, битый или с неразбираемыми кусками. Ответ один: `422`. */
function readEventsCursor(raw: string): DeviceEventsCursor | null {
  const decoded = decodeDeviceEventsCursor(raw);
  if (!decoded) return null;
  const parsed = eventsCursorForm.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Отметка времени С ПОЛНОЙ ТОЧНОСТЬЮ БАЗЫ — та же ловушка, что у блоков истории (`exactInstant` в
 * `office-equipment-blocks.ts`). `timestamptz` хранит микросекунды, `Date` в JS заканчивается
 * миллисекундой, и курсор, собранный из `toISOString()`, оказывается МЛАДШЕ строки, которой
 * принадлежит: строгое сравнение выбрасывает соседей по той же миллисекунде с бо́льшим хвостом, и
 * страница молча теряет события. Пачка писем, прочитанная после паузы, ложится именно так — десятки
 * строк в одну миллисекунду приёма, — поэтому здесь ловушка не теоретическая.
 */
function exactInstant(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** «События СТРОГО СТАРШЕ того, на котором остановились» — кортежем, как читается и сортировка. */
function beforeCursor(cursor: DeviceEventsCursor): SQL {
  const anchor = sql`${cursor.id}::uuid`;
  if (equipmentCursorInstantIsExact(cursor.observedAt)) {
    return sql`(${deviceEvents.observedAt}, ${deviceEvents.id})
             < (${cursor.observedAt}::timestamptz, ${anchor})`;
  }
  // Курсор без микросекунд прийти неоткуда — ленты до этой ручки не существовало, — но правило
  // расширения границы повторено осознанно: молча терять строку хуже, чем один раз её повторить.
  return and(
    sql`${deviceEvents.observedAt} < ${cursor.observedAt}::timestamptz + interval '1 millisecond'`,
    sql`${deviceEvents.id} <> ${anchor}`,
  )!;
}

/**
 * Карточка для телеметрии: та же проверка архива и области, что у самой карточки единицы.
 *
 * Своей копией, а не вызовом `requireHistoryEquipment` из маршрута справочника: тот не экспортирован
 * и завязан на семь колонок, из которых ленте нужны три. Общее у них не код, а ПРАВИЛО, и правило
 * это живёт в `lib/access.ts` — обе стороны зовут одни и те же две проверки.
 */
async function requireTelemetryEquipment(p: Principal, id: string): Promise<{ id: string }> {
  const [ex] = await db
    .select({
      id: officeEquipment.id,
      objectId: officeEquipment.objectId,
      ownerDepartmentId: officeEquipment.ownerDepartmentId,
      deletedAt: officeEquipment.deletedAt,
    })
    .from(officeEquipment)
    .where(eq(officeEquipment.id, id));
  if (!ex) throw err.notFound('Единица оргтехники не найдена');
  assertArchiveVisible(p, ex.deletedAt, 'Единица оргтехники не найдена');
  assertOfficeEquipmentScope(p, { objectId: ex.objectId, ownerDepartmentId: ex.ownerDepartmentId });
  return { id: ex.id };
}

type LatestMetricRow = Record<string, unknown> & {
  metric_code: string;
  component: string;
  value: string;
  unit: string;
  /** Уже строкой ISO: отметки печатает база, а не драйвер (см. `isoInstant`). */
  observed_at: string;
  device_time: string | null;
  source: string;
};

/**
 * Отметка времени строкой ISO — ПЕЧАТАЕТ БАЗА, а не драйвер.
 *
 * Сырой запрос (`db.execute`) идёт мимо разметки колонок drizzle, и `timestamptz` приезжает из
 * драйвера тем, чем драйвер решит, — строкой без зоны у одной настройки пула и `Date` у другой.
 * Строить на этом `toISOString()` значит держать форму ответа на настройке соединения; печать в
 * самом запросе даёт одно и то же всегда. Миллисекунды, а не микросекунды: у метрик отметка
 * показанная, а не курсорная, и выглядеть она обязана так же, как в `DeviceEventDto`.
 */
const isoInstant = (column: string): SQL<string> =>
  sql<string>`to_char(${sql.raw(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Последние значения — ПО ПАРЕ «код + разрез» (Р33), а не по одному коду.
 *
 * Пилот цветной, и письмо об уровнях несёт четыре тонера одним кодом метрики. Возьми мы последнее
 * значение по `metric_code`, три числа из четырёх исчезли бы с экрана — причём именно те, за
 * которыми в блок и приходят: «сколько осталось в жёлтом».
 *
 * `DISTINCT ON` по индексу `(equipment_id, metric_code, observed_at DESC)`, а не коррелированный
 * подзапрос в списке столбцов: такой подзапрос драйвер в односоставном запросе собирает неверно и
 * молча (`office-equipment-sql-correlation.test.ts`).
 *
 * Порядок внутри пары — `observed_at DESC, id DESC`: свежесть ряда держит момент приёма порталом
 * (Р21), а не время аппарата. Часы МФУ без NTP уходят на месяцы, и «последнее по `device_time`»
 * означало бы «последнее по показаниям сбитых часов».
 */
async function loadLatestMetrics(equipmentId: string): Promise<DeviceMetricValueDto[]> {
  const rows = await db.execute<LatestMetricRow>(sql`
    SELECT DISTINCT ON (metric_code, component)
           metric_code, component, value, unit, source,
           ${isoInstant('observed_at')} AS observed_at,
           ${isoInstant('device_time')} AS device_time
      FROM device_observations
     WHERE equipment_id = ${equipmentId}
     ORDER BY metric_code, component, observed_at DESC, id DESC`);

  return rows.rows
    .map((row): DeviceMetricValueDto => ({
      // Коды приезжают из базы строкой (колонка `text`, перечисления базы у них нет), и
      // неизвестный словарю код здесь НЕ отбрасывается: подпись портал возьмёт с запасным
      // вариантом, а выброшенная строка означала бы «аппарат этого не присылал» — неправду.
      metricCode: row.metric_code as MetricCode,
      component: row.component as ComponentCode,
      value: row.value,
      unit: row.unit as MetricUnit,
      observedAt: row.observed_at,
      deviceTime: row.device_time,
      source: row.source as TelemetrySource,
    }))
    .sort(
      (a, b) =>
        orderOf(METRIC_ORDER, a.metricCode) - orderOf(METRIC_ORDER, b.metricCode) ||
        orderOf(COMPONENT_ORDER, a.component) - orderOf(COMPONENT_ORDER, b.component) ||
        a.component.localeCompare(b.component),
    );
}

export default async function officeEquipmentTelemetryRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('officeEquipment.read');

  /**
   * Блок «Показания и события»: последние значения метрик и страница ленты событий.
   *
   * ОДНОЙ РУЧКОЙ, А НЕ ДВУМЯ, потому что этого просит замороженный контракт: `DeviceTelemetryCardDto`
   * несёт и метрики, и первую страницу ленты. Продолжение ленты приходит сюда же с курсором —
   * метрики при этом считаются заново (один запрос по индексу) и портал их просто не перерисовывает.
   * Отдать на такой запрос пустой список метрик было бы дешевле и означало бы «аппарат ничего не
   * присылал» — то самое утверждение, которое пустое состояние этого блока и делает законным.
   *
   * ПУСТОТА — ЗАКОННЫЙ ОТВЕТ. Блок появится в карточках раньше первого письма, и «метрик нет,
   * событий нет» здесь не ошибка и не пропуск: это «аппарат ещё не присылал писем». Ни `404`, ни
   * отсутствия полей — форма ответа одна на пустой и на полный аппарат.
   */
  r.get(
    '/:id/telemetry',
    {
      preHandler: [app.authenticate, canRead],
      schema: { params: idParams, querystring: deviceTelemetryQuerySchema },
    },
    async (req): Promise<DeviceTelemetryCardDto> => {
      const p = requirePrincipal(req);
      const equipment = await requireTelemetryEquipment(p, req.params.id);

      const raw = req.query.cursor;
      const cursor = raw ? readEventsCursor(raw) : null;
      // Отказ, а не молчаливая первая страница: ответ «ссылка не читается — откройте заново»
      // честнее ленты, которая после нажатия «показать ещё» начинается сначала.
      if (raw && !cursor) {
        throw err.unprocessable('Ссылка на продолжение ленты не читается — откройте её заново', {
          cursor: 'Некорректный курсор',
        });
      }

      const pageSize = req.query.pageSize;
      const rows = await db
        .select({
          id: deviceEvents.id,
          eventCode: deviceEvents.eventCode,
          severity: deviceEvents.severity,
          observedAt: deviceEvents.observedAt,
          /** Та же отметка с точностью базы — она и уезжает в курсор (см. `exactInstant`). */
          observedAtCursor: exactInstant(deviceEvents.observedAt),
          deviceTime: deviceEvents.deviceTime,
          source: deviceEvents.source,
          vendorCode: deviceEvents.vendorCode,
          text: deviceEvents.text,
        })
        .from(deviceEvents)
        .where(
          and(
            eq(deviceEvents.equipmentId, equipment.id),
            cursor ? beforeCursor(cursor) : undefined,
          ),
        )
        // Порядок ленты — по приёму портала (Р21): он единственное надёжное время в ряду. Показывает
        // лента при этом время АППАРАТА, и расхождения тут нет — порядок и подпись отвечают на
        // разные вопросы («что пришло позже» и «когда это случилось у аппарата»).
        .orderBy(desc(deviceEvents.observedAt), desc(deviceEvents.id))
        // На строку больше страницы: она же и есть ответ на вопрос «а есть ли ещё».
        .limit(pageSize + 1);

      const page = rows.slice(0, pageSize);
      const hasMore = rows.length > pageSize;
      const last = page[page.length - 1];

      return {
        metrics: await loadLatestMetrics(equipment.id),
        events: {
          items: page.map((row): DeviceEventDto => ({
            id: row.id,
            eventCode: row.eventCode as DeviceEventCode,
            severity: row.severity as DeviceEventSeverity,
            observedAt: row.observedAt.toISOString(),
            deviceTime: row.deviceTime?.toISOString() ?? null,
            source: row.source as TelemetrySource,
            vendorCode: row.vendorCode,
            text: row.text,
          })),
          hasMore,
          nextCursor:
            hasMore && last
              ? encodeDeviceEventsCursor({ observedAt: last.observedAtCursor, id: last.id })
              : null,
        },
      };
    },
  );
}
