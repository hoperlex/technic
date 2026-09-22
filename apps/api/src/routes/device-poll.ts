import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  COMPONENT_NONE,
  DEVICE_POLL_OIDS,
  devicePollKeyParamsSchema,
  devicePollWroteValue,
  normalizeIdentityValue,
  officeEquipmentTitle,
  type DevicePollAttemptDto,
  type DevicePollOutcome,
  type DevicePollTargetDto,
  type DevicePollTargetsDto,
  type MetricCode,
  type MetricUnit,
} from '@technic/contracts';
import { db } from '../db/client';
import { deviceObservations, devicePollAttempts, officeEquipment, users } from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import { err } from '../lib/errors';
import { config } from '../config';
import { pollTarget } from '../services/device-snmp/poll';
import { parsePollTargets, targetAddress, type PollTarget } from '../services/device-snmp/targets';

/**
 * ОПРОС АППАРАТОВ ПО СЕТИ — вкладка «Опрос по сети» рядом с очередью писем
 * (решение `docs/adr/0205-device-network-poll.md`).
 *
 * КНОПКА ОПРАШИВАЕТ СИНХРОННО, И ЭТО ОСОЗНАННО. Очередь задач с фоновым исполнителем была бы
 * честнее для парка в сотни аппаратов, но здесь цель одна, ответ приходит за миллисекунды, а
 * молчание — за срок ожидания: человек нажал и тут же видит исход. Очередь в этом месте добавила бы
 * состояние «задача поставлена», которое пришлось бы показывать, опрашивать и чистить, — и всё это
 * ради ожидания в три секунды.
 *
 * ПРАВО — `officeEquipment.telemetry`, то же, что у очереди писем и правил разбора. Опрос — это
 * снятие показаний тем же кругом людей и с тех же аппаратов; второе право означало бы, что кто-то
 * разбирает письма, но не вправе спросить у того же аппарата то же число.
 *
 * СЕРВЕР ХОДИТ В СЕТЬ САМ, и до аппаратов он дотягивается только через маршрут, проложенный
 * администратором (туннель или проброс порта): офисная сеть за NAT, и это предусловие, а не
 * дефект — см. `Р92` в `docs/office-equipment-usage-plan.md`. Когда целей станет много или адреса
 * начнут задаваться из портала, опрос переедет на узел в офисной сети — форма ответа к этому
 * готова, а SNMP-модуль (`services/device-snmp/`) не знает ни про Fastify, ни про базу.
 */

interface EquipmentRef {
  id: string;
  title: string;
}

export default async function devicePollRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canPoll = app.requirePermission('officeEquipment.telemetry');

  /**
   * Реестр целей читается ОДИН РАЗ при сборке приложения — как и всё остальное окружение.
   * Перечитывать его на каждый запрос значило бы обещать «правка `.env` подхватится сама», чего
   * процесс не умеет: `env` фиксируется на старте.
   *
   * Битые строки не роняют портал (см. `parsePollTargets`), но и не молчат: они уезжают в журнал
   * при старте, где их видит тот, кто только что правил настройку.
   */
  const { targets, problems } = parsePollTargets(config.devicePoll.targets);
  if (problems.length > 0) {
    app.log.warn({ problems }, 'опрос аппаратов: часть целей в DEVICE_POLL_TARGETS не разобрана');
  }
  const byKey = new Map(targets.map((target) => [target.key, target]));

  /**
   * Сторож одновременного опроса ОДНОЙ цели, в памяти процесса.
   *
   * Зачем: двойное нажатие шлёт аппарату два запроса и кладёт в ряд наработки два одинаковых числа
   * с разным `source_ref` — уникальный ключ наблюдений их не склеит, потому что попытки разные.
   * Почему в памяти, а не в базе: сторож защищает от двойного нажатия, а не от двух серверов, и
   * строка-замок пережила бы падение процесса, оставив цель запертой навсегда.
   */
  const inFlight = new Set<string>();

  /**
   * Карточка аппарата по серийному номеру — тем же сравнением, что у почтового опознания
   * (`upper(btrim(...))`): считай иначе, и опрос перестанет находить карточку, которую письмо
   * находит.
   *
   * Снятые карточки (`deleted_at`) не ищутся: писать наработку в удалённую значило бы копить ряд,
   * которого никто не видит.
   */
  async function equipmentBySerial(serial: string): Promise<EquipmentRef | null> {
    const normalized = normalizeIdentityValue(serial);
    if (!normalized) return null;
    const rows = await db
      .select({
        id: officeEquipment.id,
        name: officeEquipment.name,
        inventoryNumber: officeEquipment.inventoryNumber,
        serialNumber: officeEquipment.serialNumber,
      })
      .from(officeEquipment)
      .where(
        and(
          isNull(officeEquipment.deletedAt),
          sql`upper(btrim(${officeEquipment.serialNumber})) = ${normalized}`,
        ),
      )
      .limit(2);

    // Двух карточек с одним серийником быть не может — на номер стоит уникальный индекс, — но если
    // они всё же нашлись, выбирать «какую-нибудь» нельзя: показание уехало бы в произвольную.
    if (rows.length !== 1) return null;
    const row = rows[0] as (typeof rows)[number];
    return { id: row.id, title: officeEquipmentTitle(row) };
  }

  async function lastAttempt(targetKey: string): Promise<DevicePollAttemptDto | null> {
    const rows = await db
      .select({
        id: devicePollAttempts.id,
        startedAt: devicePollAttempts.startedAt,
        durationMs: devicePollAttempts.durationMs,
        outcome: devicePollAttempts.outcome,
        message: devicePollAttempts.message,
        sysDescr: devicePollAttempts.sysDescr,
        sysName: devicePollAttempts.sysName,
        deviceSerial: devicePollAttempts.deviceSerial,
        metricCode: devicePollAttempts.metricCode,
        value: devicePollAttempts.value,
        unit: devicePollAttempts.unit,
        requestedBy: users.fullName,
      })
      .from(devicePollAttempts)
      .leftJoin(users, eq(users.id, devicePollAttempts.requestedBy))
      .where(eq(devicePollAttempts.targetKey, targetKey))
      .orderBy(desc(devicePollAttempts.startedAt))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      startedAt: row.startedAt.toISOString(),
      durationMs: row.durationMs,
      outcome: row.outcome as DevicePollOutcome,
      message: row.message,
      sysDescr: row.sysDescr,
      sysName: row.sysName,
      deviceSerial: row.deviceSerial,
      metricCode: (row.metricCode as MetricCode | null) ?? null,
      // `numeric` приезжает из драйвера строкой — число здесь делается явно и в одном месте.
      value: row.value === null ? null : Number(row.value),
      unit: row.unit ? (row.unit as MetricUnit) : null,
      requestedBy: row.requestedBy,
    };
  }

  async function targetDto(target: PollTarget): Promise<DevicePollTargetDto> {
    return {
      key: target.key,
      label: target.label,
      address: targetAddress(target),
      expectedSerial: target.expectedSerial,
      equipment: target.expectedSerial ? await equipmentBySerial(target.expectedSerial) : null,
      lastAttempt: await lastAttempt(target.key),
    };
  }

  /**
   * Список целей с последней попыткой у каждой.
   *
   * ЦЕЛЕЙ ЕДИНИЦЫ, поэтому последняя попытка берётся отдельным запросом на цель, а не одним
   * `DISTINCT ON`: каждый из них — чтение одной строки по индексу, зато и типы, и время остаются
   * теми, что объявила схема. Появятся десятки целей — это первое место, которое надо будет
   * переписать одним запросом.
   *
   * ПУСТОЙ СПИСОК — ЗАКОННЫЙ ОТВЕТ, а не ошибка: «целей не настроено» означает, что реестр в
   * окружении пуст, и вкладка так и говорит.
   */
  r.get('/targets', { preHandler: [app.authenticate, canPoll] }, async (): Promise<
    DevicePollTargetsDto
  > => {
    const items: DevicePollTargetDto[] = [];
    for (const target of targets) items.push(await targetDto(target));
    return { items };
  });

  /**
   * Опрос одной цели: спросить аппарат, записать попытку и — если снятое есть куда положить —
   * показание.
   *
   * ПОПЫТКА ПИШЕТСЯ ВСЕГДА, любым исходом. Молчание сети и чужой серийник — такие же факты, как
   * снятое число, и спрашивают о них чаще: «почему за среду нет показания» отвечается только
   * журналом попыток.
   *
   * ПОКАЗАНИЕ — ТОЛЬКО ВМЕСТЕ С КАРТОЧКОЙ. Ряд наработки принадлежит аппарату, а не адресу: если
   * карточки с таким серийником в справочнике нет, число остаётся в журнале попытки и виден исход
   * `no_equipment`. Класть его «куда-нибудь» нельзя, а молчать о снятом числе — нечестно.
   */
  r.post(
    '/targets/:key/poll',
    { preHandler: [app.authenticate, canPoll], schema: { params: devicePollKeyParamsSchema } },
    async (req): Promise<DevicePollTargetDto> => {
      const p = requirePrincipal(req);
      const target = byKey.get(req.params.key);
      if (!target) {
        throw err.notFound('Цель опроса не найдена — проверьте настройку DEVICE_POLL_TARGETS');
      }
      if (inFlight.has(target.key)) {
        throw err.conflict('Опрос этой цели уже идёт — дождитесь ответа', {
          code: 'poll_in_progress',
        });
      }

      inFlight.add(target.key);
      try {
        const equipment = target.expectedSerial
          ? await equipmentBySerial(target.expectedSerial)
          : null;
        const result = await pollTarget(target, config.devicePoll.timeoutMs);

        // Снять удалось, а положить некуда: исход переписывается здесь, потому что про справочник
        // знает маршрут, а не опросчик.
        const outcome: DevicePollOutcome =
          result.reading && !equipment ? 'no_equipment' : result.outcome;
        const message =
          outcome === 'no_equipment'
            ? `${result.message}. ${
                target.expectedSerial
                  ? `Карточки с серийным номером «${target.expectedSerial}» в справочнике нет`
                  : 'У цели не задан серийный номер'
              } — показание не записано`
            : result.message;

        await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(devicePollAttempts)
            .values({
              targetKey: target.key,
              address: targetAddress(target),
              equipmentId: equipment?.id ?? null,
              startedAt: result.startedAt,
              durationMs: result.durationMs,
              outcome,
              message,
              sysDescr: result.sysDescr,
              sysName: result.sysName,
              deviceSerial: result.deviceSerial,
              // Снятое число кладётся в журнал ДАЖЕ когда наблюдение не пишется: иначе исход
              // «карточки нет» скрывал бы от человека то самое число, ради которого он нажал.
              metricCode: result.reading?.metricCode ?? null,
              value: result.reading ? String(result.reading.value) : null,
              unit: result.reading?.unit ?? '',
              requestedBy: p.id,
            })
            .returning({ id: devicePollAttempts.id });

          const attempt = inserted[0];
          if (!attempt) throw new Error('попытка опроса не записалась');

          if (result.reading && equipment && devicePollWroteValue(outcome)) {
            await tx.insert(deviceObservations).values({
              equipmentId: equipment.id,
              metricCode: result.reading.metricCode,
              // Разреза у общего счётчика нет, и это значение, а не `NULL`: пустая строка —
              // обязательная часть уникального ключа наблюдений (Р33).
              component: COMPONENT_NONE,
              value: String(result.reading.value),
              unit: result.reading.unit,
              observedAt: result.startedAt,
              // Часов аппарата опрос не спрашивает: время снятия и есть время опроса, а не то, что
              // думают о времени настройки принтера.
              deviceTime: null,
              source: 'collector',
              /**
               * Ссылка на попытку — ЗНАЧЕНИЕМ, а не внешним ключом, как и у почтового приёма. Пара
               * `source + source_ref` держит уникальность наблюдения: повторное нажатие даёт новую
               * попытку и новую строку, а не дубль той же.
               */
              sourceRef: attempt.id,
              rawLabel: `SNMP ${DEVICE_POLL_OIDS.counter}`,
            });
          }
        });

        return targetDto(target);
      } finally {
        inFlight.delete(target.key);
      }
    },
  );
}
