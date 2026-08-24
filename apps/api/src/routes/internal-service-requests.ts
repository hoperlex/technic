import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { SERVICE_CLOSING_DOCUMENT_KINDS } from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { logger } from '../logger';

/**
 * Внутренние маршруты заявок оргтехники: ими worker будит автозакрытие «Решена» → «Закрыта»
 * (план `docs/office-equipment-requests-rework-plan.md`, §7.3; решение Н7 набросков).
 *
 * ПОЧЕМУ ПЕРИОДИЧЕСКИЙ ОТБОР, А НЕ ОТЛОЖЕННАЯ ЗАДАЧА (Н7). Задачу с `runAt = «Решена» + сутки`
 * пришлось бы перезаводить при подшивке документа (иначе она срабатывает вхолостую), досоздавать
 * миграцией заявкам, уже стоящим в «Решена» на день выката, а потерянная задача означала бы
 * заявку, которая не закроется никогда. Отбор по условию не знает ни одной из этих бед: он смотрит
 * на текущее состояние, а не на то, успел ли кто-то поставить задачу.
 *
 * ПОЧЕМУ ПРАВИЛО ЖИВЁТ В API, А НЕ В WORKER. Та же причина, что записана в `internal-mail.ts`:
 * worker подключён к базе голым `pg`, а правила закрытия, запись истории и письма живут здесь.
 * Второй экземпляр правил там означал бы, что заявки закрываются по двум расходящимся версиям
 * одного правила.
 *
 * Доступ — по общему секрету, а не по учётной записи: у автозакрытия нет человека, от чьего имени
 * оно действует. Наружу префикс `/internal` не проксируется (`deploy/nginx/spa.conf`), и это
 * второй рубеж: даже с утёкшим токеном постучаться можно только из внутренней сети.
 */

/**
 * Сколько заявка стоит в «Решена», прежде чем портал закроет её сам. Сутки — окно заказчика на
 * возражение (В8а набросков).
 *
 * Константой, а не настройкой: срок — это правило цикла, одинаковое для всех заявок портала, и
 * менять его через `env` значило бы менять смысл статуса «Решена» перезапуском сервиса. Настройкой
 * задан только размер пачки — он про нагрузку, а не про правило.
 */
export const SERVICE_AUTO_CLOSE_AFTER_HOURS = 24;

/**
 * Проверка общего секрета — та же, что у почтовых внутренних ручек. Скопирована, а не вынесена в
 * общий модуль: `internal-mail.ts` держит её приватной, а два вызова одного `if` не стоят третьего
 * файла. Разъехаться им негде — обе читают одно поле конфигурации.
 */
function assertInternalToken(req: FastifyRequest): void {
  const expected = config.mail.internalToken;
  // Пустой секрет не открывает дверь всем: он закрывает её совсем.
  if (!expected) throw err.unauthorized('Внутренний доступ не настроен');
  const got = req.headers['x-internal-token'];
  if (typeof got !== 'string' || got !== expected) {
    throw err.unauthorized('Недействительный внутренний токен');
  }
}

// ── Условие отбора ──
//
// Дальше идут куски одного предиката. Собраны они из констант, а не переписаны словами, потому что
// спрашивают их дважды: в отборе пачки и в перепроверке под блокировкой. Разъедься эти две
// редакции — заявка либо закрывалась бы вопреки условию, либо не закрывалась бы никогда.

/** Строка заявки в запросах ниже называется `r`. */
const NEEDS_DOCUMENT = sql`(r.kind = 'repair' AND r.service_counterparty_id IS NOT NULL)`;

/**
 * Виды закрывающих документов — из контрактов (`SERVICE_CLOSING_DOCUMENT_KINDS`), а не строкой в
 * SQL: перечень уже разъезжался по тексту трижды, и Н8 свёл его в одно место. Акт, счёт и
 * гарантийный талон равнозначны — любой подтверждает, что работа состоялась.
 */
const CLOSING_KINDS = sql`${sql.param([...SERVICE_CLOSING_DOCUMENT_KINDS])}::text[]`;

const HAS_DOCUMENT = sql`EXISTS (SELECT 1 FROM service_request_files f
                                  WHERE f.request_id = r.id AND f.kind = ANY(${CLOSING_KINDS}))`;

/**
 * Подшивка **первого** закрывающего документа, а не последнего (§7.3). Доплатный счёт, присланный
 * через неделю после акта, сдвигал бы `max` и отодвигал закрытие заново — заявка, по которой всё
 * привезли и приняли, висела бы открытой из-за бумажного хвоста.
 */
const FIRST_DOCUMENT_AT = sql`(SELECT min(f.attached_at) FROM service_request_files f
                                WHERE f.request_id = r.id AND f.kind = ANY(${CLOSING_KINDS}))`;

/**
 * Когда заявка созревает для закрытия.
 *
 * `GREATEST` **только там, где документ обязателен** (правка после ревью плана). Безусловный
 * `GREATEST` был бы ошибкой: к инхаус-ремонту и к заявке на расходники документ не требуется, но
 * подшить его никто не мешает — и приложенный после «Решена» счёт отодвинул бы закрытие заявки,
 * которой бумага вообще не нужна. Сдвиг уместен ровно там, где документ и держал переход.
 *
 * У **новых** заявок второе слагаемое не срабатывает никогда: у сервисного ремонта документ обязан
 * лежать до «Решена» (Н8), и позднейшим всегда оказывается сам переход. Живёт правило ради
 * наследия — заявки, уехавшей в «Решена» без бумаги до выпуска 1: подшитый по ней акт делает её
 * закрываемой, и закрыть её той же секундой значило бы отдать сутки на возражение, которых никто
 * не видел.
 *
 * `completed_at` ставит переход в «Решена» и переписывает на КАЖДОМ таком переходе, поэтому возврат
 * на доработку и повторное закрытие отсчитывают сутки заново: окно на возражение открывается после
 * последнего предъявления работы, а не после первого.
 */
const DUE_AT = sql`(CASE WHEN ${NEEDS_DOCUMENT}
                         THEN GREATEST(r.completed_at, ${FIRST_DOCUMENT_AT})
                         ELSE r.completed_at END)`;

/**
 * Созревшая заявка целиком.
 *
 * ЗАЯВКИ БЕЗ ОБЯЗАТЕЛЬНОГО ДОКУМЕНТА ОТСЕКАЮТСЯ ЗДЕСЬ, А НЕ ПРОВЕРКОЙ ПОСЛЕ ВЫБОРКИ (правка после
 * ревью плана). Такие строки существуют: до выпуска 1 планка стояла только на приёмке, и внешний
 * ремонт мог уехать в «Решена» без бумаги. Возьми их отбор в пачку и отсей потом — они займут её
 * целиком и будут вытеснять законные заявки каждый прогон, а закрытия не случится ни у кого.
 * Условие повторяет `serviceRequestNeedsClosingDocument` на SQL: «либо документ не требуется, либо
 * он есть».
 *
 * Условие держит и второе: без него `GREATEST(completed_at, NULL)` в PostgreSQL равен
 * `completed_at` — то есть заявка сервиса без единой бумаги закрывалась бы ровно так же, как с
 * бумагой, и планка Н8 обходилась бы молчанием.
 *
 * Отложенная заявка (`on_hold`) сюда не попадает по статусу: её `status` не `done`, а
 * `held_from_status` условие не читает — отложенная заявка стоит, и срок ей не идёт.
 */
const MATURE = sql`r.status = 'done'
  AND r.deleted_at IS NULL
  AND r.completed_at IS NOT NULL
  AND (NOT ${NEEDS_DOCUMENT} OR ${HAS_DOCUMENT})
  AND ${DUE_AT} <= now() - (interval '1 hour' * ${sql.param(SERVICE_AUTO_CLOSE_AFTER_HOURS)})`;

interface AutoCloseStats {
  /** Сколько строк удалось взять в пачку: столько же и максимум работы у этого прогона. */
  taken: number;
  closed: number;
  /** Перепроверка под блокировкой не сошлась — заявку успели тронуть между отбором и закрытием. */
  skipped: number;
  /** Закрытие одной заявки отбилось базой; остальные в пачке от этого не страдают. */
  failed: number;
}

/**
 * Один прогон автозакрытия.
 *
 * ПАЧКА БЕРЁТСЯ `FOR UPDATE SKIP LOCKED`. Пропуск занятых строк здесь не оптимизация, а условие
 * работоспособности (Н7): заявку в этот же момент может держать человек, закрывающий её руками, и
 * без `SKIP LOCKED` отбор встал бы за его транзакцией, потянув за собой весь пакет. Пропущенная
 * строка никуда не денется — следующий прогон возьмёт её через несколько минут.
 *
 * РАЗМЕР ПАЧКИ — НАСТРОЙКА, и на первом прогоне в проде она важнее всего: отбор увидит все заявки,
 * стоявшие в «Решена» до выката, и закроет их разом. Уменьшенный размер разбирает очередь за
 * несколько проходов вместо одного.
 */
async function runAutoClose(limit: number): Promise<{ stats: AutoCloseStats; closed: string[] }> {
  const closed: string[] = [];
  let skipped = 0;
  let failed = 0;

  const taken = await db.transaction(async (tx) => {
    /**
     * Отложенные ограничения — немедленными на всю транзакцию пачки.
     *
     * Заявка держит инвариант исполнителя отложенным constraint-триггером (миграция M4): он
     * срабатывает на `COMMIT`, а не на `UPDATE`. В пачке это означало бы, что одна негодная строка
     * роняет `COMMIT` — и вместе с ним закрытие всех остальных заявок пачки, каждый прогон и
     * навсегда: отбор идёт от самых старых, и негодная строка попадала бы в пачку снова и снова.
     * `IMMEDIATE` переносит проверку на сам `UPDATE`, где её ловит точка сохранения ниже и отбивает
     * ровно одну заявку.
     */
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);

    const batch = await tx.execute<{ id: string }>(sql`
      SELECT r.id, ${DUE_AT} AS due_at
        FROM service_requests r
       WHERE ${MATURE}
       ORDER BY due_at
       LIMIT ${sql.param(limit)}
       FOR UPDATE OF r SKIP LOCKED`);

    for (const row of batch.rows) {
      try {
        // Точка сохранения на заявку: отказ базы по одной строке не уносит пачку (см. выше).
        const done = await tx.transaction(async (one) => {
          /**
           * Перепроверка условий на момент вызова. Строка уже под блокировкой, но снимок
           * подзапросов у `FOR UPDATE` может быть старше её: между отбором и блокировкой заявку
           * успевают вернуть на доработку, отложить или снять с неё документ. Не сошлось хоть одно
           * условие — тихо пропускаем, следующий прогон посмотрит заново.
           */
          const fresh = await one.execute<{ estimate_revision: number }>(sql`
            SELECT r.estimate_revision FROM service_requests r
             WHERE r.id = ${row.id} AND ${MATURE}`);
          const current = fresh.rows[0];
          if (!current) return false;

          /**
           * Приёмка без человека: `accepted_at` есть, `accepted_by` пуст, источник — `auto`
           * (миграция M2 и её `CHECK`). «Автоматически, но кем-то» — состояние, которое никто не
           * объяснит, и база его не примет.
           *
           * `updated_by` тоже обнуляется: оставить там прежнего человека значило бы записать
           * закрытие на того, кто последним правил заявку, — а закрыл её портал.
           */
          await one.execute(sql`
            UPDATE service_requests
               SET status = 'accepted',
                   accepted_at = now(),
                   accepted_by = NULL,
                   acceptance_source = 'auto',
                   status_changed_at = now(),
                   updated_by = NULL,
                   updated_at = now(),
                   version = version + 1
             WHERE id = ${row.id}`);

          /**
           * Строка истории без автора: `changed_by` пуст, `actor_source = 'system'` (миграция M2).
           * Служебная учётка вместо пустоты была бы хуже пустоты — она появлялась бы в журнале
           * наравне с людьми, и «кто закрыл мою заявку» отвечалось бы именем, которого нет.
           */
          await one.execute(sql`
            INSERT INTO service_request_status_history
                   (request_id, from_status, to_status, estimate_revision, changed_by, actor_source)
            VALUES (${row.id}, 'done', 'accepted', ${current.estimate_revision}, NULL, 'system')`);
          return true;
        });
        if (done) closed.push(row.id);
        else skipped += 1;
      } catch (e) {
        failed += 1;
        logger.error({ err: e, requestId: row.id }, 'Автозакрытие заявки оргтехники отбито базой');
      }
    }
    return batch.rows.length;
  });

  return { stats: { taken, closed: closed.length, skipped, failed }, closed };
}

export default async function internalServiceRequestRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Закрыть созревшие заявки. Тела у запроса нет: размер пачки — настройка сервера
   * (`SERVICE_REQUEST_AUTO_CLOSE_BATCH`), и позволить worker'у называть своё число значило бы
   * завести второе место, где это решается.
   */
  app.post('/auto-close', async (req) => {
    assertInternalToken(req);
    const { stats, closed } = await runAutoClose(config.serviceRequests.autoCloseBatch);

    // Аудит — после `COMMIT` и по строке на заявку: «портал закрыл сам» обязано читаться в журнале
    // сущности рядом с человеческими действиями, а не выводиться из пустого автора.
    for (const id of closed) {
      await writeAudit({
        actorUserId: null,
        action: 'serviceRequest.autoAccept',
        entityType: 'serviceRequest',
        entityId: id,
        metadata: { afterHours: SERVICE_AUTO_CLOSE_AFTER_HOURS },
      });
    }
    if (stats.taken > 0) logger.info(stats, 'Автозакрытие заявок оргтехники');
    return stats;
  });
}
