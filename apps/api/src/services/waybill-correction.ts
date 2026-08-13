import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import {
  type AccessSubject,
  type BackdateAccess,
  backdateGuard,
  type BackdateVerdict,
  can,
} from '@technic/contracts';
import { db } from '../db/client';
import { vehicleRequestCorrections, waybillCorrections, waybills } from '../db/schema';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';

/**
 * Операция коррекции задним числом (ADR 0101, миграция 0129).
 *
 * Входов у заднего числа много — списание бланка (Р20), коррекция рейса (Р2), перенос между
 * рейсами (Р30), сверка ЭСМ-2 (Р8), дата заявки (Р6), — а правило у всех одно: правка прошедшего
 * дня существует только вместе с правом, причиной, автором и следом. Здесь живёт то общее, что
 * иначе каждый вход написал бы по-своему:
 *
 * - перевод вердикта `backdateGuard` в HTTP-отказ (`permission` → 403, `reason` и `limit` → 422);
 * - заведение строки операции в транзакции вместе с самой правкой;
 * - идемпотентность по ключу клиента и отпечатку тела (Р31);
 * - мелочь, которую легко посчитать по-разному: эффективная дата листа, связь операции с заявками,
 *   аннулирование листа операцией.
 *
 * Почему транзакционная таблица, а не аудит, объяснено в схеме и в ADR 0101 п. 8: `writeAudit`
 * пишет отдельным соединением и глотает ошибку — единственным носителем обоснования правки бланка
 * строгой отчётности best-effort лог быть не может. Аудит рядом остаётся, но как дополнение.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Транзакция операции — её получает `perform`, и в ней же обязана идти вся правка. */
export type CorrectionTx = Tx;
/** Читающие функции годятся и вне транзакции: карточка спрашивает их до всякой правки. */
type Reader = Tx | typeof db;

/**
 * Вид операции. Тип берётся у самой колонки, а не переписывается сюда списком: реестр значений
 * держит `waybill_corrections.kind` вместе со своим CHECK, и второй перечень тех же слов разошёлся
 * бы с ним при первом же новом входе.
 */
export type CorrectionKind = (typeof waybillCorrections)['$inferInsert']['kind'];

/** Строка операции — то, на что ссылаются оба листа и затронутые заявки. */
export interface CorrectionRecord {
  id: string;
  operationId: string;
  kind: CorrectionKind;
  reason: string;
  actorUserId: string;
  createdAt: Date;
}

/**
 * Команда, которую операция исполняет. `target` и `body` в фингерпринт идут вместе и по разным
 * причинам: тело у коррекции рейса и у переноса совпадает по форме, а цель у них разная — id в
 * пути ручки телом не передаётся вовсе, и без него один ключ покрыл бы две разные команды.
 */
export interface CorrectionCommand {
  /** Ключ идемпотентности от клиента (Р31): uuid, придуманный до отправки. */
  operationId: string;
  kind: CorrectionKind;
  /** Что правим: id из пути ручки; у переноса — оба рейса. */
  target: string | readonly string[];
  /** Тело запроса, каким его разобрала схема. */
  body: unknown;
  /** Причина операции: она же уходит в листы (Р35) и объясняет разрыв нумерации через месяцы. */
  reason: string;
  actorUserId: string;
}

export interface CorrectionHandlers {
  /**
   * Проверка доступа — полем, а не порядком вызова.
   *
   * Сервис зовёт её сам и первой, на **каждой** попытке, включая повтор. Иначе проверка, стоящая
   * внутри `perform` (а под блокировками ей там самое место), на повторе молча пропала бы:
   * `perform` в этом случае не выполняется вовсе. Отдать прежний результат тому, у кого право
   * успели отобрать, — та же утечка, что выполнить операцию без права (Р31).
   *
   * Возвращаемое значение сервису не нужно и потому не сужается: вызывающий обычно зовёт эту же
   * функцию до `runCorrection` — вердикт заднего числа решает, нужна ли операция вообще, — и она
   * там что-нибудь возвращает. Второй прогон чистого предиката ничего не стоит.
   */
  authorize: () => unknown;
  /**
   * Сама правка — в транзакции операции. Возвращает снимок «было → стало» для `payload`:
   * справочники живут своей жизнью, а объяснять операцию придётся через месяцы, и восстановить
   * прежние значения по текущему состоянию будет уже нечем.
   *
   * Ответ HTTP отсюда не собирается намеренно (Р31): его вызывающий пересобирает из текущего
   * состояния листов, рейса и заявок — одним и тем же кодом на обеих ветках. Снимок DTO протух бы
   * при первой же правке контракта, а повтор обязан отвечать то же, что ответил бы новый запрос.
   */
  perform: (tx: Tx, correction: CorrectionRecord) => Promise<Record<string, unknown>>;
}

export interface CorrectionOutcome {
  correction: CorrectionRecord;
  /** true — операцию уже выполнял этот же запрос; `perform` не звался, номер не сгорел. */
  repeated: boolean;
}

export const CORRECTION_KEY_REUSED =
  'Ключ операции уже занят другой командой — повтором возвращается только тот же самый запрос. Обновите страницу и выполните действие заново';

export const CORRECTION_KEY_FOREIGN =
  'Операция с этим ключом выполнена другим пользователем — обновите страницу: её результат уже в журнале';

export const CORRECTION_OPERATION_ID_REQUIRED =
  'Команда задним числом идёт с ключом операции: без него повтор после обрыва связи сжёг бы второй номер бланка';

/**
 * Отпечаток команды — хеш нормализованного значения.
 *
 * Нормализация делает две вещи и обе обязательны: сортирует ключи объектов (порядок полей в JSON
 * от клиента не гарантирован, а ретрай той же кнопки обязан дать тот же отпечаток) и выбрасывает
 * `undefined` (необязательное поле, не переданное вовсе, и оно же, переданное пустым, — одна и та
 * же команда). Порядок элементов массива, наоборот, сохраняется: у коррекции им задаётся порядок
 * талонов, и перестановка — другая команда.
 */
export function correctionFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeForFingerprint(value)) ?? 'null')
    .digest('hex');
}

function normalizeForFingerprint(value: unknown): unknown {
  // Дата в теле команды не ждётся, но `JSON.stringify` превратил бы её в строку, а обход по ключам
  // — в пустой объект: два разных дня дали бы один отпечаток.
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForFingerprint);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    normalized[key] = normalizeForFingerprint(item);
  }
  return normalized;
}

/**
 * Выполнить команду задним числом — один раз, что бы ни делала сеть (Р31).
 *
 * Порядок такой:
 *
 * 1. `authorize` — до всего; на повторе это единственная проверка доступа, какая вообще случится;
 * 2. поиск прежней операции по ключу. Нашлась — сверяются отпечаток и автор, и вызывающий
 *    пересобирает ответ из текущего состояния, ничего не выполняя;
 * 3. транзакция: строка операции, `perform`, снимок в `payload`. Всё вместе — иначе номер бланка
 *    сгорел бы, а объяснения не осталось.
 *
 * Гонка двух одновременных ретраев доходит до `waybill_corrections_operation_unique`: проигравшая
 * транзакция откатывается целиком (в PostgreSQL после ошибки продолжать в ней нечего), после чего
 * прежняя операция перечитывается уже вне её — и запрос отвечает как обычный повтор. Проверка
 * `SELECT` перед вставкой её не отменяет: между чтением и вставкой чужая транзакция ещё не видна.
 */
export async function runCorrection(
  command: CorrectionCommand,
  handlers: CorrectionHandlers,
): Promise<CorrectionOutcome> {
  await handlers.authorize();
  const fingerprint = correctionFingerprint({
    kind: command.kind,
    target: command.target,
    body: command.body,
  });

  const prior = await findCorrection(db, command.operationId);
  if (prior) return { correction: sameCommandOrThrow(prior, command, fingerprint), repeated: true };

  try {
    const correction = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(waybillCorrections)
        .values({
          operationId: command.operationId,
          fingerprint,
          kind: command.kind,
          reason: command.reason,
          actorUserId: command.actorUserId,
        })
        .returning(correctionColumns);
      const created = row!;
      const payload = await handlers.perform(tx, created);
      // Снимок отдельным `UPDATE`, потому что «было → стало» становится известно только внутри
      // `perform`, а идентификатор операции нужен ему самому — листы ссылаются на неё колонкой.
      await tx
        .update(waybillCorrections)
        .set({ payload })
        .where(eq(waybillCorrections.id, created.id));
      return created;
    });
    return { correction, repeated: false };
  } catch (e) {
    if (!isOperationKeyRace(e)) throw e;
    const winner = await findCorrection(db, command.operationId);
    // Строки нет — значит уникальность нарушил не наш ключ (либо победитель сам откатился уже
    // после нас). Придумывать этому объяснение нечем: ошибка уходит как есть.
    if (!winner) throw e;
    return { correction: sameCommandOrThrow(winner, command, fingerprint), repeated: true };
  }
}

const correctionColumns = {
  id: waybillCorrections.id,
  operationId: waybillCorrections.operationId,
  fingerprint: waybillCorrections.fingerprint,
  kind: waybillCorrections.kind,
  reason: waybillCorrections.reason,
  actorUserId: waybillCorrections.actorUserId,
  createdAt: waybillCorrections.createdAt,
};

/** Операция по ключу клиента — для повтора и для карточки разбирательства. */
export async function findCorrection(
  reader: Reader,
  operationId: string,
): Promise<(CorrectionRecord & { fingerprint: string }) | undefined> {
  const [row] = await reader
    .select(correctionColumns)
    .from(waybillCorrections)
    .where(eq(waybillCorrections.operationId, operationId));
  return row;
}

/**
 * Тот же ли это запрос. Ключ отвечает лишь на «повтор?», и клиент, переиспользовавший uuid, молча
 * получил бы чужой результат вместо выполнения своей команды — поэтому сверяются оба признака:
 * отпечаток тела и автор. Отказ один и тот же по смыслу («это не повтор»), но тексты разные: одно
 * поручение человеку — повторить действие заново, другое — обновить страницу и посмотреть, что уже
 * сделал коллега.
 */
function sameCommandOrThrow(
  prior: CorrectionRecord & { fingerprint: string },
  command: CorrectionCommand,
  fingerprint: string,
): CorrectionRecord {
  if (prior.actorUserId !== command.actorUserId) throw err.conflict(CORRECTION_KEY_FOREIGN);
  if (prior.fingerprint !== fingerprint) throw err.conflict(CORRECTION_KEY_REUSED);
  return prior;
}

function isOperationKeyRace(e: unknown): boolean {
  const pg = pgErrorOf(e);
  return pg?.code === '23505' && pg.constraint === 'waybill_corrections_operation_unique';
}

// ── Право и граница заднего числа ──

/**
 * Что субъекту позволено задним числом (Р37). Отдельной функцией, потому что спрашивают это все
 * входы, а пара прав легко разъезжается: `waybills.correctBeyondLimit` без `waybills.correct` не
 * значит ничего, и складывать их каждый раз заново — способ однажды сложить неверно.
 */
export function backdateAccessOf(subject: AccessSubject | null | undefined): BackdateAccess {
  return {
    correct: can(subject, 'waybills.correct'),
    beyondLimit: can(subject, 'waybills.correctBeyondLimit'),
  };
}

export interface BackdateCheckInput {
  /**
   * Эффективная дата операции — строго по таблице §4 плана: у рейса `routeDate`, у грузовой
   * заявки день `scheduledAt` по МСК, у листа ЭСМ-2 `periodTo`, у правки срока — та граница,
   * которую двигают. Ошибка здесь дороже всех прочих: сдвинув её на день, сдвигаешь всю границу.
   */
  effectiveDate: string;
  /** Сегодня по МСК (`moscowDateKeyOf`) — тем же поясом границу считает портал. */
  today: string;
  subject: AccessSubject | null | undefined;
  hasReason: boolean;
}

/** Вердикт по дате операции — тот же `backdateGuard`, но с правами, прочитанными у субъекта. */
export function checkBackdate(input: BackdateCheckInput): BackdateVerdict {
  const access = backdateAccessOf(input.subject);
  return backdateGuard({
    effectiveDate: input.effectiveDate,
    today: input.today,
    allowed: access.correct,
    unlimited: access.beyondLimit,
    hasReason: input.hasReason,
  });
}

/**
 * Вердикт в HTTP-отказ; возвращает `backdated` — задним ли числом идёт операция.
 *
 * Коды разведены намеренно (Р29): «нет права» это 403 и поручение другому человеку, «не хватает
 * причины» и «слишком давно» — 422 и поручение либо самому просителю, либо администратору. Один
 * код на все три сделал бы отказ нечитаемым, а портал — гадающим, что показать.
 */
export function backdateOrThrow(verdict: BackdateVerdict): boolean {
  if (verdict.ok) return verdict.backdated;
  if (verdict.code === 'permission') throw err.forbidden(verdict.reason);
  throw err.unprocessable(verdict.reason);
}

/**
 * Эффективная дата существующего листа — `periodTo` у ЭСМ-2, день выезда у листа на рейс.
 *
 * Тем же выражением границу считает `canCancelWaybill`, и это не совпадение: «когда неделя
 * кончилась» обязано считаться в портале один раз. Второй расчёт того же через понедельник
 * разошёлся бы с первым на шесть дней (Р29).
 */
export function waybillEffectiveDate(waybill: {
  issuedForDate: string;
  periodTo?: string | null;
}): string {
  return waybill.periodTo || waybill.issuedForDate;
}

// ── Что операция делает с листами и заявками ──

/**
 * Аннулировать лист в рамках операции: списание задним числом (Р20) и первый шаг перевыписки (Р2,
 * Р30) — одно и то же действие, и различаются они лишь тем, что происходит дальше.
 *
 * Причина операции идёт в `cancel_reason` (Р35): у аннулированного листа колонка причины уже есть,
 * и держать объяснение в двух местах значило бы завести два ответа на вопрос «почему этот номер
 * списан». Ради этого же `waybills_correction_issue_reason_check` не требует `correction_reason` у
 * аннулированного.
 *
 * `correction_id` при этом не трогается: там стоит операция, **породившая** номер, и у листа,
 * рождённого перевыпиской и списанного следующей коррекцией (цепочка A → B → C, Р32), они разные.
 * Списавшая операция уходит в свою колонку `cancel_correction_id` — затерев ею одну другую, мы
 * получили бы строку журнала, называющую причину рождения со ссылкой на списание (Р12).
 *
 * Возвращает `false`, если лист уже был аннулирован: условие стоит в самом `UPDATE`, потому что
 * между чтением строки и правкой её успевает списать соседняя вкладка, а «аннулировать дважды»
 * означало бы вторую запись о списании одного бланка.
 */
export async function cancelWaybillForCorrection(
  tx: Tx,
  input: { waybillId: string; correctionId: string; reason: string; actorUserId: string },
): Promise<boolean> {
  const updated = await tx
    .update(waybills)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: input.actorUserId,
      cancelReason: input.reason,
      // Списавшая операция — в свою колонку, рядом с `cancelledBy`/`cancelReason`. Писать её в
      // `correctionId` нельзя: там стоит операция, **породившая** лист, и у перевыписанного, а
      // затем скорректированного заново номера они разные. Затерев одну другой, мы получили бы
      // строку, называющую причину рождения со ссылкой на списание.
      cancelCorrectionId: input.correctionId,
      updatedAt: new Date(),
    })
    .where(and(eq(waybills.id, input.waybillId), ne(waybills.status, 'cancelled')))
    .returning({ id: waybills.id });
  return updated.length > 0;
}

/**
 * Связать операцию с заявками, которых она коснулась: у коррекции рейса это весь состав, у
 * переноса — одна заявка, зато на два рейса.
 *
 * `onConflictDoNothing` ради повторного вызова из одной операции (состав и заявка-основание
 * перегона могут совпасть): пара «операция + заявка» это факт, а не счётчик.
 */
export async function linkCorrectionRequests(
  tx: Tx,
  correctionId: string,
  requestIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(requestIds)];
  if (ids.length === 0) return;
  await tx
    .insert(vehicleRequestCorrections)
    .values(ids.map((requestId) => ({ correctionId, requestId })))
    .onConflictDoNothing();
}
