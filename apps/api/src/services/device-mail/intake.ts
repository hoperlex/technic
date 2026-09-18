import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  DEVICE_MAIL_PAUSE_CODE,
  DEVICE_MAIL_STUCK_ATTEMPTS,
  deviceErrorClasses,
  isFinalDeviceMessageStatus,
  isPauseErrorCode,
  type DeviceErrorCode,
  type DeviceMailContext,
  type DeviceMessageStatus,
  type DeviceSkipReason,
  type ParsedDeviceMessage,
} from '@technic/contracts';
import { config } from '../../config';
import { db } from '../../db/client';
import {
  deviceEvents,
  deviceMailAccounts,
  deviceMailMessages,
  deviceObservations,
} from '../../db/schema';
import { AppError, err } from '../../lib/errors';
import { isFeatureEnabled } from '../feature-flags';
import { applyResolvedDeviceMessage } from './apply';
import { resolveDeviceIdentity } from './identity';
import { parseDeviceMail } from './mime';
import { DeviceParseError, normalizeParsedMessage } from './normalize';
import { chooseProfile } from './profiles';
import { applyParseRules, EMPTY_RULE_SET, type ParseRuleSet } from './rules';
import { loadParseRules } from './rules-store';
import {
  buildDeviceMailObjectKey,
  getDeviceMailRaw,
  putDeviceMailRaw,
  scheduleDeviceMailRawCleanup,
} from './storage';

/**
 * Приём письма аппарата: журнал письма, сырьё, разбор и курсор ящика (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §9.1 — протокол по шагам, Р23–Р26, Р32).
 *
 * ПОРЯДОК ШАГОВ ЗДЕСЬ НЕ ПЕРЕОТКРЫВАЕТСЯ. Пять кругов ревью плана били в один и тот же узел, и
 * каждая точечная починка открывала соседний стык; §9.1 — итог, а этот файл — его исполнение.
 * Четыре утверждения, из которых всё остальное следует:
 *
 * 1. **Строка раньше хранилища, и у неё есть признак сырья.** Конфликт по ключу идемпотентности —
 *    штатный успех, и при обратном порядке каждый повторный заход оставлял бы в хранилище объект,
 *    на который никто не ссылается, — а значит, и отложенного удаления ему никто не поставит.
 * 2. **`received` коммитится отдельно.** Без этого правило «зависшее письмо видно в очереди» не
 *    выполняется ровно в том случае, ради которого написано: процесс умер на разборе.
 * 3. **Курсор двигается ТОЛЬКО последним коммитом** — тем, что пишет исход. Сдвинь его первой
 *    транзакцией, и падение до записи объекта оставит строку `received`/`absent` навсегда: worker
 *    спросит курсор, получит уже сдвинутый и начнёт со следующего UID. Письмо не будет сдано
 *    никогда.
 * 4. **Повторная сдача разбирается по паре «статус + состояние сырья», а не по факту строки.**
 *    Плоский «успех, вот новый last_uid» теряет письмо целиком; плоский «успех, курсор не двигаю»
 *    гоняет один UID по кругу вечно, причём без единой ошибки в журнале.
 *
 * ВРЕМЕННЫЙ ОТКАЗ — НЕ ОШИБКА ПИСЬМА. Выключенный рубильник и недоступное хранилище отвечают
 * `DeviceMailPauseError`: письмо остаётся в ящике, курсор стоит, счётчик застревания не растёт.
 * Иначе выключенный на сутки рубильник — штатное аварийное действие (Р28) — выел бы за сутки
 * десятки писем подряд, каждое по очереди становясь головой пачки.
 */

/** Транзакция drizzle: ровно то, что даёт `db.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Пауза приёма: «портал целиком не принимает», и письмо тут ни при чём.
 *
 * СВОЙ КЛАСС, А НЕ `err.unavailable`, потому что снаружи важен не статус, а код: обработчик ошибок
 * маршрута считает заходы по каждому письму и обязан отличить паузу от отказа, различающего
 * письмо. Отличать их по тексту сообщения нельзя — текст правится редактурой, код контрактом.
 */
export class DeviceMailPauseError extends AppError {
  readonly errorCode: DeviceErrorCode;

  constructor(code: DeviceErrorCode, message: string, cause?: unknown) {
    super(503, DEVICE_MAIL_PAUSE_CODE, message, undefined, { errorCode: code });
    this.name = 'DeviceMailPauseError';
    this.errorCode = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Пауза ли это. Ровно один вопрос обработчика ошибок маршрута — растить ли счётчик. */
export function isDeviceMailPause(error: unknown): error is DeviceMailPauseError {
  return error instanceof DeviceMailPauseError && isPauseErrorCode(error.errorCode);
}

// ── Курсор ящика ──

export interface DeviceMailCursor {
  account: string;
  uidValidity: bigint;
  lastUid: bigint;
  resetUidValidity: bigint | null;
  resetMaxUid: bigint | null;
  stuckUidValidity: bigint | null;
  stuckUid: bigint | null;
  stuckAttempts: number;
  /**
   * Причина, по которой курсор стоит. Читается вместе с курсором намеренно: её накопил обработчик
   * ошибок маршрута, а закрывающая строка `stuck` обязана её унести в `error_text` — иначе
   * `advanceCursor` стирает единственное объяснение тем же коммитом, которым закрывает письмо, и
   * человеку в очереди не остаётся ни тела, ни снимка, ни причины.
   */
  lastError: string;
}

const CURSOR_COLUMNS = {
  account: deviceMailAccounts.account,
  uidValidity: deviceMailAccounts.uidValidity,
  lastUid: deviceMailAccounts.lastUid,
  resetUidValidity: deviceMailAccounts.resetUidValidity,
  resetMaxUid: deviceMailAccounts.resetMaxUid,
  stuckUidValidity: deviceMailAccounts.stuckUidValidity,
  stuckUid: deviceMailAccounts.stuckUid,
  stuckAttempts: deviceMailAccounts.stuckAttempts,
  lastError: deviceMailAccounts.lastError,
};

/**
 * Строка ящика: нет — заводится нулями.
 *
 * Заводится здесь, а не миграцией, по двум причинам сразу. Имя ящика приезжает настройкой
 * (`DEVICE_MAIL_ACCOUNT`), и миграция его знать не может; а строка письма ссылается на ящик внешним
 * ключом — без неё первое же письмо упало бы нарушением ссылки, то есть пятисоткой, которую §9.1
 * п. 7 прочтёт как застревание.
 */
export async function ensureDeviceMailAccount(
  reader: Tx | typeof db,
  account: string,
): Promise<DeviceMailCursor> {
  await reader.insert(deviceMailAccounts).values({ account }).onConflictDoNothing();
  const [row] = await reader
    .select(CURSOR_COLUMNS)
    .from(deviceMailAccounts)
    .where(eq(deviceMailAccounts.account, account));
  return row!;
}

/**
 * Курсор для worker'а перед заходом в ящик (Р23) плюс отметка живости и причина, по которой ящик
 * не прочитался.
 *
 * Отметка ставится чтением намеренно: «курсор стоит с такого-то времени» показывает очередь
 * §10, и знать это время больше неоткуда — застрявшее письмо может не доехать до базы ни разу
 * (§9.1, п. 8), и тогда своей строки у него нет вовсе.
 *
 * ПРИЧИНА ПРИЕЗЖАЕТ ТЕМ ЖЕ ЗАПРОСОМ, И ЭТО ЕДИНСТВЕННАЯ ДВЕРЬ ДЛЯ НЕЁ. Ящик, который не читается
 * ВОВСЕ — неверный пароль, провал STARTTLS, обрыв посреди пачки, — не оставляет в базе ни строки:
 * сдачи не было, а `last_error` до сих пор писал только счётчик застревания из обработчика ошибок
 * приёма. То есть мёртвый контур не был виден правдой нигде, хотя §9.1 п. 8 обещает обратное.
 * Приёмник называет причину один раз, первым запросом курсора после неудачного захода, и сам её
 * забывает; поэтому пустое значение НИЧЕГО НЕ МЕНЯЕТ — вчерашняя беда не имеет права лечь поверх
 * сегодняшней работы. Снимает причину первый успешный приём (`advanceCursor`), и порядок здесь
 * именно такой: причина живёт до первого успеха, а не поверх него.
 */
export async function readDeviceMailCursor(
  account: string,
  mailboxError?: string,
): Promise<DeviceMailCursor> {
  const state = await ensureDeviceMailAccount(db, account);
  const reason = (mailboxError ?? '').trim();
  await db
    .update(deviceMailAccounts)
    .set({
      lastPollAt: new Date(),
      ...(reason === '' ? {} : { lastError: reason.slice(0, 500), updatedAt: new Date() }),
    })
    .where(eq(deviceMailAccounts.account, account));
  return reason === '' ? state : { ...state, lastError: reason.slice(0, 500) };
}

/**
 * Счётчик застревания: растёт отдельной закоммиченной транзакцией из обработчика ошибок маршрута
 * (§9.1, п. 7).
 *
 * НЕ В ТЕЛЕ РУЧКИ И НЕ НА ВХОДЕ СЛЕДУЮЩЕГО ЗАХОДА. В теле его не достать: необработанное
 * исключение уходит в общий обработчик ошибок приложения, который про UID письма не знает ничего,
 * и счётчик не вырос бы ни разу. А на входе следующего захода неизвестно, почему письмо
 * вернулось, — и час недоступного хранилища досчитал бы до `stuck` совершенно законное письмо.
 *
 * Пара «эпоха + UID» хранится целиком: сохранённый номер после смены `uid_validity` указывал бы на
 * другое письмо нового ящика, которому «осталась одна попытка».
 */
export async function bumpDeviceMailStuck(
  account: string,
  uidValidity: bigint,
  uid: bigint,
  reason: string,
): Promise<void> {
  await ensureDeviceMailAccount(db, account);
  await db
    .update(deviceMailAccounts)
    .set({
      stuckAttempts: sql`CASE
        WHEN ${deviceMailAccounts.stuckUidValidity} = ${uidValidity.toString()}::bigint
         AND ${deviceMailAccounts.stuckUid} = ${uid.toString()}::bigint
        THEN ${deviceMailAccounts.stuckAttempts} + 1 ELSE 1 END`,
      stuckUidValidity: uidValidity,
      stuckUid: uid,
      lastError: reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(deviceMailAccounts.account, account));
}

/**
 * Эпоха ящика. Совпала — ничего не происходит; выросла — ящик пересоздан провайдером, курсор
 * сбрасывается и ящик читается заново целиком (Р23).
 *
 * ОТМЕТКУ ГРАНИЦЫ ПРИНОСИТ WORKER (`mailboxMaxUid`), и в этом весь смысл поля. Р32 требует
 * границей режима дочитывания архива «максимальный UID ящика на эту минуту»; ящик видит только
 * worker — он берёт конверты пачкой и знает верхний номер, — а API в ящик не ходит вовсе. Не
 * прислали — отметка остаётся пустой, и барьер дедупликации выключен: из двух отказов это
 * выбранный. Без барьера перечитанный архив задвоится (данные есть, их можно почистить), а барьер
 * БЕЗ ГРАНИЦЫ съел бы новое письмо о замятии, совпавшее по хешу и `Date` с сентябрьским, — а §2
 * плана объявляет поток событий невосстановимым.
 *
 * ПЕРВОЕ ЗНАКОМСТВО С ЯЩИКОМ СБРОСОМ НЕ СЧИТАЕТСЯ. Нулевая эпоха означает, что прошлой не было
 * вовсе: ящик читается впервые, а не перечитывается. Поставь отметку и здесь — и барьер включился
 * бы на первом же обходе, где два настоящих замятия аппарата с севшей батарейкой RTC совпадают
 * хешем и `Date`; второе потерялось бы молча, и это ровно тот вред, от которого Р32 и
 * предостерегает.
 *
 * Письмо ПРОШЛОЙ эпохи (эпоха меньше сохранённой) принимается, но курсора не двигает: это
 * дочитывающий заход старого контейнера, и вернуть курсор в прошлое значило бы прочитать ящик
 * второй раз целиком.
 */
async function syncEpoch(
  state: DeviceMailCursor,
  uidValidity: bigint,
  mailboxMaxUid: bigint | null,
): Promise<DeviceMailCursor> {
  if (state.uidValidity === uidValidity || uidValidity < state.uidValidity) return state;
  const firstEver = state.uidValidity === 0n;
  const [row] = await db
    .update(deviceMailAccounts)
    .set({
      uidValidity,
      lastUid: 0n,
      resetAt: firstEver ? null : new Date(),
      resetUidValidity: firstEver ? null : uidValidity,
      resetMaxUid: firstEver ? null : mailboxMaxUid,
      // Счётчик обнуляется при сбросе курсора: попытки, накопленные в прошлой эпохе, считались по
      // другому письму, и переносить их на нового владельца номера нельзя.
      stuckUidValidity: null,
      stuckUid: null,
      stuckAttempts: 0,
      lastError: '',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deviceMailAccounts.account, state.account),
        sql`${deviceMailAccounts.uidValidity} < ${uidValidity.toString()}::bigint`,
      ),
    )
    .returning(CURSOR_COLUMNS);
  return row ?? { ...state, uidValidity, lastUid: 0n, lastError: '' };
}

/**
 * Курсор двигается `GREATEST`, а не присваиванием (Р23): два перекрывшихся захода — выкат, когда
 * старый контейнер дочитывает пачку, или пачка из пятидесяти тяжёлых писем дольше периода
 * опроса — иначе уводят курсор назад.
 *
 * Успешный приём обнуляет счётчик застревания. Без обнуления попытки копятся по разным письмам
 * месяцами, и однажды законное письмо закрывается `stuck` с первого отказа.
 */
async function advanceCursor(
  tx: Tx,
  state: DeviceMailCursor,
  uidValidity: bigint,
  uid: bigint,
): Promise<bigint> {
  const [row] = await tx
    .update(deviceMailAccounts)
    .set({
      lastUid: sql`GREATEST(${deviceMailAccounts.lastUid}, ${uid.toString()}::bigint)`,
      lastError: '',
      stuckUidValidity: null,
      stuckUid: null,
      stuckAttempts: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deviceMailAccounts.account, state.account),
        // Эпоха сверяется в условии: письмо прошлой эпохи не имеет права двигать сегодняшний
        // курсор, и молчаливый промах здесь честнее отдельной ветки с тем же смыслом.
        eq(deviceMailAccounts.uidValidity, uidValidity),
      ),
    )
    .returning({ lastUid: deviceMailAccounts.lastUid });
  return row?.lastUid ?? state.lastUid;
}

// ── Приём письма ──

export interface DeviceMailIntakeInput {
  account: string;
  uidValidity: bigint;
  uid: bigint;
  /** Размер письма по конверту IMAP: по нему переросток и опознаётся, не качаясь (§9.1, п. 1). */
  size: number;
  messageIdHeader: string;
  dateHeader: string | null;
  envelopeTo: string;
  /** Тело целиком либо `null` — конверт без сырья, и это ТОЛЬКО переросток (§9.1, п. 1). */
  raw: Buffer | null;
  /** Почему тела нет. Приезжает вместе с пустым телом и ни при каких других условиях. */
  skipReason: DeviceSkipReason | null;
  /**
   * Верхний номер ящика на момент обхода — граница режима дочитывания архива (Р32). Знает его
   * только worker: он берёт конверты пачкой и видит максимальный UID, а API в ящик не ходит.
   * Применяется РОВНО В ОДИН момент — когда сменилась эпоха и курсор сбрасывается; в остальных
   * заходах поле не значит ничего и ни на что не влияет.
   */
  mailboxMaxUid: bigint | null;
}

export interface DeviceMailIntakeResult {
  /**
   * `created` или `existed` — отдельным полем, а не догадкой по статусу. Без него приёмник,
   * молча съедающий всё подряд, проходит тесты идеально (§9.1, п. 5).
   */
  outcome: 'created' | 'existed';
  status: DeviceMessageStatus;
  /** Курсор ПОСЛЕ приёма: worker двигается по ответу, а не по своей памяти (Р23). */
  lastUid: number;
}

/** Терминальный исход, который ручка ставит сама, не спрашивая разборщик. */
interface ForcedOutcome {
  status: DeviceMessageStatus;
  code: DeviceErrorCode;
  text: string;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Ключ повтора — хеш сырья плюс `Date` письма (Р24).
 *
 * `Date` нет (бывает у старых прошивок) — берётся дата приёма с точностью до суток. Это и есть
 * прежнее окно дедупликации, но теперь оно частный случай, а не правило.
 */
function dedupeKeyOf(raw: Buffer, dateHeader: string | null, receivedAt: Date): string {
  const sha = createHash('sha256').update(raw).digest('hex');
  const stamp = dateHeader ?? receivedAt.toISOString().slice(0, 10);
  return `${sha}|${stamp}`;
}

function shaOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Рубильник приёма (Р28) — проверяется ДО первой записи: отказ не оставляет следов вовсе. */
async function assertIntakeOpen(): Promise<void> {
  if (await isFeatureEnabled(db, 'device_mail_intake')) return;
  throw new DeviceMailPauseError(
    'intake_disabled',
    'Приём писем от аппаратов выключен рубильником device_mail_intake',
  );
}

/**
 * Барьер дедупликации — ТОЛЬКО на дочитывании архива (Р32).
 *
 * В штатной работе UID растут, и идемпотентность целиком держит ключ `(account, uid_validity,
 * uid)`. Барьером `dedupe_key` становится в одном случае: эпоха совпала с отметкой сброса и UID не
 * выше отметки — то есть ровно на архиве, который перечитывается после пересоздания ящика.
 *
 * Срабатывает только против ЗАВЕРШЁННОЙ строки с сырьём `stored` либо `purged`. Вычеркни
 * `purged` — и барьер выключится ровно на том архиве, ради которого написан. А против строки
 * `absent`/`received` он не срабатывает никогда: письмо, чья строка заведена, а сырьё не легло,
 * погасилось бы как дубль собственной пустой строки и потерялось бы совсем.
 */
async function archiveDuplicate(
  state: DeviceMailCursor,
  uidValidity: bigint,
  uid: bigint,
  dedupeKey: string,
): Promise<{ id: string; status: DeviceMessageStatus } | null> {
  if (state.resetUidValidity === null || state.resetMaxUid === null) return null;
  if (state.resetUidValidity !== uidValidity || uid > state.resetMaxUid) return null;
  const [row] = await db
    .select({ id: deviceMailMessages.id, status: deviceMailMessages.status })
    .from(deviceMailMessages)
    .where(
      and(
        eq(deviceMailMessages.account, state.account),
        eq(deviceMailMessages.dedupeKey, dedupeKey),
        sql`${deviceMailMessages.status} <> 'received'`,
        sql`${deviceMailMessages.rawState} <> 'absent'`,
      ),
    )
    .limit(1);
  return row ?? null;
}

interface MessageRow {
  id: string;
  status: DeviceMessageStatus;
  rawState: 'absent' | 'stored' | 'purged';
  s3ObjectKey: string | null;
  receivedAt: Date;
}

const MESSAGE_COLUMNS = {
  id: deviceMailMessages.id,
  status: deviceMailMessages.status,
  rawState: deviceMailMessages.rawState,
  s3ObjectKey: deviceMailMessages.s3ObjectKey,
  receivedAt: deviceMailMessages.receivedAt,
};

async function findMessage(
  account: string,
  uidValidity: bigint,
  uid: bigint,
): Promise<MessageRow | null> {
  const [row] = await db
    .select(MESSAGE_COLUMNS)
    .from(deviceMailMessages)
    .where(
      and(
        eq(deviceMailMessages.account, account),
        eq(deviceMailMessages.uidValidity, uidValidity),
        eq(deviceMailMessages.uid, uid),
      ),
    );
  return (row as MessageRow | undefined) ?? null;
}

/**
 * ШАГ 3, первый коммит: строка `received` с признаком `absent`.
 *
 * Отдельной транзакцией и раньше хранилища. Конфликт по ключу идемпотентности гасится молча и
 * строка перечитывается: два захода worker'а на одно письмо — штатное дело, а не ошибка.
 */
async function insertReceived(
  input: DeviceMailIntakeInput,
  dedupeKey: string,
  sha: string,
): Promise<{ row: MessageRow; created: boolean }> {
  const [inserted] = await db
    .insert(deviceMailMessages)
    .values({
      account: input.account,
      uidValidity: input.uidValidity,
      uid: input.uid,
      messageIdHeader: input.messageIdHeader,
      envelopeTo: input.envelopeTo,
      rawSha256: sha,
      dedupeKey,
      deviceTime: parseDate(input.dateHeader),
      status: 'received',
      rawState: 'absent',
    })
    .onConflictDoNothing({
      target: [deviceMailMessages.account, deviceMailMessages.uidValidity, deviceMailMessages.uid],
    })
    .returning(MESSAGE_COLUMNS);
  if (inserted) return { row: inserted as MessageRow, created: true };
  const existing = await findMessage(input.account, input.uidValidity, input.uid);
  if (!existing) {
    // Строки нет и вставка не прошла — такого исхода у ключа идемпотентности не бывает, и
    // угадывать здесь нечего: пусть считается застреванием и разбирается человеком.
    throw new Error('device-mail: строка письма не завелась и не нашлась');
  }
  return { row: existing, created: false };
}

/**
 * ШАГ 3, второй коммит: объект в хранилище, затем `raw_state = stored`.
 *
 * Отказ хранилища — ПАУЗА, а не ошибка письма: письмо остаётся в ящике и дождётся, пока хранилище
 * поднимут. Строка при этом уже заведена и видна в очереди как зависшая — ровно то состояние,
 * ради которого заведён признак сырья.
 *
 * УБОРКА СТАВИТСЯ НА КЛЮЧ РАНЬШЕ САМОГО ОБЪЕКТА, и это не перестановка ради красоты. Между
 * записью в хранилище и её коммитом процесс может умереть — выкат, OOM, обрыв, — и тело осталось
 * бы лежать без ссылки: строка про него не знает, повтор положит новый uuid, а срок хранения
 * ходит по задачам, не по объектам. То есть письмо с внутренними адресами и IP живой сети (Р31)
 * не удалит уже никто и никогда. Поставленная вперёд задача убирает и такого сироту: удаление
 * отсутствующего объекта идемпотентно и считается успехом (`deleteObject`), так что лишняя задача
 * не стоит ничего, а пропущенная стоит навсегда оставшегося тела.
 */
async function storeRaw(row: MessageRow, raw: Buffer): Promise<MessageRow> {
  const objectKey = buildDeviceMailObjectKey(row.receivedAt);
  await db.transaction(async (tx) => {
    await scheduleDeviceMailRawCleanup(tx, objectKey, row.receivedAt);
  });
  try {
    await putDeviceMailRaw(objectKey, raw);
  } catch (e) {
    throw new DeviceMailPauseError(
      'storage_unavailable',
      'Хранилище не приняло сырьё письма — приём отложен',
      e,
    );
  }
  await db
    .update(deviceMailMessages)
    .set({ s3ObjectKey: objectKey, rawState: 'stored', updatedAt: new Date() })
    .where(eq(deviceMailMessages.id, row.id));
  return { ...row, s3ObjectKey: objectKey, rawState: 'stored' };
}

/** Что разбор даёт строке письма: снимок, исход и то, чем письмо опознано. */
interface ParseOutcome {
  status: DeviceMessageStatus;
  errorCode: DeviceErrorCode | null;
  errorText: string;
  parsed: ParsedDeviceMessage | null;
  ctx: DeviceMailContext | null;
}

/**
 * Разбор письма БЕЗ базы: MIME, профиль, нормализация.
 *
 * Ни одна ветка не выпускает исключение наружу. Ошибка разбора — это статус строки, а не отказ
 * ручки (Р3): письмо записывается с кодом ошибки, следующее идёт своим ходом. Незавёрнутое
 * исключение ушло бы в общий обработчик ошибок, а тот читается снаружи как пауза — и ящик встал бы
 * навсегда из-за одного кривого письма.
 */
async function parseMessage(
  raw: Buffer,
  envelopeTo: string,
  rules: ParseRuleSet,
): Promise<ParseOutcome> {
  let ctx: DeviceMailContext;
  try {
    ctx = await parseDeviceMail(raw, { envelopeTo });
  } catch (e) {
    return {
      status: 'failed',
      errorCode: 'malformed',
      errorText: `письмо не разбирается как MIME: ${e instanceof Error ? e.message : String(e)}`,
      parsed: null,
      ctx: null,
    };
  }

  // ВЫБОР ПРОФИЛЯ — ТОЖЕ ВНУТРИ ОБЕЩАНИЯ. `detect` каждого профиля — чужой код, и падение одного
  // из них не имеет права стать пятисоткой: снаружи она читается как пауза, счётчик застревания
  // досчитает до десяти, и письмо закроется `stuck` вместо честного `failed` с кодом и причиной.
  // По той же причине неожидаемое исключение нормализации не перебрасывается, а сводится к
  // `extract_failed`: сырьё сложено, кнопка «перечитать» жива, и разбираться человек будет с
  // причиной в строке, а не с номером ограничения в журнале сервера.
  let parsed: ParsedDeviceMessage;
  let recognized: boolean;
  try {
    const choice = chooseProfile(ctx);
    recognized = choice.recognized;
    // Правила из базы ПЕРЕКРЫВАЮТ разбор профиля (план
    // `docs/office-equipment-mail-identity-ui-plan.md`, §5.2): правило пишут под конкретный формат,
    // а словарь профиля общий. Стоят они внутри того же обещания, что и сам профиль: кривое
    // правило обязано стать `failed` у одного письма, а не паузой всего ящика.
    parsed = applyParseRules(
      normalizeParsedMessage(choice.profile, ctx),
      ctx,
      rules,
      choice.profile.code,
    );
  } catch (e) {
    if (e instanceof DeviceParseError) {
      return { status: 'failed', errorCode: e.code, errorText: e.reason, parsed: null, ctx };
    }
    return {
      status: 'failed',
      errorCode: 'extract_failed',
      errorText: `разбор письма сорвался: ${e instanceof Error ? e.message : String(e)}`,
      parsed: null,
      ctx,
    };
  }

  // Профиль не узнал никто — `unrecognized`, и это законный исход, а не отказ: снимок с
  // подсказками опознания всё равно ложится в строку, и из этой очереди берут образцы для
  // следующего профиля.
  if (!recognized) {
    return {
      status: 'unrecognized',
      errorCode: 'no_profile',
      errorText: 'формат письма не узнал ни один профиль',
      parsed,
      ctx,
    };
  }
  return { status: 'parsed', errorCode: null, errorText: '', parsed, ctx };
}

/** Отправитель вне списка доверенных — терминальный исход, но сырьё сохраняется (§9.1, п. 6). */
function senderRefusal(ctx: DeviceMailContext | null): ForcedOutcome | null {
  const allowed = config.deviceMail.allowedSenders;
  if (allowed.length === 0 || !ctx) return null;
  const from = ctx.fromAddress.trim().toLowerCase();
  if (from !== '' && allowed.includes(from)) return null;
  return {
    status: 'ignored',
    code: 'sender_not_allowed',
    text: `отправитель «${from}» не в списке DEVICE_MAIL_ALLOWED_SENDERS`,
  };
}

/**
 * ИСХОД РАЗБОРА ПИШЕТ КОНВЕЙЕР `applyResolvedDeviceMessage`, А НЕ ЭТА РУЧКА.
 *
 * Правило «однозначно или никак» (Р20) — статус по исходу резолва и запись наблюдений ТОЛЬКО при
 * однозначной привязке — живёт одним местом, в `apply.ts`. Своя сборка исхода здесь была второй
 * копией того же правила: оба носителя верны сегодня и расходятся молча завтра, а за конвейером
 * стоит проверка, которая ловит подмену «кандидатов двое, возьмём первого». Приёму остаётся ровно
 * то, чего конвейер не знает и знать не должен: поля конверта, коды отказов, состояние сырья,
 * курсор и счётчик застревания.
 *
 * ПОЧЕМУ ДВЕ ЗАПИСИ ОДНОЙ СТРОКИ, А НЕ ОДНА. Конвейер пишет снимок, статус и счётчики; конверт и
 * причина отказа — не его предмет, и передавать их ему значило бы тащить в общий слой половину
 * почтового протокола. Обе записи идут ОДНОЙ транзакцией — той же, что двигает курсор (§9.1,
 * п. 3), — так что промежуточного состояния не видит никто.
 */
async function finish(
  state: DeviceMailCursor,
  input: DeviceMailIntakeInput,
  row: MessageRow,
  outcome: ParseOutcome,
  forced: ForcedOutcome | null,
  rules: ParseRuleSet,
): Promise<{ status: DeviceMessageStatus; lastUid: bigint }> {
  return db.transaction(async (tx) => {
    const ctx = outcome.ctx;
    let status: DeviceMessageStatus = forced ? forced.status : outcome.status;
    const errorCode: string = forced ? forced.code : (outcome.errorCode ?? '');
    const errorText: string = forced ? forced.text : outcome.errorText;

    if (!forced && outcome.status === 'parsed' && outcome.parsed) {
      // Резолв — читалка: он только называет карточку либо честно признаётся, что не может.
      // Решение, что с этим делать, принимает конвейер.
      const resolution = await resolveDeviceIdentity(tx, {
        hints: outcome.parsed.identity,
        fromAddress: ctx?.fromAddress ?? null,
        envelopeTo: ctx?.envelopeTo ?? input.envelopeTo,
      });
      const applied = await applyResolvedDeviceMessage(tx, {
        messageId: row.id,
        // Момент приёма порталом, а не время аппарата (Р21): часы МФУ без NTP уходят на месяцы.
        receivedAt: row.receivedAt,
        snapshot: outcome.parsed,
        resolution,
      });
      status = applied.status;
    } else {
      // Разбора не случилось (терминальный исход, `failed`, `unrecognized`): применять нечего, и
      // конвейеру здесь делать нечего тоже. Снимок, если он есть, всё равно ложится в строку —
      // у `unrecognized` в нём подсказки опознания, и очередь работает от них.
      await tx
        .update(deviceMailMessages)
        .set({
          status,
          equipmentId: null,
          profileCode: outcome.parsed?.profileCode ?? null,
          parserVersion: outcome.parsed?.parserVersion ?? null,
          parsedPayload: outcome.parsed ?? null,
          observationCount: outcome.parsed?.observations.length ?? 0,
          eventCount: outcome.parsed?.events.length ?? 0,
          parsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(deviceMailMessages.id, row.id));
    }

    // Поля конверта и код отказа — предмет приёма, а не телеметрии.
    await tx
      .update(deviceMailMessages)
      .set({
        subject: ctx?.subject ?? '',
        fromAddress: ctx?.fromAddress ?? '',
        messageIdHeader: ctx?.messageIdHeader || input.messageIdHeader,
        deviceTime: parseDate(ctx?.dateHeader ?? input.dateHeader),
        errorCode,
        errorClass: errorCode ? deviceErrorClasses[errorCode as DeviceErrorCode] : '',
        errorText: errorText.slice(0, 2000),
        // Каким набором правил письмо прочитано. Отметка справочная: отбора на перечитывание по
        // ней нет и не нужно, пока разобранных писем не существует (план §5.3).
        rulesRevision: rules.revision,
        updatedAt: new Date(),
      })
      .where(eq(deviceMailMessages.id, row.id));

    const lastUid = await advanceCursor(tx, state, input.uidValidity, input.uid);
    return { status, lastUid };
  });
}

/** Терминальный исход без разбора: строка есть, сырья может не быть, курсор едет дальше. */
async function finishForced(
  state: DeviceMailCursor,
  input: DeviceMailIntakeInput,
  row: MessageRow,
  forced: ForcedOutcome,
): Promise<{ status: DeviceMessageStatus; lastUid: bigint }> {
  const empty: ParseOutcome = {
    status: forced.status,
    errorCode: forced.code,
    errorText: forced.text,
    parsed: null,
    ctx: null,
  };
  // Разбора не было вовсе (переросток, недоверенный отправитель), поэтому и отметки набора правил
  // у такого письма нет: пустой набор здесь честнее нынешней ревизии, которая обещала бы, что
  // правила к письму применяли.
  return finish(state, input, row, empty, forced, EMPTY_RULE_SET);
}

/**
 * ПРИЁМ ОДНОГО ПИСЬМА. Шаги идут ровно в порядке §9.1 и в комментариях названы его номерами.
 */
export async function intakeDeviceMessage(
  input: DeviceMailIntakeInput,
): Promise<DeviceMailIntakeResult> {
  // Шаг 7: рубильник спрашивается первым — отказ не заводит ни строки, ни объекта.
  await assertIntakeOpen();

  const state = await syncEpoch(
    await ensureDeviceMailAccount(db, input.account),
    input.uidValidity,
    input.mailboxMaxUid,
  );
  const existing = await findMessage(input.account, input.uidValidity, input.uid);

  // Шаг 5, первая ветка: конечный статус при ЛЮБОМ состоянии сырья — успех сразу, без обращения к
  // хранилищу. `purged` накрывается наравне с остальными: Р32 заставляет перечитать весь ящик при
  // смене эпохи, а срок хранения гарантирует, что архив старше месяца именно `purged`.
  //
  // ЭТА ВЕТКА СТОИТ РАНЬШЕ СЧЁТЧИКА ЗАСТРЕВАНИЯ, и порядок несущий. Счётчик может указывать на
  // письмо, которое уже закрыто: последний заход упал ПОСЛЕ коммита исхода — на записи ответа, на
  // обрыве соединения, — и тогда обработчик ошибок честно дописал попытку по закрытой строке.
  // Проверь счётчик первым, и ручка переписала бы разобранное письмо в `ignored`/`stuck`, обнулив
  // `equipment_id` и счётчики; наблюдения и события с этим `mail_message_id` при этом остались бы
  // жить — то есть телеметрия висела бы на письме, которое больше ни к какому аппарату не
  // привязано, и отменить это нечем.
  if (existing && isFinalDeviceMessageStatus(existing.status)) {
    const lastUid = await db.transaction((tx) =>
      advanceCursor(tx, state, input.uidValidity, input.uid),
    );
    return { outcome: 'existed', status: existing.status, lastUid: Number(lastUid) };
  }

  // Шаг 7: письмо, простоявшее головой пачки десять заходов, закрывается САМОЙ ручкой — worker в
  // базу не ходит вовсе. Курсор после этого едет дальше, иначе устойчивый отказ стоял бы вечно, а
  // контур был бы мёртв, и это не видно нигде.
  if (
    state.stuckUidValidity === input.uidValidity &&
    state.stuckUid === input.uid &&
    state.stuckAttempts >= DEVICE_MAIL_STUCK_ATTEMPTS
  ) {
    const row =
      existing ??
      (
        await insertReceived(
          input,
          input.raw ? dedupeKeyOf(input.raw, input.dateHeader, new Date()) : '',
          input.raw ? shaOf(input.raw) : '',
        )
      ).row;
    // СЫРЬЁ СКЛАДЫВАЕТСЯ И ЗДЕСЬ, если тело у нас в руках. `stuck` — это письмо, с которым
    // человеку разбираться ОБЯЗАТЕЛЬНО: десять заходов отказа означают, что причину знает только
    // само письмо. Закрой его без тела, и у единственного класса писем, ради которого заведена
    // кнопка «перечитать», не останется ни тела, ни снимка — §9.1 п. 6 требует обратного прямо
    // («сырьё при этом сохраняется»). Отказ хранилища здесь законно вернётся паузой: закрытие
    // подождёт следующего захода, письмо никуда не денется.
    const kept = input.raw && row.rawState !== 'stored' ? await storeRaw(row, input.raw) : row;
    const done = await finishForced(state, input, kept, {
      status: 'ignored',
      code: 'stuck',
      // Причина, накопленная обработчиком ошибок, уносится в строку письма: `advanceCursor`
      // стирает `last_error` ящика тем же коммитом, и не перенеси её сюда — единственное
      // объяснение исчезло бы вместе с курсором.
      text:
        `письмо закрыто после ${state.stuckAttempts} заходов подряд ` +
        `(потолок ${DEVICE_MAIL_STUCK_ATTEMPTS})` +
        (state.lastError ? `; последняя причина — ${state.lastError}` : ''),
    });
    return {
      outcome: existing ? 'existed' : 'created',
      status: done.status,
      lastUid: Number(done.lastUid),
    };
  }

  // Шаг 1: конверт без сырья — это ТОЛЬКО переросток. Строка `ignored` с причиной, курсор дальше.
  //
  // Тела нет и причины нет — протокол сдачи нарушен, и это тоже ТЕРМИНАЛЬНЫЙ исход со своим кодом
  // (§9.1, п. 6): во втором заходе тот же вызов принесёт ровно то же самое, и общий 400 гонял бы
  // письмо по кругу, не оставив в журнале ни строки, ни кода — разбирать было бы нечего. Строка с
  // `bad_submission` и называет виновника, и снимает голову пачки.
  if (!input.raw) {
    const row = existing ?? (await insertReceived(input, '', '')).row;
    const done = await finishForced(state, input, row, {
      status: 'ignored',
      code: input.skipReason ?? 'bad_submission',
      text: input.skipReason
        ? `тело письма не принято: размер ${input.size} байт`
        : 'сдан конверт без тела и без причины пропуска — протокол приёма нарушен',
    });
    return {
      outcome: existing ? 'existed' : 'created',
      status: done.status,
      lastUid: Number(done.lastUid),
    };
  }

  const raw = input.raw;
  const now = new Date();
  const dedupeKey = dedupeKeyOf(raw, input.dateHeader, now);

  // Р32: барьер повторов — только на дочитывании архива и только против завершённой строки.
  // Совпадение — успех ручки, а не ошибка: конфликт по `dedupe_key`, как и по UID, штатный.
  if (!existing) {
    const duplicate = await archiveDuplicate(state, input.uidValidity, input.uid, dedupeKey);
    if (duplicate) {
      const lastUid = await db.transaction((tx) =>
        advanceCursor(tx, state, input.uidValidity, input.uid),
      );
      return { outcome: 'existed', status: duplicate.status, lastUid: Number(lastUid) };
    }
  }

  // Шаг 3, первый коммит.
  const { row: created, created: isNew } = existing
    ? { row: existing, created: false }
    : await insertReceived(input, dedupeKey, shaOf(raw));

  // Шаг 3, второй коммит. Ветка «`received` + `stored`» сюда не заходит: сырьё на месте, и
  // остаётся довести разбор — это самое частое последствие выката (процесс убит на разборе).
  const stored = created.rawState === 'stored' ? created : await storeRaw(created, raw);

  // Шаг 4 и шаг 6: разбор и исход. Письмо сверх потолка, доехавшее телом вопреки шагу 1, и письмо
  // чужого ящика закрываются терминально — но сырьё у них уже сложено, и кнопка «перечитать» жива.
  let forced: ForcedOutcome | null = null;
  if (input.account !== config.deviceMail.account) {
    forced = {
      status: 'ignored',
      code: 'wrong_account',
      text: `письмо сдано под ящиком «${input.account}», а портал принимает «${config.deviceMail.account}»`,
    };
  } else if (raw.byteLength > config.deviceMail.maxSizeBytes) {
    forced = {
      status: 'ignored',
      code: 'too_large',
      text: `тело письма ${raw.byteLength} байт при потолке ${config.deviceMail.maxSizeBytes}`,
    };
  }

  const rules = await loadParseRules();
  const outcome = await parseMessage(raw, input.envelopeTo, rules);
  forced ??= senderRefusal(outcome.ctx);
  const done = await finish(state, input, stored, outcome, forced, rules);
  return {
    outcome: isNew ? 'created' : 'existed',
    status: done.status,
    lastUid: Number(done.lastUid),
  };
}

// ── Перечитывание ──

/**
 * Перечитать письмо нынешними правилами разбора (Р26). Нагрузка задачи
 * `reparse_device_message` — один идентификатор письма, и ничего больше.
 *
 * УДАЛЕНИЕ, РАЗБОР И ЗАПИСЬ ИДУТ ОДНОЙ ТРАНЗАКЦИЕЙ, ПРОМЕЖУТОЧНОГО СТАТУСА НЕТ. Порядок «удалить →
 * вернуть в `received` → разобрать» отвергнут ревью плана насквозь: выкат убивает воркера между
 * шагами, попытки кончаются, задача уходит в `dead` — и письмо остаётся в `received` с удалёнными
 * наблюдениями, вне отбора очереди, то есть данные исчезли и этого не видно никому.
 *
 * КУРСОР ЯЩИКА ПЕРЕЧИТЫВАНИЕ НЕ ТРОГАЕТ ВОВСЕ: это работа по уже принятому письму, а не приём.
 */
export async function reparseDeviceMessage(messageId: string): Promise<DeviceMessageStatus> {
  const [row] = await db
    .select({
      ...MESSAGE_COLUMNS,
      account: deviceMailMessages.account,
      uidValidity: deviceMailMessages.uidValidity,
      uid: deviceMailMessages.uid,
      envelopeTo: deviceMailMessages.envelopeTo,
      messageIdHeader: deviceMailMessages.messageIdHeader,
      subject: deviceMailMessages.subject,
      fromAddress: deviceMailMessages.fromAddress,
      deviceTime: deviceMailMessages.deviceTime,
    })
    .from(deviceMailMessages)
    .where(eq(deviceMailMessages.id, messageId));
  if (!row) throw err.notFound('Письмо аппарата не найдено');
  if (row.rawState !== 'stored' || !row.s3ObjectKey) {
    throw err.unprocessable('Перечитывать нечем: сырьё письма не сохранено или вычищено по сроку');
  }

  const raw = await getDeviceMailRaw(row.s3ObjectKey);
  if (!raw) {
    // Строка уверяет, что сырьё сложено, а объекта НЕТ (а не «не читается»: отказ хранилища летит
    // исключением и сюда не доходит). Значит его унесла отложенная уборка по сроку — и состояние
    // строки просто отстало от жизни. Признаём это значением `purged` и отвечаем «перечитывать
    // нечем»: без такой починки задача очереди ходила бы кругами до конца попыток, а очередь
    // предлагала бы кнопку, которой нечем работать.
    await db
      .update(deviceMailMessages)
      .set({ rawState: 'purged', s3ObjectKey: null, updatedAt: new Date() })
      .where(eq(deviceMailMessages.id, messageId));
    throw err.unprocessable('Перечитывать нечем: сырьё письма вычищено по сроку хранения');
  }

  const rules = await loadParseRules();
  const outcome = await parseMessage(raw, row.envelopeTo, rules);
  const forced = senderRefusal(outcome.ctx);

  return db.transaction(async (tx) => {
    // Производное снимается целиком: и наблюдения, и события этого письма. Уникальность у них
    // считается по `source_ref`, то есть по строке письма, — и без удаления новый разбор просто
    // не записал бы ничего, молча оставив прежние числа.
    await tx.delete(deviceObservations).where(eq(deviceObservations.mailMessageId, messageId));
    await tx.delete(deviceEvents).where(eq(deviceEvents.mailMessageId, messageId));

    const ctx = outcome.ctx;
    let status: DeviceMessageStatus = forced ? forced.status : outcome.status;
    const errorCode: string = forced ? forced.code : (outcome.errorCode ?? '');
    const errorText = forced ? forced.text : outcome.errorText;

    // Исход разбора пишет тот же конвейер, что и на приёме: правило «однозначно или никак» (Р20)
    // обязано быть одним местом, иначе перечитывание однажды применит снимок по своей редакции
    // правила — и заметить это будет нечем.
    if (!forced && outcome.status === 'parsed' && outcome.parsed) {
      const resolution = await resolveDeviceIdentity(tx, {
        hints: outcome.parsed.identity,
        fromAddress: ctx?.fromAddress ?? null,
        envelopeTo: ctx?.envelopeTo ?? row.envelopeTo,
      });
      const applied = await applyResolvedDeviceMessage(tx, {
        messageId,
        // Момент приёма — прежний: пакетное перечитывание иначе выстроило бы весь архив в одну
        // секунду, и порядок ряда потерялся бы (Р21).
        receivedAt: row.receivedAt,
        snapshot: outcome.parsed,
        resolution,
      });
      status = applied.status;
    } else {
      await tx
        .update(deviceMailMessages)
        .set({
          status,
          equipmentId: null,
          profileCode: outcome.parsed?.profileCode ?? null,
          parserVersion: outcome.parsed?.parserVersion ?? null,
          parsedPayload: outcome.parsed ?? null,
          observationCount: outcome.parsed?.observations.length ?? 0,
          eventCount: outcome.parsed?.events.length ?? 0,
          parsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(deviceMailMessages.id, messageId));
    }

    await tx
      .update(deviceMailMessages)
      .set({
        // ПОЛЯ КОНВЕРТА ПЕРЕЧИТЫВАНИЕ НЕ СТИРАЕТ. Разбор мог и не состояться — правка профиля,
        // поехавший MIME, — и тогда `ctx` пуст. Затри ими строку, и письмо потеряет `device_time`,
        // а Р21 говорит, что лента событий показывает именно его: «замялось сорок раз только что»
        // вместо настоящего времени аварии. Прежние значения старше нынешнего отказа и потому
        // остаются.
        subject: ctx ? ctx.subject : row.subject,
        fromAddress: ctx ? ctx.fromAddress : row.fromAddress,
        messageIdHeader: ctx?.messageIdHeader || row.messageIdHeader,
        deviceTime: ctx ? (parseDate(ctx.dateHeader) ?? row.deviceTime) : row.deviceTime,
        errorCode,
        errorClass: errorCode ? deviceErrorClasses[errorCode as DeviceErrorCode] : '',
        errorText: errorText.slice(0, 2000),
        rulesRevision: rules.revision,
        updatedAt: new Date(),
      })
      .where(eq(deviceMailMessages.id, messageId));

    return status;
  });
}
