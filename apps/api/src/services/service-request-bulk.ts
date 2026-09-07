import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  formatServiceRequestNumber,
  serviceRequestBulkOperationLabels,
  SERVICE_REQUEST_BULK_CONFLICT_CODES,
  type ServiceRequestBulkFailureCode,
  type ServiceRequestBulkOperation,
  type ServiceRequestBulkResultDto,
  type ServiceRequestBulkRowResultDto,
  type ServiceRequestBulkState,
  type ServiceRequestBulkStatusDto,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import {
  serviceRequestBulkMailItems,
  serviceRequestBulkOperations,
  serviceRequests,
} from '../db/schema';
import type { Principal } from '../auth/principal';
import { AppError, err } from '../lib/errors';
import { ServiceAccessDenied } from '../lib/service-access-denied';
import { serviceRequestVisibilityWhere } from '../lib/access';
import { logger } from '../logger';
import { pgErrorOf } from '../lib/pg-error';
import { queueMail } from './mail';
import { SERVICE_MAIL_ACCOUNT, type ServiceMailBulkSink } from './service-request-mail';

/**
 * ПРОТОКОЛ МАССОВЫХ ДЕЙСТВИЙ НАД ЗАЯВКАМИ (план `docs/office-equipment-bulk-actions-plan.md`,
 * Р3, Р7, Р10; этап Э2).
 *
 * Здесь живёт всё, что у пачки СВОЕГО: ключ идемпотентности и отпечаток тела, аренда владельца с
 * heartbeat, транзакция на строку с checkpoint'ом внутри неё, подхват брошенной пачки, частичный
 * результат и финализация отчёта вместе с почтовой сводкой.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО: ни одной доменной проверки. «Можно ли эту операцию этому
 * субъекту на этой строке» решают те же шаги, что и одиночные ручки (Р2, Н9) — они приходят сюда
 * callback'ом. Заведи протокол хоть одно своё условие, «массово» стало бы обходом матрицы доступа.
 *
 * ПОЧЕМУ ЧАСТИЧНЫЙ РЕЗУЛЬТАТ, А НЕ ПОЛНЫЙ ОТКАТ (Р3). Четыре довода, и первые два технические:
 * outbox письма стоит в одной транзакции с переходом (полный откат означал бы одну транзакцию на
 * пятьдесят заявок с `FOR UPDATE` на всех), а отложенные constraint-триггеры срабатывают на
 * `COMMIT` — одна негодная строка уронила бы `COMMIT` вместе с годными, ровно то, на чём уже
 * обожглось автозакрытие. Продуктовые: пятьдесят заявок — это пятьдесят решений, а не одно, и
 * «отменили сорок девять, а пятидесятая уехала в другой статус» — законный исход, о котором надо
 * доложить, а не повод отменить сорок девять обратно.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Как доменный шаг открывает свою транзакцию.
 *
 * Обычной ручке это `db.transaction`, пачке — та же транзакция плюс checkpoint строки ВНУТРИ неё.
 * Инъекция заведена здесь, а не при выделении шагов (Э1): выделение было чистым рефакторингом, а
 * это уже новое свойство — «мутация и отметка о ней неразделимы».
 *
 * ВТОРЫМ АРГУМЕНТОМ РАБОТА ПОЛУЧАЕТ ПОЧТОВЫЙ СТОК (Р10) — `null` у одиночной ручки, заполненный у
 * строки пачки. Признак «идём в пачке» едет ИМЕННО так, а не глобальной переменной и не полем
 * модуля: он решает, получит ли адресат пятьдесят писем или одно, и обязан быть виден в сигнатуре
 * каждой точки, через которую проходит — шага, `applyTransition` и построителя письма.
 *
 * Ехать он мог бы и отдельным параметром шага, но тогда пара «транзакция строки + её сток»
 * разъехалась бы: шаг, забывший передать один из двух, писал бы намерение не в ту пачку либо слал
 * бы обычное письмо внутри пакетной транзакции — молча. Здесь они неразделимы по устройству.
 */
export type BulkTxRunner = <T>(
  fn: (tx: Tx, mail: ServiceMailBulkSink | null) => Promise<T>,
) => Promise<T>;

/** Обычная транзакция: так работают все одиночные ручки, и умолчанием стоит именно она. */
const ownTransaction: BulkTxRunner = (fn) =>
  // Стока нет — письмо уходит в очередь тем же путём, что и сегодня, без единого отличия.
  db.transaction((tx) => fn(tx, null));

/**
 * ПРИПИСКА ПАЧКИ К ЗАПИСИ АУДИТА (Р8) — то, что доменный шаг подмешивает в `metadata`.
 *
 * Форм ровно две, и вторая — ПУСТАЯ, а не `bulkOperationId: null`. «Сделано человеком поштучно» и
 * «сделано одним движением» обязаны различаться самой формой записи: `null` одинаково читался бы и
 * как «не пачкой», и как «эту запись писали до Р8», а отсутствие ключа не читается никак, кроме
 * как «пачки здесь не было». Разложенная в объект (`...`), пустая приписка не добавляет ничего —
 * metadata одиночной ручки остаётся прежней до ключа.
 */
export type BulkAuditTag = { bulkOperationId: string } | { bulkOperationId?: never };

/**
 * ЧТО ПАЧКА ДАЁТ ДОМЕННОМУ ШАГУ — ОДНИМ ПРЕДМЕТОМ (Р8, Р10).
 *
 * Внутри две вещи, и обе про одно и то же исполнение одной строки: как открыть её транзакцию и чем
 * пометить записи журнала, которые шаг сделает по её итогам. Ехать они могли бы и порознь — двумя
 * параметрами шага, — но тогда шаг, передавший одно и забывший другое, писал бы аудит без пачки,
 * выполняя её строку, либо приписывал бы пачку к обычной одиночной правке; и то и другое молча.
 * Здесь забыть половину нечем — тем же доводом, каким сток письма неотделим от транзакции.
 *
 * Умолчание (`outsideBulk`) — это и есть одиночная ручка: обычная `db.transaction`, стока письма
 * нет, приписки в аудите нет. Ни глобальной переменной, ни поля модуля: признак «идём в пачке»
 * виден в сигнатуре каждой точки, через которую проходит.
 */
export interface BulkStepContext {
  /** Как открыть транзакцию: пачка кладёт в неё checkpoint строки, одиночная ручка — нет. */
  runTx: BulkTxRunner;
  /** Приписка к `metadata` аудита: пусто вне пачки, `bulkOperationId` у её строки. */
  audit: BulkAuditTag;
}

/** Вне пачки: транзакция своя, письмо обычное, аудит без приписки — сегодняшнее поведение. */
export const outsideBulk: BulkStepContext = { runTx: ownTransaction, audit: {} };

/** Пара «идентификатор + версия» из тела запроса (Р4). */
export interface BulkRowInput {
  id: string;
  version: number;
}

/**
 * Исполнитель одной строки: зовёт тот же доменный шаг, что и одиночная ручка, передавая ему
 * контекст пачки. Ничего не возвращает — исход строки считается по тому, бросил шаг или нет.
 */
export type BulkRowRunner = (
  row: BulkRowInput,
  index: number,
  step: BulkStepContext,
) => Promise<void>;

/** Отчёт вернулся из журнала — команда уже выполнялась под этим ключом (Р7). */
interface BulkReplay {
  kind: 'replay';
  result: ServiceRequestBulkResultDto;
}

/** Пачка наша: выполняем строки, которых ещё нет в checkpoint'ах. */
interface BulkClaimed {
  kind: 'claimed';
  operationId: string;
  ownerToken: string;
  done: ServiceRequestBulkRowResultDto[];
}

type BulkClaim = BulkReplay | BulkClaimed;

/** Имя ограничения, по которому разбирается гонка двух одновременных нажатий (`23505`). */
const KEY_CONSTRAINT = 'service_request_bulk_operations_key_unique';

/** «Аренду забрал кто-то другой» — не отказ человеку, а сигнал протоколу отойти в сторону. */
class BulkLeaseLost extends Error {
  constructor() {
    super('Аренда пачки потеряна');
    this.name = 'BulkLeaseLost';
  }
}

/**
 * Отпечаток нормализованного тела (Р7, приём кандидата и закупки): версия впереди, чтобы смена
 * состава полей однажды не выдала старый отпечаток за новый.
 *
 * Нормализуется ВСЁ тело вместе с порядком строк: переставленные местами заявки — та же команда, и
 * честный повтор потерянного ответа не должен получать «ключ занят другой командой». Версии строк
 * при этом в отпечаток ВХОДЯТ: та же пачка с другими версиями — другая команда, потому что человек
 * перечитал список.
 */
export function serviceBulkFingerprint(body: unknown): string {
  return `v1:${createHash('sha256')
    .update(JSON.stringify(normalize(body)))
    .digest('hex')}`;
}

/** Устойчивый к порядку ключей вид тела: `JSON.stringify` иначе зависел бы от порядка полей. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value ?? null;
}

/** «Под этим ключом уже принята другая команда»: повторять нечего, нужен новый ключ. */
function idempotencyConflict(): never {
  throw err.conflict('Под этим ключом уже принята другая команда — обновите страницу', {
    code: SERVICE_REQUEST_BULK_CONFLICT_CODES.idempotency,
  });
}

/** «Эта же команда сейчас выполняется»: клиент продолжает читать `GET /bulk/:key` (Н12). */
function inProgressConflict(): never {
  throw err.conflict('Эта пачка уже выполняется — дождитесь отчёта', {
    code: SERVICE_REQUEST_BULK_CONFLICT_CODES.inProgress,
  });
}

const leaseInterval = () =>
  sql.raw(`interval '${Number(config.serviceRequests.bulk.leaseSeconds)} seconds'`);

/** Строка журнала в объёме, которым принимаются все решения протокола. */
interface BulkRow {
  id: string;
  operation: ServiceRequestBulkOperation;
  /** Снимок подписи автора: сводка называет, кто это сделал, а учётки к тому времени может не быть. */
  actorName: string;
  fingerprint: string;
  requestedCount: number;
  rowResults: ServiceRequestBulkRowResultDto[];
  ownerToken: string | null;
  leaseAlive: boolean;
  result: ServiceRequestBulkResultDto | null;
  finished: boolean;
}

async function findByKey(actorId: string, key: string): Promise<BulkRow | null> {
  const [row] = await db
    .select({
      id: serviceRequestBulkOperations.id,
      operation: serviceRequestBulkOperations.operation,
      actorName: serviceRequestBulkOperations.actorName,
      fingerprint: serviceRequestBulkOperations.idempotencyFingerprint,
      requestedCount: serviceRequestBulkOperations.requestedCount,
      rowResults: serviceRequestBulkOperations.rowResults,
      ownerToken: serviceRequestBulkOperations.ownerToken,
      // Живость аренды считает БАЗА, а не процесс: у двух узлов часы расходятся, и «жива ли она»
      // обязано решаться там же, где она и записана.
      leaseAlive: sql<boolean>`${serviceRequestBulkOperations.leaseExpiresAt} IS NOT NULL
        AND ${serviceRequestBulkOperations.leaseExpiresAt} > now()`,
      result: serviceRequestBulkOperations.result,
      finished: sql<boolean>`${serviceRequestBulkOperations.finishedAt} IS NOT NULL`,
    })
    .from(serviceRequestBulkOperations)
    .where(
      and(
        eq(serviceRequestBulkOperations.actorUserId, actorId),
        eq(serviceRequestBulkOperations.idempotencyKey, key),
      ),
    );
  return row ?? null;
}

/**
 * ЗАЯВКА НА ВЛАДЕНИЕ ПАЧКОЙ (Р7): запись заводится ДО выполнения и закрывается отчётом после.
 *
 * Четыре исхода, и все четыре названы планом:
 *
 *   · ключ+отпечаток совпали, запись завершена → вернуть сохранённый отчёт, ничего не выполняя;
 *   · ключ совпал, отпечаток другой → `409 bulk_idempotency`;
 *   · ключ совпал, аренда жива → `409 bulk_in_progress`;
 *   · ключ+отпечаток совпали, аренда истекла → новый `owner_token` забирает запись условным
 *     `UPDATE` и продолжает с первого индекса, которого нет в `row_results`.
 *
 * Гонка двух одновременных нажатий разбирается по ИМЕНИ уникального ограничения: `SELECT` перед
 * `INSERT` её не ловит — двое проходят его оба.
 */
async function claim(params: {
  actor: Principal;
  key: string;
  fingerprint: string;
  operation: ServiceRequestBulkOperation;
  requestedCount: number;
}): Promise<BulkClaim> {
  const seen = await findByKey(params.actor.id, params.key);
  if (seen) return takeOver(seen, params.fingerprint);

  const ownerToken = randomUUID();
  try {
    const [created] = await db
      .insert(serviceRequestBulkOperations)
      .values({
        actorUserId: params.actor.id,
        actorName: params.actor.fullName,
        idempotencyKey: params.key,
        idempotencyFingerprint: params.fingerprint,
        operation: params.operation,
        requestedCount: params.requestedCount,
        ownerToken,
        leaseExpiresAt: sql`now() + ${leaseInterval()}`,
      })
      .returning({ id: serviceRequestBulkOperations.id });
    return { kind: 'claimed', operationId: created!.id, ownerToken, done: [] };
  } catch (e) {
    // Проиграли гонку: победитель уже записан, и решение по нему принимается тем же разбором.
    if (pgErrorOf(e)?.constraint !== KEY_CONSTRAINT) throw e;
    const winner = await findByKey(params.actor.id, params.key);
    if (!winner) throw e;
    return takeOver(winner, params.fingerprint);
  }
}

/** Разбор уже существующей записи: повтор, чужая команда, живая пачка или брошенная. */
async function takeOver(row: BulkRow, fingerprint: string): Promise<BulkClaim> {
  if (row.fingerprint !== fingerprint) idempotencyConflict();
  if (row.finished && row.result) return { kind: 'replay', result: row.result };
  if (row.leaseAlive) inProgressConflict();

  const ownerToken = randomUUID();
  const [taken] = await db
    .update(serviceRequestBulkOperations)
    .set({
      ownerToken,
      leaseExpiresAt: sql`now() + ${leaseInterval()}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(serviceRequestBulkOperations.id, row.id),
        isNull(serviceRequestBulkOperations.finishedAt),
        // Условие «аренда и правда мертва» повторяется в `WHERE`, а не берётся из прочитанного:
        // между чтением и записью помещается чужой takeover, и вырвать пачку у живого владельца
        // означало бы применить строку дважды.
        sql`(${serviceRequestBulkOperations.leaseExpiresAt} IS NULL
             OR ${serviceRequestBulkOperations.leaseExpiresAt} <= now())`,
      ),
    )
    .returning({ id: serviceRequestBulkOperations.id });
  if (!taken) {
    // Либо пачку подхватил кто-то другой, либо её успели завершить: и то и другое читается
    // перечитыванием, а не догадкой.
    const now = await findByKey0(row.id);
    if (now?.finished && now.result) return { kind: 'replay', result: now.result };
    inProgressConflict();
  }
  return { kind: 'claimed', operationId: row.id, ownerToken, done: row.rowResults ?? [] };
}

/** Та же строка по идентификатору: нужна там, где ключ и автор уже отработали. */
async function findByKey0(id: string): Promise<BulkRow | null> {
  const [row] = await db
    .select({
      id: serviceRequestBulkOperations.id,
      operation: serviceRequestBulkOperations.operation,
      actorName: serviceRequestBulkOperations.actorName,
      fingerprint: serviceRequestBulkOperations.idempotencyFingerprint,
      requestedCount: serviceRequestBulkOperations.requestedCount,
      rowResults: serviceRequestBulkOperations.rowResults,
      ownerToken: serviceRequestBulkOperations.ownerToken,
      leaseAlive: sql<boolean>`${serviceRequestBulkOperations.leaseExpiresAt} IS NOT NULL
        AND ${serviceRequestBulkOperations.leaseExpiresAt} > now()`,
      result: serviceRequestBulkOperations.result,
      finished: sql<boolean>`${serviceRequestBulkOperations.finishedAt} IS NOT NULL`,
    })
    .from(serviceRequestBulkOperations)
    .where(eq(serviceRequestBulkOperations.id, id));
  return row ?? null;
}

/** Исход попытки записать checkpoint: «записали», «этот индекс уже закрыт», «аренда ушла». */
type CheckpointOutcome = 'written' | 'already' | 'lost';

/**
 * ОТМЕТКА О СТРОКЕ — УСЛОВНЫМ `UPDATE` (Р7).
 *
 * Три условия неразделимы: та же пачка (`id`), тот же владелец (`owner_token`) и незавершённость.
 * Поэтому старый процесс не может завершить строку после того, как аренду забрал новый: его
 * `UPDATE` изменит ноль строк, и вызывающий откатит мутацию вместе с ним.
 *
 * Четвёртое условие — «этого индекса ещё нет»: takeover обязан пропускать сделанное, а не удваивать
 * его. Проверяется оно тем же запросом, а не чтением перед ним: между чтением и записью помещается
 * весь остальной протокол.
 */
async function writeCheckpoint(
  exec: Tx | typeof db,
  params: {
    operationId: string;
    ownerToken: string;
    entry: ServiceRequestBulkRowResultDto;
  },
): Promise<CheckpointOutcome> {
  const entry = sql`${JSON.stringify([params.entry])}::jsonb`;
  const updated = await exec.execute(sql`
    UPDATE service_request_bulk_operations
       SET row_results = row_results || ${entry},
           lease_expires_at = now() + ${leaseInterval()},
           updated_at = now()
     WHERE id = ${params.operationId}
       AND owner_token = ${params.ownerToken}
       AND finished_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(row_results) AS e
          WHERE (e->>'index')::int = ${params.entry.index})
    RETURNING id`);
  if (updated.rows.length > 0) return 'written';
  const seen = await findByKey0(params.operationId);
  if (!seen) return 'lost';
  if (seen.rowResults.some((r) => r.index === params.entry.index)) return 'already';
  return 'lost';
}

/** Продление аренды перед строкой: живую пачку не отбирают только за то, что она длинная. */
async function heartbeat(operationId: string, ownerToken: string): Promise<void> {
  const [alive] = await db
    .update(serviceRequestBulkOperations)
    .set({ leaseExpiresAt: sql`now() + ${leaseInterval()}`, updatedAt: new Date() })
    .where(
      and(
        eq(serviceRequestBulkOperations.id, operationId),
        eq(serviceRequestBulkOperations.ownerToken, ownerToken),
        isNull(serviceRequestBulkOperations.finishedAt),
      ),
    )
    .returning({ id: serviceRequestBulkOperations.id });
  if (!alive) throw new BulkLeaseLost();
}

/** Безопасные тексты отказа: отчёт не должен становиться способом читать чужое (§6.2). */
const FAILURE_TEXT: Record<ServiceRequestBulkFailureCode, string> = {
  version: 'Заявка изменилась — обновите список и повторите',
  blocked: 'Состояние заявки этого хода не даёт',
  forbidden: 'Заявка недоступна для этого действия',
  gone: 'Заявка не найдена или уже в архиве',
  abandoned: 'Обработка прервалась — повторите по этим заявкам',
  error: 'Не удалось выполнить — попробуйте позже',
};

/**
 * Перевод отказа шага в код строки (§6.2, Р5).
 *
 * Грубость кодов намеренная: отсутствие заявки, её архивность и чужая область получают ОДИН общий
 * текст, иначе отчёт стал бы способом перебирать чужие UUID. Доменное 422 своим текстом уходит в
 * `reason` — оно написано для человека и ничего не раскрывает («Заявку сначала распределяют»).
 */
function classify(e: unknown): { code: ServiceRequestBulkFailureCode; reason: string } {
  if (e instanceof AppError) {
    if (e.statusCode === 409) return { code: 'version', reason: FAILURE_TEXT.version };
    if (e.statusCode === 404) return { code: 'gone', reason: FAILURE_TEXT.gone };
    /*
     * Отказы стражей модуля различаются ПРИЧИНОЙ, а не кодом HTTP (`ServiceAccessDenied.reason`), и
     * для отчёта это разница между «вам сюда нельзя» и «эта заявка так не ходит».
     *
     * `scope` — заявка вне области: субъект её не видел, и отчёт остаётся глухим (`forbidden`).
     * `side` — заявка ему ВИДНА, он сам выбрал её в списке, а ход в ней принадлежит другой стороне
     * либо её статус этого хода не даёт. Это ровно `blocked` из §6.2 («не тот статус»), и текст
     * доменной команды здесь можно показать целиком: он не рассказывает ничего, чего человек не
     * видит в строке. Прежде оба случая приезжали как `forbidden`, и отчёт по выбранной своими
     * руками заявке читался как «нет доступа» — да ещё и без номера.
     */
    if (e instanceof ServiceAccessDenied) {
      return e.reason === 'side'
        ? { code: 'blocked', reason: e.message || FAILURE_TEXT.blocked }
        : { code: 'forbidden', reason: FAILURE_TEXT.forbidden };
    }
    if (e.statusCode === 403) return { code: 'forbidden', reason: FAILURE_TEXT.forbidden };
    if (e.statusCode === 422 || e.statusCode === 400) {
      return { code: 'blocked', reason: e.message || FAILURE_TEXT.blocked };
    }
  }
  return { code: 'error', reason: FAILURE_TEXT.error };
}

/**
 * Коды, при которых номер не спрашивается вовсе: заявки либо нет, либо неизвестно, что с ней.
 *
 * Это НЕ про сокрытие — сокрытие держит условие видимости в самом запросе ниже. Здесь другое: у
 * `gone` строки уже нет (называть нечего), а у `error` и `abandoned` мы не знаем даже, состоялась
 * ли мутация, и номер создавал бы видимость знания. `forbidden` в перечне больше нет намеренно:
 * чужую заявку скроет предикат области, а своя, отбитая стороной хода, номер получит.
 */
const NO_NUMBER: ReadonlySet<ServiceRequestBulkFailureCode> =
  new Set<ServiceRequestBulkFailureCode>(['gone', 'error', 'abandoned']);

/**
 * Номер заявки для отчёта — по ОДНОМУ правилу: называется тот, кого субъекту видно.
 *
 * Прежде правило было перечнем кодов (`forbidden`, `gone`, `error`, `abandoned` — молчим), и он
 * ошибался в обе стороны сразу. Строка, отбитая стороной хода, теряла номер, хотя человек сам её
 * выбрал в списке, — а номер несуществующей заявки перечень бы не скрыл, потому что запрос шёл без
 * единого условия видимости.
 *
 * Теперь условие видимости стоит в самом запросе: невидимая заявка не отдаёт номера просто потому,
 * что не находится. Это тот же предикат, которым отбирается список, — то есть отчёт не может
 * назвать номер, которого человек не увидел бы в реестре.
 */
async function displayNumberOf(
  p: Principal,
  id: string,
  exec: Tx | typeof db = db,
): Promise<string | null> {
  const [row] = await exec
    .select({ num: serviceRequests.num })
    .from(serviceRequests)
    .where(and(eq(serviceRequests.id, id), serviceRequestVisibilityWhere(p)));
  return row ? formatServiceRequestNumber(row.num) : null;
}

export interface RunServiceBulkParams {
  actor: Principal;
  key: string;
  fingerprint: string;
  operation: ServiceRequestBulkOperation;
  rows: BulkRowInput[];
  run: BulkRowRunner;
  /** Лог запроса: одна строка на пачку, как у приёма показаний (§8). */
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

/**
 * ВЫПОЛНЕНИЕ ПАЧКИ (Р3, Р7).
 *
 * Транзакция на строку, порядок ответа — порядок запроса, HTTP всегда `200` (кроме отказов на весь
 * запрос, которые разбирает вызывающий до входа сюда).
 */
export async function runServiceRequestBulk(
  params: RunServiceBulkParams,
): Promise<ServiceRequestBulkResultDto> {
  const started = Date.now();
  const claimed = await claim({
    actor: params.actor,
    key: params.key,
    fingerprint: params.fingerprint,
    operation: params.operation,
    requestedCount: params.rows.length,
  });
  if (claimed.kind === 'replay') return claimed.result;

  const { operationId, ownerToken } = claimed;
  const done = new Map<number, ServiceRequestBulkRowResultDto>(
    claimed.done.map((entry) => [entry.index, entry]),
  );

  try {
    for (const [index, row] of params.rows.entries()) {
      if (done.has(index)) continue;
      await heartbeat(operationId, ownerToken);
      const entry = await runRow({ ...params, operationId, ownerToken, row, index });
      done.set(index, entry);
    }
  } catch (e) {
    if (!(e instanceof BulkLeaseLost)) throw e;
    /*
     * Аренду забрал другой заход — и это не отказ человеку: пачка продолжается там, а сделанное
     * здесь уже зафиксировано вместе со своими мутациями. Клиенту отвечает состояние по ключу.
     */
    params.log?.info({ operationId, operation: params.operation }, 'пачка заявок: аренда ушла');
    inProgressConflict();
  }

  const result = await finalize({
    operationId,
    ownerToken,
    operation: params.operation,
    actorName: params.actor.fullName,
  });
  params.log?.info(
    {
      operationId,
      operation: params.operation,
      size: params.rows.length,
      done: result.done,
      failed: result.failed,
      durationMs: Date.now() - started,
    },
    'пачка заявок: выполнена',
  );
  return result;
}

/**
 * ОДНА СТРОКА (Р7).
 *
 * Успешная мутация и checkpoint — в ОДНОЙ транзакции: ноль изменённых строк на checkpoint'е бросает
 * исключение и откатывает мутацию. Ожидаемый доменный отказ откатывает транзакцию строки, после
 * чего `failed` пишется короткой отдельной транзакцией с той же проверкой владельца. Падение между
 * этими двумя действиями безопасно: мутация не зафиксирована, строка повторится. Падение после
 * успешной транзакции безопасно тоже: checkpoint зафиксирован вместе с ней, и takeover пропустит
 * индекс.
 */
async function runRow(params: {
  operationId: string;
  ownerToken: string;
  /** Субъект пачки: им же спрашивается видимость заявки для номера в отчёте. */
  actor: Principal;
  row: BulkRowInput;
  index: number;
  run: BulkRowRunner;
  log?: RunServiceBulkParams['log'];
}): Promise<ServiceRequestBulkRowResultDto> {
  const { operationId, ownerToken, actor, row, index } = params;
  const entry: ServiceRequestBulkRowResultDto = {
    index,
    id: row.id,
    displayNumber: null,
    outcome: 'done',
  };

  /**
   * Сток письма ЭТОЙ строки. Пара «операция + позиция» — половина первичного ключа намерения,
   * поэтому строка, повторённая после takeover, намерения не удваивает, а брошенная — не оставляет
   * его от чужой пачки.
   */
  const mailSink: ServiceMailBulkSink = { operationId, rowIndex: index };

  const runTx: BulkTxRunner = (fn) =>
    db.transaction(async (tx) => {
      /*
       * Пределы транзакции СТРОКИ, и оба меньше аренды: строка, застрявшая дольше, чем живёт
       * аренда, дала бы пачке двух владельцев сразу. Числа приходят из настроек (Р7) и
       * подставляются `sql.raw`, потому что `SET` параметров не принимает вовсе.
       */
      await tx.execute(
        sql.raw(
          `SET LOCAL lock_timeout = '${Number(config.serviceRequests.bulk.lockTimeoutSeconds)}s'`,
        ),
      );
      await tx.execute(
        sql.raw(
          `SET LOCAL statement_timeout = '${Number(config.serviceRequests.bulk.statementTimeoutSeconds)}s'`,
        ),
      );
      /*
       * Отложенные ограничения — немедленными (Н5). Заявка держит инвариант исполнителя отложенным
       * constraint-триггером, срабатывающим на `COMMIT`: без этого негодная строка отвечала бы не
       * своим доменным отказом, а падением `COMMIT` уже после checkpoint'а — то есть откатывала бы
       * собственную отметку и повторялась бы на каждом заходе. Приём взят у автозакрытия.
       */
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      /*
       * Сток уезжает работе ВТОРЫМ аргументом — вместе с транзакцией и неотделимо от неё (Р10).
       * Доменный шаг передаёт его дальше, в `applyTransition` и в построитель письма; тот вместо
       * строки `mail_messages` кладёт намерение в `service_request_bulk_mail_items`, откуда его
       * заберёт одна сводка на пару «адресат + аудитория».
       */
      const out = await fn(tx, mailSink);
      /*
       * Номер читается ЗДЕСЬ, до checkpoint'а и в той же транзакции. Проставленный после неё, он
       * попал бы только в ответ этого захода: в `row_results` уехала бы строка без номера, и
       * повтор по ключу (равно как и чтение состояния) вернул бы отчёт, в котором успешные заявки
       * безымянны. Отчёт обязан быть один и тот же, слово в слово.
       */
      entry.displayNumber = await displayNumberOf(actor, row.id, tx);
      const checkpoint = await writeCheckpoint(tx, { operationId, ownerToken, entry });
      if (checkpoint !== 'written') throw new BulkLeaseLost();
      return out;
    });

  /**
   * КОНТЕКСТ ЭТОЙ СТРОКИ (Р8): её транзакция и приписка пачки к аудиту — одним предметом.
   *
   * Идентификатор здесь тот же, что у стока письма и у checkpoint'а, и берётся он из одного места:
   * запись журнала, сток намерения и отметка о строке обязаны называть ОДНУ пачку, иначе «эти
   * двадцать записей сделаны одним движением» перестало бы проверяться сложением.
   */
  const step: BulkStepContext = { runTx, audit: { bulkOperationId: operationId } };

  try {
    await params.run(row, index, step);
    return entry;
  } catch (e) {
    if (e instanceof BulkLeaseLost) throw e;
    const { code, reason } = classify(e);
    if (code === 'error') {
      // В лог идёт только непредвиденный сбой строки — как у приёма показаний. Построчные отказы
      // живут в отчёте и в аудите, и дублировать их логом значит утопить в них настоящий сбой.
      params.log?.error(
        { operationId, requestId: row.id, index, err: e },
        'пачка заявок: сбой строки',
      );
      logger.error({ operationId, requestId: row.id, index, err: e }, 'пачка заявок: сбой строки');
    }
    const failed: ServiceRequestBulkRowResultDto = {
      index,
      id: row.id,
      displayNumber: NO_NUMBER.has(code) ? null : await displayNumberOf(actor, row.id),
      outcome: 'failed',
      code,
      reason,
    };
    const checkpoint = await writeCheckpoint(db, { operationId, ownerToken, entry: failed });
    if (checkpoint === 'lost') throw new BulkLeaseLost();
    return failed;
  }
}

/**
 * ФИНАЛИЗАЦИЯ (Р7, Р10).
 *
 * Порядок обязателен: сперва почтовая сводка, и только потом `finished_at`. Упади процесс между
 * ними — пачка останется в состоянии `finishing_notifications`, а не соврёт `finished`, и takeover
 * повторит ТОЛЬКО финализацию: сама постановка сводки идемпотентна по `dedupe_key`.
 */
async function finalize(params: {
  operationId: string;
  ownerToken: string;
  operation: ServiceRequestBulkOperation;
  actorName: string;
}): Promise<ServiceRequestBulkResultDto> {
  await queueBulkDigest(params.operationId, params.operation, params.actorName);

  const row = await findByKey0(params.operationId);
  if (!row) throw err.notFound('Пачка не найдена');
  if (row.finished && row.result) return row.result;

  const rows = [...row.rowResults].sort((a, b) => a.index - b.index);
  const result: ServiceRequestBulkResultDto = {
    operationId: params.operationId,
    operation: params.operation,
    done: rows.filter((r) => r.outcome === 'done').length,
    failed: rows.filter((r) => r.outcome === 'failed').length,
    rows,
  };
  const [closed] = await db
    .update(serviceRequestBulkOperations)
    .set({
      result,
      doneCount: result.done,
      failedCount: result.failed,
      finishedAt: new Date(),
      // Аренда снимается вместе с итогом: держать её после завершения не за чем, а оставленная
      // она мешала бы разбору «кто сейчас работает».
      ownerToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(serviceRequestBulkOperations.id, params.operationId),
        eq(serviceRequestBulkOperations.ownerToken, params.ownerToken),
        isNull(serviceRequestBulkOperations.finishedAt),
      ),
    )
    .returning({ id: serviceRequestBulkOperations.id });
  if (closed) return result;

  // Пачку закрыл кто-то другой — возвращается ЕГО отчёт, а не пересчитанный здесь: два отчёта об
  // одной пачке означали бы, что «повтор вернул тот же результат» перестало быть правдой.
  const settled = await findByKey0(params.operationId);
  return settled?.result ?? result;
}

/**
 * ПОЧТОВАЯ СВОДКА ПАЧКИ (Р10) — один digest на пару «адресат + аудитория».
 *
 * ЗАЧЕМ ОНА ВООБЩЕ. Существующий потолок писем модуля считается по тройке «заявка + адрес + час» и
 * от пачки по РАЗНЫМ заявкам не спасает: пятьдесят отменённых заявок дали бы одному адресату
 * пятьдесят обычных писем.
 *
 * ОТКУДА БЕРУТСЯ НАМЕРЕНИЯ. Их складывает сам построитель писем: `queueServiceMailForIntent`
 * получает сток строки (`ServiceMailBulkSink`) и вместо строки `mail_messages` пишет намерение в
 * `service_request_bulk_mail_items` — той же транзакцией, что и мутация строки. Все решения «кому
 * и что можно сообщить» при этом остаются его: рубильник события, обязательные цели, адресаты,
 * аудитории и тело считаются тем же кодом, что у одиночной ручки. Здесь — только доставка уже
 * сложенного.
 *
 * ЧЕГО ЗДЕСЬ НЕ ВОССТАНОВИТЬ. Проекция аудитории применена НА СТРОКЕ: `projected_payload` хранит
 * готовую строку сводки для этого читателя. Собирать её тут из полной заявки нельзя — заявка к
 * этому моменту уже другая, а что именно позволено видеть данному адресату, знает только тот код,
 * который и посчитал ему аудиторию.
 *
 * ПАЧКА БЕЗ ПИСЕМ — ЗАКОННЫЙ СЛУЧАЙ: у срочности и архивирования почтового события нет вовсе, и
 * `items.length === 0` означает «сводке не о чем», а не сбой.
 */
async function queueBulkDigest(
  operationId: string,
  operation: ServiceRequestBulkOperation,
  actorName: string,
): Promise<void> {
  // Почта выключена — сводки нет, и это не ошибка пачки: доменная работа уже сделана.
  if (!config.mail.enabled) return;
  const items = await db
    .select({
      recipientHash: serviceRequestBulkMailItems.recipientHash,
      recipientEmail: serviceRequestBulkMailItems.recipientEmail,
      audience: serviceRequestBulkMailItems.audience,
      rowIndex: serviceRequestBulkMailItems.rowIndex,
      payload: serviceRequestBulkMailItems.projectedPayload,
    })
    .from(serviceRequestBulkMailItems)
    .where(eq(serviceRequestBulkMailItems.operationId, operationId))
    // Порядок строк в письме — порядок строк в запросе, а не порядок выдачи планировщика: человек
    // сверяет сводку с тем списком, который отправлял.
    .orderBy(serviceRequestBulkMailItems.rowIndex);
  if (items.length === 0) return;

  const groups = new Map<string, { email: string; hash: string; lines: string[] }>();
  for (const item of items) {
    const key = `${item.recipientHash}:${item.audience}`;
    const group = groups.get(key) ?? {
      email: item.recipientEmail,
      hash: item.recipientHash,
      lines: [],
    };
    group.lines.push(payloadLine(item.payload, item.rowIndex));
    groups.set(key, group);
  }

  const label = serviceRequestBulkOperationLabels[operation];
  for (const group of groups.values()) {
    /*
     * `dedupe_key = bulk:<operationId>:<recipientHash>` и уникальность очереди по паре
     * `(kind, dedupe_key)` делают финализацию повторяемой: упавший на середине финализатор
     * повторяется целиком и второго письма не ставит.
     *
     * Ключ различает и АУДИТОРИИ, хотя её имени в нём нет: `recipientHash` — отпечаток пары
     * «аудитория + адрес» (`bulkMailRecipientHash`), а не одного адреса. Хешируй он адрес — два
     * письма одному человеку, попавшему в пачке и во внутреннюю аудиторию, и в копию, получили бы
     * один ключ, и второе молча подавилось бы уникальностью очереди.
     */
    await queueMail({
      kind: 'service_request_bulk_summary',
      dedupeKey: `bulk:${operationId}:${group.hash}`,
      to: group.email,
      account: SERVICE_MAIL_ACCOUNT,
      subject: `Заявки на обслуживание: ${label.toLowerCase()} — ${group.lines.length}`,
      entityType: 'serviceRequestBulkOperation',
      entityId: operationId,
      content: {
        title: `${label}: заявок — ${group.lines.length}`,
        blocks: [
          { kind: 'lines', lines: [`Действие: ${label}`, `Выполнил: ${actorName}`] },
          { kind: 'list', items: group.lines },
        ],
      },
    });
  }
  // Одна строка на пачку, как и у самой пачки (§8): сколько сводок и на сколько намерений. Адресов
  // в логе нет — они в очереди писем и в аудите, у которых есть право доступа.
  logger.info(
    { operationId, operation, digests: groups.size, items: items.length },
    'пачка заявок: почтовая сводка поставлена',
  );
}

/**
 * Строка сводки по уже спроецированному payload'у. Контракт синка: `line` — готовая строка для
 * читателя этой аудитории, `displayNumber` — номер заявки. Ни того ни другого нет — называется
 * позиция в пачке: соврать номером хуже, чем не назвать его.
 */
function payloadLine(payload: unknown, rowIndex: number): string {
  const data = (payload ?? {}) as { line?: unknown; displayNumber?: unknown };
  if (typeof data.line === 'string' && data.line.trim()) return data.line.trim();
  if (typeof data.displayNumber === 'string' && data.displayNumber.trim()) {
    return data.displayNumber.trim();
  }
  return `Заявка № ${rowIndex + 1} в пачке`;
}

/** Состояние пачки по её строке: `finishing_notifications` — строки готовы, сводка ещё нет (Р10). */
function stateOf(row: BulkRow): ServiceRequestBulkState {
  if (row.finished) return 'finished';
  return row.rowResults.length >= row.requestedCount ? 'finishing_notifications' : 'running';
}

/**
 * ЧИТАЮЩАЯ РУЧКА ПО КЛЮЧУ (Р1, Н12): прогресс и восстановление после обрыва.
 *
 * Область здесь одна и своя — автор пачки: чужой ключ отвечает `null` (маршрут превращает это в
 * `404`), а не «не ваша пачка». Синхронный `POST` сам по себе честного прогресса не даёт: после
 * обрыва сети клиент не знает, работает ли пачка, а ответ появится лишь в конце.
 */
export async function readServiceBulkStatus(
  actorId: string,
  key: string,
): Promise<ServiceRequestBulkStatusDto | null> {
  const row = await findByKey(actorId, key);
  if (!row) return null;
  return {
    operationId: row.id,
    state: stateOf(row),
    requested: row.requestedCount,
    processed: row.rowResults.length,
    result: row.result,
  };
}

/**
 * УБОРКА ЖУРНАЛА ПАЧЕК (§6.3), две фазы и обе без единого нового доменного действия.
 *
 * 1. Брошенная пачка с истёкшей арендой и без heartbeat дольше `abandonHours` закрывается
 *    сохранённым итогом: уже готовые строки остаются как есть, необработанные получают
 *    `abandoned`. Так никогда не повторённая пачка не живёт вечно, а её зафиксированные успехи не
 *    теряются и не превращаются в ложное «ничего не вышло».
 * 2. Завершённые пачки старше `retentionDays` удаляются каскадом вместе со своими почтовыми
 *    намерениями.
 *
 * ВЫЗЫВАТЬ ЕЁ ОБЯЗАН WORKER (`apps/worker`), и его задача этим этапом НЕ заводится: файлы воркера
 * лежат за границей этой работы. До неё код `abandoned` в отчёте не появляется ни разу — брошенная
 * пачка просто ждёт повтора по ключу, который её и подхватит.
 */
export async function sweepServiceRequestBulk(): Promise<{ closed: number; purged: number }> {
  const abandonHours = Number(config.serviceRequests.bulk.abandonHours);
  const retentionDays = Number(config.serviceRequests.bulk.retentionDays);

  /*
   * Без `FOR UPDATE SKIP LOCKED`, и это решение: взятая ВНЕ транзакции блокировка отпускается тем
   * же запросом и не удерживает ничего — она выглядела бы защитой, не будучи ею. Двух уборщиков
   * разводит условный `UPDATE` ниже (`finished_at IS NULL`): второй изменит ноль строк и просто не
   * посчитает пачку своей.
   */
  const stale = await db.execute<{ id: string }>(sql`
    SELECT id FROM service_request_bulk_operations
     WHERE finished_at IS NULL
       AND updated_at < now() - ${sql.raw(`interval '${abandonHours} hours'`)}
       AND (lease_expires_at IS NULL OR lease_expires_at <= now())`);

  let closed = 0;
  for (const { id } of stale.rows) {
    const row = await findByKey0(id);
    if (!row || row.finished) continue;
    /*
     * СВОДКА СТАВИТСЯ И ЗДЕСЬ, И ДО ЗАКРЫТИЯ (§6.3, Р10). Уборка — вторая, и последняя, дверь к
     * финализации: у брошенной пачки уже есть успешные строки, а у них — сложенные почтовые
     * намерения. Закрой мы её без сводки, эти намерения не доставил бы никто и retention снёс бы
     * их каскадом: адресат так и не узнал бы о сорока девяти отменённых заявках. Новых доменных
     * действий уборка при этом не делает — сводка лишь доставляет уже решённое.
     */
    await queueBulkDigest(row.id, row.operation, row.actorName);
    const seen = new Set(row.rowResults.map((r) => r.index));
    const rows = [...row.rowResults];
    for (let index = 0; index < row.requestedCount; index += 1) {
      if (seen.has(index)) continue;
      rows.push({
        index,
        // Идентификатора необработанной строки в журнале нет: тело запроса не хранится, и
        // придумывать его на уборке нельзя. Портал сопоставляет строку по `index`.
        id: '',
        displayNumber: null,
        outcome: 'failed',
        code: 'abandoned',
        reason: FAILURE_TEXT.abandoned,
      });
    }
    rows.sort((a, b) => a.index - b.index);
    const result: ServiceRequestBulkResultDto = {
      operationId: id,
      operation: row.operation,
      done: rows.filter((r) => r.outcome === 'done').length,
      failed: rows.filter((r) => r.outcome === 'failed').length,
      rows,
    };
    const [done] = await db
      .update(serviceRequestBulkOperations)
      .set({
        rowResults: rows,
        result,
        doneCount: result.done,
        failedCount: result.failed,
        finishedAt: new Date(),
        ownerToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(serviceRequestBulkOperations.id, id),
          isNull(serviceRequestBulkOperations.finishedAt),
        ),
      )
      .returning({ id: serviceRequestBulkOperations.id });
    if (done) closed += 1;
  }

  const purged = await db.execute(sql`
    DELETE FROM service_request_bulk_operations
     WHERE finished_at IS NOT NULL
       AND finished_at < now() - ${sql.raw(`interval '${retentionDays} days'`)}`);
  return { closed, purged: purged.rowCount ?? 0 };
}
